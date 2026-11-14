/**
 * Driving the sirens and alarm handlers directly (hub-design.md section 2: a handler is a function
 * of its slice, a message and a context), for the rules and the protocol's vectors where a test
 * must set a counter or a message no input could. The view is the state with the handled slices
 * put back, as the dispatcher keeps it.
 */
import { expect } from "bun:test";
import { ok } from "neverthrow";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";
import type { Context } from "../../../src/core/model/handler.ts";
import {
  bootId,
  type DeviceId,
  deviceId,
  type LinkId,
  linkId,
  seq,
} from "../../../src/core/model/ids.ts";
import type { Arrival, Internal } from "../../../src/core/model/messages.ts";
import { DeviceState } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES, type HubRules } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { mono, type Mono } from "../../../src/core/model/time.ts";
import { handleAlarm } from "../../../src/core/alarm/handle.ts";
import { handleRegistry } from "../../../src/core/registry/handle.ts";
import { handleSirens } from "../../../src/core/sirens/handle.ts";
import { emptyState } from "../../../src/core/step.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { emptySnapshot } from "../../world/world.ts";

export const SECOND = 1_000_000;
/** The vectors' siren (siren-command.json, siren-report.json, siren-settings.json). */
export const SIREN: DeviceId = deviceId(5);
export const SIREN_ADDRESS = 1584361601;
export const WIFI: LinkId = linkId(7);
export const GATEWAY: DeviceId = deviceId(4);

const cipher = VectorCipher.fromVectors();

/** A hub driven one message at a time through the alarm and sirens handlers. */
export class Direct {
  state: HubState = emptyState();
  readonly out: (Internal | Effect)[] = [];
  readonly rules: HubRules;
  #seq = 1;
  at: Mono = mono(0);

  constructor(rules: HubRules = DEFAULT_RULES) {
    this.rules = rules;
  }

  context(): Context {
    const ctx: Context = {
      now: {
        mono: this.at,
        wall: 1_800_000_000_000 + Math.floor(this.at / 1000),
        wallTrusted: true,
      },
      view: this.state,
      deps: { cipher, rules: this.rules },
      entropy: entropyCursor(new Uint8Array(32), "tick"),
      records: { take: () => ok(seq(this.#seq++)) },
      event: "tick",
    };
    return ctx;
  }

  /**
   * Delivers one message to the registry (whose names and addresses the sirens read), the alarm,
   * then the sirens, as the dispatcher does; returns the alarm's and the sirens' output.
   */
  send(message: Internal): readonly (Internal | Effect)[] {
    const emitted: (Internal | Effect)[] = [];
    if (message.kind === "deviceAdded") {
      // A device added without a board behind it: the registry's row as provisioning gives it.
      const devices = new Map(this.state.registry.devices).set(message.device, {
        id: message.device,
        address: message.address,
        role: message.role,
        name: message.name,
        chipId: new Uint8Array(6),
        firmware: 0,
        development: true,
        state: DeviceState.Provisioning,
        addedMs: 0,
        removedMs: null,
      });
      this.state = { ...this.state, registry: { ...this.state.registry, devices } };
    } else {
      const registry = handleRegistry(this.state.registry, message, this.context());
      expect(registry.isOk()).toBe(true);
      if (registry.isOk()) this.state = { ...this.state, registry: registry.value.slice };
    }
    const alarm = handleAlarm(this.state.alarm, message, this.context());
    expect(alarm.isOk()).toBe(true);
    if (alarm.isOk()) {
      this.state = { ...this.state, alarm: alarm.value.slice };
      emitted.push(...alarm.value.out);
    }
    const sirens = handleSirens(this.state.sirens, message, this.context());
    expect(sirens.isOk()).toBe(true);
    if (sirens.isOk()) {
      this.state = { ...this.state, sirens: sirens.value.slice };
      emitted.push(...sirens.value.out);
    }
    // Messages the alarm emitted reach the sirens next, as on the dispatcher's queue.
    const queued = emitted.filter((item): item is Internal => item.kind === "sirenIntent");
    for (const intent of queued) emitted.push(...this.send(intent));
    this.out.push(...emitted);
    return emitted;
  }

  /** As if the window for "report now" after the start had passed (section 7). */
  forgoReportNow(): void {
    const sirens = new Map(
      [...this.state.sirens.sirens].map(([id, entry]) => [
        id,
        { ...entry, reportNowWanted: false },
      ]),
    );
    this.state = {
      ...this.state,
      sirens: { ...this.state.sirens, sirens, reportNowUntil: undefined },
    };
  }

  advanceTo(at: number): readonly (Internal | Effect)[] {
    this.at = mono(at);
    const due = [...this.state.alarm.timers, ...this.state.sirens.timers]
      .filter((t) => t.at <= this.at)
      .sort((a, b) => a.at - b.at);
    return due.flatMap((timer) => this.send({ kind: "timer", key: timer.key, at: timer.at }));
  }

  boot(snapshot: DurableSnapshot, id = 1): readonly (Internal | Effect)[] {
    return this.send({
      kind: "boot",
      snapshot,
      boot: { id: bootId(id), previousExit: "clean", cause: undefined },
    });
  }
}

/** A snapshot with the vectors' siren, its settings and a resume point. */
export function sirenSnapshot(
  settings: Partial<DurableSnapshot["sirenConfig"][number]> = {},
  resumePoint = 1024,
): DurableSnapshot {
  return {
    ...emptySnapshot(),
    devices: [
      {
        id: SIREN,
        address: SIREN_ADDRESS,
        role: 2,
        name: "hall",
        chipId: new Uint8Array(6),
        firmware: 0x010000,
        development: true,
        state: DeviceState.Contacted,
        addedMs: 0,
        removedMs: null,
      },
    ],
    sirenConfig: [
      {
        deviceId: SIREN,
        version: 3,
        wifiIntervalS: 30,
        loraCheckUnits: 20,
        maxSoundS: 900,
        sendRate: 5,
        commandRate: 5,
        siteChannel: 1,
        versionHistory: new Uint8Array(),
        ...settings,
      },
    ],
    sendCounters: [{ deviceId: SIREN, resumePoint }],
  };
}

export const wifiArrival: Arrival = { path: "wifi", link: WIFI };

export function loraArrival(at: Mono, snrQuarterDb = 20, gateway: DeviceId = GATEWAY): Arrival {
  return {
    path: "lora",
    gateway,
    link: linkId(90 + gateway),
    gatewayCounter: 1,
    gatewayLink: "network",
    gatewayMicros: at,
    endedAt: at,
    rssiDbm: -90,
    snrQuarterDb,
    dataRate: 5,
    siteChannel: 1,
  };
}

/** A siren report, accepted. */
export function report(
  fields: {
    state?: number;
    secondsLeft?: number;
    last?: number;
    version?: number;
    reason?: number;
  },
  arrival: Arrival = wifiArrival,
  counter = 5000,
  newest = true,
): Internal {
  return {
    kind: "accepted",
    device: SIREN,
    role: 2,
    counter,
    message: {
      type: 0x10,
      settingsVersion: fields.version ?? 3,
      state: fields.state ?? 0,
      soundingSecondsLeft: fields.secondsLeft ?? 0,
      lastCommandCounterLow: fields.last ?? 0,
      flags: {
        onMains: true,
        cellFitted: false,
        charging: false,
        coverOpen: false,
        wifiConnected: true,
      },
      cellBatteryCode: 0,
      temperatureCelsius: 20,
      reason: fields.reason ?? 0,
    },
    arrival,
    record: seq(999),
    newest,
  };
}

/** The sends and radio packets in some output. */
export function sendsIn(out: readonly (Internal | Effect)[]) {
  return out.filter((o): o is Extract<Effect, { kind: "send" }> => o.kind === "send");
}

export function radiosIn(out: readonly (Internal | Effect)[]) {
  return out.filter((o): o is Extract<Internal, { kind: "radioOut" }> => o.kind === "radioOut");
}

/** The decisions of one kind in some output. */
export function decisionsIn(out: readonly (Internal | Effect)[], kind: string) {
  return out.flatMap((o) =>
    o.kind === "auditRecord" && o.record.kind === "decision" && o.record.row.kind === kind
      ? [o.record.row]
      : [],
  );
}

export { cipher };

/**
 * Running the upkeep handler on its own (A8's tests): a view built from every module's empty
 * slice with the few others upkeep reads (people for clients and the app key, app for the hub's
 * facts, schedules for the zone, registry for devices, alarm and site for what holds a switch
 * back), a context with a chosen time, a seeded entropy source, a record cursor, and its timers
 * run as the dispatcher runs them: due ones first, to their owner only.
 */
import { expect } from "bun:test";
import { ok } from "neverthrow";
import { nodeSha256, Role } from "@hsn/protocol";
import type { Calendar } from "../../../src/core/model/calendar.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import { type DurableSnapshot, EMPTY_M2_SNAPSHOT } from "../../../src/core/model/events.ts";
import type { Context, CoreDeps } from "../../../src/core/model/handler.ts";
import {
  bootId,
  type ClientId,
  type DeviceId,
  deviceId,
  RECORDS_PER_BOOT,
  type Seq,
  seq,
} from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  ClientKind,
  type ClientRow,
  type DeviceRow,
  DeviceState,
} from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { type Mono, mono, type Now } from "../../../src/core/model/time.ts";
import { EMPTY_ALARM_SLICE } from "../../../src/core/alarm/state.ts";
import { EMPTY_APP_SLICE } from "../../../src/core/app/state.ts";
import { EMPTY_AUDIT_SLICE } from "../../../src/core/audit/state.ts";
import { EMPTY_CLOCK_SLICE } from "../../../src/core/clock/state.ts";
import { EMPTY_CONTROL_SLICE } from "../../../src/core/control/state.ts";
import { EMPTY_GATEWAYS_SLICE } from "../../../src/core/gateways/state.ts";
import { EMPTY_HEALTH_SLICE } from "../../../src/core/health/state.ts";
import { EMPTY_INTAKE_SLICE } from "../../../src/core/intake/state.ts";
import { EMPTY_LAYOUT_SLICE } from "../../../src/core/layout/state.ts";
import { EMPTY_LINKS_SLICE } from "../../../src/core/links/state.ts";
import { EMPTY_NOTIFY_SLICE } from "../../../src/core/notify/state.ts";
import { EMPTY_PEOPLE_SLICE } from "../../../src/core/people/state.ts";
import { EMPTY_REGISTRY_SLICE } from "../../../src/core/registry/state.ts";
import { EMPTY_SCHEDULES_SLICE } from "../../../src/core/schedules/state.ts";
import { EMPTY_SENSORS_SLICE } from "../../../src/core/sensors/state.ts";
import { EMPTY_SETUP_SLICE } from "../../../src/core/setup/state.ts";
import { EMPTY_SIRENS_SLICE } from "../../../src/core/sirens/state.ts";
import { EMPTY_SITE_SLICE } from "../../../src/core/site/state.ts";
import { EMPTY_SLOTS_SLICE } from "../../../src/core/slots/state.ts";
import { handleUpkeep } from "../../../src/core/upkeep/handle.ts";
import { EMPTY_UPKEEP_SLICE, type UpkeepSlice } from "../../../src/core/upkeep/state.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";

export const SECOND_US = 1_000_000;
export const MINUTE_US = 60 * SECOND_US;
export const HOUR_US = 60 * MINUTE_US;
/** 2026-11-14 00:00 UTC: the wall clock at t = 0. */
export const WALL0 = Date.UTC(2026, 10, 14);
export const ZONE = "UTC";

/**
 * A calendar over UTC only, enough for the daily backup: the first `at` at or after `fromMs` on
 * any day. The real one is A5's (over Temporal), tested with its own zones.
 */
export const UTC_CALENDAR: Calendar = {
  next(rule, _zone, fromMs) {
    const day = 86_400_000;
    const start = Math.floor(fromMs / day) * day;
    const at = (rule.at.hour * 60 + rule.at.minute) * 60_000;
    return start + at >= fromMs ? start + at : start + day + at;
  },
  local: () => ({
    date: { year: 2026, month: 11, day: 14 },
    time: { hour: 0, minute: 0 },
    offsetMinutes: 0,
  }),
};

export const DEPS: CoreDeps = {
  cipher: VectorCipher.fromVectors(),
  rules: DEFAULT_RULES,
  calendar: UTC_CALENDAR,
  sha256: nodeSha256,
};

export function emptyState(): HubState {
  return {
    clock: EMPTY_CLOCK_SLICE,
    registry: EMPTY_REGISTRY_SLICE,
    links: EMPTY_LINKS_SLICE,
    setup: EMPTY_SETUP_SLICE,
    control: EMPTY_CONTROL_SLICE,
    people: EMPTY_PEOPLE_SLICE,
    layout: EMPTY_LAYOUT_SLICE,
    app: EMPTY_APP_SLICE,
    schedules: EMPTY_SCHEDULES_SLICE,
    gateways: EMPTY_GATEWAYS_SLICE,
    intake: EMPTY_INTAKE_SLICE,
    alarm: EMPTY_ALARM_SLICE,
    site: EMPTY_SITE_SLICE,
    sensors: EMPTY_SENSORS_SLICE,
    slots: EMPTY_SLOTS_SLICE,
    sirens: EMPTY_SIRENS_SLICE,
    health: EMPTY_HEALTH_SLICE,
    notify: EMPTY_NOTIFY_SLICE,
    upkeep: EMPTY_UPKEEP_SLICE,
    audit: EMPTY_AUDIT_SLICE,
  };
}

export const SENSOR = deviceId(3);

export function sensorRow(id: DeviceId = SENSOR): DeviceRow {
  return {
    id,
    address: 0x1000 + id,
    role: Role.Sensor,
    name: `d${id}`,
    chipId: new Uint8Array(8),
    firmware: 0x010000,
    development: false,
    state: DeviceState.Paired,
    addedMs: WALL0,
    removedMs: null,
  };
}

export function clientRow(id: ClientId, kind: ClientKind, epoch: number | null): ClientRow {
  return {
    id,
    personId: null,
    staticKey: new Uint8Array(32).fill(id),
    kind,
    name: `c${id}`,
    linkedByClient: null,
    createdMs: WALL0,
    removedMs: null,
    lastSeq: 0,
    lastSeenMs: null,
    backupKeyEpoch: epoch,
  };
}

/** The hub's app key, its facts and the zone, as a running hub has them. */
export const APP_PUBLIC = new Uint8Array(32).fill(7);
export function runningView(): HubState {
  const state = emptyState();
  return {
    ...state,
    people: { ...state.people, appStaticPublic: APP_PUBLIC },
    app: {
      ...state.app,
      facts: {
        version: "1.0.0",
        addresses: ["192.168.1.20"],
        appsPort: 8444,
        consolePort: 8445,
        certificateSha256: new Uint8Array(32).fill(9),
      },
    },
    schedules: { ...state.schedules, zone: ZONE },
  };
}

export function snapshot(m2: Partial<DurableSnapshot["m2"]> = {}): DurableSnapshot {
  return {
    devices: [],
    sendCounters: [],
    hubKeys: undefined,
    site: undefined,
    sensorConfig: [],
    sirenConfig: [],
    gatewayConfig: [],
    countdowns: [],
    alarm: undefined,
    alarmTriggers: [],
    alarmSirens: [],
    previousBoot: undefined,
    deviceState: [],
    lossDaily: [],
    provisioningKeys: new Map(),
    m2: { ...EMPTY_M2_SNAPSHOT, ...m2 },
  };
}

/** A deterministic source of each step's 32 bytes. */
function entropyFor(step: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (step * 31 + i * 7 + 1) & 0xff;
  return bytes;
}

export interface Ran {
  readonly out: readonly (Internal | Effect)[];
  readonly effects: readonly Effect[];
  readonly messages: readonly Internal[];
}

const EFFECTS: ReadonlySet<string> = new Set([
  "write",
  "record",
  "cadence",
  "send",
  "close",
  "respond",
  "advertise",
  "appSend",
  "closeClient",
  "linkSecret",
  "fileJob",
  "historyRead",
  "closeConn",
  "hubStatusRead",
]);

function isEffect(item: Internal | Effect): item is Effect {
  return EFFECTS.has(item.kind);
}

/** The upkeep handler on its own, over a view that tests may change between steps. */
export class Runner {
  view: HubState;
  now: Now;
  #steps = 0;
  #record = 1;
  /** Every output since the start, for checks over the whole run (the key in no record). */
  readonly all: (Internal | Effect)[] = [];

  constructor(view: HubState = runningView(), trusted = true) {
    this.view = view;
    this.now = { mono: mono(0), wall: WALL0, wallTrusted: trusted };
  }

  get slice(): UpkeepSlice {
    return this.view.upkeep;
  }

  /** Moves the clocks on by `us` microseconds, without running anything. */
  advance(us: number): void {
    this.now = {
      mono: mono(this.now.mono + us),
      wall: this.now.wall + Math.floor(us / 1000),
      wallTrusted: this.now.wallTrusted,
    };
  }

  trust(trusted: boolean): void {
    this.now = { ...this.now, wallTrusted: trusted };
  }

  #ctx(): Context {
    const step = ++this.#steps;
    let n = this.#record;
    return {
      now: this.now,
      view: this.view,
      deps: DEPS,
      entropy: entropyCursor(entropyFor(step), "tick"),
      records: {
        take: () => {
          const taken: Seq = seq(RECORDS_PER_BOOT + n++);
          this.#record = n;
          return ok(taken);
        },
      },
      event: "tick",
    };
  }

  /** The entropy step `n` of this run carries, for checks of what was taken from it. */
  entropyOf(step: number): Uint8Array {
    return entropyFor(step);
  }

  get stepCount(): number {
    return this.#steps;
  }

  /** One message to upkeep, as one step's input (no timers run). */
  send(message: Internal): Ran {
    const ctx = this.#ctx();
    const handled = handleUpkeep(this.view.upkeep, message, ctx);
    expect(handled.isOk() ? undefined : handled.error.message).toBeUndefined();
    const value = handled.isOk() ? handled.value : { slice: this.view.upkeep, out: [] };
    this.view = { ...this.view, upkeep: value.slice };
    const out = value.out;
    this.all.push(...out);
    return {
      out,
      effects: out.filter(isEffect),
      messages: out.filter((item): item is Internal => !isEffect(item)),
    };
  }

  /** The earliest upkeep timer, or undefined. */
  nextTimer(): Mono | undefined {
    const ats = this.slice.timers.map((t) => t.at);
    return ats.length === 0 ? undefined : ats.reduce((a, b) => (b < a ? b : a));
  }

  /**
   * Moves on by `us` and runs every timer due on the way, each at its own time, as a `tick`
   * step would; returns everything they emitted.
   */
  run(us: number): Ran {
    const until = this.now.mono + us;
    const out: (Internal | Effect)[] = [];
    for (;;) {
      const due = this.slice.timers.filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      if (due.at > this.now.mono) this.advance(due.at - this.now.mono);
      out.push(...this.send({ kind: "timer", key: due.key, at: due.at }).out);
    }
    if (until > this.now.mono) this.advance(until - this.now.mono);
    return {
      out,
      effects: out.filter(isEffect),
      messages: out.filter((item): item is Internal => !isEffect(item)),
    };
  }

  boot(snap: DurableSnapshot = snapshot()): Ran {
    return this.send({
      kind: "boot",
      snapshot: snap,
      boot: { id: bootId(1), previousExit: "clean", cause: undefined },
    });
  }
}

/** A people decision's record, as `people` sends it to audit. */
export function peopleChange(
  kind: "person_added" | "client_removed" | "permissions_changed",
  n = 1,
): Internal {
  return {
    kind: "auditRecord",
    durability: "now",
    record: {
      kind: "decision",
      row: {
        seq: seq(RECORDS_PER_BOOT + 10_000 + n),
        atMs: WALL0,
        clockOk: true,
        kind,
        deviceId: null,
        causeSeq: null,
        value: n,
        detail: null,
      },
    },
  };
}

/** A registry hub event's record. */
export function deviceChange(code: string): Internal {
  return {
    kind: "auditRecord",
    durability: "now",
    record: {
      kind: "hubEvent",
      row: {
        seq: seq(RECORDS_PER_BOOT + 20_000),
        atMs: WALL0,
        clockOk: true,
        level: "info",
        origin: "core/registry",
        code,
        message: code,
        detail: null,
      },
    },
  };
}

export { ClientKind };

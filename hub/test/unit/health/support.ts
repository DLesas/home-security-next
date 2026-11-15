/**
 * Running the health and notify handlers on their own (A6's tests): a context with a chosen time,
 * a record cursor, and a view built from the empty state with the few slices these modules read
 * (registry for roles, alarm for arming, clock for stamps).
 */
import { nodeSha256 } from "@hsn/protocol";
import { expect } from "bun:test";
import { ok } from "neverthrow";
import {
  type Message,
  MessageType,
  Role,
  batteryCode,
  SENSOR_STATUS_FLAGS,
  SIREN_REPORT_FLAGS,
} from "@hsn/protocol";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";
import type { Context, CoreDeps, Handler } from "../../../src/core/model/handler.ts";
import {
  type DeviceId,
  deviceId,
  linkId,
  bootId,
  RECORDS_PER_BOOT,
  type Seq,
  seq,
} from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import type { ModuleName } from "../../../src/core/model/modules.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { ArmState, type DeviceRow, DeviceState } from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { type Mono, mono, type Now } from "../../../src/core/model/time.ts";
import { EMPTY_CLOCK_SLICE } from "../../../src/core/clock/state.ts";
import { EMPTY_REGISTRY_SLICE } from "../../../src/core/registry/state.ts";
import { EMPTY_LINKS_SLICE } from "../../../src/core/links/state.ts";
import { EMPTY_SETUP_SLICE } from "../../../src/core/setup/state.ts";
import { EMPTY_CONTROL_SLICE } from "../../../src/core/control/state.ts";
import { EMPTY_PEOPLE_SLICE } from "../../../src/core/people/state.ts";
import { EMPTY_LAYOUT_SLICE } from "../../../src/core/layout/state.ts";
import { EMPTY_APP_SLICE } from "../../../src/core/app/state.ts";
import { EMPTY_SCHEDULES_SLICE } from "../../../src/core/schedules/state.ts";
import { EMPTY_GATEWAYS_SLICE } from "../../../src/core/gateways/state.ts";
import { EMPTY_INTAKE_SLICE } from "../../../src/core/intake/state.ts";
import { EMPTY_ALARM_SLICE } from "../../../src/core/alarm/state.ts";
import { EMPTY_SITE_SLICE } from "../../../src/core/site/state.ts";
import { EMPTY_SENSORS_SLICE } from "../../../src/core/sensors/state.ts";
import { EMPTY_SLOTS_SLICE } from "../../../src/core/slots/state.ts";
import { EMPTY_SIRENS_SLICE } from "../../../src/core/sirens/state.ts";
import { EMPTY_HEALTH_SLICE } from "../../../src/core/health/state.ts";
import { EMPTY_NOTIFY_SLICE } from "../../../src/core/notify/state.ts";
import { EMPTY_UPKEEP_SLICE } from "../../../src/core/upkeep/state.ts";
import { EMPTY_AUDIT_SLICE } from "../../../src/core/audit/state.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { EMPTY_M2_SNAPSHOT } from "../../../src/core/model/events.ts";

export const DEPS: CoreDeps = {
  cipher: VectorCipher.fromVectors(),
  rules: DEFAULT_RULES,
  calendar: UNBUILT_CALENDAR,
  sha256: nodeSha256,
};

export const SECOND_US = 1_000_000;
export const MINUTE_US = 60 * SECOND_US;
export const WALL0 = Date.UTC(2026, 10, 14);

export const SENSOR = deviceId(3);
export const SENSOR2 = deviceId(4);
export const SIREN = deviceId(5);
export const GATEWAY = deviceId(6);

function deviceRow(id: DeviceId, role: number): DeviceRow {
  return {
    id,
    address: 0x1000 + id,
    role,
    name: `d${id}`,
    chipId: new Uint8Array(8),
    firmware: 0x010000,
    development: false,
    state: DeviceState.Paired,
    addedMs: WALL0,
    removedMs: null,
  };
}

export const DEVICE_ROWS: readonly DeviceRow[] = [
  deviceRow(SENSOR, Role.Sensor),
  deviceRow(SENSOR2, Role.Sensor),
  deviceRow(SIREN, Role.Siren),
  deviceRow(GATEWAY, Role.Gateway),
];

/**
 * The state before the boot event, slice by slice (as `step.ts`'s `emptyState`, without loading
 * every module's handler, which other engineers are editing).
 */
function emptyState(): HubState {
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

/** The empty state with the devices registered and the given sensors armed. */
export function viewWith(armed: readonly DeviceId[] = []): HubState {
  const state = emptyState();
  const sensors = new Map(
    [SENSOR, SENSOR2].map((sensor) => [
      sensor,
      {
        arm: armed.includes(sensor) ? ArmState.Armed : ArmState.Disarmed,
        armedBoot: null,
        armedMono: null,
        countdownS: 30,
        door: undefined,
        doorNow: undefined,
        doorWarned: false,
        changesWarned: undefined,
        batteryMv: undefined,
      },
    ]),
  );
  return {
    ...state,
    registry: { ...state.registry, devices: new Map(DEVICE_ROWS.map((row) => [row.id, row])) },
    alarm: { ...state.alarm, sensors },
  };
}

/** A clock: `t` microseconds after the start, the wall clock trusted. */
export function at(t: number): Now {
  return { mono: mono(t), wall: WALL0 + Math.floor(t / 1000), wallTrusted: true };
}

/** A snapshot of an empty database (as `test/world/world.ts` has it, without loading the core). */
function emptySnapshot(): DurableSnapshot {
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
    m2: EMPTY_M2_SNAPSHOT,
  };
}

/** A snapshot with these devices and whatever M2 rows a test gives. */
export function snapshotWith(m2: Partial<DurableSnapshot["m2"]> = {}): DurableSnapshot {
  const base = emptySnapshot();
  return { ...base, devices: [...DEVICE_ROWS], m2: { ...base.m2, ...m2 } };
}

/** Record `n` of boot 1. */
export function rec(n: number): Seq {
  return seq(RECORDS_PER_BOOT + n);
}

/** Record numbers for one test, counting up from boot 1. */
export function recordCounter(): { next: () => Seq } {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return rec(n);
    },
  };
}

/** One module's handler run over messages, its slice threaded, its output kept. */
export class Runner<K extends ModuleName> {
  slice: HubState[K];
  view: HubState;
  now: Now = at(0);
  readonly out: (Internal | Effect)[] = [];
  private readonly seqs = recordCounter();

  constructor(
    private readonly module: K,
    private readonly handler: Handler<K>,
    view: HubState,
    deps: CoreDeps = DEPS,
  ) {
    this.view = view;
    this.slice = view[module];
    this.deps = deps;
  }

  private readonly deps: CoreDeps;

  /** Handles one message at `now`; returns what it emitted. */
  run(message: Internal): readonly (Internal | Effect)[] {
    const view = { ...this.view, [this.module]: this.slice };
    const ctx: Context = {
      now: this.now,
      view,
      deps: this.deps,
      entropy: entropyCursor(new Uint8Array(32), "tick"),
      records: { take: () => ok(this.seqs.next()) },
      event: "tick",
    };
    const result = this.handler(this.slice, message, ctx);
    if (result.isErr()) {
      expect(result.error.message).toBe("no fault");
      return [];
    }
    this.slice = result.value.slice;
    this.out.push(...result.value.out);
    return result.value.out;
  }

  /** Moves the clock to `t` microseconds after the start. */
  at(t: number): this {
    this.now = at(t);
    return this;
  }
}

function flags<const N extends readonly string[]>(
  names: N,
  on: readonly N[number][],
): Record<N[number], boolean> {
  return Object.fromEntries(names.map((name) => [name, on.includes(name)])) as Record<
    N[number],
    boolean
  >;
}

const SENSOR_FLAGS = SENSOR_STATUS_FLAGS;

/** A sensor status packet's message: a heartbeat unless `type` says otherwise. */
export function sensorMessage(
  millivolts: number,
  options: {
    readonly type?: "heartbeat" | "door" | "cover" | "button";
    readonly coverOpen?: boolean;
    readonly button?: number;
    readonly ageS?: number;
  } = {},
): Message {
  const status = {
    settingsVersion: 1,
    flags: flags(SENSOR_FLAGS, options.coverOpen === true ? ["coverOpen"] : []),
    batteryCode: batteryCode(millivolts),
    temperatureCelsius: 20,
    doorChangeCount: 0,
    eventAgeSeconds: options.ageS ?? 0,
  };
  switch (options.type ?? "heartbeat") {
    case "heartbeat":
      return { type: MessageType.Heartbeat, ...status };
    case "door":
      return { type: MessageType.DoorChanged, ...status };
    case "cover":
      return { type: MessageType.CoverChanged, ...status };
    case "button":
      return { type: MessageType.Button, ...status, buttonAction: options.button ?? 1 };
  }
}

/** A siren report's message. */
export function sirenMessage(
  millivolts: number,
  options: { readonly onMains?: boolean; readonly cellFitted?: boolean } = {},
): Message {
  const on: (typeof SIREN_REPORT_FLAGS)[number][] = [];
  if (options.onMains === true) on.push("onMains");
  if (options.cellFitted !== false) on.push("cellFitted");
  return {
    type: MessageType.SirenReport,
    settingsVersion: 1,
    state: 0,
    soundingSecondsLeft: 0,
    lastCommandCounterLow: 0,
    flags: flags(SIREN_REPORT_FLAGS, on),
    cellBatteryCode: batteryCode(millivolts),
    temperatureCelsius: 20,
    reason: 0,
  };
}

let counter = 100;

/** An accepted packet from `device`, the newest unless said otherwise. */
export function accepted(
  device: DeviceId,
  message: Message,
  options: { readonly newest?: boolean; readonly record?: Seq } = {},
): Internal {
  counter += 1;
  return {
    kind: "accepted",
    device,
    role: message.type === MessageType.SirenReport ? Role.Siren : Role.Sensor,
    counter,
    message,
    arrival: { path: "wifi", link: linkId(1) },
    record: options.record ?? rec(900_000 + counter),
    newest: options.newest ?? true,
  };
}

/** The boot event with this snapshot. */
export function boot(snapshot: DurableSnapshot): Internal {
  return {
    kind: "boot",
    snapshot,
    boot: { id: bootId(1), previousExit: "clean", cause: undefined },
  };
}

/** The decisions among what a handler emitted. */
export function decisions(out: readonly (Internal | Effect)[]) {
  return out.flatMap((item) =>
    item.kind === "auditRecord" && item.record.kind === "decision"
      ? [{ durability: item.durability, row: item.record.row }]
      : [],
  );
}

/** The writes among what a handler emitted. */
export function writes(out: readonly (Internal | Effect)[]) {
  return out.flatMap((item) => (item.kind === "write" ? [item] : []));
}

export type { Mono };

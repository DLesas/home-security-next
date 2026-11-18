/**
 * Running the firmware handler on its own (U7's tests), as upkeep's tests run theirs: a view made
 * by booting every other real module over a small site (six sensors, two sirens, two gateways),
 * which the tests then change where a condition needs it (a sensor heard, armed, a battery, a
 * countdown, a gateway's session); a context with a chosen time, a seeded entropy and a record
 * cursor; and firmware's timers run as the dispatcher runs them, due ones first, to it only.
 * Device packets arrive as `intake` gives them (`accepted`), with the sensor's `heardAt` moved as
 * intake would move it.
 */
import { expect } from "bun:test";
import { ok } from "neverthrow";
import {
  type Message,
  type MessageOf,
  MessageType,
  nodeSha256,
  Role,
  type StartedImage,
  UpdateHolding,
} from "@hsn/protocol";
import type { AppOpV2 } from "@hsn/protocol/app";
import type { Effect } from "../../../src/core/model/effects.ts";
import {
  type DurableSnapshot,
  EMPTY_M2_SNAPSHOT,
  EMPTY_M3M4_SNAPSHOT,
  type FileOutcome,
  type M3M4Snapshot,
} from "../../../src/core/model/events.ts";
import type { Context, CoreDeps, Handler } from "../../../src/core/model/handler.ts";
import {
  bootId,
  clientId,
  connId,
  type DeviceId,
  deviceId,
  type ImageId,
  imageId,
  type JobId,
  type LinkId,
  linkId,
  personId,
  RECORDS_PER_BOOT,
  requestId,
  type Seq,
  seq,
} from "../../../src/core/model/ids.ts";
import type {
  Actor,
  AnswerTo,
  Arrival,
  Internal,
  OpOutcome,
} from "../../../src/core/model/messages.ts";
import { DEFAULT_RULES, type HubRules } from "../../../src/core/model/rules.ts";
import {
  ArmState,
  type DeviceRow,
  DeviceState,
  type DeviceUpdateRow,
  type FirmwareImageRow,
  ImageKind,
  MoveStage,
  type RolloutRow,
  type SensorConfigRow,
} from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import type { StoreOp } from "../../../src/core/model/store.ts";
import { type Mono, mono, type Now } from "../../../src/core/model/time.ts";
import { makeCore, MODULES, type Modules } from "../../../src/core/step.ts";
import { handleFirmware } from "../../../src/core/firmware/handle.ts";
import { EMPTY_FIRMWARE_SLICE, type FirmwareSlice } from "../../../src/core/firmware/state.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";

export const SECOND_US = 1_000_000;
export const MINUTE_US = 60 * SECOND_US;
export const HOUR_US = 60 * MINUTE_US;
export const DAY_US = 24 * HOUR_US;
/** 2026-11-18 00:00 UTC: the wall clock at t = 0. */
export const WALL0 = Date.UTC(2026, 10, 18);

const UNUSED_CALENDAR = {
  next: () => undefined,
  local: () => ({
    date: { year: 2026, month: 11, day: 18 },
    time: { hour: 0, minute: 0 },
    offsetMinutes: 0,
  }),
};

export function depsWith(rules: HubRules = DEFAULT_RULES): CoreDeps {
  return {
    cipher: VectorCipher.fromVectors(),
    rules,
    calendar: UNUSED_CALENDAR,
    sha256: nodeSha256,
    deepFreeze: true,
    checkDeadlines: true,
  };
}

// ----- The site -----

export const SENSORS = [10, 11, 12, 13, 14, 15].map(deviceId);
export const SIRENS = [20, 21].map(deviceId);
export const GATEWAYS = [30, 31].map(deviceId);
export const [S1 = deviceId(10), S2 = deviceId(11), S3 = deviceId(12)] = SENSORS;
export const [R1 = deviceId(20), R2 = deviceId(21)] = SIRENS;
export const [G1 = deviceId(30), G2 = deviceId(31)] = GATEWAYS;
export const ALL = [...SENSORS, ...SIRENS, ...GATEWAYS];
/** A sensor's heartbeat interval at the settings below: 12 units of 15 s. */
export const INTERVAL_MS = 180_000;

/** The running firmware, 1.0.0, and the image's, 1.1.0. */
export const OLD_VERSION = 0x010000;
export const NEW_VERSION = 0x010100;

function deviceRow(
  id: DeviceId,
  role: number,
  state: DeviceState = DeviceState.Contacted,
): DeviceRow {
  return {
    id,
    address: 0x0100_0000 + id,
    role,
    name: `d${id}`,
    chipId: new Uint8Array(6),
    firmware: OLD_VERSION,
    development: false,
    state,
    addedMs: WALL0,
    removedMs: null,
  };
}

function sensorConfig(id: DeviceId): SensorConfigRow {
  return {
    deviceId: id,
    arm: ArmState.Disarmed,
    armedBoot: null,
    armedMono: null,
    countdownS: 30,
    heartbeatUnits: 12,
    linkCheckEvery: 5,
    sendRate: 5,
    replyRate: 5,
    replyRateFixed: false,
    correctionUnits: 0,
    correctionFixed: false,
    nextChannel: 0xff,
    nextRate: 0xff,
    moveConfirmed: 0,
    moveFollowed: 0,
    version: 1,
    versionHistory: new Uint8Array(),
  };
}

/**
 * Two people with user management on (D13): Anna with *manage system*, Ben without it.
 */
const PEOPLE: DurableSnapshot["m2"] = {
  ...EMPTY_M2_SNAPSHOT,
  peopleSettings: { userManagement: true },
  people: [
    { id: personId(1), name: "Anna", createdMs: WALL0, removedMs: null, revision: 0 },
    { id: personId(2), name: "Ben", createdMs: WALL0, removedMs: null, revision: 0 },
  ],
  personRoles: [
    { personId: personId(1), manageUsers: true, manageSystem: true, revision: 0 },
    { personId: personId(2), manageUsers: false, manageSystem: false, revision: 0 },
  ],
};
export const ANNA: Actor = {
  kind: "person",
  person: personId(1),
  client: clientId(2),
  name: "Anna (client 2)",
};
export const BEN: Actor = {
  kind: "person",
  person: personId(2),
  client: clientId(3),
  name: "Ben (client 3)",
};

/** The site's snapshot: every device paired and contacted, the site with Wi-Fi details. */
export function siteSnapshot(m3m4: Partial<M3M4Snapshot> = {}): DurableSnapshot {
  return {
    devices: [
      ...SENSORS.map((id) => deviceRow(id, Role.Sensor)),
      ...SIRENS.map((id) => deviceRow(id, Role.Siren)),
      ...GATEWAYS.map((id) => deviceRow(id, Role.Gateway)),
    ],
    sendCounters: [...SIRENS, ...GATEWAYS].map((id) => ({ deviceId: id, resumePoint: 1024 })),
    hubKeys: undefined,
    site: {
      channel: 1,
      rateMask: 1 << 5,
      moveId: 0,
      moveStage: MoveStage.Done,
      moveChannel: null,
      moveRate: null,
      moveActor: null,
      moveRequestedMs: null,
      moveForced: false,
      moveSwitchedBoot: null,
      moveSwitchedMono: null,
      wifiName: new TextEncoder().encode("home"),
      wifiPassword: new TextEncoder().encode("secret"),
      countdownDefaultS: 30,
      autoStopS: 300,
      replyPowerDbm: 22,
      sirenPowerDbm: 22,
      retentionRoutineDays: 30,
      retentionEventDays: 365,
    },
    sensorConfig: SENSORS.map(sensorConfig),
    sirenConfig: SIRENS.map((id) => ({
      deviceId: id,
      version: 1,
      wifiIntervalS: 30,
      loraCheckUnits: 20,
      maxSoundS: 300,
      sendRate: 5,
      commandRate: 5,
      siteChannel: 1,
      versionHistory: new Uint8Array(),
    })),
    gatewayConfig: GATEWAYS.map((id) => ({
      deviceId: id,
      version: 1,
      statusIntervalS: 30,
      interferenceDb: 10,
      interferenceS: 30,
      defaultPowerDbm: 22,
      sirenPowerDbm: 22,
    })),
    countdowns: [],
    alarm: undefined,
    alarmTriggers: [],
    alarmSirens: [],
    previousBoot: undefined,
    deviceState: [],
    lossDaily: [],
    provisioningKeys: new Map(),
    m2: PEOPLE,
    m3m4: { ...EMPTY_M3M4_SNAPSHOT, ...m3m4 },
  };
}

const ignoreFirmware: Handler<"firmware"> = (slice) => ok({ slice, out: [] });

/** Every other real module booted over the snapshot; firmware's slice left empty for the runner. */
export function bootedView(snapshot: DurableSnapshot, rules: HubRules = DEFAULT_RULES): HubState {
  const modules: Modules = {
    ...MODULES,
    firmware: { ...MODULES.firmware, handle: ignoreFirmware, deadlines: () => [] },
  };
  const core = makeCore(modules);
  const stepped = core.step(
    core.emptyState(),
    {
      now: { mono: mono(0), wall: WALL0, wallTrusted: true },
      entropy: new Uint8Array(32),
      event: {
        kind: "boot",
        snapshot,
        boot: { id: bootId(1), previousExit: "clean", cause: undefined },
      },
    },
    { ...depsWith(rules), deepFreeze: false },
  );
  expect(stepped.isOk() ? "" : stepped.error.message).toBe("");
  return { ...stepped._unsafeUnwrap().state, firmware: EMPTY_FIRMWARE_SLICE };
}

// ----- An image -----

export function imageRow(
  id = 1,
  version = NEW_VERSION,
  overrides: Partial<FirmwareImageRow> = {},
): FirmwareImageRow {
  const sha256 = new Uint8Array(32).fill(0x40 + id);
  return {
    id: imageId(id),
    imageId: sha256.slice(0, 8),
    sha256,
    version,
    kind: ImageKind.Official,
    roles: 0b1110,
    bytes: 1_500_000,
    header: new Uint8Array(128).fill(id),
    manifest: "{}",
    file: `${id}.bin`,
    addedMs: WALL0,
    addedBy: "dimitri",
    removedMs: null,
    ...overrides,
  };
}

/** The file a device pulls for an image: its bytes and the 128-byte header. */
export function fileBytes(row: FirmwareImageRow): number {
  return row.bytes + 128;
}

// ----- The runner -----

export interface Ran {
  readonly out: readonly (Internal | Effect)[];
  readonly effects: readonly Effect[];
  readonly messages: readonly Internal[];
}

const EFFECT_KINDS: ReadonlySet<string> = new Set([
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
  "relayConnect",
  "relayRoster",
  "pushSend",
  "pushKey",
  "transferGrant",
  "transferRevoke",
  "bluetoothSession",
]);

function isEffect(item: Internal | Effect): item is Effect {
  return EFFECT_KINDS.has(item.kind);
}

/** A deterministic source of each step's 32 bytes. */
export function entropyFor(step: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (step * 31 + i * 7 + 1) & 0xff;
  return bytes;
}

export const COMPUTER: Actor = { kind: "computer", name: "dimitri" };
export const CONSOLE: Actor = { kind: "console", client: clientId(1) };

export class Runner {
  view: HubState;
  now: Now;
  readonly deps: CoreDeps;
  #steps = 0;
  #record = 1;
  #counter = 100;
  #request = 1;
  /** Every output since the start. */
  readonly all: (Internal | Effect)[] = [];

  constructor(view: HubState, rules: HubRules = DEFAULT_RULES) {
    this.view = view;
    this.deps = depsWith(rules);
    this.now = { mono: mono(0), wall: WALL0, wallTrusted: true };
  }

  get slice(): FirmwareSlice {
    return this.view.firmware;
  }

  get rules(): HubRules {
    return this.deps.rules;
  }

  /** Moves the clocks on by `us` microseconds, without running anything. */
  advance(us: number): void {
    this.now = {
      mono: mono(this.now.mono + us),
      wall: this.now.wall + Math.floor(us / 1000),
      wallTrusted: this.now.wallTrusted,
    };
  }

  get stepCount(): number {
    return this.#steps;
  }

  #ctx(): Context {
    const step = ++this.#steps;
    let n = this.#record;
    return {
      now: this.now,
      view: this.view,
      deps: this.deps,
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

  /** One message to firmware, as one step's input. */
  send(message: Internal): Ran {
    const handled = handleFirmware(this.view.firmware, message, this.#ctx());
    expect(handled.isOk() ? undefined : handled.error.message).toBeUndefined();
    const value = handled.isOk() ? handled.value : { slice: this.view.firmware, out: [] };
    this.view = { ...this.view, firmware: value.slice };
    this.all.push(...value.out);
    return {
      out: value.out,
      effects: value.out.filter(isEffect),
      messages: value.out.filter((item): item is Internal => !isEffect(item)),
    };
  }

  /** The earliest firmware timer, or undefined. */
  nextTimer(): Mono | undefined {
    const ats = this.slice.timers.map((t) => t.at);
    return ats.length === 0 ? undefined : ats.reduce((a, b) => (b < a ? b : a));
  }

  /** Moves on by `us`, running every timer due on the way at its own time. */
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

  boot(snapshot: DurableSnapshot): Ran {
    return this.send({
      kind: "boot",
      snapshot,
      boot: { id: bootId(1), previousExit: "clean", cause: undefined },
    });
  }

  // ----- The view, changed as the other modules would change it -----

  /** Intake accepted a packet from the device now. */
  hear(device: DeviceId): void {
    const known = this.view.intake.devices.get(device);
    if (known === undefined) return;
    const devices = new Map(this.view.intake.devices);
    devices.set(device, { ...known, heardAt: this.now.mono, heardMs: this.now.wall });
    this.view = { ...this.view, intake: { ...this.view.intake, devices } };
  }

  /** Every sensor heard now. */
  hearAll(): void {
    for (const s of SENSORS) this.hear(s);
  }

  arm(sensor: DeviceId, arm: ArmState = ArmState.Armed): void {
    const entry = this.view.alarm.sensors.get(sensor);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const sensors = new Map(this.view.alarm.sensors);
    sensors.set(sensor, { ...entry, arm });
    this.view = { ...this.view, alarm: { ...this.view.alarm, sensors } };
  }

  /** A countdown starts (or, with `false`, every one ends). */
  countdown(sensor: DeviceId | false): void {
    const countdowns = new Map(this.view.alarm.countdowns);
    if (sensor === false) countdowns.clear();
    else {
      countdowns.set(sensor, {
        openedAt: this.now.mono,
        deadline: mono(this.now.mono + 30 * SECOND_US),
        newestCounter: 1,
        replyGateway: undefined,
        replyRate: 5,
        cause: seq(1),
        restored: false,
      });
    }
    this.view = { ...this.view, alarm: { ...this.view.alarm, countdowns } };
  }

  /** An alarm runs (or, with `false`, ends). */
  alarm(on: boolean): void {
    this.view = {
      ...this.view,
      alarm: {
        ...this.view.alarm,
        alarm: on
          ? {
              startedAt: this.now.mono,
              cause: seq(1),
              triggers: new Map(),
              sirens: new Map(),
              quietEnd: mono(this.now.mono + 300 * SECOND_US),
            }
          : undefined,
      },
    };
  }

  /** A site move at this stage (D115). */
  siteMove(stage: MoveStage): void {
    this.view = {
      ...this.view,
      site: { ...this.view.site, row: { ...this.view.site.row, moveId: 1, moveStage: stage } },
    };
  }

  /** A battery reading, as `health` keeps it. */
  battery(device: DeviceId, millivolts: number): void {
    const devices = new Map(this.view.health.devices);
    const before = devices.get(device);
    devices.set(device, {
      cell: { millivolts, onMains: false },
      batteryLow: false,
      tamperOpen: false,
      silent: false,
      poorLink: false,
      openedAtMs: undefined,
      coverShown: undefined,
      ...(before === undefined ? {} : { ...before, cell: { millivolts, onMains: false } }),
    });
    this.view = { ...this.view, health: { ...this.view.health, devices } };
  }

  /** A gateway's session proven on `link` (or, with undefined, gone). */
  gatewaySession(gateway: DeviceId, link: LinkId | undefined): void {
    const entry = this.view.gateways.gateways.get(gateway);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const gateways = new Map(this.view.gateways.gateways);
    gateways.set(gateway, {
      ...entry,
      offline: false,
      live:
        link === undefined
          ? undefined
          : {
              link,
              linkKind: "network",
              gatewayRandom: new Uint8Array(8),
              hubRandom: new Uint8Array(8),
              binding: new Uint8Array(16),
              lastReceived: 1,
              openedAt: this.now.mono,
              clock: { samples: [], offset: undefined },
            },
    });
    this.view = { ...this.view, gateways: { ...this.view.gateways, gateways } };
  }

  /** A hub version switch under way (upkeep), or not. */
  hubSwitching(on: boolean): void {
    this.view = {
      ...this.view,
      upkeep: {
        ...this.view.upkeep,
        update: { ...this.view.upkeep.update, switchingMs: on ? this.now.wall : null },
      },
    };
  }

  // ----- Messages -----

  #accepted(device: DeviceId, message: Message, arrival: Arrival, extra: object = {}): Internal {
    this.hear(device);
    const role = this.view.registry.devices.get(device)?.role ?? 0;
    return {
      kind: "accepted",
      device,
      role,
      counter: this.#counter++,
      message,
      arrival,
      record: seq(RECORDS_PER_BOOT + 50_000 + this.#counter),
      newest: true,
      ...extra,
    };
  }

  /** The record number the next accepted packet will carry. */
  nextRecord(): Seq {
    return seq(RECORDS_PER_BOOT + 50_000 + this.#counter + 1);
  }

  query(
    device: DeviceId,
    fields: {
      readonly image?: Uint8Array;
      readonly held?: number;
      readonly bytes?: number;
      readonly wifi?: boolean;
      readonly power?: boolean;
    } = {},
    arrival: Arrival = LORA,
  ): Ran {
    const message: MessageOf<typeof MessageType.UpdateQuery> = {
      type: MessageType.UpdateQuery,
      imageId: fields.image ?? new Uint8Array(8),
      held: fields.held ?? UpdateHolding.Nothing,
      bytesHeld: fields.bytes ?? 0,
      batteryCode: 200,
      flags: { hasWifiDetails: fields.wifi ?? true, externalPower: fields.power ?? false },
    };
    return this.send(this.#accepted(device, message, arrival));
  }

  status(
    device: DeviceId,
    image: Uint8Array,
    stage: number,
    reason = 0,
    bytes = 0,
    arrival: Arrival = LORA,
  ): Ran {
    const message: MessageOf<typeof MessageType.UpdateStatus> = {
      type: MessageType.UpdateStatus,
      imageId: image,
      stage,
      reason,
      bytesWritten: bytes,
    };
    return this.send(this.#accepted(device, message, arrival));
  }

  started(
    device: DeviceId,
    version: number,
    image: StartedImage | undefined,
    fields: { readonly resetCause?: number; readonly fatal?: number } = {},
    arrival: Arrival = LORA,
  ): Ran {
    const message: MessageOf<typeof MessageType.Started> = {
      type: MessageType.Started,
      role: this.view.registry.devices.get(device)?.role ?? 0,
      firmwareVersion: {
        major: Math.floor(version / 65_536),
        minor: Math.floor(version / 256) % 256,
        patch: version % 256,
      },
      resetCause: fields.resetCause ?? 3,
      lastFatalError: fields.fatal ?? 0,
      settingsVersion: 1,
    };
    return this.send(
      this.#accepted(device, message, arrival, image === undefined ? {} : { startedImage: image }),
    );
  }

  /** A heartbeat (or any packet the module only notes) on `arrival`. */
  heartbeat(device: DeviceId, arrival: Arrival = LORA): Ran {
    const message: Message = {
      type: MessageType.Heartbeat,
      settingsVersion: 1,
      flags: {
        doorOpen: false,
        coverOpen: false,
        usbPower: false,
        charging: false,
        replyWanted: false,
        localAlarmSounded: false,
        buzzing: false,
        listeningAtSendRate: false,
      },
      batteryCode: 200,
      temperatureCelsius: 20,
      doorChangeCount: 0,
      eventAgeSeconds: 0,
    };
    return this.send(this.#accepted(device, message, arrival));
  }

  /** An operation, from `actor`, answered to an app's connection or `hsn`. */
  op(
    op: AppOpV2,
    actor: Actor = COMPUTER,
    to: "control" | "app" = "control",
  ): Ran & { answer: OpOutcome | undefined } {
    const id = this.#request++;
    const answerTo: AnswerTo =
      to === "control"
        ? { kind: "control", request: requestId(id), conn: connId(7) }
        : { kind: "app", conn: connId(8), client: clientId(2), id, seq: id };
    const ran = this.send({
      kind: "v2OpRequest",
      owner: "firmware",
      op,
      actor,
      answerTo,
      record: seq(RECORDS_PER_BOOT + 90_000 + id),
    });
    const answer = ran.messages.find((m) => m.kind === "opAnswer");
    return { ...ran, answer: answer?.kind === "opAnswer" ? answer.outcome : undefined };
  }

  fileReady(job: JobId, outcome: FileOutcome): Ran {
    return this.send({ kind: "fileReady", job, outcome });
  }

  /** A decision another module made, as audit's message carries it. */
  decision(kind: string, device: DeviceId): Ran {
    return this.send({
      kind: "auditRecord",
      durability: "now",
      record: {
        kind: "decision",
        row: {
          seq: seq(RECORDS_PER_BOOT + 70_000),
          atMs: this.now.wall,
          clockOk: true,
          kind: kind as never,
          deviceId: device,
          causeSeq: null,
          value: null,
          detail: null,
        },
      },
    });
  }
}

// ----- Arrivals -----

export const LORA: Arrival = {
  path: "lora",
  gateway: deviceId(30),
  link: linkId(900),
  gatewayCounter: 1,
  gatewayMicros: 0,
  endedAt: mono(0),
  rssiDbm: -80,
  snrQuarterDb: 20,
  dataRate: 5,
  siteChannel: 1,
  gatewayLink: "network",
};

export function wifi(link: number): Arrival {
  return { path: "wifi", link: linkId(link) };
}

// ----- Reading what came out -----

/** The Update offers in an output, by device. */
export function offers(ran: Ran): readonly Extract<Internal, { readonly kind: "updateOffer" }>[] {
  return ran.messages.filter(
    (m): m is Extract<Internal, { readonly kind: "updateOffer" }> => m.kind === "updateOffer",
  );
}

export function offerTo(ran: Ran, device: DeviceId) {
  return offers(ran).find((o) => o.device === device);
}

/** The decisions recorded in an output, as kind and device. */
export function decisions(
  ran: Ran,
): readonly { kind: string; device: number | null; value: number | null; durability: string }[] {
  return ran.messages.flatMap((m) =>
    m.kind === "auditRecord" && m.record.kind === "decision"
      ? [
          {
            kind: m.record.row.kind,
            device: m.record.row.deviceId,
            value: m.record.row.value,
            durability: m.durability,
          },
        ]
      : [],
  );
}

export function hubEvents(
  ran: Ran,
): readonly { code: string; detail: string | null; durability: string }[] {
  return ran.messages.flatMap((m) =>
    m.kind === "auditRecord" && m.record.kind === "hubEvent"
      ? [{ code: m.record.row.code, detail: m.record.row.detail, durability: m.durability }]
      : [],
  );
}

/** The writes of an output, as table, durability and row. */
export function writes(ran: { readonly effects: readonly Effect[] }): readonly {
  table: string;
  durability: string;
  op: StoreOp;
}[] {
  return ran.effects.flatMap((e) =>
    e.kind === "write" ? [{ table: e.op.table, durability: e.durability, op: e.op }] : [],
  );
}

export function updateRows(ran: {
  readonly effects: readonly Effect[];
}): readonly { durability: string; row: DeviceUpdateRow }[] {
  return ran.effects.flatMap((e) =>
    e.kind === "write" && e.op.table === "device_updates" && e.op.op === "upsert"
      ? [{ durability: e.durability, row: e.op.row }]
      : [],
  );
}

export function rolloutRows(ran: { readonly effects: readonly Effect[] }): readonly RolloutRow[] {
  return ran.effects.flatMap((e) =>
    e.kind === "write" && e.op.table === "rollouts" && e.op.op === "upsert" ? [e.op.row] : [],
  );
}

/** The device's update row as the slice holds it. */
export function rowOf(runner: Runner, device: DeviceId): DeviceUpdateRow | undefined {
  return runner.slice.updates.get(device)?.row;
}

/** The open rollout's row. */
export function openRow(runner: Runner): RolloutRow | undefined {
  return [...runner.slice.rollouts.values()].find((r) => r.row.endedMs === null)?.row;
}

export function okBody(answer: OpOutcome | undefined): unknown {
  expect(answer?.ok).toBe(true);
  return answer?.ok === true ? answer.body : undefined;
}

export function refusal(answer: OpOutcome | undefined): unknown {
  expect(answer?.ok).toBe(false);
  return answer?.ok === false ? answer.error : undefined;
}

export { DEFAULT_RULES, imageId, type ImageId };

// ----- A rollout, step by step -----

/** A runner over the site with one image (1.1.0) in the store, booted, every sensor heard. */
export function siteRunner(
  rules: HubRules = DEFAULT_RULES,
  m3m4: Partial<M3M4Snapshot> = {},
): { readonly runner: Runner; readonly image: FirmwareImageRow } {
  const image = imageRow();
  const snapshot = siteSnapshot({ firmwareImages: [image], ...m3m4 });
  const runner = new Runner(bootedView(snapshot, rules), rules);
  runner.boot(snapshot);
  runner.hearAll();
  return { runner, image };
}

/** Each siren on its Wi-Fi link (600 + n) and each gateway's session on its link (700 + n). */
export function linkAll(runner: Runner): void {
  SIRENS.forEach((siren, i) => runner.heartbeat(siren, wifi(600 + i)));
  GATEWAYS.forEach((gateway, i) => {
    runner.gatewaySession(gateway, linkId(700 + i));
    runner.send({ kind: "gatewayUp", gateway, link: linkId(700 + i) });
  });
}

/** A sensor from its first query to confirmed: by Wi-Fi on link `link`. */
export function sensorThrough(
  runner: Runner,
  sensor: DeviceId,
  image: FirmwareImageRow,
  link: number,
): void {
  runner.query(sensor);
  runner.query(sensor, {}, wifi(link));
  runner.status(sensor, image.imageId, 2 /* verified */);
  runner.started(sensor, NEW_VERSION, {
    flags: { onTrial: true, rolledBack: false },
    failedVersion: { major: 0, minor: 0, patch: 0 },
  });
  runner.status(sensor, image.imageId, 5 /* confirmed */);
}

/** A siren or gateway, already offered on its link, from verified to confirmed. */
export function linkedThrough(
  runner: Runner,
  device: DeviceId,
  image: FirmwareImageRow,
  arrival: Arrival,
): void {
  runner.status(device, image.imageId, 2, 0, fileBytes(image), arrival);
  runner.started(
    device,
    NEW_VERSION,
    {
      flags: { onTrial: false, rolledBack: false },
      failedVersion: { major: 0, minor: 0, patch: 0 },
    },
    {},
    arrival,
  );
}

/** The started image flags of a trial, and of a rollback of `failed`. */
export const ON_TRIAL: StartedImage = {
  flags: { onTrial: true, rolledBack: false },
  failedVersion: { major: 0, minor: 0, patch: 0 },
};
export const CONFIRMED_IMAGE: StartedImage = {
  flags: { onTrial: false, rolledBack: false },
  failedVersion: { major: 0, minor: 0, patch: 0 },
};
export function rolledBack(failed: number): StartedImage {
  return {
    flags: { onTrial: false, rolledBack: true },
    failedVersion: {
      major: Math.floor(failed / 65_536),
      minor: Math.floor(failed / 256) % 256,
      patch: failed % 256,
    },
  };
}

/** Every effect of a kind in an output. */
export function effectsOf<K extends Effect["kind"]>(
  ran: { readonly effects: readonly Effect[] },
  kind: K,
): readonly Extract<Effect, { kind: K }>[] {
  return ran.effects.filter((e): e is Extract<Effect, { kind: K }> => e.kind === kind);
}

export { UpdateHolding };

/** The answer an output carries, if any (unknown: version 2's errors are wider than `OpOutcome`'s). */
export function answerOf(ran: Ran): unknown {
  const answer = ran.messages.find((m) => m.kind === "opAnswer");
  return answer?.kind === "opAnswer" ? answer.outcome : undefined;
}

/** The `deviceUpdate` bodies an output sends to `app`, for one device or all. */
export function updateEvents(
  ran: Ran,
  device?: DeviceId,
): readonly Extract<Internal, { readonly kind: "deviceUpdateEvent" }>["body"][] {
  return ran.messages.flatMap((m) =>
    m.kind === "deviceUpdateEvent" && (device === undefined || m.body.device === device)
      ? [m.body]
      : [],
  );
}

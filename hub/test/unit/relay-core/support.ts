/**
 * Running the relay handler on its own (B5's tests), as firmware's tests run theirs: a view made
 * by booting every other real module over a small household, which the tests then change where a
 * condition needs it (a sensor armed); a context with a chosen time and a record cursor; relay's
 * timers run as the dispatcher runs them, due ones first, to it only. Notifications arrive as
 * `notify` raises them (`notificationRaised`, with the clients it let through), each with the
 * `notifications` row it writes, so a restart can be given the rows a power cut leaves.
 *
 * The household, with user management on (D13):
 *
 * | Person | Manage system | S1 | S2 | S3 | Clients |
 * | --- | --- | --- | --- | --- | --- |
 * | Anna (1) | yes | manage | manage | manage | 11 phone, 12 browser |
 * | Ben (2) | no | view | manage | — | 21 phone, 22 phone |
 *
 * and the console, client 1.
 */
import { expect } from "bun:test";
import { ok } from "neverthrow";
import { nodeSha256, Role } from "@hsn/protocol";
import type {
  AppErrorV2,
  AppOpV2,
  NotificationCategory,
  NotificationObject,
  PushOutcome,
} from "@hsn/protocol/app";
import type { Effect, RosterEntry } from "../../../src/core/model/effects.ts";
import {
  type DurableSnapshot,
  EMPTY_M2_SNAPSHOT,
  EMPTY_M3M4_SNAPSHOT,
  type M3M4Snapshot,
  type RelayDownReason,
} from "../../../src/core/model/events.ts";
import type { Context, CoreDeps, Handler } from "../../../src/core/model/handler.ts";
import {
  bootId,
  type ClientId,
  clientId,
  connId,
  type DeviceId,
  deviceId,
  modeId,
  type OutboxId,
  personId,
  RECORDS_PER_BOOT,
  requestId,
  type Seq,
  seq,
} from "../../../src/core/model/ids.ts";
import type { Actor, AnswerTo, Internal } from "../../../src/core/model/messages.ts";
import { DEFAULT_RULES, type HubRules } from "../../../src/core/model/rules.ts";
import {
  ArmState,
  ClientKind,
  type ClientRow,
  type DeviceRow,
  DeviceState,
  MoveStage,
  type NotificationRow,
  type PushOutboxRow,
  PushEnvironmentCode,
  PushPlatformCode,
  type PushTargetRow,
  type RelaySettingsRow,
  type SensorConfigRow,
} from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import type { Durability } from "../../../src/core/model/store.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import { makeCore, MODULES, type Modules } from "../../../src/core/step.ts";
import { handleRelay } from "../../../src/core/relay/handle.ts";
import { EMPTY_RELAY_SLICE, type RelaySlice } from "../../../src/core/relay/state.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { emptySnapshot } from "../../world/world.ts";

export const SECOND_US = 1_000_000;
export const MINUTE_US = 60 * SECOND_US;
export const HOUR_US = 60 * MINUTE_US;
export const DAY_US = 24 * HOUR_US;
/** 2026-11-18 00:00 UTC: the wall clock at t = 0. */
export const WALL0 = Date.UTC(2026, 10, 18);

/** A local relay, as this Mac's tests set one (m4-design section 11). */
export const LOCAL_URL = "ws://192.168.1.20:8480";

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

// ----- The household -----

export const S1 = deviceId(10);
export const S2 = deviceId(11);
export const S3 = deviceId(12);
export const R1 = deviceId(20);
export const G1 = deviceId(30);
export const SENSORS = [S1, S2, S3];

export const ANNA = personId(1);
export const BEN = personId(2);
export const CONSOLE_CLIENT = clientId(1);
export const ANNA_PHONE = clientId(11);
export const ANNA_LAPTOP = clientId(12);
export const BEN_PHONE = clientId(21);
export const BEN_PHONE2 = clientId(22);
export const PHONES = [ANNA_PHONE, BEN_PHONE, BEN_PHONE2];

/** A mode a person made, with a name the household typed. */
export const NIGHT_MODE = modeId(3);

/** The hub's app key (public): its identity is this key's hash (M2 section 5). */
export const APP_KEY = new Uint8Array(32).map((_, i) => 0xa0 + i);

/** A device name that is also something a household would type. */
export const DEVICE_NAMES: Readonly<Record<number, string>> = {
  10: "front-door",
  11: "garage",
  12: "study-window",
  20: "hall-siren",
  30: "attic-gateway",
};

function deviceRow(id: DeviceId, role: number): DeviceRow {
  return {
    id,
    address: 0x0100_0000 + id,
    role,
    name: DEVICE_NAMES[id] ?? `d${id}`,
    chipId: new Uint8Array(6),
    firmware: 0x010000,
    development: false,
    state: DeviceState.Contacted,
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

function client(id: ClientId, person: number | null, kind: ClientKind, name: string): ClientRow {
  return {
    id,
    personId: person === null ? null : personId(person),
    staticKey: new Uint8Array(32).fill(id),
    kind,
    name,
    linkedByClient: null,
    createdMs: WALL0,
    removedMs: null,
    lastSeq: 0,
    lastSeenMs: null,
    backupKeyEpoch: null,
  };
}

const HOUSEHOLD: DurableSnapshot["m2"] = {
  ...EMPTY_M2_SNAPSHOT,
  appKeys: { appStaticPublic: APP_KEY },
  peopleSettings: { userManagement: true },
  people: [
    { id: ANNA, name: "Anna", createdMs: WALL0, removedMs: null, revision: 0 },
    { id: BEN, name: "Ben", createdMs: WALL0, removedMs: null, revision: 0 },
  ],
  personRoles: [
    { personId: ANNA, manageUsers: true, manageSystem: true, revision: 0 },
    { personId: BEN, manageUsers: false, manageSystem: false, revision: 0 },
  ],
  permissions: [
    { personId: ANNA, deviceId: S1, manage: true, view: true },
    { personId: ANNA, deviceId: S2, manage: true, view: true },
    { personId: ANNA, deviceId: S3, manage: true, view: true },
    { personId: BEN, deviceId: S1, manage: false, view: true },
    { personId: BEN, deviceId: S2, manage: true, view: true },
  ],
  modes: [{ id: NIGHT_MODE, name: "Night at Anna's", fixed: 0, revision: 0 }],
  clients: [
    client(CONSOLE_CLIENT, null, ClientKind.Console, "hub computer"),
    client(ANNA_PHONE, 1, ClientKind.Phone, "Anna's phone"),
    client(ANNA_LAPTOP, 1, ClientKind.Web, "Anna's laptop"),
    client(BEN_PHONE, 2, ClientKind.Phone, "Ben's phone"),
    client(BEN_PHONE2, 2, ClientKind.Phone, "Ben's old phone"),
  ],
};

/** A key id per phone: 8 bytes of its client number. */
export function keyIdOf(phone: ClientId, generation = 0): Uint8Array {
  return new Uint8Array(8).fill(phone + generation * 64);
}

/** A push key per phone, never seen in a record. */
export function keyOf(phone: ClientId, generation = 0): Uint8Array {
  return new Uint8Array(32).map((_, i) => (phone * 7 + i * 13 + generation * 31 + 5) & 0xff);
}

/** An APNs token per phone: 64 lowercase hex digits. */
export function tokenOf(phone: ClientId, generation = 0): string {
  return ((phone + generation * 64) & 0xff).toString(16).padStart(2, "0").repeat(32);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A phone's stored target. */
export function targetRow(phone: ClientId, overrides: Partial<PushTargetRow> = {}): PushTargetRow {
  return {
    clientId: phone,
    keyId: keyIdOf(phone),
    platform: PushPlatformCode.Apns,
    environment: PushEnvironmentCode.Production,
    token: tokenOf(phone),
    registeredMs: WALL0,
    invalidMs: null,
    ...overrides,
  };
}

/** The household's snapshot, with migration 3's rows given. */
export function householdSnapshot(
  m3m4: Partial<M3M4Snapshot> = {},
  notifications: readonly NotificationRow[] = [],
): DurableSnapshot {
  return {
    ...emptySnapshot(),
    devices: [
      ...SENSORS.map((id) => deviceRow(id, Role.Sensor)),
      deviceRow(R1, Role.Siren),
      deviceRow(G1, Role.Gateway),
    ],
    site: {
      channel: 1,
      rateMask: 1 << 5,
      moveId: 0,
      moveStage: MoveStage.None,
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
    m2: { ...HOUSEHOLD, notifications },
    m3m4: { ...EMPTY_M3M4_SNAPSHOT, ...m3m4 },
  };
}

/** A relay set to `url`, and every phone of `phones` registered. */
export function relaySnapshot(
  phones: readonly ClientId[] = PHONES,
  settings: RelaySettingsRow = { url: LOCAL_URL, revision: 1 },
  extra: Partial<M3M4Snapshot> = {},
  notifications: readonly NotificationRow[] = [],
): DurableSnapshot {
  return householdSnapshot(
    { relaySettings: settings, pushTargets: phones.map((p) => targetRow(p)), ...extra },
    notifications,
  );
}

const ignoreRelay: Handler<"relay"> = (slice) => ok({ slice, out: [] });

/** Every other real module booted over the snapshot; relay's slice left empty for the runner. */
export function bootedView(snapshot: DurableSnapshot, rules: HubRules = DEFAULT_RULES): HubState {
  const modules: Modules = {
    ...MODULES,
    relay: { ...MODULES.relay, handle: ignoreRelay, deadlines: () => [] },
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
  return { ...stepped._unsafeUnwrap().state, relay: EMPTY_RELAY_SLICE };
}

// ----- The runner -----

/** Steps at one instant before the runner calls it a deadline that never clears. */
export const MAX_STEPS_AT_ONE_INSTANT = 100;

/** An operation's outcome, as `OpOutcome` carries it. */
export type Outcome =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly error: AppErrorV2 };

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

export type Item = Internal | Effect;

export function isEffect(item: Item): item is Effect {
  return EFFECT_KINDS.has(item.kind);
}

export interface Ran {
  readonly out: readonly Item[];
  readonly effects: readonly Effect[];
  readonly messages: readonly Internal[];
}

function ran(out: readonly Item[]): Ran {
  return {
    out,
    effects: out.filter(isEffect),
    messages: out.filter((item): item is Internal => !isEffect(item)),
  };
}

/** A notification as `notify` raises it, and the row it writes (critical now, else routine). */
export interface Raising {
  readonly kind: string;
  readonly category: NotificationCategory;
  readonly critical: boolean;
  readonly device: DeviceId | null;
  readonly cause?: Seq | null;
  readonly clients: readonly ClientId[];
}

export const COMPUTER: Actor = { kind: "computer", name: "dimitri" };
export const CONSOLE: Actor = { kind: "console", client: CONSOLE_CLIENT };

export function personActor(client: ClientId): Actor {
  const person = client === ANNA_PHONE || client === ANNA_LAPTOP ? ANNA : BEN;
  return {
    kind: "person",
    person,
    client,
    name: `${person === ANNA ? "Anna" : "Ben"} (client ${client})`,
  };
}

export class Runner {
  view: HubState;
  now: Now;
  readonly deps: CoreDeps;
  #record = 1;
  #request = 1;
  /** Every output since the start, with the notification rows `raise` wrote, as audit gets them. */
  readonly all: Item[] = [];
  /** Every input and output in order, for following a push from its send to its result. */
  readonly log: ({ readonly input: Internal } | { readonly output: Item })[] = [];

  /** This run's boot: its records are numbered from `boot × 2³²` (HD 2). */
  readonly boot_: number;

  constructor(view: HubState, rules: HubRules = DEFAULT_RULES, boot = 1) {
    this.view = view;
    this.deps = depsWith(rules);
    this.now = { mono: mono(0), wall: WALL0, wallTrusted: true };
    this.boot_ = boot;
  }

  get slice(): RelaySlice {
    return this.view.relay;
  }

  get rules(): HubRules {
    return this.deps.rules;
  }

  /** Moves the clocks on by `us` microseconds, without running anything. */
  advance(us: number): void {
    // The wall clock follows the monotonic one to the millisecond, without drifting by rounding.
    const to = this.now.mono + us;
    this.now = {
      mono: mono(to),
      wall: this.now.wall + Math.floor(to / 1000) - Math.floor(this.now.mono / 1000),
      wallTrusted: this.now.wallTrusted,
    };
  }

  /** The record number the next record will take. */
  nextRecord(): Seq {
    return seq(this.boot_ * RECORDS_PER_BOOT + this.#record);
  }

  #ctx(): Context {
    let n = this.#record;
    return {
      now: this.now,
      view: this.view,
      deps: this.deps,
      entropy: entropyCursor(new Uint8Array(32), "tick"),
      records: {
        take: () => {
          const taken: Seq = seq(this.boot_ * RECORDS_PER_BOOT + n++);
          this.#record = n;
          return ok(taken);
        },
      },
      event: "tick",
    };
  }

  /** One message to relay, as one step's input. */
  send(message: Internal): Ran {
    this.log.push({ input: message });
    const before = this.slice.timers;
    const handled = handleRelay(this.view.relay, message, this.#ctx());
    expect(handled.isOk() ? undefined : handled.error.message).toBeUndefined();
    const value = handled.isOk() ? handled.value : { slice: this.view.relay, out: [] };
    this.view = { ...this.view, relay: value.slice };
    this.all.push(...value.out);
    this.log.push(...value.out.map((output) => ({ output })));
    this.#noDeadlineLeftDue(before, message);
    return ran(value.out);
  }

  /**
   * The property of every step (hub-design section 2, "Timers"): after a step at time t, none of
   * relay's deadlines is at or before t, unless it was already there, due, before the step (the
   * dispatcher runs every due timer in one step; this runner gives them one at a time). The timer
   * a step was given is never left in place.
   */
  #noDeadlineLeftDue(
    before: readonly { readonly at: number; readonly key: object }[],
    message: Internal,
  ): void {
    const now = this.now.mono;
    const name = (t: { readonly at: number; readonly key: object }) =>
      `${JSON.stringify(t.key)}@${String(t.at)}`;
    const old = new Set(before.map(name));
    const given = message.kind === "timer" ? name(message) : undefined;
    const due = this.slice.timers
      .filter((t) => t.at <= now && (!old.has(name(t)) || name(t) === given))
      .map(name);
    expect({ step: message.kind, now, due }).toEqual({ step: message.kind, now, due: [] });
  }

  /**
   * Moves on by `us`, running every timer due on the way at its own time. More than
   * `MAX_STEPS_AT_ONE_INSTANT` timers at one instant is a deadline that never clears: the test
   * fails at once instead of spinning.
   */
  run(us: number): Ran {
    const until = this.now.mono + us;
    const out: Item[] = [];
    let atOneInstant = 0;
    for (;;) {
      const due = this.slice.timers.filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      if (due.at > this.now.mono) {
        this.advance(due.at - this.now.mono);
        atOneInstant = 0;
      }
      atOneInstant += 1;
      expect({
        at: this.now.mono,
        atOneInstant: Math.min(atOneInstant, MAX_STEPS_AT_ONE_INSTANT + 1),
      }).toEqual({
        at: this.now.mono,
        atOneInstant: Math.min(atOneInstant, MAX_STEPS_AT_ONE_INSTANT),
      });
      out.push(...this.send({ kind: "timer", key: due.key, at: due.at }).out);
    }
    if (until > this.now.mono) this.advance(until - this.now.mono);
    return ran(out);
  }

  /** The time of the relay timer of `kind`, or undefined. */
  timerAt(kind: string): number | undefined {
    return this.slice.timers.find((t) => t.key.kind === kind)?.at;
  }

  /** The boot input, with the deployment's default relay the shell would give (none by default). */
  boot(snapshot: DurableSnapshot, defaultRelayUrl: string | null = null): Ran {
    return this.send({
      kind: "boot",
      snapshot,
      boot: { id: bootId(this.boot_), previousExit: "clean", cause: undefined, defaultRelayUrl },
    });
  }

  up(url: string = LOCAL_URL, roles: readonly string[] = ["relay", "push", "releases"]): Ran {
    return this.send({ kind: "relayLink", state: "up", url, roles });
  }

  down(reason: RelayDownReason = "noPong", url: string = LOCAL_URL): Ran {
    return this.send({ kind: "relayLink", state: "down", url, reason });
  }

  results(results: readonly { readonly id: OutboxId; readonly outcome: PushOutcome }[]): Ran {
    return this.send({ kind: "pushResults", results });
  }

  /** Every push in flight answered `outcome`. */
  answerAll(outcome: PushOutcome = "accepted"): Ran {
    const ids = [
      ...[...this.slice.outbox.values()].filter((p) => p.inFlight).map((p) => p.row.id),
      ...this.slice.tests.keys(),
    ];
    return this.results(ids.map((id) => ({ id, outcome })));
  }

  /** `notify` raising a notification, with its row as audit would get it. */
  raise(raising: Raising): Ran & { readonly row: NotificationRow } {
    const ctx = this.#ctx();
    const taken = ctx.records.take();
    const number = taken.isOk() ? taken.value : seq(0);
    const row: NotificationRow = {
      seq: number,
      atMs: this.now.wall,
      clockOk: this.now.wallTrusted,
      kind: raising.kind,
      category: raising.category,
      critical: raising.critical,
      deviceId: raising.device,
      causeSeq: raising.cause ?? null,
      recipients: new Uint8Array(),
      detail: null,
    };
    const durability: Durability = raising.critical ? "now" : "routine";
    const record: Item = { kind: "auditRecord", durability, record: { kind: "notification", row } };
    this.all.push(record);
    this.log.push({ output: record });
    const notification: NotificationObject = {
      seq: row.seq,
      atMs: row.atMs,
      clockOk: row.clockOk,
      kind: row.kind,
      category: raising.category,
      critical: row.critical,
      device: row.deviceId,
      cause: row.causeSeq,
      read: false,
      delayed: false,
    };
    return {
      ...this.send({ kind: "notificationRaised", notification, clients: raising.clients }),
      row,
    };
  }

  /** A decision another module made, passing on its way to audit. */
  decision(
    kind: string,
    value: number | null,
    device: DeviceId | null = null,
    detail: Uint8Array | null = null,
  ): Seq {
    const number = this.nextRecord();
    this.#record += 1;
    this.send({
      kind: "auditRecord",
      durability: "now",
      record: {
        kind: "decision",
        row: {
          seq: number,
          atMs: this.now.wall,
          clockOk: true,
          kind: kind as never,
          deviceId: device,
          causeSeq: null,
          value,
          detail,
        },
      },
    });
    return number;
  }

  /** An operation from `actor`, answered to an app's connection or `hsn`. */
  op(op: AppOpV2, actor: Actor = COMPUTER): Ran & { answer: Outcome | undefined; record: Seq } {
    const id = this.#request++;
    const answerTo: AnswerTo =
      actor.kind === "person" || actor.kind === "console"
        ? { kind: "app", conn: connId(8), client: actor.client, id, seq: id }
        : { kind: "control", request: requestId(id), conn: connId(7) };
    const record = seq(this.boot_ * RECORDS_PER_BOOT + 90_000 + id);
    const result = this.send({ kind: "v2OpRequest", owner: "relay", op, actor, answerTo, record });
    const answer = result.messages.find((m) => m.kind === "opAnswer");
    const outcome = answer?.kind === "opAnswer" ? answer.outcome : undefined;
    return { ...result, answer: outcome, record };
  }

  /** `push.register` from a phone, for itself. */
  register(
    phone: ClientId,
    fields: {
      readonly generation?: number;
      readonly platform?: "apns" | "fcm";
      readonly keyId?: string;
      readonly key?: string;
    } = {},
  ): Ran & { answer: Outcome | undefined; record: Seq } {
    const generation = fields.generation ?? 0;
    const platform = fields.platform ?? "apns";
    const body = {
      environment: "production" as const,
      token: platform === "apns" ? tokenOf(phone, generation) : `fcm:${phone}:${generation}`,
      keyId: fields.keyId ?? hex(keyIdOf(phone, generation)),
      key: fields.key ?? base64url(keyOf(phone, generation)),
    };
    const op: AppOpV2 =
      platform === "apns"
        ? { op: "push.register", body: { platform: "apns", ...body } }
        : { op: "push.register", body: { platform: "fcm", ...body } };
    return this.op(op, personActor(phone));
  }

  /** Changes a sensor's arming in the view, as `alarm` would. */
  arm(sensor: DeviceId, arm: ArmState = ArmState.Armed): void {
    const entry = this.view.alarm.sensors.get(sensor);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const sensors = new Map(this.view.alarm.sensors);
    sensors.set(sensor, { ...entry, arm });
    this.view = { ...this.view, alarm: { ...this.view.alarm, sensors } };
  }

  /** Takes a person's view of a sensor away, as `people` would. */
  forbid(person: typeof ANNA, sensor: DeviceId): void {
    const permissions = new Map(this.view.people.permissions);
    const theirs = new Map(permissions.get(person));
    theirs.delete(sensor);
    permissions.set(person, theirs);
    this.view = { ...this.view, people: { ...this.view.people, permissions } };
  }

  /** Removes a client, as `people` would before its `clientRemoved`. */
  removeClient(gone: ClientId): Ran {
    const row = this.view.people.clients.get(gone);
    expect(row).toBeDefined();
    if (row !== undefined) {
      const clients = new Map(this.view.people.clients).set(gone, {
        ...row,
        removedMs: this.now.wall,
      });
      this.view = { ...this.view, people: { ...this.view.people, clients } };
    }
    return this.send({ kind: "clientRemoved", client: gone });
  }
}

// ----- Reading what came out -----

export type PushSend = Extract<Effect, { readonly kind: "pushSend" }>;
export type Write = Extract<Effect, { readonly kind: "write" }>;
export type Roster = Extract<Effect, { readonly kind: "relayRoster" }>;

export function pushes(items: readonly Item[]): readonly PushSend[] {
  return items.filter((e): e is PushSend => e.kind === "pushSend");
}

export function writes(items: readonly Item[]): readonly Write[] {
  return items.filter((e): e is Write => e.kind === "write");
}

export function rosters(items: readonly Item[]): readonly Roster[] {
  return items.filter((e): e is Roster => e.kind === "relayRoster");
}

export function rosterClients(roster: Roster | undefined): readonly ClientId[] {
  return (roster?.targets ?? []).map((t: RosterEntry) => t.client);
}

/** The hub events relay recorded, by code, with their records' durability and detail. */
export function hubEvents(items: readonly Item[]): readonly {
  readonly code: string;
  readonly durability: Durability;
  readonly detail: unknown;
  readonly level: string;
}[] {
  return items.flatMap((m) =>
    m.kind === "auditRecord" && m.record.kind === "hubEvent"
      ? [
          {
            code: m.record.row.code,
            durability: m.durability,
            level: m.record.row.level,
            detail:
              m.record.row.detail === null ? null : (JSON.parse(m.record.row.detail) as unknown),
          },
        ]
      : [],
  );
}

/** The decisions relay recorded. */
export function decisions(items: readonly Item[]): readonly {
  readonly kind: string;
  readonly value: number | null;
  readonly durability: Durability;
  readonly cause: Seq | null;
}[] {
  return items.flatMap((m) =>
    m.kind === "auditRecord" && m.record.kind === "decision"
      ? [
          {
            kind: m.record.row.kind,
            value: m.record.row.value,
            durability: m.durability,
            cause: m.record.row.causeSeq,
          },
        ]
      : [],
  );
}

/** The outbox rows written, as upserts. */
export function outboxUpserts(
  items: readonly Item[],
): readonly (PushOutboxRow & { readonly durability: Durability })[] {
  return writes(items).flatMap((w) =>
    w.op.table === "push_outbox" && w.op.op === "upsert"
      ? [{ ...w.op.row, durability: w.durability }]
      : [],
  );
}

export function outboxDeletes(items: readonly Item[]): readonly OutboxId[] {
  return writes(items).flatMap((w) =>
    w.op.table === "push_outbox" && w.op.op === "delete" ? [w.op.key.id] : [],
  );
}

/** A fresh runner over the household with a relay set and every phone registered, booted. */
export function relayRunner(
  snapshot: DurableSnapshot = relaySnapshot(),
  rules?: HubRules,
  defaultRelayUrl: string | null = null,
): Runner {
  const runner = new Runner(bootedView(snapshot, rules), rules);
  runner.boot(snapshot, defaultRelayUrl);
  return runner;
}

/** An ordinary notification about a sensor to the given phones. */
export function ordinary(clients: readonly ClientId[], device: DeviceId = S1): Raising {
  return { kind: "battery_low", category: "batteryLow", critical: false, device, clients };
}

/** A countdown about a sensor to the given phones (critical, D92). */
export function countdown(
  clients: readonly ClientId[],
  device: DeviceId = S1,
  cause?: Seq,
): Raising {
  return {
    kind: "countdown_started",
    category: "countdown",
    critical: true,
    device,
    clients,
    ...(cause === undefined ? {} : { cause }),
  };
}

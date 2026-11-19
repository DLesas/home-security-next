/**
 * The core under test for people and app (m2-design.md section 11, owner A3): the real dispatcher
 * and every M1a module, people and app with the sources the frozen model does not give the core
 * yet (SHA-256, the hub's addresses and facts), and the other M2 modules (layout, schedules,
 * health, notify, upkeep) as stand-ins that answer their operations `notBuilt` and change
 * nothing, so these tests do not move with modules other engineers are writing.
 *
 * `Hub` drives it with chosen times and entropy, keeps the committed rows of people's tables as a
 * restart reads them back, and picks effects apart.
 */
import { expect } from "bun:test";
import { nodeSha256, Role } from "@hsn/protocol";
import {
  APP_OPS,
  type AppEvent,
  type AppMessage,
  type AppOp,
  type AppOpName,
  type AppReply,
  type LinkResult,
} from "@hsn/protocol/app";
import { ok } from "neverthrow";
import type { Effect } from "../../../../src/core/model/effects.ts";
import type { CoreFault } from "../../../../src/core/model/errors.ts";
import {
  type DurableSnapshot,
  EMPTY_M2_SNAPSHOT,
  type HubEvent,
} from "../../../../src/core/model/events.ts";
import type { CoreDeps, Handler } from "../../../../src/core/model/handler.ts";
import {
  bootId,
  type ClientId,
  clientId,
  type ConnId,
  connId,
  type DeviceId,
  deviceId,
  modeId,
  type PersonId,
  personId,
  requestId,
} from "../../../../src/core/model/ids.ts";
import type { Internal } from "../../../../src/core/model/messages.ts";
import type { M2ModuleName } from "../../../../src/core/model/modules.ts";
import { DEFAULT_RULES } from "../../../../src/core/model/rules.ts";
import {
  ClientKind,
  type ClientReplyRow,
  type ClientRow,
  type DeviceRow,
  DeviceState,
  type DeviceStateRow,
  type LinkTokenRow,
  ModeFixed,
  MoveStage,
  type PermissionRow,
  type PersonRoleRow,
  type PersonRow,
  type SiteRow,
} from "../../../../src/core/model/rows.ts";
import type { HubState } from "../../../../src/core/model/state.ts";
import type { StoreOp } from "../../../../src/core/model/store.ts";
import { type Mono, mono } from "../../../../src/core/model/time.ts";
import type { ControlCommand } from "../../../../src/core/model/control.ts";
import { type Core, makeCore, type Modules, MODULES } from "../../../../src/core/step.ts";
import { UNBUILT_CALENDAR } from "../../../../src/shell/calendar/unbuilt.ts";
import type { Calendar } from "../../../../src/core/model/calendar.ts";
import { VectorCipher } from "../../../world/vector-cipher.ts";
import { emptySnapshot } from "../../../world/world.ts";

export const SECOND = 1_000_000;
export const MINUTE = 60 * SECOND;
export const WALL_AT_START = Date.UTC(2026, 10, 14);

/** The shell's facts (`hubFacts`, section 2), given after every boot. */
export const FACTS = {
  version: "2.0.0",
  addresses: ["192.168.1.10", "fd00::10"],
  appsPort: 8444,
  consolePort: 8445,
  certificateSha256: new Uint8Array(32).fill(0xab),
} as const;
export const APP_STATIC_PUBLIC = new Uint8Array(32).fill(0x42);

/** `LinkResult`, sent as the link connection's `handshake` message (section 5). */
export interface LinkResultSent {
  readonly kind: "linkResult";
  readonly conn: ConnId;
  readonly result: LinkResult;
}

/** An M2 module not A3's: changes nothing, answers its operations `notBuilt`. */
function standIn<K extends M2ModuleName>(name: K): Modules[K] {
  const handle: Handler<K> = (slice, message) =>
    ok(
      message.kind === "opRequest" && message.owner === name
        ? {
            slice,
            out: [
              {
                kind: "opAnswer",
                answerTo: message.answerTo,
                outcome: { ok: false, error: { code: "notBuilt", detail: { op: message.op.op } } },
              },
            ],
          }
        : { slice, out: [] },
    );
  return { empty: MODULES[name].empty, handle, deadlines: () => [] } as unknown as Modules[K];
}

/**
 * An M2 stand-in that, on the next `tick`, emits these messages once: what another engineer's
 * module would send app (a decision, `notificationRaised`, `siteMove`).
 */
export function emitter<K extends M2ModuleName>(
  name: K,
  messages: readonly Internal[],
): Modules[K] {
  let left = [...messages];
  const base = standIn(name);
  const handle: Handler<K> = (slice, message, ctx) => {
    if (message.kind !== "tick" || left.length === 0) return base.handle(slice, message, ctx);
    const out = left;
    left = [];
    return ok({ slice, out });
  };
  return { ...base, handle };
}

export function testModules(overrides: Partial<Modules> = {}): Modules {
  return {
    ...MODULES,
    layout: standIn("layout"),
    schedules: standIn("schedules"),
    health: standIn("health"),
    notify: standIn("notify"),
    upkeep: standIn("upkeep"),
    ...overrides,
  };
}

export function siteRow(overrides: Partial<SiteRow> = {}): SiteRow {
  return {
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
    wifiPassword: new TextEncoder().encode("correct horse battery"),
    countdownDefaultS: 30,
    autoStopS: 300,
    replyPowerDbm: 22,
    sirenPowerDbm: 22,
    retentionRoutineDays: 30,
    retentionEventDays: 365,
    ...overrides,
  };
}

export function device(id: number, role: number, name: string): DeviceRow {
  return {
    id: deviceId(id),
    address: 0x1000 + id,
    role,
    name,
    chipId: new Uint8Array(6).fill(id),
    firmware: 0x010203,
    development: true,
    state: DeviceState.Contacted,
    addedMs: 0,
    removedMs: null,
  };
}

export const FRONT = deviceId(11);
export const GARAGE = deviceId(12);
export const HALL_SIREN = deviceId(21);
export const DEVICES: readonly DeviceRow[] = [
  device(11, Role.Sensor, "front"),
  device(12, Role.Sensor, "garage"),
  device(21, Role.Siren, "hall"),
];

export function person(id: number, name: string, overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    id: personId(id),
    name,
    createdMs: WALL_AT_START - 86_400_000,
    removedMs: null,
    revision: 0,
    ...overrides,
  };
}

export function client(
  id: number,
  owner: number | null,
  overrides: Partial<ClientRow> = {},
): ClientRow {
  return {
    id: clientId(id),
    personId: owner === null ? null : personId(owner),
    staticKey: new Uint8Array(32).fill(id),
    kind: owner === null ? ClientKind.Console : ClientKind.Web,
    name: `client-${id}`,
    linkedByClient: null,
    createdMs: WALL_AT_START - 86_400_000,
    removedMs: null,
    lastSeq: 0,
    lastSeenMs: null,
    backupKeyEpoch: null,
    ...overrides,
  };
}

/** Anna (person 1, client 7 and 8) and Ben (person 2, client 9); the console is client 1. */
export const ANNA = personId(1);
export const BEN = personId(2);
export const CONSOLE_CLIENT = clientId(1);
export const ANNA_LAPTOP = clientId(7);
export const ANNA_PHONE = clientId(8);
export const BEN_LAPTOP = clientId(9);

export interface Household {
  readonly people?: readonly PersonRow[];
  readonly clients?: readonly ClientRow[];
  readonly roles?: readonly PersonRoleRow[];
  readonly permissions?: readonly PermissionRow[];
  readonly userManagement?: boolean;
  readonly linkTokens?: readonly LinkTokenRow[];
  readonly clientReplies?: readonly ClientReplyRow[];
  readonly deviceState?: readonly DeviceStateRow[];
}

export function household(h: Household = {}): DurableSnapshot {
  return {
    ...emptySnapshot(),
    devices: [...DEVICES],
    site: siteRow(),
    deviceState: h.deviceState ?? [],
    m2: {
      ...EMPTY_M2_SNAPSHOT,
      appKeys: { appStaticPublic: APP_STATIC_PUBLIC },
      modes: [
        { id: modeId(1), name: "Away", fixed: ModeFixed.Away, revision: 0 },
        { id: modeId(2), name: "Disarmed", fixed: ModeFixed.Disarmed, revision: 0 },
      ],
      modeState: { currentModeId: modeId(2), modeModified: false },
      peopleSettings: { userManagement: h.userManagement ?? false },
      people: h.people ?? [person(1, "Anna"), person(2, "Ben")],
      clients: h.clients ?? [
        client(1, null),
        client(7, 1),
        client(8, 1, { kind: ClientKind.Phone }),
        client(9, 2),
      ],
      personRoles: h.roles ?? [],
      permissions: h.permissions ?? [],
      linkTokens: h.linkTokens ?? [],
      clientReplies: h.clientReplies ?? [],
    },
  };
}

/** Entropy with these bytes first, then 0x5a: a test's secret and token id, chosen. */
export function entropy(...parts: readonly (Uint8Array | readonly number[])[]): Uint8Array {
  const bytes = new Uint8Array(32).fill(0x5a);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

export class Hub {
  readonly core: Core;
  readonly deps: CoreDeps;
  state: HubState;
  at: Mono = mono(SECOND);
  readonly steps: (readonly Effect[])[] = [];
  #nextConn = 100;
  #nextRequest = 1;
  #seq = new Map<ClientId, number>();
  #id = new Map<ConnId, number>();

  constructor(modules: Modules = testModules(), calendar: Calendar = UNBUILT_CALENDAR) {
    this.core = makeCore(modules);
    this.deps = {
      cipher: VectorCipher.fromVectors(),
      rules: DEFAULT_RULES,
      calendar,
      sha256: nodeSha256,
      deepFreeze: true,
      checkDeadlines: true,
    };
    this.state = this.core.emptyState();
  }

  wall(): number {
    return WALL_AT_START + Math.floor(this.at / 1000);
  }

  try(event: HubEvent, bytes: Uint8Array = entropy()) {
    const result = this.core.step(
      this.state,
      { now: { mono: this.at, wall: this.wall(), wallTrusted: true }, entropy: bytes, event },
      this.deps,
    );
    if (result.isOk()) {
      this.state = result.value.state;
      this.steps.push(result.value.effects);
    }
    return result;
  }

  input(event: HubEvent, bytes?: Uint8Array): readonly Effect[] {
    const result = this.try(event, bytes);
    const fault: CoreFault | undefined = result.isErr() ? result.error : undefined;
    expect(fault?.message ?? "ok").toBe("ok");
    return result.isOk() ? result.value.effects : [];
  }

  /** A boot, then the shell's facts, as the shell gives them (section 2). */
  boot(from: DurableSnapshot = household(), id = 1, facts = true): readonly Effect[] {
    const effects = this.input({
      kind: "boot",
      snapshot: from,
      boot: { id: bootId(id), previousExit: "clean", cause: undefined },
    });
    if (facts) this.input({ kind: "hubFacts", ...FACTS });
    return effects;
  }

  /** A proven session of `client` (section 5). */
  connect(client: ClientId, listener: "lan" | "console" = "lan"): ConnId {
    const conn = connId(this.#nextConn++);
    this.input({ kind: "clientConnected", conn, client, listener, proto: 1, app: "1.0.0" });
    return conn;
  }

  nextSeq(client: ClientId): number {
    const next = (this.#seq.get(client) ?? 0) + 1;
    this.#seq.set(client, next);
    return next;
  }

  /** A request on `conn`; a change takes the client's next `seq` unless one is given. */
  request(
    conn: ConnId,
    client: ClientId,
    op: AppOp,
    options: { readonly seq?: number; readonly change?: boolean; readonly bytes?: Uint8Array } = {},
  ): {
    readonly id: number;
    readonly seq: number | undefined;
    readonly effects: readonly Effect[];
  } {
    const id = (this.#id.get(conn) ?? 0) + 1;
    this.#id.set(conn, id);
    const change = options.change ?? isChange(op.op);
    const seq = change ? (options.seq ?? this.nextSeq(client)) : undefined;
    const effects = this.input(
      { kind: "clientRequest", conn, client, request: { id, seq, op } },
      options.bytes,
    );
    return { id, seq, effects };
  }

  command(command: ControlCommand, bytes?: Uint8Array): readonly Effect[] {
    return this.input(
      {
        kind: "command",
        conn: connId(0),
        request: requestId(this.#nextRequest++),
        actor: "root",
        command,
      },
      bytes,
    );
  }

  advance(ms: number): readonly Effect[] {
    this.at = mono(this.at + ms * 1000);
    return this.input({ kind: "tick" });
  }

  get all(): readonly Effect[] {
    return this.steps.flat();
  }
}

function isChange(op: AppOpName): boolean {
  return APP_OPS[op].change;
}

// Picking effects apart.

export function sentTo(effects: readonly Effect[], conn: ConnId): readonly AppMessage[] {
  // These tests' sessions are version 1's (`connect`), so what they are sent is version 1's.
  return effects.flatMap((e) =>
    e.kind === "appSend" && e.conn === conn ? [e.message as AppMessage] : [],
  );
}

export function repliesTo(effects: readonly Effect[], conn: ConnId): readonly AppReply[] {
  // A handshake's message (`LinkResult`) has no `t`.
  return sentTo(effects, conn).flatMap((m) => ("t" in m && m.t === "res" ? [m] : []));
}

export function eventsTo(effects: readonly Effect[], conn: ConnId): readonly AppEvent[] {
  return sentTo(effects, conn).flatMap((m) => ("t" in m && m.t === "evt" ? [m] : []));
}

/** The one reply on `conn` in these effects. */
export function onlyReply(effects: readonly Effect[], conn: ConnId): AppReply {
  const all = repliesTo(effects, conn);
  expect(all.length).toBe(1);
  return all[0] ?? { t: "res", id: 1, ok: false, error: { code: "notBuilt", detail: { op: "-" } } };
}

export function codeOf(reply: AppReply): string {
  return reply.ok ? "ok" : reply.error.code;
}

export function bodyOf(reply: AppReply): Record<string, unknown> {
  return reply.ok && typeof reply.body === "object" && reply.body !== null
    ? (reply.body as Record<string, unknown>)
    : {};
}

export function nowWrites(effects: readonly Effect[]): readonly StoreOp[] {
  return effects.flatMap((e) => (e.kind === "write" && e.durability === "now" ? [e.op] : []));
}

export function writesTo(effects: readonly Effect[], table: string): readonly StoreOp[] {
  return effects.flatMap((e) => (e.kind === "write" && e.op.table === table ? [e.op] : []));
}

export function decisionsOf(effects: readonly Effect[]) {
  return effects.flatMap((e) =>
    e.kind === "record" && e.record.kind === "decision"
      ? [{ durability: e.durability, row: e.record.row }]
      : [],
  );
}

export function commandRows(effects: readonly Effect[]) {
  return effects.flatMap((e) =>
    e.kind === "record" && e.record.kind === "command"
      ? [{ durability: e.durability, row: e.record.row }]
      : [],
  );
}

export function linkSecrets(effects: readonly Effect[]) {
  return effects.flatMap((e) => (e.kind === "linkSecret" ? [e] : []));
}

export function linkResults(effects: readonly Effect[]): readonly LinkResultSent[] {
  return effects.flatMap((e) =>
    e.kind === "appSend" && "kind" in e.message && "client" in e.message.body
      ? [{ kind: "linkResult" as const, conn: e.conn, result: e.message.body }]
      : [],
  );
}

export function closes(effects: readonly Effect[]) {
  return effects.flatMap((e) => (e.kind === "closeClient" ? [e] : []));
}

/**
 * The committed rows of people's tables, as a restart reads them back: applies `write` ops in
 * order, as the writer does.
 */
export class Committed {
  readonly people = new Map<number, PersonRow>();
  readonly clients = new Map<number, ClientRow>();
  readonly roles = new Map<number, PersonRoleRow>();
  readonly permissions = new Map<string, PermissionRow>();
  readonly tokens = new Map<number, LinkTokenRow>();
  readonly secrets = new Map<number, Uint8Array>();
  readonly replies = new Map<string, ClientReplyRow>();
  userManagement = false;

  constructor(from: DurableSnapshot) {
    for (const row of from.m2.people) this.people.set(row.id, row);
    for (const row of from.m2.clients) this.clients.set(row.id, row);
    for (const row of from.m2.personRoles) this.roles.set(row.personId, row);
    for (const row of from.m2.permissions)
      this.permissions.set(`${row.personId}:${row.deviceId}`, row);
    for (const row of from.m2.linkTokens) this.tokens.set(row.id, row);
    for (const row of from.m2.clientReplies) this.replies.set(`${row.clientId}:${row.seq}`, row);
    this.userManagement = from.m2.peopleSettings?.userManagement ?? false;
  }

  apply(effects: readonly Effect[]): void {
    for (const e of effects) {
      if (e.kind !== "write") continue;
      const op = e.op;
      if (op.op === "prune") continue;
      switch (op.table) {
        case "people":
          if (op.op === "upsert") this.people.set(op.row.id, op.row);
          break;
        case "clients":
          if (op.op === "upsert") this.clients.set(op.row.id, op.row);
          break;
        case "person_roles":
          if (op.op === "upsert") this.roles.set(op.row.personId, op.row);
          break;
        case "permissions":
          if (op.op === "upsert")
            this.permissions.set(`${op.row.personId}:${op.row.deviceId}`, op.row);
          else this.permissions.delete(`${op.key.personId}:${op.key.deviceId}`);
          break;
        case "link_tokens":
          if (op.op === "upsert") this.tokens.set(op.row.id, op.row);
          break;
        case "link_secrets":
          if (op.op === "upsert") this.secrets.set(op.row.tokenId, op.row.psk);
          else this.secrets.delete(op.key.tokenId);
          break;
        case "client_replies":
          if (op.op === "upsert") this.replies.set(`${op.row.clientId}:${op.row.seq}`, op.row);
          else this.replies.delete(`${op.key.clientId}:${op.key.seq}`);
          break;
        case "people_settings":
          if (op.op === "upsert") this.userManagement = op.row.userManagement;
          break;
        default:
          break;
      }
    }
  }

  snapshot(deviceState: readonly DeviceStateRow[] = []): DurableSnapshot {
    return household({
      people: [...this.people.values()],
      clients: [...this.clients.values()],
      roles: [...this.roles.values()],
      permissions: [...this.permissions.values()],
      userManagement: this.userManagement,
      linkTokens: [...this.tokens.values()],
      clientReplies: [...this.replies.values()],
      deviceState,
    });
  }
}

/** Full permissions rows: user management on, `who` may do what on which sensor. */
export function role(
  who: PersonId,
  manageUsers: boolean,
  manageSystem: boolean,
  revision = 0,
): PersonRoleRow {
  return { personId: who, manageUsers, manageSystem, revision };
}

export function permission(
  who: PersonId,
  sensor: DeviceId,
  manage: boolean,
  view: boolean,
): PermissionRow {
  return { personId: who, deviceId: sensor, manage, view };
}

/** Every one of `items` is in `list` (in any order, among others). */
export function containsAll<T>(list: readonly T[], items: readonly T[]): void {
  for (const item of items) expect(list).toContain(item);
}

/** The first write to `table` whose row matches `fields`. */
export function rowWritten(
  effects: readonly Effect[],
  table: string,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  for (const op of writesTo(effects, table)) {
    if (op.op !== "upsert") continue;
    const row = op.row as unknown as Record<string, unknown>;
    if (Object.entries(fields).every(([k, v]) => row[k] === v)) return row;
  }
  return undefined;
}

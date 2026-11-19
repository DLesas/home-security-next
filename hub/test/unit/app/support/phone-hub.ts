/**
 * The whole core with every real module, for channel version 2's tests (H1): sessions of either
 * version, the real cipher keyed from the `device_keys` rows the steps write (as the shell's
 * `KeyStore` is, after each commit), and the committed rows of people's and the registry's tables,
 * so a test can stop the hub after any step and start it again from exactly what was written.
 *
 * Every step's writes count as committed when the step ends: the loop commits a step's "now"
 * writes before its sends (hub-design.md section 4), and a reply lost after the commit is a test
 * that drops it (`restart`).
 */
import { expect } from "bun:test";
import { nodeSha256, Role } from "@hsn/protocol";
import {
  APP_OPS_V2,
  type AppMessage,
  type AppMessageV2,
  type AppOpV2,
  type AppReplyV2,
  type AppEventV2,
} from "@hsn/protocol/app";
import type { Effect } from "../../../../src/core/model/effects.ts";
import type { CoreFault } from "../../../../src/core/model/errors.ts";
import type { DurableSnapshot, HubEvent } from "../../../../src/core/model/events.ts";
import type { CoreDeps } from "../../../../src/core/model/handler.ts";
import {
  bootId,
  type ClientId,
  type ConnId,
  connId,
  type DeviceId,
  deviceId,
  requestId,
} from "../../../../src/core/model/ids.ts";
import type { ControlCommand } from "../../../../src/core/model/control.ts";
import { DEFAULT_RULES } from "../../../../src/core/model/rules.ts";
import type {
  DeviceRow,
  SensorConfigRow,
  SirenConfigRow,
} from "../../../../src/core/model/rows.ts";
import { sensorRow } from "../../../scenarios/sensors/bench.ts";
import type { HubState } from "../../../../src/core/model/state.ts";
import type { StoreOp } from "../../../../src/core/model/store.ts";
import { type Mono, mono } from "../../../../src/core/model/time.ts";
import { type Core, makeCore, type Modules, MODULES } from "../../../../src/core/step.ts";
import { KeyStoreCipher } from "../../../../src/shell/cipher/device-cipher.ts";
import { UNBUILT_CALENDAR } from "../../../../src/shell/calendar/unbuilt.ts";
import { MemoryKeyStore } from "../../../../src/shell/storage/keys.ts";
import { Committed, DEVICES, entropy, FACTS, household } from "../../people/support/hub.ts";
import { CommittedRows, HUB_IDENTITY, HUB_SIGNING_PUBLIC } from "../../setup/support/driver.ts";

export const SECOND = 1_000_000;
export const WALL_AT_START = Date.UTC(2026, 10, 14);

/** A key for a seeded device: 16 bytes from its number. */
export function seededKey(id: number): Uint8Array {
  return new Uint8Array(16).map((_, i) => (id * 17 + i) & 0xff);
}

/** What one hub's disk holds: people's tables and the registry's, and the device keys. */
export class Disk {
  readonly people: Committed;
  readonly rows: CommittedRows;
  /** The sensors' and sirens' settings rows, when a test seeds them (`withSettings`). */
  readonly sensorConfig = new Map<DeviceId, SensorConfigRow>();
  readonly sirenConfig = new Map<DeviceId, SirenConfigRow>();

  constructor() {
    this.people = new Committed(household());
    this.rows = new CommittedRows();
    this.rows.site = household().site;
    for (const row of DEVICES) this.rows.devices.set(row.id, row);
    for (const row of DEVICES) this.rows.keys.set(row.id, seededKey(row.id));
  }

  /** Seeds the household's sensors and siren with settings rows at these versions. */
  withSettings(sensorVersion: number, sirenVersion: number): this {
    for (const row of DEVICES) {
      if (row.role === Role.Sensor)
        this.sensorConfig.set(row.id, sensorRow(row.id, 5, { version: sensorVersion }));
      if (row.role === Role.Siren)
        this.sirenConfig.set(row.id, {
          deviceId: row.id,
          version: sirenVersion,
          wifiIntervalS: 30,
          loraCheckUnits: 20,
          maxSoundS: 300,
          sendRate: 5,
          commandRate: 5,
          siteChannel: 1,
          versionHistory: new Uint8Array(),
        });
    }
    return this;
  }

  apply(effects: readonly Effect[]): void {
    for (const e of effects) {
      if (e.kind !== "write") continue;
      if (e.op.table === "sensor_config" && e.op.op === "upsert")
        this.sensorConfig.set(e.op.row.deviceId, e.op.row);
      if (e.op.table === "siren_config" && e.op.op === "upsert")
        this.sirenConfig.set(e.op.row.deviceId, e.op.row);
    }
    this.people.apply(effects);
    this.rows.apply(effects.flatMap((e): StoreOp[] => (e.kind === "write" ? [e.op] : [])));
  }

  snapshot(): DurableSnapshot {
    const people = this.people.snapshot();
    const rows = this.rows.snapshot();
    return {
      ...people,
      hubKeys: { signingPublic: HUB_SIGNING_PUBLIC, identity: HUB_IDENTITY },
      devices: rows.devices,
      sendCounters: rows.sendCounters,
      site: rows.site,
      provisioningKeys: rows.provisioningKeys,
      sensorConfig: [...this.sensorConfig.values()],
      sirenConfig: [...this.sirenConfig.values()],
    };
  }
}

export class PhoneHub {
  readonly core: Core;
  readonly deps: CoreDeps;
  readonly keys: MemoryKeyStore;
  readonly disk: Disk;
  state: HubState;
  at: Mono = mono(SECOND);
  readonly steps: (readonly Effect[])[] = [];
  #nextConn = 100;
  readonly #ids = new Map<ConnId, number>();
  readonly #seqs = new Map<ClientId, number>();

  constructor(disk: Disk = new Disk(), modules: Modules = MODULES) {
    this.disk = disk;
    this.core = makeCore(modules);
    this.keys = new MemoryKeyStore(disk.rows.keys);
    this.deps = {
      cipher: new KeyStoreCipher(this.keys),
      rules: DEFAULT_RULES,
      calendar: UNBUILT_CALENDAR,
      sha256: nodeSha256,
      deepFreeze: true,
      checkDeadlines: true,
    };
    this.state = this.core.emptyState();
    // Each client remembers its last `seq` (m2-design.md section 5), as the disk has it.
    for (const row of disk.people.clients.values()) this.#seqs.set(row.id, row.lastSeq);
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
      this.disk.apply(result.value.effects);
      this.keys.applyCommitted(
        result.value.effects.flatMap((e): StoreOp[] => (e.kind === "write" ? [e.op] : [])),
      );
    }
    return result;
  }

  input(event: HubEvent, bytes?: Uint8Array): readonly Effect[] {
    const result = this.try(event, bytes);
    const fault: CoreFault | undefined = result.isErr() ? result.error : undefined;
    expect(fault?.message ?? "ok").toBe("ok");
    return result.isOk() ? result.value.effects : [];
  }

  boot(id = 1): this {
    this.input({
      kind: "boot",
      snapshot: this.disk.snapshot(),
      boot: { id: bootId(id), previousExit: "clean", cause: undefined },
    });
    this.input({ kind: "hubFacts", ...FACTS });
    return this;
  }

  /** The same disk, started again (a restart after the last step's commit). */
  restart(id = 2): PhoneHub {
    const again = new PhoneHub(this.disk);
    again.at = mono(this.at + 10 * SECOND);
    return again.boot(id);
  }

  connect(client: ClientId, proto: 1 | 2 = 2, listener: "lan" | "console" = "lan"): ConnId {
    const conn = connId(this.#nextConn++);
    this.input({ kind: "clientConnected", conn, client, listener, proto, app: "2.0.0" });
    return conn;
  }

  /** The client's last `seq`, as its own storage keeps it: carried over a restart by the test. */
  seqOf(client: ClientId): number {
    return this.#seqs.get(client) ?? 0;
  }

  setSeq(client: ClientId, seq: number): void {
    this.#seqs.set(client, seq);
  }

  request(
    conn: ConnId,
    client: ClientId,
    op: AppOpV2,
    options: { readonly seq?: number; readonly bytes?: Uint8Array } = {},
  ): {
    readonly id: number;
    readonly seq: number | undefined;
    readonly effects: readonly Effect[];
  } {
    const id = (this.#ids.get(conn) ?? 0) + 1;
    this.#ids.set(conn, id);
    let seq: number | undefined;
    if (APP_OPS_V2[op.op].change) {
      seq = options.seq ?? this.seqOf(client) + 1;
      if (seq > this.seqOf(client)) this.#seqs.set(client, seq);
    }
    const effects = this.input(
      { kind: "clientRequest", conn, client, request: { id, seq, op } },
      options.bytes,
    );
    return { id, seq, effects };
  }

  /** A control command, as `hsn` sends it. */
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

  #nextRequest = 1;

  advance(ms: number): readonly Effect[] {
    this.at = mono(this.at + ms * 1000);
    return this.input({ kind: "tick" });
  }

  device(id: number): DeviceRow | undefined {
    return this.state.registry.devices.get(deviceId(id));
  }
}

// ----- Picking effects apart -----

export function framesTo(
  effects: readonly Effect[],
  conn: ConnId,
): readonly (AppMessage | AppMessageV2)[] {
  return effects.flatMap((e) => (e.kind === "appSend" && e.conn === conn ? [e.message] : []));
}

/** The one reply on `conn` in these effects, as JSON then parsed, as a client reads it. */
export function replyTo(effects: readonly Effect[], conn: ConnId): AppReplyV2 {
  const replies = framesTo(effects, conn).filter((m) => "t" in m && m.t === "res");
  expect(replies.length).toBe(1);
  return JSON.parse(JSON.stringify(replies[0])) as AppReplyV2;
}

export function eventsOn(effects: readonly Effect[], conn: ConnId): readonly AppEventV2[] {
  return framesTo(effects, conn).flatMap((m) =>
    "t" in m && m.t === "evt" ? [JSON.parse(JSON.stringify(m)) as AppEventV2] : [],
  );
}

export function okBody(reply: AppReplyV2): Record<string, unknown> {
  expect(reply.ok ? "ok" : JSON.stringify(reply.error)).toBe("ok");
  return reply.ok ? (reply.body as Record<string, unknown>) : {};
}

export function errorOf(reply: AppReplyV2): unknown {
  return reply.ok ? undefined : reply.error;
}

export { Role };

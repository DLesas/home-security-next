/**
 * What the storage, budget and crash tests share (hub-design.md section 11): a temporary data
 * folder, a clock the test sets, the real store on a real SQLite file, and rows and effects of
 * every kind the core writes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import {
  type BootId,
  bootId,
  type DeviceId,
  deviceId,
  type Seq,
  seq,
} from "../../../src/core/model/ids.ts";
import type {
  CountdownRow,
  DeviceRow,
  DeviceStateRow,
  HubEventLevel,
  RxRow,
  SensorConfigRow,
} from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES, type HubRules } from "../../../src/core/model/rules.ts";
import type { Durability, StoreOp } from "../../../src/core/model/store.ts";
import { type Mono, mono, monoAfterMs, type Now } from "../../../src/core/model/time.ts";
import type { Clock } from "../../../src/ports/clock.ts";
import type { StagedEffect } from "../../../src/ports/writer.ts";
import { type OpenedStore, openStore } from "../../../src/shell/storage/store.ts";

export const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "drizzle");
export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** 2026-11-13 00:00 UTC, the wall clock the tests start at. */
export const WALL_AT_START_MS = Date.UTC(2026, 10, 13);

/** A temporary folder; `remove` deletes it. */
export function tempDir(prefix: string): { readonly path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), `hsn-${prefix}-`));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** A clock the test moves: mono in microseconds, the wall clock following it unless set. */
export class TestClock implements Clock {
  #mono: Mono = mono(0);
  #wallAtZero = WALL_AT_START_MS;
  trusted = true;

  now(): Now {
    return { mono: this.#mono, wall: this.wall, wallTrusted: this.trusted };
  }

  get mono(): Mono {
    return this.#mono;
  }

  get wall(): number {
    return this.#wallAtZero + Math.floor(this.#mono / 1000);
  }

  advanceMs(ms: number): Mono {
    this.#mono = monoAfterMs(this.#mono, ms);
    return this.#mono;
  }

  /** A new boot: the monotonic clock starts again at zero; the wall clock keeps going. */
  reboot(offMs = 0): void {
    this.#wallAtZero = this.wall + offMs;
    this.#mono = mono(0);
  }

  setWall(wallMs: number, trusted: boolean): void {
    this.#wallAtZero = wallMs - Math.floor(this.#mono / 1000);
    this.trusted = trusted;
  }
}

export interface StoreOverrides {
  readonly rules?: HubRules;
  readonly migrations?: string;
}

/** The real store at `dir`: settings, migrations, snapshot, writer and reader. */
export function openTestStore(
  dir: string,
  clock: Clock,
  overrides: StoreOverrides = {},
): OpenedStore {
  return openStore({
    dataDir: dir,
    migrationsFolder: overrides.migrations ?? MIGRATIONS,
    clock,
    rules: overrides.rules ?? DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
}

export function write(durability: Durability, op: StoreOp): StagedEffect & Effect {
  return { kind: "write", durability, op };
}

export function record(durability: Durability, rec: AuditRecord): StagedEffect & Effect {
  return { kind: "record", durability, record: rec };
}

export const BOOT: BootId = bootId(1);

/** The n-th sequence number of boot `boot`. */
export function seqOf(boot: number, n: number): Seq {
  return seq(boot * 2 ** 32 + n);
}

export function deviceRow(id: number, name = `dev-${id}`): DeviceRow {
  return {
    id: deviceId(id),
    address: 0x5e000000 + id,
    role: 1,
    name,
    chipId: new Uint8Array([1, 2, 3, id & 0xff]),
    firmware: 0x010000,
    development: false,
    state: 1,
    addedMs: WALL_AT_START_MS,
    removedMs: null,
  };
}

export function sensorConfigRow(id: number, version = 1): SensorConfigRow {
  return {
    deviceId: deviceId(id),
    arm: 0,
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
    version,
    versionHistory: new Uint8Array([version, 5, 0]),
  };
}

export function deviceStateRow(id: number, at: Mono, reading: number): DeviceStateRow {
  return {
    deviceId: deviceId(id),
    boot: BOOT,
    lastSeenMono: at,
    lastSeenMs: WALL_AT_START_MS + Math.floor(at / 1000),
    clockOk: true,
    window: new Uint8Array(12).fill(reading & 0xff),
    reading: new Uint8Array([reading & 0xff, 0x40, 0x10]),
    rssi: -95,
    snrQ: 32,
    bestGatewayId: deviceId(2),
    uptimeS: null,
    estimates: null,
  };
}

export function countdownRow(sensor: number, cause: Seq): CountdownRow {
  return {
    sensorId: deviceId(sensor),
    boot: BOOT,
    openedMono: mono(0),
    deadlineMono: mono(30_000_000),
    newestCounter: 3392,
    replyGatewayId: deviceId(2),
    replyRate: 5,
    causeSeq: cause,
  };
}

export function rxRow(s: Seq, device: number, atMs: number, body = new Uint8Array(10)): RxRow {
  return {
    seq: s,
    atMs,
    clockOk: true,
    deviceId: deviceId(device),
    type: 0x01,
    counter: s % 1_000_000,
    path: 0,
    gatewayId: deviceId(2),
    gwUs: 500_000_000,
    rssi: -95,
    snrQ: 32,
    rate: 5,
    body,
  };
}

export function rxRecord(
  s: Seq,
  device: number,
  atMs: number,
  table: "routine" | "event" = "routine",
): AuditRecord {
  return { kind: "rx", table, row: rxRow(s, device, atMs) };
}

export function hubEventRecord(
  s: Seq,
  atMs: number,
  level: HubEventLevel,
  origin = "test",
): AuditRecord {
  return {
    kind: "hubEvent",
    row: {
      seq: s,
      atMs,
      clockOk: true,
      level,
      origin,
      code: "test",
      message: "a test event",
      detail: null,
    },
  };
}

export function sendCounterOp(device: DeviceId, resumePoint: number): StoreOp {
  return { table: "send_counters", op: "upsert", row: { deviceId: device, resumePoint } };
}

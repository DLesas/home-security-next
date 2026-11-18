/**
 * The export with history, the history file (m2-design.md section 9, "Export on demand"): JSON
 * Lines of `recordJson` rows after a first line, read in pages of 500 ‡ rows per table by `seq`
 * through the writer's connection, one page a piece, never a database image; every record
 * committed up to `upToSeq` once and in `seq` order, nothing else; no key, token or secret; door
 * reports committed and checkpointed between its pieces, none of them in it; each piece at most
 * a page of lines (and its part line); a stop half-way sends no end mark; and `restore` refuses
 * it in the design's words.
 *
 * Wall time depends on what else the machine does: the ordinary run asserts the work a piece does
 * (lines written, one page read) and only a bound generous enough for a loaded machine. Section
 * 3's 20 ms ‡ is asserted by the opt-in measurement, run alone: `HSN_TIMING=1`, with
 * `HSN_HISTORY_EXPORT_MB=240` for the largest size (the database's hard stop, section 3, with
 * `rejects` and `loss_daily` at the most their retention holds); by default a smaller one, as a
 * piece's work does not grow with the database.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { appIdentityBytes, formatIdentity } from "@hsn/protocol/app";
import { recordJson } from "../../../src/control-protocol/records.ts";
import { recordJson as historyLine } from "@hsn/protocol/records";
import { ok } from "neverthrow";
import type { ExportSink } from "../../../src/shell/backup/write.ts";
import type { HistoryDeps } from "../../../src/shell/backup/history-export.ts";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { clientId, connId, deviceId, jobId, seq, tokenId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { BACKUP_STATE_DEFAULTS, TokenKind } from "../../../src/core/model/rows.ts";
import { bootId } from "../../../src/core/model/ids.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import type { Clock } from "../../../src/ports/clock.ts";
import type { StagedEffect } from "../../../src/ports/writer.ts";
import {
  HISTORY_EXPORT_TABLES,
  HISTORY_FORMAT,
  HISTORY_ROWS_PER_PAGE,
  HistoryExport,
} from "../../../src/shell/backup/history-export.ts";
import { runToEnd } from "../../../src/shell/backup/jobs.ts";
import { readRestoreHeader, RestorePieces } from "../../../src/shell/backup/restore.ts";
import type { ExportChunk } from "../../../src/shell/backup/write.ts";
import { type OpenedStore, openStore } from "../../../src/shell/storage/store.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "drizzle");
const WALL = Date.UTC(2026, 10, 15, 3, 0, 0);
const APP_PUBLIC = new Uint8Array(32).fill(0x0a);
/** Every secret the hub holds, each a distinct fill, searched for in the file. */
const SECRETS = {
  signingPrivate: new Uint8Array(48).fill(0x51),
  appStaticPrivate: new Uint8Array(32).fill(0x52),
  tlsPrivate: new Uint8Array(40).fill(0x53),
  deviceKey: new Uint8Array(16).fill(0x54),
  psk: new Uint8Array(32).fill(0x55),
  lookup: new Uint8Array(4).fill(0x56),
  backupKey: new Uint8Array(32).fill(0x57),
};
/** The piece limit of section 3 ‡: asserted only when timing is asked for (`HSN_TIMING=1`). */
const PIECE_LIMIT_MS = 20;
/** A bound for a loaded machine (the whole suite at once): a piece doing far more than a page. */
const LOADED_BOUND_MS = 250;
const TIMING = process.env.HSN_TIMING === "1";
const folders: string[] = [];
const stores: OpenedStore[] = [];
afterEach(() => {
  for (const opened of stores.splice(0)) opened.db.close(true);
});

afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

class FixedClock implements Clock {
  now(): Now {
    return { mono: mono(1_000_000), wall: WALL, wallTrusted: true };
  }
}

function now(op: Extract<StagedEffect, { readonly kind: "write" }>["op"]): StagedEffect {
  return { kind: "write", durability: "now", op };
}

function record(r: AuditRecord, durability: "now" | "routine" = "now"): StagedEffect {
  return { kind: "record", durability, record: r };
}

/** One record of each kind in turn, its `seq` given. */
function recordAt(n: number): AuditRecord {
  const s = seq(n);
  const stamped = { seq: s, atMs: WALL + n, clockOk: true };
  const device = deviceId(3);
  switch (n % 10) {
    case 0:
      return {
        kind: "rx",
        table: "routine",
        row: {
          ...stamped,
          deviceId: device,
          type: 1,
          counter: n,
          path: 0,
          gatewayId: null,
          gwUs: null,
          gwCounter: null,
          rssi: -80,
          snrQ: 20,
          rate: 5,
          body: new Uint8Array([1, 2, 3]),
        },
      };
    case 1:
      return {
        kind: "rx",
        table: "event",
        row: {
          ...stamped,
          deviceId: device,
          type: 2,
          counter: n,
          path: 0,
          gatewayId: null,
          gwUs: null,
          gwCounter: null,
          rssi: null,
          snrQ: null,
          rate: null,
          body: new Uint8Array([4]),
        },
      };
    case 2:
    case 3:
      return {
        kind: "tx",
        table: n % 10 === 2 ? "routine" : "event",
        row: {
          ...stamped,
          deviceId: device,
          type: 3,
          counter: n,
          path: 0,
          gatewayId: null,
          requestCounter: null,
          resultCounter: null,
          rate: null,
          power: null,
          outcome: 0,
          gwSentUs: null,
          body: new Uint8Array([5]),
        },
      };
    case 4:
      return {
        kind: "decision",
        row: {
          ...stamped,
          kind: "person_added",
          deviceId: null,
          causeSeq: null,
          value: 1.5,
          detail: new Uint8Array([6]),
        },
      };
    case 5:
      return {
        kind: "deviceLog",
        row: {
          ...stamped,
          deviceId: device,
          counter: n,
          madeMs: WALL,
          level: 1,
          code: 2,
          text: new TextEncoder().encode("hello"),
          repeatOf: null,
        },
      };
    case 6:
      return {
        kind: "hubEvent",
        row: {
          ...stamped,
          level: "info",
          origin: "test",
          code: "backup_written",
          message: 'a "quoted" line\nwith a break',
          detail: null,
        },
      };
    case 7:
      return {
        kind: "command",
        row: { ...stamped, actor: "d", kind: "arm", args: "{}", outcome: "ok", detail: null },
      };
    case 8:
      return {
        kind: "notification",
        row: {
          ...stamped,
          kind: "door_opened",
          category: "doors",
          critical: n % 20 === 8,
          deviceId: device,
          causeSeq: null,
          recipients: new Uint8Array([1, 0, 0, 0]),
          detail: null,
        },
      };
    default:
      return {
        kind: "notificationRead",
        row: { ...stamped, notificationSeq: seq(Math.max(1, n - 1)), clientId: clientId(2) },
      };
  }
}

/** A hub's database: its keys and every secret, and `records` audit records of every kind. */
function hub(dataDir: string, records: number): OpenedStore {
  const store = openStore({
    dataDir,
    migrationsFolder: MIGRATIONS,
    clock: new FixedClock(),
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
  store.writer.stage([
    now({
      table: "hub_keys",
      op: "upsert",
      row: {
        signingPrivate: SECRETS.signingPrivate,
        signingPublic: new Uint8Array(64).fill(0x61),
        identity: new Uint8Array(8).fill(0x62),
        appStaticPrivate: SECRETS.appStaticPrivate,
        appStaticPublic: APP_PUBLIC,
        tlsPrivate: SECRETS.tlsPrivate,
        tlsCertificate: null,
      },
    }),
    now({
      table: "device_keys",
      op: "upsert",
      row: { deviceId: deviceId(3), key: SECRETS.deviceKey },
    }),
    now({
      table: "link_tokens",
      op: "upsert",
      row: {
        id: tokenId(5),
        lookup: SECRETS.lookup,
        kind: TokenKind.NewPerson,
        personId: null,
        personName: null,
        createdByClient: null,
        createdBoot: bootId(1),
        createdMono: mono(0),
        expiresAfterMs: 600_000,
        typed: false,
        failures: 0,
        usedMs: null,
      },
    }),
    now({ table: "link_secrets", op: "upsert", row: { tokenId: tokenId(5), psk: SECRETS.psk } }),
    now({ table: "backup_key", op: "upsert", row: { key: SECRETS.backupKey, epoch: 2 } }),
    now({ table: "backup_state", op: "upsert", row: { ...BACKUP_STATE_DEFAULTS } }),
    // A rejection count: in the file's `rejects` part, not among the records.
    record({
      kind: "reject",
      row: {
        minute: 1,
        via: "device:3",
        reason: "badTag",
        count: 2,
        address: 1,
        sample: new Uint8Array(4),
      },
    }),
  ]);
  expect(store.writer.flush("now").isOk()).toBe(true);
  for (let from = 1; from <= records; from += 2000) {
    const batch: StagedEffect[] = [];
    for (let n = from; n < from + 2000 && n <= records; n++) batch.push(record(recordAt(n)));
    store.writer.stage(batch);
    expect(store.writer.flush("now").isOk()).toBe(true);
  }
  stores.push(store);
  return store;
}

const WALL_MINUTE = Math.floor(WALL / 60_000);
const WALL_DAY = Math.floor(WALL / 86_400_000);
const VIAS = ["device:1", "device:2", "device:3"];
const REASONS = ["badTag", "duplicate", "tooOld", "unknownAddress"];

/**
 * `rejects` rows for the last `minutes` minutes before the export, three sources and four reasons
 * each, and `loss_daily` rows for `devices` devices over the 31 days retention keeps; and one of
 * each after the export's minute and day, which it leaves out.
 */
function fillParts(store: OpenedStore, minutes: number, devices: number): void {
  const db = store.db;
  const reject = db.query(
    "INSERT INTO rejects (minute, via, reason, count, address, sample) VALUES (?,?,?,?,?,?)",
  );
  const sample = new Uint8Array(16).fill(3);
  db.run("BEGIN");
  for (let m = WALL_MINUTE - minutes + 1; m <= WALL_MINUTE + 1; m++)
    for (const via of VIAS)
      for (const reason of REASONS)
        if (m !== 1 || via !== "device:3" || reason !== "badTag")
          reject.run(m, via, reason, 1, 7, sample);
  const loss = db.query(
    "INSERT INTO loss_daily (device_id, day, received, expected) VALUES (?,?,?,?)",
  );
  for (let day = WALL_DAY - 30; day <= WALL_DAY + 1; day++)
    for (let d = 1; d <= devices; d++) loss.run(d, day, 90, 96);
  db.run("COMMIT");
}

/** The lines of each part: the records, `rejects` and `lossDaily`, after their part lines. */
function parts(text: string): { records: unknown[]; rejects: unknown[]; loss: unknown[] } {
  const lines = text
    .slice(0, -1)
    .split("\n")
    .map((l): unknown => JSON.parse(l));
  const r = lines.findIndex((l) => JSON.stringify(l) === '{"part":"rejects"}');
  const d = lines.findIndex((l) => JSON.stringify(l) === '{"part":"lossDaily"}');
  expect(r).toBeGreaterThan(0);
  expect(d).toBeGreaterThan(r);
  return { records: lines.slice(1, r), rejects: lines.slice(r + 1, d), loss: lines.slice(d + 1) };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hsn-history-"));
  folders.push(root);
});

function collect(): { chunks: ExportChunk[]; sink: ExportSink } {
  const chunks: ExportChunk[] = [];
  return {
    chunks,
    sink: {
      send: (_c, chunk) => {
        chunks.push(chunk);
        return ok(undefined);
      },
    },
  };
}

function deps(store: OpenedStore): HistoryDeps {
  return {
    nowMs: () => WALL,
    salt: () => ok(new Uint8Array(8)),
    flush: () => store.writer.flush("log").mapErr((e) => e.message),
  };
}

function textOf(chunks: readonly ExportChunk[]): string {
  return Buffer.concat(chunks.map((c) => Buffer.from(c.data, "base64url"))).toString("utf8");
}

/** Every `(table, seq)` the audit tables hold, as the file's lines name them. */
function heldBy(store: OpenedStore, upTo: number): string[] {
  const held: string[] = [];
  for (const table of HISTORY_EXPORT_TABLES)
    for (const row of store.db
      .query<{ seq: number }, [number]>(`SELECT seq FROM "${table}" WHERE seq <= ? ORDER BY seq`)
      .all(upTo))
      held.push(`${table}:${row.seq}`);
  return held.toSorted();
}

const TABLE_OF: Readonly<Record<string, string>> = {
  "rx:routine": "rx_routine",
  "rx:event": "rx_event",
  "tx:routine": "tx_routine",
  "tx:event": "tx_event",
  decision: "decisions",
  deviceLog: "device_log",
  hubEvent: "hub_events",
  command: "commands",
  notification: "notifications",
  notificationRead: "notification_reads",
};

describe("the history file", () => {
  test("JSON Lines: the first line, then every record up to upToSeq once, in seq order, as recordJson; the end mark's hash", () => {
    const store = hub(join(root, "data"), 3_456);
    const { chunks, sink } = collect();
    const done = runToEnd(
      jobId(7),
      { kind: "export", conn: connId(4), history: true, key: SECRETS.backupKey, epoch: 2 },
      {
        db: store.db,
        dataDir: join(root, "data"),
        migrationsFolder: MIGRATIONS,
        rules: DEFAULT_RULES,
        uploads: { pathOf: () => undefined },
        exports: sink,
        prefix: undefined,
        switchBlockedBy: () => undefined,
        ...deps(store),
      },
    );
    expect(done).toMatchObject({ kind: "ready", outcome: { kind: "exportSent" } });
    for (const c of chunks)
      expect(Buffer.from(c.data, "base64url").length).toBeLessThanOrEqual(48_000);
    const whole = Buffer.concat(chunks.map((c) => Buffer.from(c.data, "base64url")));
    expect(chunks.at(-1)?.end).toEqual({
      chunks: chunks.length,
      sha256: Buffer.from(sha256(new Uint8Array(whole))).toString("hex"),
    });
    const text = whole.toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text
      .slice(0, -1)
      .split("\n")
      .map((l): unknown => JSON.parse(l));
    expect(lines[0]).toEqual({
      format: HISTORY_FORMAT,
      hub: formatIdentity(appIdentityBytes(sha256, APP_PUBLIC)),
      madeMs: WALL,
      schema: expect.any(Number) as unknown,
      upToSeq: 3_456,
    });
    const rows = parts(text).records.map((l) => recordJson.parse(l));
    const seqs = rows.map((r) => (r.kind === "reject" ? -1 : r.row.seq));
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(rows.some((r) => r.kind === "reject")).toBe(false);
    const named = rows
      .map((r) => {
        const key = "table" in r ? `${r.kind}:${r.table}` : r.kind;
        return `${TABLE_OF[key] ?? key}:${r.kind === "reject" ? -1 : r.row.seq}`;
      })
      .toSorted();
    expect(named).toEqual(heldBy(store, 3_456));
    // Exactly as `hsn log --json` gives a row.
    expect(rows[5]).toEqual({
      kind: "hubEvent",
      row: {
        seq: 6,
        atMs: WALL + 6,
        clockOk: true,
        level: "info",
        origin: "test",
        code: "backup_written",
        message: 'a "quoted" line\nwith a break',
        detail: null,
      },
    });
  });

  test("then rejects and lossDaily: every row of each once, in key order, up to the export's minute and day", () => {
    const store = hub(join(root, "data"), 200);
    fillParts(store, 3_000, 75);
    const { chunks, sink } = collect();
    const job = new HistoryExport(store.db, 1, { conn: connId(4) }, sink, deps(store));
    while (job.next() === undefined);
    const { rejects, loss } = parts(textOf(chunks));
    const expectedRejects = store.db
      .query<Record<string, unknown>, [number]>(
        "SELECT * FROM rejects WHERE minute <= ? ORDER BY minute, via, reason",
      )
      .all(WALL_MINUTE)
      .map((row) => ({
        kind: "reject",
        row: {
          minute: row.minute,
          via: row.via,
          reason: row.reason,
          count: row.count,
          address: row.address,
          sample: Buffer.from(row.sample as Uint8Array).toString("hex"),
        },
      }));
    // The fixture's one at minute 1 too.
    expect(expectedRejects).toHaveLength(3_000 * 12 + 1);
    expect(rejects).toEqual(expectedRejects);
    for (const line of rejects) expect(recordJson.safeParse(line).success).toBe(true);
    const expectedLoss = store.db
      .query<Record<string, number>, [number]>(
        "SELECT * FROM loss_daily WHERE day <= ? ORDER BY day, device_id",
      )
      .all(WALL_DAY)
      .map((row) => ({
        kind: "lossDaily",
        row: {
          deviceId: row.device_id,
          day: row.day,
          received: row.received,
          expected: row.expected,
        },
      }));
    expect(expectedLoss).toHaveLength(31 * 75);
    expect(loss).toEqual(expectedLoss);
    for (const line of loss) expect(historyLine.safeParse(line).success).toBe(true);
  });

  test("no key, token or secret: none of the hub's secrets is in it, as hex or base64", () => {
    const store = hub(join(root, "data"), 500);
    const { chunks, sink } = collect();
    const job = new HistoryExport(store.db, 1, { conn: connId(4) }, sink, deps(store));
    while (job.next() === undefined);
    const text = textOf(chunks);
    for (const secret of Object.values(SECRETS)) {
      expect(text).not.toContain(Buffer.from(secret).toString("hex"));
      expect(text).not.toContain(Buffer.from(secret).toString("base64").slice(0, 12));
    }
    for (const table of ["hub_keys", "device_keys", "link_tokens", "link_secrets", "backup_key"])
      for (const row of store.db.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all())
        for (const value of Object.values(row))
          if (value instanceof Uint8Array && value.length >= 4 && !value.every((b) => b === 0))
            expect(text).not.toContain(Buffer.from(value).toString("hex"));
  });

  test("what is staged is flushed first: a routine record not yet committed is in it", () => {
    const store = hub(join(root, "data"), 100);
    store.writer.stage([record(recordAt(101), "routine")]);
    const { chunks, sink } = collect();
    const job = new HistoryExport(store.db, 1, { conn: connId(4) }, sink, deps(store));
    while (job.next() === undefined);
    expect(job.upToSeq).toBe(101);
    expect(textOf(chunks)).toContain('"seq":101,');
  });

  test("a stop half-way: no end mark, nothing more sent", () => {
    const store = hub(join(root, "data"), 6_000);
    const { chunks, sink } = collect();
    const job = new HistoryExport(store.db, 1, { conn: connId(4) }, sink, deps(store));
    for (let i = 0; i < 30; i++) expect(job.next()).toBeUndefined();
    const before = chunks.length;
    expect(before).toBeGreaterThan(0);
    expect(job.abort("the hub is stopping")).toMatchObject({ kind: "failed", reason: "io" });
    expect(job.next()).toMatchObject({ kind: "failed" });
    expect(chunks).toHaveLength(before);
    expect(chunks.some((c) => c.end !== undefined)).toBe(false);
  });

  test("restore refuses it: badFile, this is a history export, not a backup", () => {
    const store = hub(join(root, "data"), 300);
    const { chunks, sink } = collect();
    const job = new HistoryExport(store.db, 1, { conn: connId(4) }, sink, deps(store));
    while (job.next() === undefined);
    const path = join(root, "history.jsonl");
    writeFileSync(path, textOf(chunks));
    const refused: FileOutcome = {
      kind: "failed",
      reason: "badFile",
      message: "this is a history export, not a backup",
    };
    expect(readRestoreHeader(path)).toEqual(refused);
    const pieces = new RestorePieces({
      dataDir: join(root, "new"),
      uploadPath: path,
      key: SECRETS.backupKey,
      migrationsFolder: MIGRATIONS,
      rules: DEFAULT_RULES,
    });
    let outcome;
    while ((outcome = pieces.next()) === undefined);
    expect(outcome).toEqual(refused);
  });

  test("in pieces of a page: at most a page of lines a piece, door reports committed and checkpointed between them and not in it", () => {
    const mb = Number(process.env.HSN_HISTORY_EXPORT_MB ?? "6");
    const data = join(root, "data");
    const store = hub(data, 2_000);
    // Both tables without a `seq` at the most their 30-day retention holds at the largest site
    // (every minute, three gateways, four reasons; 75 devices), or a smaller part by default.
    const full = mb >= 240;
    const minutes = full ? 30 * 1440 : 2_000;
    fillParts(store, minutes, 75);
    // Then fill to the size asked (the size guard's hard stop at most) with door reports' rows.
    const db = store.db;
    let n = 2_001;
    const insert = db.query(
      "INSERT INTO rx_event (seq,at_ms,clock_ok,device_id,type,counter,path,rssi,snr_q,rate,body) VALUES (?,?,1,3,2,?,0,-80,20,5,?)",
    );
    const body = new Uint8Array(24).fill(7);
    const size = (): number =>
      statSync(join(data, "hub.db")).size +
      (statSync(join(data, "hub.db-wal"), { throwIfNoEntry: false })?.size ?? 0);
    // Short of the hard stop by a few megabytes, so the reports during the export still fit.
    while (size() < Math.min(mb, 236) * 1e6) {
      db.run("BEGIN");
      for (let k = 0; k < 20_000; k++, n++) insert.run(n, WALL + n, n, body);
      db.run("COMMIT");
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    const upTo = n - 1;
    const { chunks, sink } = collect();
    const job = new HistoryExport(db, 1, { conn: connId(4) }, sink, deps(store));
    let longest = 0;
    let pieces = 0;
    let doors = 0;
    const doorSeqs: number[] = [];
    let outcome;
    for (;;) {
      const t = performance.now();
      const linesBefore = job.lines;
      outcome = job.next();
      longest = Math.max(longest, performance.now() - t);
      pieces += 1;
      // A piece writes at most a page of lines, and a part's opening line.
      expect(job.lines - linesBefore).toBeLessThanOrEqual(HISTORY_ROWS_PER_PAGE + 1);
      if (outcome !== undefined) break;
      // A door report between pieces, committed now, and the log checkpointed in full: no
      // read of the export's holds the write-ahead log.
      if (pieces % 50 === 0) {
        // A door report (`rx_event`, seq ≡ 1 mod 10), into the table the export is reading.
        const door = (Math.floor(upTo / 10) + 1 + doors) * 10 + 1;
        doorSeqs.push(door);
        store.writer.stage([record(recordAt(door))]);
        expect(store.writer.flush("now").isOk()).toBe(true);
        const cp = db
          .query<{ busy: number; log: number; checkpointed: number }, []>(
            "PRAGMA wal_checkpoint(PASSIVE)",
          )
          .get();
        expect(cp?.busy).toBe(0);
        expect(cp?.checkpointed).toBe(cp?.log);
        doors += 1;
      }
    }
    expect(outcome).toMatchObject({ kind: "exportSent" });
    expect(doors).toBeGreaterThan(0);
    expect(job.upToSeq).toBe(upTo);
    const text = textOf(chunks);
    for (const door of doorSeqs) expect(text).not.toContain(`"seq":${door},`);
    // The first line, the records, two part lines, and both parts' rows.
    expect(job.lines).toBe(1 + upTo + 2 + minutes * 12 + 1 + 31 * 75);
    expect(pieces).toBeGreaterThan(upTo / HISTORY_ROWS_PER_PAGE);
    console.log(
      `history export of ${mb} MB, ${minutes * 12} rejects, ${31 * 75} loss rows: ${pieces} pieces, longest ${longest.toFixed(1)} ms, ${(text.length / 1e6).toFixed(0)} MB of JSON Lines`,
    );
    expect(longest).toBeLessThan(TIMING ? PIECE_LIMIT_MS : LOADED_BOUND_MS);
  });
});

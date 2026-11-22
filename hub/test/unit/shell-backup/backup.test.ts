/**
 * The shell's backup, export and restore on real files and a real hub database (m2-design.md
 * section 9): the file encrypted before a byte reaches disk, holding the configuration and keys and
 * never a link token, a stored reply or history; written through a temporary file and renamed; the
 * newest `keep` kept and older epochs deleted; an unreachable folder answered `unreachable`; an
 * export streamed in chunks with the hash of the whole and nothing written; and a restore that
 * leaves the running hub as it was until the switch, raises every client's `seq` and every send
 * counter, keeps the clients as the file has them, restores no token, and boots.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { appIdentityBytes, backupCodec, formatIdentity } from "@hsn/protocol/app";
import { err, ok } from "neverthrow";
import type { StagedEffect } from "../../../src/ports/writer.ts";
import {
  bootId,
  clientId,
  connId,
  deviceId,
  jobId,
  personId,
  tokenId,
} from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  BACKUP_STATE_DEFAULTS,
  ClientKind,
  DeviceState,
  TokenKind,
} from "../../../src/core/model/rows.ts";
import type { StoreOp } from "../../../src/core/model/store.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import type { Clock } from "../../../src/ports/clock.ts";
import { BACKUP_TABLES, NEVER_TABLES } from "../../../src/shell/backup/contents.ts";
import { ExportPieces } from "../../../src/shell/backup/export-pieces.ts";
import { jobToEnd, runToEnd } from "../../../src/shell/backup/jobs.ts";
import {
  BEFORE_RESTORE_FILE,
  RESTORE_FILE,
  RESTORE_ROWS_PER_PIECE,
  RestorePieces,
  swapRestored,
} from "../../../src/shell/backup/restore.ts";
import { SEAL_PIECE_BYTES, SealStream } from "../../../src/shell/backup/sealing.ts";
import { BackupPieces, type ExportChunk } from "../../../src/shell/backup/write.ts";
import { type OpenedStore, openStore } from "../../../src/shell/storage/store.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "drizzle");
const WALL = Date.UTC(2026, 10, 14, 3, 0, 0);
const KEY = new Uint8Array(32).fill(0x31);
const PHONE_KEY = new Uint8Array(32).fill(0x77);
const APP_PUBLIC = new Uint8Array(32).fill(0x0a);
const DEVICE_KEY = new Uint8Array(16).fill(0xd1);
const PSK = new Uint8Array(32).fill(0xee);
const NAME = "Anna-the-unique-name";
const folders: string[] = [];
const stores: OpenedStore[] = [];
afterEach(() => {
  for (const opened of stores.splice(0)) opened.db.close(true);
});

afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

class FixedClock implements Clock {
  wall = WALL;
  now(): Now {
    return { mono: mono(1_000_000), wall: this.wall, wallTrusted: true };
  }
}

function now(op: StoreOp): StagedEffect {
  return { kind: "write", durability: "now", op };
}

/** A hub's database with a person, a client, a device, a link token and a stored reply. */
function hub(dataDir: string, clock: FixedClock): OpenedStore {
  const opened = openStore({
    dataDir,
    migrationsFolder: MIGRATIONS,
    clock,
    rules: DEFAULT_RULES,
    platform: process.platform,
  });
  expect(opened.isOk()).toBe(true);
  const store = opened._unsafeUnwrap();
  const sensor = deviceId(3);
  store.writer.stage([
    now({
      table: "hub_keys",
      op: "upsert",
      row: {
        signingPrivate: new Uint8Array(8),
        signingPublic: new Uint8Array(64),
        identity: new Uint8Array(8),
        appStaticPrivate: new Uint8Array(32),
        appStaticPublic: APP_PUBLIC,
        tlsPrivate: null,
        tlsCertificate: null,
      },
    }),
    now({
      table: "people",
      op: "upsert",
      row: { id: personId(1), name: NAME, createdMs: WALL, removedMs: null, revision: 1 },
    }),
    now({
      table: "clients",
      op: "upsert",
      row: {
        id: clientId(2),
        personId: personId(1),
        staticKey: new Uint8Array(32).fill(2),
        kind: ClientKind.Web,
        name: "laptop",
        linkedByClient: null,
        createdMs: WALL,
        removedMs: null,
        lastSeq: 41,
        lastSeenMs: null,
        backupKeyEpoch: null,
      },
    }),
    now({
      table: "client_replies",
      op: "upsert",
      row: { clientId: clientId(2), seq: 41, reply: new TextEncoder().encode('{"t":"res"}') },
    }),
    now({
      table: "devices",
      op: "upsert",
      row: {
        id: sensor,
        address: 0x1234,
        role: 1,
        name: "front",
        chipId: new Uint8Array(8),
        firmware: 65536,
        development: false,
        state: DeviceState.Paired,
        addedMs: WALL,
        removedMs: null,
      },
    }),
    now({
      table: "device_keys",
      op: "upsert",
      row: { deviceId: sensor, key: DEVICE_KEY, nextKey: null, rekey: 0 },
    }),
    now({ table: "send_counters", op: "upsert", row: { deviceId: sensor, resumePoint: 2048 } }),
    now({
      table: "link_tokens",
      op: "upsert",
      row: {
        id: tokenId(5),
        lookup: new Uint8Array(4).fill(1),
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
    now({ table: "link_secrets", op: "upsert", row: { tokenId: tokenId(5), psk: PSK } }),
    now({
      table: "backup_state",
      op: "upsert",
      row: { ...BACKUP_STATE_DEFAULTS, lastChangeMs: WALL - 5000 },
    }),
  ]);
  expect(store.writer.flush("now").isOk()).toBe(true);
  stores.push(store);
  return store;
}

let root: string;
let data: string;
let folder: string;
let clock: FixedClock;
let store: OpenedStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hsn-backup-"));
  folders.push(root);
  data = join(root, "data");
  folder = join(root, "backups");
  mkdirSync(folder);
  clock = new FixedClock();
  store = hub(data, clock);
});

const uploads = new Map<string, string>();

function deps(over: Partial<Parameters<typeof runToEnd>[2]> = {}): Parameters<typeof runToEnd>[2] {
  return {
    db: store.db,
    dataDir: data,
    migrationsFolder: MIGRATIONS,
    rules: DEFAULT_RULES,
    uploads: { pathOf: (ref) => uploads.get(`${ref.conn}/${ref.job}`) },
    exports: { send: () => ok(undefined) },
    prefix: undefined,
    switchBlockedBy: () => undefined,
    nowMs: () => clock.wall,
    salt: () => ok(new Uint8Array(8).fill(9)),
    ...over,
  };
}

/** A backup through the hub's own job, its file work on its worker. */
function backup(epoch = 1, keep = 20): ReturnType<typeof jobToEnd> {
  return jobToEnd(jobId(1), { kind: "backup", folder, keep, key: KEY, epoch }, deps());
}

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(hay).includes(Buffer.from(needle));
}

function openFile(bytes: Uint8Array, key: Uint8Array = KEY): Database {
  const opened = backupCodec.open(key, bytes);
  expect(opened.ok).toBe(true);
  return Database.deserialize(opened.ok ? opened.value.database : new Uint8Array());
}

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
}

describe("a backup into the folder", () => {
  test("named for this hub and time; the configuration and keys, no token, no reply, no history", async () => {
    const done = await backup();
    expect(done).toMatchObject({ kind: "ready", outcome: { kind: "backupWritten" } });
    const identity = formatIdentity(appIdentityBytes(sha256, APP_PUBLIC));
    const names = readdirSync(folder);
    expect(names).toEqual([`hsn-${identity}-20261114T030000000Z.hsnb`]);
    const bytes = new Uint8Array(readFileSync(join(folder, names[0] ?? "")));
    const header = backupCodec.readHeader(bytes);
    expect(header.ok && header.value).toMatchObject({
      epoch: 1,
      madeMs: WALL,
      lastChangeMs: WALL - 5000,
      flags: 0,
    });
    const db = openFile(bytes);
    expect(new Set(tables(db))).toEqual(new Set(BACKUP_TABLES));
    for (const never of NEVER_TABLES) expect(tables(db)).not.toContain(never);
    expect(db.query("SELECT name FROM people").all()).toEqual([{ name: NAME }]);
    expect(db.query<{ key: Uint8Array }, []>("SELECT key FROM device_keys").get()?.key).toEqual(
      DEVICE_KEY,
    );
    // The commit mark is this boot's, not the home's.
    expect(db.query("SELECT device_id FROM device_state WHERE device_id = 0").all()).toEqual([]);
  });

  test("encrypted before a byte reaches disk: no name, no device key, no backup key in the folder", async () => {
    await backup();
    for (const name of readdirSync(folder)) {
      const bytes = new Uint8Array(readFileSync(join(folder, name)));
      expect(contains(bytes, new TextEncoder().encode(NAME))).toBe(false);
      expect(contains(bytes, DEVICE_KEY)).toBe(false);
      expect(contains(bytes, KEY)).toBe(false);
    }
    expect(readdirSync(folder).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("the newest `keep` kept, and this hub's files of an older epoch deleted", async () => {
    for (let i = 0; i < 4; i++) {
      clock.wall = WALL + i * 60_000;
      await backup(1, 3);
    }
    expect(readdirSync(folder)).toHaveLength(3);
    expect(readdirSync(folder).toSorted()[0]).toContain("T030100000Z");
    writeFileSync(join(folder, "someone-else.txt"), "kept");
    clock.wall = WALL + 10 * 60_000;
    await backup(2, 3);
    const left = readdirSync(folder).toSorted();
    expect(left).toEqual([
      "hsn-" + formatIdentity(appIdentityBytes(sha256, APP_PUBLIC)) + "-20261114T031000000Z.hsnb",
      "someone-else.txt",
    ]);
  });

  test("an unreachable folder is `unreachable`, and nothing is written", async () => {
    const done = await jobToEnd(
      jobId(1),
      { kind: "backup", folder: join(root, "unplugged"), keep: 20, key: KEY, epoch: 1 },
      deps(),
    );
    expect(done).toMatchObject({
      kind: "ready",
      outcome: { kind: "failed", reason: "unreachable" },
    });
    expect(existsSync(join(root, "unplugged"))).toBe(false);
  });
});

describe("an export", () => {
  test("without history: the configuration backup a scheduled one writes, in chunks of at most 48 KB with the hash of the whole; nothing on disk", async () => {
    const chunks: ExportChunk[] = [];
    const before = readdirSync(data).toSorted();
    const done = runToEnd(
      jobId(7),
      { kind: "export", conn: connId(4), history: false, key: KEY, epoch: 1 },
      deps({
        exports: {
          send: (conn, chunk) => {
            expect(conn).toBe(connId(4));
            chunks.push(chunk);
            return ok(undefined);
          },
        },
      }),
    );
    expect(done).toMatchObject({ kind: "ready", outcome: { kind: "exportSent" } });
    expect(readdirSync(data).toSorted()).toEqual(before);
    expect(readdirSync(folder)).toEqual([]);
    const parts = chunks.map((c) => Buffer.from(c.data, "base64url"));
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(48_000);
    expect(chunks.map((c) => c.n)).toEqual(chunks.map((_, i) => i));
    const whole = new Uint8Array(Buffer.concat(parts));
    const end = chunks.at(-1)?.end;
    expect(end).toEqual({
      chunks: chunks.length,
      sha256: Buffer.from(sha256(whole)).toString("hex"),
    });
    const header = backupCodec.readHeader(whole);
    // Every flag zero (bit 0, history, retired): exactly a scheduled backup's file.
    expect(header.ok && header.value.flags).toBe(0);
    const scheduled = await backup();
    expect(scheduled).toMatchObject({ kind: "ready", outcome: { kind: "backupWritten" } });
    const name = readdirSync(folder)[0] ?? "";
    expect(tables(openFile(whole))).toEqual(
      tables(openFile(new Uint8Array(readFileSync(join(folder, name))))),
    );
    expect(tables(openFile(whole))).not.toContain("decisions");
    expect(tables(openFile(whole))).not.toContain("link_secrets");
  });
});

describe("an export in pieces", () => {
  test("a stop half-way ends it, and nothing more is sent", () => {
    const sent: ExportChunk[] = [];
    const pieces = new ExportPieces(
      store.db,
      9,
      { conn: connId(4), key: KEY, epoch: 1 },
      {
        send: (_c, chunk) => {
          sent.push(chunk);
          return ok(undefined);
        },
      },
      deps(),
    );
    pieces.next();
    expect(pieces.abort("the hub is stopping")).toMatchObject({ kind: "failed", reason: "io" });
    expect(pieces.next()).toMatchObject({ kind: "failed" });
    expect(sent).toEqual([]);
  });
});

describe("sealing in pieces", () => {
  test("at most SEAL_PIECE_BYTES of plaintext a call, and the file the one-call seal makes", () => {
    const plain = new Uint8Array(1024 * 1024 + 123).map((_, i) => i & 255);
    const header = {
      format: 1,
      flags: 0,
      identity: new Uint8Array(16),
      epoch: 1,
      madeMs: 0,
      schema: 3,
      salt: new Uint8Array(8),
      lastChangeMs: 0,
    };
    const stream = SealStream.start(KEY, header, plain);
    expect(typeof stream).not.toBe("string");
    const parts: Uint8Array[] = [];
    let calls = 0;
    while (typeof stream !== "string" && !stream.done) {
      const part = stream.next();
      expect(typeof part).not.toBe("string");
      if (typeof part !== "string") parts.push(part);
      calls += 1;
    }
    expect(SEAL_PIECE_BYTES).toBeLessThanOrEqual(256 * 1024);
    expect(calls).toBe(Math.ceil(plain.length / SEAL_PIECE_BYTES));
    const whole = backupCodec.seal(KEY, header, plain);
    expect(whole.ok && Buffer.concat(parts).equals(Buffer.from(whole.value))).toBe(true);
  });
});

describe("an upload that is not there", () => {
  test("readRestore, applyRestore and stageUpdate end in noUpload, not badFile", () => {
    const upload = { conn: connId(8), job: 77 };
    const works = [
      { kind: "readRestore", upload },
      { kind: "applyRestore", upload, key: KEY },
      { kind: "stageUpdate", upload },
    ] as const;
    for (const work of works) {
      const done = runToEnd(jobId(1), work, deps());
      expect(done.kind === "ready" ? done.outcome : undefined).toMatchObject({
        kind: "failed",
        reason: "noUpload",
      });
    }
  });
});

describe("a backup in pieces", () => {
  test("a stop before it is placed leaves no temporary file", () => {
    const pieces = new BackupPieces(store.db, { folder, keep: 20, key: KEY, epoch: 1 }, deps());
    pieces.next();
    expect(readdirSync(folder).some((n) => n.endsWith(".tmp"))).toBe(true);
    expect(pieces.abort("the hub is stopping")).toMatchObject({ kind: "failed" });
    expect(readdirSync(folder)).toEqual([]);
  });
});

describe("an export that stops part way", () => {
  test("failed, saying how far it got, and nothing more sent after the failure", () => {
    let sent = 0;
    const done = runToEnd(
      jobId(7),
      { kind: "export", conn: connId(4), history: false, key: KEY, epoch: 1 },
      deps({
        exports: {
          send: () => {
            sent += 1;
            return sent === 1 ? ok(undefined) : err("the connection is gone");
          },
        },
      }),
    );
    expect(done).toMatchObject({ kind: "ready", outcome: { kind: "failed", reason: "io" } });
    expect(
      done.kind === "ready" && done.outcome.kind === "failed" ? done.outcome.message : "",
    ).toContain("after chunk 1 of");
    expect(sent).toBe(2);
  });
});

describe("restore", () => {
  /** A backup of the old hub, as a phone's key would unlock it, uploaded to a new hub. */
  function uploaded(): {
    readonly path: string;
    readonly newStore: OpenedStore;
    readonly newData: string;
  } {
    // On the thread, at once: the backup is this restore's input (its worker: `write-job.test.ts`).
    runToEnd(
      jobId(1),
      { kind: "backup", folder, keep: 20, key: KEY, epoch: 3 },
      deps({ onThread: true }),
    );
    const file = join(folder, readdirSync(folder)[0] ?? "");
    const upload = join(root, "upload.hsnb");
    writeFileSync(upload, readFileSync(file));
    uploads.set("9/1", upload);
    store.writer.stop().match(
      () => undefined,
      () => undefined,
    );
    const newData = join(root, "new");
    const opened = openStore({
      dataDir: newData,
      migrationsFolder: MIGRATIONS,
      clock,
      rules: DEFAULT_RULES,
      platform: process.platform,
    });
    const newStore = opened._unsafeUnwrap();
    stores.push(newStore);
    store = newStore;
    return { path: upload, newStore, newData };
  }

  /** An export with history, big enough for several chunks, as the restore's upload. */
  function bigUpload(): {
    readonly path: string;
    readonly newData: string;
    readonly newStore: OpenedStore;
  } {
    const db = store.db;
    db.run("BEGIN");
    const device = db.query(
      "INSERT INTO devices (id,address,role,name,chip_id,firmware,development,state,added_ms) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    for (let i = 10; i < 8010; i++)
      device.run(i, 0x4000 + i, 1, `door-${i}`, new Uint8Array(8).fill(i & 255), 65536, 0, 1, WALL);
    db.run("COMMIT");
    const chunks: ExportChunk[] = [];
    const pieces = new ExportPieces(
      db,
      9,
      { conn: connId(4), key: KEY, epoch: 3 },
      {
        send: (_c, chunk) => {
          chunks.push(chunk);
          return ok(undefined);
        },
      },
      deps(),
    );
    while (pieces.next() === undefined);
    const path = join(root, "big.hsnb");
    writeFileSync(path, Buffer.concat(chunks.map((c) => Buffer.from(c.data, "base64url"))));
    uploads.set("9/2", path);
    store.writer.stop().match(
      () => undefined,
      () => undefined,
    );
    const newData = join(root, "new2");
    const newStore = openStore({
      dataDir: newData,
      migrationsFolder: MIGRATIONS,
      clock,
      rules: DEFAULT_RULES,
      platform: process.platform,
    })._unsafeUnwrap();
    stores.push(newStore);
    store = newStore;
    return { path, newData, newStore };
  }

  test("a damaged chunk after the first: badFile, and nothing of the file left on disk", () => {
    const { path, newData } = bigUpload();
    const file = readFileSync(path);
    expect(file.length).toBeGreaterThan(3 * 65_552);
    file[64 + 2 * 65_552 + 100] = (file[64 + 2 * 65_552 + 100] ?? 0) ^ 1;
    writeFileSync(path, file);
    const before = readdirSync(newData).toSorted();
    const pieces = new RestorePieces({
      dataDir: newData,
      uploadPath: path,
      key: KEY,
      migrationsFolder: MIGRATIONS,
      rules: DEFAULT_RULES,
    });
    let outcome;
    // Only the opened chunks' scratch file, readable by the hub's account alone, meanwhile.
    while ((outcome = pieces.next()) === undefined) {
      const now = readdirSync(newData).toSorted();
      expect(now.filter((f) => !before.includes(f))).toEqual(["hub.db.restore.new.plain"]);
      // POSIX mode bits describe the plaintext file only on Unix.
      if (process.platform !== "win32")
        expect(statSync(join(newData, "hub.db.restore.new.plain")).mode & 0o077).toBe(0);
    }
    expect(outcome).toMatchObject({ kind: "failed", reason: "badFile" });
    expect(readdirSync(newData).toSorted()).toEqual(before);
  });

  test("the first chunk not opening is wrongKey; the whole file in pieces when it opens", () => {
    const { path, newData } = bigUpload();
    const wrong = new RestorePieces({
      dataDir: newData,
      uploadPath: path,
      key: PHONE_KEY,
      migrationsFolder: MIGRATIONS,
      rules: DEFAULT_RULES,
    });
    let outcome;
    while ((outcome = wrong.next()) === undefined);
    expect(outcome).toMatchObject({ kind: "failed", reason: "wrongKey" });
    const right = new RestorePieces({
      dataDir: newData,
      uploadPath: path,
      key: KEY,
      migrationsFolder: MIGRATIONS,
      rules: DEFAULT_RULES,
    });
    let pieces = 0;
    let rowPieces = 0;
    for (;;) {
      if (right.phase === "rows") rowPieces += 1;
      outcome = right.next();
      if (outcome !== undefined) break;
      pieces += 1;
    }
    expect(outcome).toEqual({ kind: "restoreReady" });
    // The opened file's scratch copy is gone once its rows are copied out.
    expect(existsSync(join(newData, "hub.db.restore.new.plain"))).toBe(false);
    expect(pieces).toBeGreaterThan(8);
    // The rows a bounded batch a piece.
    // 8,000 more devices take 32 pieces of 250, and every other table at least one.
    expect(RESTORE_ROWS_PER_PIECE).toBeLessThanOrEqual(250);
    expect(rowPieces).toBeGreaterThanOrEqual(Math.ceil(8001 / RESTORE_ROWS_PER_PIECE) + 20);
    const restored = new Database(join(newData, RESTORE_FILE), { readonly: true });
    expect(restored.query("SELECT count(*) AS n FROM devices").get()).toEqual({ n: 8001 });
    restored.close(true);
  });

  test("a stop half-way through the rows: nothing left behind", () => {
    const { path, newData } = bigUpload();
    const before = readdirSync(newData).toSorted();
    const pieces = new RestorePieces({
      dataDir: newData,
      uploadPath: path,
      key: KEY,
      migrationsFolder: MIGRATIONS,
      rules: DEFAULT_RULES,
    });
    while (pieces.phase !== "rows") pieces.next();
    pieces.next();
    expect(pieces.abort("the hub is stopping")).toMatchObject({ kind: "failed" });
    expect(readdirSync(newData).toSorted()).toEqual(before);
  });

  test("the header read for the console's question, off the loop", async () => {
    const { newData } = uploaded();
    const read = await jobToEnd(
      jobId(1),
      { kind: "readRestore", upload: { conn: connId(9), job: 1 } },
      deps({ dataDir: newData }),
    );
    expect(read).toMatchObject({
      kind: "ready",
      outcome: { kind: "restoreRead", epoch: 3, madeMs: WALL, lastChangeMs: WALL - 5000 },
    });
  });

  test("a wrong key: wrongKey, and the running hub exactly as it was", async () => {
    const { newData } = uploaded();
    const files = readdirSync(newData).toSorted();
    const db = readFileSync(join(newData, "hub.db"));
    const done = await jobToEnd(
      jobId(2),
      { kind: "applyRestore", upload: { conn: connId(9), job: 1 }, key: PHONE_KEY },
      deps({ dataDir: newData }),
    );
    expect(done).toMatchObject({ kind: "ready", outcome: { kind: "failed", reason: "wrongKey" } });
    expect(readdirSync(newData).toSorted()).toEqual(files);
    expect(readFileSync(join(newData, "hub.db"))).toEqual(db);
  });

  test("prepared beside hub.db: clients as the file has them with seq + 2³², counters + 2²⁴, no token, the phone's key, the mark", async () => {
    const { newData, newStore } = uploaded();
    const done = await jobToEnd(
      jobId(2),
      { kind: "applyRestore", upload: { conn: connId(9), job: 1 }, key: KEY },
      deps({ dataDir: newData }),
    );
    expect(done).toEqual({ kind: "ready", outcome: { kind: "restoreReady" } });
    const restored = new Database(join(newData, RESTORE_FILE), { readonly: true });
    expect(restored.query("SELECT id, name, last_seq AS seq FROM clients").all()).toEqual([
      { id: 2, name: "laptop", seq: 41 + 2 ** 32 },
    ]);
    expect(restored.query("SELECT resume_point AS r FROM send_counters").all()).toEqual([
      { r: 2048 + 2 ** 24 },
    ]);
    expect(restored.query("SELECT count(*) AS n FROM link_tokens").get()).toEqual({ n: 0 });
    expect(restored.query("SELECT count(*) AS n FROM link_secrets").get()).toEqual({ n: 0 });
    expect(restored.query("SELECT count(*) AS n FROM client_replies").get()).toEqual({ n: 0 });
    expect(
      restored
        .query<{ key: Uint8Array; epoch: number }, []>("SELECT key, epoch FROM backup_key")
        .get(),
    ).toEqual({ key: KEY, epoch: 3 } as never);
    expect(
      restored.query("SELECT restored_from_ms AS m, last_change_ms AS c FROM backup_state").get(),
    ).toEqual({ m: WALL, c: WALL - 5000 });
    expect(
      restored.query<{ k: Uint8Array }, []>("SELECT app_static_public AS k FROM hub_keys").get()?.k,
    ).toEqual(APP_PUBLIC);
    restored.close(true);

    // The switch, after the clean stop: the old file kept, the restored one in place, and it opens.
    expect(newStore.writer.stop().isOk()).toBe(true);
    newStore.db.close(true);
    const swapped = swapRestored(newData);
    expect(swapped.isOk() ? "" : swapped.error).toBe("");
    expect(existsSync(join(newData, BEFORE_RESTORE_FILE))).toBe(true);
    const reopened = openStore({
      dataDir: newData,
      migrationsFolder: MIGRATIONS,
      clock,
      rules: DEFAULT_RULES,
      platform: process.platform,
    });
    expect(reopened.isOk()).toBe(true);
    stores.push(reopened._unsafeUnwrap());
    const snapshot = reopened._unsafeUnwrap().snapshot;
    expect(snapshot.m2.backupState?.restoredFromMs).toBe(WALL);
    expect(snapshot.m2.backupKey?.epoch).toBe(3);
    expect(snapshot.m2.people.map((p) => p.name)).toEqual([NAME]);
    expect(snapshot.m2.linkTokens).toEqual([]);
    reopened
      ._unsafeUnwrap()
      .writer.stop()
      .match(
        () => undefined,
        () => undefined,
      );
  });

  test("the switch refuses without a prepared file, and moves nothing", () => {
    const { newData } = uploaded();
    const files = readdirSync(newData).toSorted();
    expect(swapRestored(newData).isErr()).toBe(true);
    expect(readdirSync(newData).toSorted()).toEqual(files);
  });
});

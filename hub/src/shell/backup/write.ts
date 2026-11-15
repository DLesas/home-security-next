/**
 * Writing a backup into the chosen folder, and streaming an export (m2-design.md section 9,
 * "Where and how", "Export on demand"; D53, D122, HB22).
 *
 * - The file: `hsn-<identity>-<UTC date and time>.hsnb`, the 64-byte header and the database sealed
 *   under the backup key by `@hsn/protocol`'s `backupCodec` **in memory**, so nothing readable ever
 *   reaches a disk; written to a temporary file in the folder, synced, renamed, the folder synced.
 * - Then this hub's files in the folder: those of an older epoch deleted (the key was replaced:
 *   a phone removed), and of the rest the newest `keep` kept, whatever wrote them.
 * - An export without history is the same file, streamed to the asking connection in pieces
 *   (`export-pieces.ts`), never written to the hub's disk; with history it is the history file,
 *   JSON Lines and never a database image (`history-export.ts`).
 *
 * The key is in the job and nowhere else: never logged, never in a message, never beside the file.
 */
import type { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  appIdentityBytes,
  BACKUP_FORMAT,
  type BackupHeader,
  backupCodec,
  formatIdentity,
} from "@hsn/protocol/app";
import { ok, Result } from "neverthrow";
import type { FileFailure, FileOutcome } from "../../core/model/events.ts";
import type { ConnId } from "../../core/model/ids.ts";
import { sqlite } from "../safe/sqlite.ts";
import { backupDatabase, schemaVersion } from "./contents.ts";
import {
  type FileError,
  failure,
  fileError,
  listFolder,
  readHead,
  remove,
  removeQuietly,
  rename,
  sameDevice,
  syncFolder,
} from "./files.ts";
import { SealStream } from "./sealing.ts";

const ORIGIN = "shell/backup/write";

/** One chunk of an export, as `fileChunk`'s body carries it (section 6). */
export interface ExportChunk {
  readonly job: number;
  readonly n: number;
  /** base64url without padding. */
  readonly data: string;
  readonly end?: { readonly chunks: number; readonly sha256: string };
}

/** Where an export's chunks go: the asking session's queue, or the control connection's lines. */
export interface ExportSink {
  send(conn: ConnId, chunk: ExportChunk): Result<void, string>;
}

export interface WriteDeps {
  /** Wall milliseconds for the header and the name. */
  readonly nowMs: () => number;
  /** 8 random bytes for the header's salt. */
  readonly salt: () => Result<Uint8Array, string>;
}

/** What the header needs from the hub's database: its app identity and its last change (D122). */
export function headerFacts(
  db: Database,
): Result<
  { readonly identity: Uint8Array; readonly lastChangeMs: number; readonly schema: number },
  FileError
> {
  const read = sqlite(ORIGIN, "read the hub's facts", () => {
    const keys = db
      .query<{ k: Uint8Array | null }, []>(`SELECT app_static_public AS k FROM hub_keys`)
      .get();
    const state = db
      .query<{ c: number | null }, []>(`SELECT last_change_ms AS c FROM backup_state`)
      .get();
    return { key: keys?.k ?? null, lastChangeMs: state?.c ?? 0 };
  });
  if (read.isErr()) return failure("io", read.error.message);
  if (read.value.key === null) return failure("io", "the hub has no app key yet");
  const schema = schemaVersion(db);
  if (schema.isErr()) return failure("io", schema.error.message);
  return ok({
    identity: appIdentityBytes(sha256, new Uint8Array(read.value.key)),
    lastChangeMs: read.value.lastChangeMs,
    schema: schema.value,
  });
}

/** `20261114T030000123Z`: the UTC date and time, to the millisecond, so names sort by time. */
export function stampOf(ms: number): string {
  return new Date(ms).toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

/** The file's name for this hub at this time. */
export function backupName(identity: Uint8Array, ms: number): string {
  return `hsn-${formatIdentity(identity)}-${stampOf(ms)}${BACKUP_FORMAT.extension}`;
}

const NAME = /^hsn-([a-z2-7]{26})-(\d{8}T\d{9}Z)\.hsnb$/u;

export interface BackupWork {
  readonly folder: string;
  readonly keep: number;
  readonly key: Uint8Array;
  readonly epoch: number;
}

type BackupPhase = "start" | "seal" | "sync" | "place" | "prune";

/**
 * A backup into the folder in pieces between the loop's turns (section 3, "The loop's time"):
 * the configuration copied and serialised in memory (small: about 200 KB ‡), then sealed
 * `SEAL_PIECE_BYTES` ‡ a piece into a temporary file in the folder, synced, renamed, the folder
 * synced, and this hub's files of older epochs and beyond the newest `keep` removed, one a piece.
 * A failure at any piece, or `abort`, removes the temporary file; nothing readable reaches a disk.
 */
export class BackupPieces {
  readonly #db: Database;
  readonly #work: BackupWork;
  readonly #deps: WriteDeps;
  readonly #dataDir: string | undefined;
  #phase: BackupPhase = "start";
  #stream: SealStream | undefined;
  #fd: number | undefined;
  #name = "";
  #identity: Uint8Array = new Uint8Array();
  #bytes = 0;
  #pruning: string[] = [];
  #ended: FileOutcome | undefined;

  constructor(db: Database, work: BackupWork, deps: WriteDeps, dataDir?: string) {
    this.#db = db;
    this.#work = work;
    this.#deps = deps;
    this.#dataDir = dataDir;
  }

  get phase(): BackupPhase {
    return this.#phase;
  }

  #temporary(): string {
    return join(this.#work.folder, `.${this.#name}.tmp`);
  }

  next(): FileOutcome | undefined {
    if (this.#ended !== undefined) return this.#ended;
    const step = Result.fromThrowable(
      (): FileOutcome | undefined => this.#step(),
      fileError("write the backup"),
    )();
    if (step.isErr()) return this.#fail(step.error.reason, step.error.message);
    const value = step.value;
    if (value === undefined) return undefined;
    if (value.kind === "failed") return this.#fail(value.reason, value.message);
    this.#ended = value;
    return value;
  }

  abort(message: string): FileOutcome {
    return this.#fail("io", message);
  }

  #fail(reason: FileFailure, message: string): FileOutcome {
    if (this.#ended !== undefined) return this.#ended;
    const fd = this.#fd;
    this.#fd = undefined;
    if (fd !== undefined)
      Result.fromThrowable(() => {
        closeSync(fd);
      })().match(
        () => undefined,
        () => undefined,
      );
    if (this.#name !== "" && this.#phase !== "prune") removeQuietly(this.#temporary());
    this.#ended = { kind: "failed", reason, message };
    return this.#ended;
  }

  #step(): FileOutcome | undefined {
    switch (this.#phase) {
      case "start":
        return this.#start();
      case "seal":
        return this.#seal();
      case "sync":
        return this.#sync();
      case "place":
        return this.#place();
      case "prune":
        return this.#prune();
    }
  }

  #start(): FileOutcome | undefined {
    const reachable = listFolder(this.#work.folder);
    if (reachable.isErr()) return { kind: "failed", ...reachable.error };
    const facts = headerFacts(this.#db);
    if (facts.isErr()) return { kind: "failed", ...facts.error };
    const database = backupDatabase(this.#db);
    if (database.isErr()) return { kind: "failed", reason: "io", message: database.error.message };
    const salt = this.#deps.salt();
    if (salt.isErr()) return { kind: "failed", reason: "io", message: salt.error };
    const madeMs = this.#deps.nowMs();
    const header: BackupHeader = {
      format: BACKUP_FORMAT.format,
      flags: 0,
      identity: facts.value.identity,
      epoch: this.#work.epoch,
      madeMs,
      schema: facts.value.schema,
      salt: salt.value,
      lastChangeMs: facts.value.lastChangeMs,
    };
    const stream = SealStream.start(this.#work.key, header, database.value);
    if (typeof stream === "string")
      return { kind: "failed", reason: "io", message: `the backup could not be sealed: ${stream}` };
    this.#stream = stream;
    this.#identity = facts.value.identity;
    this.#name = backupName(facts.value.identity, madeMs);
    this.#fd = openSync(this.#temporary(), "wx", 0o600);
    this.#phase = "seal";
    return undefined;
  }

  /** At most a piece's plaintext sealed and written. */
  #seal(): FileOutcome | undefined {
    const stream = this.#stream;
    const fd = this.#fd;
    if (stream === undefined || fd === undefined)
      return { kind: "failed", reason: "io", message: "the backup lost its file" };
    const sealed = stream.next();
    if (typeof sealed === "string")
      return { kind: "failed", reason: "io", message: `the backup could not be sealed: ${sealed}` };
    let done = 0;
    while (done < sealed.length) done += writeSync(fd, sealed, done, sealed.length - done);
    this.#bytes += sealed.length;
    if (stream.done) this.#phase = "sync";
    return undefined;
  }

  #sync(): FileOutcome | undefined {
    const fd = this.#fd;
    if (fd === undefined)
      return { kind: "failed", reason: "io", message: "the backup lost its file" };
    fsyncSync(fd);
    closeSync(fd);
    this.#fd = undefined;
    this.#stream = undefined;
    this.#phase = "place";
    return undefined;
  }

  /** Renamed into place, the folder synced; then what to prune listed. */
  #place(): FileOutcome | undefined {
    const placed = rename(this.#temporary(), join(this.#work.folder, this.#name)).andThen(() =>
      syncFolder(this.#work.folder),
    );
    if (placed.isErr()) return { kind: "failed", ...placed.error };
    const own = formatIdentity(this.#identity);
    const names = listFolder(this.#work.folder);
    if (names.isErr()) return { kind: "failed", ...names.error };
    this.#pruning = names.value
      .filter((name) => NAME.exec(name)?.[1] === own)
      .toSorted()
      .toReversed();
    this.#kept = 0;
    this.#phase = "prune";
    return undefined;
  }

  #kept = 0;

  /** One file a piece: of an older epoch, or beyond the newest `keep`, removed. */
  #prune(): FileOutcome | undefined {
    const name = this.#pruning.shift();
    if (name === undefined) {
      // The folder's device against the data folder's (section 9): `backup_folder_on_data_disk`.
      const dataDir = this.#dataDir;
      const sameDiskAsData = dataDir !== undefined && sameDevice(this.#work.folder, dataDir);
      return { kind: "backupWritten", name: this.#name, bytes: this.#bytes, sameDiskAsData };
    }
    const path = join(this.#work.folder, name);
    const head = readHead(path, BACKUP_FORMAT.headerBytes);
    const header = head.isOk() ? backupCodec.readHeader(head.value) : undefined;
    const older = header?.ok === true && header.value.epoch < this.#work.epoch;
    if (!older && this.#kept < this.#work.keep) {
      this.#kept += 1;
      return undefined;
    }
    const removed = remove(path);
    return removed.isErr() ? { kind: "failed", ...removed.error } : undefined;
  }
}

/** `backup`: all its pieces at once, for a caller that cannot wait between turns. */
export function writeBackup(
  db: Database,
  work: BackupWork,
  deps: WriteDeps,
  dataDir?: string,
): FileOutcome {
  const pieces = new BackupPieces(db, work, deps, dataDir);
  for (;;) {
    const outcome = pieces.next();
    if (outcome !== undefined) return outcome;
  }
}

/** Bytes as base64url without padding, as JSON carries them (section 6). */
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url").replace(/=+$/u, "");
}

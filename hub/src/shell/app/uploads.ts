/**
 * Uploads (m2-design.md section 6, "File bytes never enter the core"): the `fileChunk` requests of
 * an app's console session and of `hsn`'s control connection, answered by the shell itself. Each
 * upload is kept per connection as `UploadRef {conn, job}` in a temporary file in the data
 * folder's `uploads/`, until the operation that names its `job` (`restore.start`,
 * `update.upload`) is done with it.
 *
 * The rules, each refused before anything is written:
 * - One upload at a time per connection (`busy {because: "upload"}`); a `job` is used once per
 *   connection (`invalid {taken}`).
 * - Chunks are numbered from 0 with no gap (`invalid {n, range}`); a chunk sent again with the
 *   same bytes is answered as before and changes nothing, with other bytes it is refused.
 * - Each chunk at most 48 KB ‡, the whole at most 256 MB ‡ (`invalid {data, range}`).
 * - The last chunk names the total and the SHA-256 of the whole; a wrong total or hash voids the
 *   upload (`invalid {end.chunks | end.sha256}`).
 * - An upload is deleted when its job ends, when its connection closes, and at every start.
 *
 * A release fetched over the relay link is kept here too, as an upload of the relay link's own
 * connection (`beginFetch`, m4-design section 6), under the same cap and the same deletions.
 *
 * **The file calls off the hub's thread** (D145, design P): the rules, the numbering, the hash and
 * the final check stay here on the loop, as they were; only the upload file's create, writes,
 * close and removal go through `node:fs/promises` (`safe/off-loop.ts`), since one create took
 * 513 ms on a hosted Windows C: with the antivirus on and one close 130 ms. The logic is written
 * once (`#chunkLogic`, a generator that asks for its file calls) and run by one of two drivers:
 * off the loop, the hub's (`chunk`, which settles when its calls have), or at once, the lockstep
 * hub's, whose runs are the simulated clock's (`chunkNow`, `onThread`).
 *
 * - **One chunk in flight per upload.** The sender is answered when its chunk's write has
 *   settled, the last chunk's when the close has. A chunk for an upload whose last chunk is still
 *   being written is a client breaking the protocol (`hsn` and the app each await every answer):
 *   it is answered `busy {because: "upload"}`, the protocol's answer for an upload already being
 *   received on the connection, and never written.
 * - **Voided while a call is in flight** (its connection closed, its job ended, a check failed):
 *   the upload is gone from the store at once; when the call settles its file is closed and
 *   removed off the loop, and the sender, if any, is answered `unavailable`.
 * - **A stop awaits nothing**: every start empties `uploads/` (`clearAll`).
 */
import { join } from "node:path";
import { FILE_CHUNKS, type AppError, type AppOpBody } from "@hsn/protocol/app";
import { sha256 } from "@noble/hashes/sha2.js";
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { UploadRef } from "../../core/model/effects.ts";
import type { ConnId } from "../../core/model/ids.ts";
import { ensureDir, folderNames, removeFile } from "../safe/fs.ts";
import {
  closeOffLoop,
  type FileHandle,
  openNewOffLoop,
  removeOffLoop,
  writeAllOffLoop,
} from "../safe/off-loop.ts";
import { errorFrom } from "../safe/thrown.ts";
import { closeUploadFile, createUploadFile, writeUploadFile } from "../safe/upload-files.ts";

const ORIGIN = "shell/app/uploads";
const CALLER = { kind: "storage", origin: ORIGIN } as const;

/** The folder in the data folder that holds uploads (section 6). */
export const UPLOADS_FOLDER = "uploads";

export type FileChunk = AppOpBody<"fileChunk">;

/** A chunk's answer: taken, or why not, as an app's error (section 5). */
export type ChunkOutcome =
  { readonly ok: true; readonly done: boolean } | { readonly ok: false; readonly error: AppError };

export interface UploadLimits {
  readonly maxChunkBytes: number;
  readonly maxUploadBytes: number;
}

/** A release being fetched into the store (`beginFetch`). */
export interface FetchedFile {
  /** Writes the next bytes at the end, hashing them; settles once they are written. */
  append(bytes: Uint8Array): Promise<Result<void, HubError>>;
  /** Bytes written so far. */
  bytes(): number;
  /**
   * The whole is in: true, and the upload finished, when it is `bytes` long and hashes to `sha256`;
   * false, and the file deleted, otherwise. Settles once the file is closed.
   */
  finish(bytes: number, sha256: Uint8Array): Promise<boolean>;
}

/** A finished upload, for the file job that names it. */
export interface FinishedUpload {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: Uint8Array;
}

/** An upload's open file: a descriptor at once (the lockstep hub's), a handle off the loop. */
export type UploadFile = number | FileHandle;

/** A file call the upload's logic asks for; a driver makes it, at once or off the loop. */
export type FileCall =
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "write"; readonly file: UploadFile; readonly bytes: Uint8Array }
  | { readonly kind: "close"; readonly file: UploadFile };

/** What a file call came to: the file opened (or nothing more), or the thrown value. */
export type CallResult = Result<UploadFile | undefined, unknown>;

/** A driver of file calls off the loop: `offLoopFileCall`, or a test's stand-in for it. */
export type OffLoopCalls = (call: FileCall) => Promise<CallResult>;

/** The upload's logic for one chunk: it yields its file calls and returns the chunk's answer. */
type ChunkLogic = Generator<FileCall, ChunkOutcome, CallResult>;

interface Upload {
  readonly job: number;
  readonly path: string;
  file: UploadFile | undefined;
  next: number;
  bytes: number;
  readonly hash: ReturnType<typeof sha256.create>;
  /** The last chunk taken, so a repeat of it can be told from a different chunk. */
  lastChunk: Uint8Array | undefined;
  finished: FinishedUpload | undefined;
  /** A file call is in flight (one at a time). */
  busy: boolean;
  /** Gone from the store while a call was in flight: its file is closed and removed when it settles. */
  voided: boolean;
}

function invalid(field: string, reason: "range" | "format" | "taken"): ChunkOutcome {
  return { ok: false, error: { code: "invalid", detail: { field, reason } } };
}

const BUSY: ChunkOutcome = { ok: false, error: { code: "busy", detail: { because: "upload" } } };
const FAILED: ChunkOutcome = { ok: false, error: { code: "unavailable", detail: {} } };

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Base64url without padding, decoded only when it is exactly that (section 6). */
function decodeData(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) return undefined;
  const bytes = new Uint8Array(Buffer.from(text, "base64url"));
  return Buffer.from(bytes).toString("base64url") === text ? bytes : undefined;
}

/** A file call made at once, on this thread: the lockstep hub's. */
function callNow(call: FileCall): CallResult {
  switch (call.kind) {
    case "open":
      return createUploadFile(call.path);
    case "write":
      return typeof call.file === "number"
        ? writeUploadFile(call.file, call.bytes).map(() => undefined)
        : err("an open file of the other kind");
    case "close":
      return typeof call.file === "number"
        ? closeUploadFile(call.file).map(() => undefined)
        : err("an open file of the other kind");
  }
}

/** A file call made off the hub's thread (`safe/off-loop.ts`). */
export async function offLoopFileCall(call: FileCall): Promise<CallResult> {
  switch (call.kind) {
    case "open":
      return openNewOffLoop(call.path);
    case "write":
      return typeof call.file === "number"
        ? err("an open file of the other kind")
        : (await writeAllOffLoop(call.file, call.bytes)).map(() => undefined);
    case "close":
      return typeof call.file === "number"
        ? err("an open file of the other kind")
        : (await closeOffLoop(call.file)).map(() => undefined);
  }
}

/**
 * Whether the upload was voided while one of its file calls was in flight: read through a call,
 * since the logic's own checks before the call cannot see what changed during it.
 */
function voided(upload: Upload): boolean {
  return upload.voided;
}

function runNow<T>(logic: Generator<FileCall, T, CallResult>): T {
  let step = logic.next();
  while (step.done !== true) step = logic.next(callNow(step.value));
  return step.value;
}

async function runOffLoop<T>(
  logic: Generator<FileCall, T, CallResult>,
  call: OffLoopCalls,
): Promise<T> {
  let step = logic.next();
  while (step.done !== true) step = logic.next(await call(step.value));
  return step.value;
}

export class UploadStore {
  readonly #folder: string;
  readonly #limits: UploadLimits;
  /** The lockstep hub's: every file call at once, on this thread. */
  readonly #onThread: boolean;
  /** How its file calls are made off the loop: `offLoopFileCall`, or a test's stand-in. */
  readonly #calls: OffLoopCalls;
  /** Every upload, by connection, then job. */
  readonly #uploads = new Map<ConnId, Map<number, Upload>>();
  #nextFile = 1;

  constructor(
    dataDir: string,
    limits: UploadLimits = FILE_CHUNKS,
    options: { readonly onThread?: boolean; readonly calls?: OffLoopCalls } = {},
  ) {
    this.#folder = join(dataDir, UPLOADS_FOLDER);
    this.#limits = limits;
    this.#onThread = options.onThread === true;
    this.#calls = options.calls ?? offLoopFileCall;
  }

  /** At every start: the folder exists and holds nothing (section 6). */
  clearAll(): Result<void, HubError> {
    const made = ensureDir(CALLER, this.#folder);
    if (made.isErr()) return err(made.error);
    const names = folderNames(CALLER, this.#folder);
    if (names.isErr()) return err(names.error);
    for (const name of names.value) {
      const removed = removeFile(CALLER, join(this.#folder, name));
      if (removed.isErr()) return err(removed.error);
    }
    return ok(undefined);
  }

  /** Takes one chunk of `conn`'s upload `chunk.job`, its file calls off the loop; its answer. */
  chunk(conn: ConnId, chunk: FileChunk): Promise<ChunkOutcome> {
    return runOffLoop(this.#chunkLogic(conn, chunk), this.#calls);
  }

  /** `chunk`, every file call at once on this thread: the lockstep hub's (`onThread`). */
  chunkNow(conn: ConnId, chunk: FileChunk): ChunkOutcome {
    return runNow(this.#chunkLogic(conn, chunk));
  }

  /** The rules, the numbering, the hash and the final check; the file calls yielded to a driver. */
  *#chunkLogic(conn: ConnId, chunk: FileChunk): ChunkLogic {
    const mine = this.#uploads.get(conn) ?? new Map<number, Upload>();
    const data = decodeData(chunk.data);
    if (data === undefined) return invalid("data", "format");
    if (data.length > this.#limits.maxChunkBytes) return invalid("data", "range");
    let upload = mine.get(chunk.job);
    if (upload === undefined) {
      if ([...mine.values()].some((u) => u.finished === undefined)) return BUSY;
      if (chunk.n !== 0) return invalid("n", "range");
      upload = this.#start(chunk.job);
      mine.set(chunk.job, upload);
      this.#uploads.set(conn, mine);
      upload.busy = true;
      const opened = yield { kind: "open", path: upload.path };
      upload.busy = false;
      if (opened.isErr() || opened.value === undefined) {
        this.#void(conn, upload);
        return FAILED;
      }
      upload.file = opened.value;
      if (voided(upload)) return this.#settledVoid(upload);
    } else if (upload.busy) {
      // A chunk while the last one's write is in flight: the client did not wait for its answer.
      return BUSY;
    } else if (upload.finished !== undefined) {
      return chunk.n === upload.next - 1 &&
        upload.lastChunk !== undefined &&
        same(data, upload.lastChunk)
        ? { ok: true, done: true }
        : invalid("job", "taken");
    }
    if (chunk.n === upload.next - 1 && upload.lastChunk !== undefined && chunk.end === undefined) {
      return same(data, upload.lastChunk) ? { ok: true, done: false } : invalid("n", "range");
    }
    if (chunk.n !== upload.next) return invalid("n", "range");
    if (upload.bytes + data.length > this.#limits.maxUploadBytes) {
      this.#void(conn, upload);
      return invalid("data", "range");
    }
    const file = upload.file;
    if (file === undefined) return FAILED;
    upload.busy = true;
    const written = yield { kind: "write", file, bytes: data };
    upload.busy = false;
    if (voided(upload)) return this.#settledVoid(upload);
    if (written.isErr()) {
      this.#void(conn, upload);
      return FAILED;
    }
    upload.hash.update(data);
    upload.bytes += data.length;
    upload.next += 1;
    upload.lastChunk = data;
    if (chunk.end === undefined) return { ok: true, done: false };
    if (chunk.end.chunks !== upload.next) {
      this.#void(conn, upload);
      return invalid("end.chunks", "range");
    }
    const whole = upload.hash.digest();
    if (hex(whole) !== chunk.end.sha256) {
      this.#void(conn, upload);
      return invalid("end.sha256", "format");
    }
    upload.busy = true;
    const closed = yield { kind: "close", file };
    upload.busy = false;
    upload.file = undefined;
    if (voided(upload)) return this.#settledVoid(upload);
    if (closed.isErr()) {
      this.#void(conn, upload);
      return FAILED;
    }
    upload.finished = { path: upload.path, bytes: upload.bytes, sha256: whole };
    return { ok: true, done: true };
  }

  /**
   * A release fetched over the relay link (docs/m4-design.md section 6): an upload of the relay
   * link's own connection, its job the fetch's, written in order by the relay client as the pieces
   * come and hashed as it goes, under the same cap as any upload. Refused when that job already
   * has one. `finish` checks the whole against the offer's length and SHA-256: then it is finished
   * like an upload, for the staging that follows; otherwise it is deleted. Its file calls are off
   * the loop, one at a time: the relay client awaits each `append` before the next.
   */
  beginFetch(ref: UploadRef): Result<FetchedFile, HubError> {
    const mine = this.#uploads.get(ref.conn) ?? new Map<number, Upload>();
    if (mine.has(ref.job))
      return err({ kind: "storage", origin: ORIGIN, message: `upload ${ref.job} exists already` });
    const upload = this.#start(ref.job);
    mine.set(ref.job, upload);
    this.#uploads.set(ref.conn, mine);
    const closedError = (): HubError => ({
      kind: "storage",
      origin: ORIGIN,
      message: "the fetched file is closed",
    });
    return ok({
      append: (bytes) =>
        this.#run(
          function* (this: UploadStore): Generator<FileCall, Result<void, HubError>, CallResult> {
            if (upload.voided || upload.finished !== undefined || upload.busy)
              return err(closedError());
            if (upload.bytes + bytes.length > this.#limits.maxUploadBytes)
              return err({ kind: "storage", origin: ORIGIN, message: "past the upload cap" });
            if (upload.file === undefined) {
              upload.busy = true;
              const opened = yield { kind: "open", path: upload.path };
              upload.busy = false;
              if (voided(upload)) {
                this.#discard(upload, opened.isOk() ? opened.value : undefined);
                return err(closedError());
              }
              if (opened.isErr() || opened.value === undefined) {
                this.#void(ref.conn, upload);
                return err(
                  errorFrom(
                    "storage",
                    ORIGIN,
                    "create the fetched file",
                    opened.isErr() ? opened.error : undefined,
                  ),
                );
              }
              upload.file = opened.value;
            }
            const file = upload.file;
            upload.busy = true;
            const written = yield { kind: "write", file, bytes };
            upload.busy = false;
            if (voided(upload)) {
              this.#discard(upload, file);
              return err(closedError());
            }
            if (written.isErr()) {
              this.#void(ref.conn, upload);
              return err(errorFrom("storage", ORIGIN, "write the fetched file", written.error));
            }
            upload.hash.update(bytes);
            upload.bytes += bytes.length;
            return ok(undefined);
          }.call(this),
        ),
      bytes: () => upload.bytes,
      finish: (bytes, sha) =>
        this.#run(
          function* (this: UploadStore): Generator<FileCall, boolean, CallResult> {
            if (upload.voided || upload.finished !== undefined || upload.busy) return false;
            const whole = upload.hash.digest();
            const file = upload.file;
            if (file !== undefined) {
              upload.busy = true;
              const closed = yield { kind: "close", file };
              upload.busy = false;
              upload.file = undefined;
              if (voided(upload)) {
                this.#discard(upload, undefined);
                return false;
              }
              if (closed.isErr()) {
                this.#void(ref.conn, upload);
                return false;
              }
            }
            if (upload.bytes !== bytes || !same(whole, sha)) {
              this.#void(ref.conn, upload);
              return false;
            }
            upload.finished = { path: upload.path, bytes: upload.bytes, sha256: whole };
            return true;
          }.call(this),
        ),
    });
  }

  /** The finished upload `ref` names, for its file job; undefined if there is none. */
  finished(ref: UploadRef): FinishedUpload | undefined {
    return this.#uploads.get(ref.conn)?.get(ref.job)?.finished;
  }

  /** Its job ended: the upload is deleted (section 6). */
  release(ref: UploadRef): void {
    const upload = this.#uploads.get(ref.conn)?.get(ref.job);
    if (upload !== undefined) this.#void(ref.conn, upload);
  }

  /** The connection closed: every upload of it is deleted (section 6). */
  closed(conn: ConnId): void {
    for (const upload of [...(this.#uploads.get(conn)?.values() ?? [])]) this.#void(conn, upload);
    this.#uploads.delete(conn);
  }

  /** Uploads held, for tests. */
  get held(): number {
    return [...this.#uploads.values()].reduce((n, m) => n + m.size, 0);
  }

  /** A logic run by this store's driver: off the loop, or at once for the lockstep hub. */
  #run<T>(logic: Generator<FileCall, T, CallResult>): Promise<T> {
    return this.#onThread ? Promise.resolve(runNow(logic)) : runOffLoop(logic, this.#calls);
  }

  #start(job: number): Upload {
    return {
      job,
      path: join(this.#folder, `upload-${process.pid}-${this.#nextFile++}`),
      file: undefined,
      next: 0,
      bytes: 0,
      hash: sha256.create(),
      lastChunk: undefined,
      finished: undefined,
      busy: false,
      voided: false,
    };
  }

  /**
   * The upload gone from the store. Its file is closed and removed now, or, while one of its file
   * calls is in flight, by that call's logic when it settles (`#settledVoid`).
   */
  #void(conn: ConnId, upload: Upload): void {
    this.#uploads.get(conn)?.delete(upload.job);
    if (upload.busy) {
      upload.voided = true;
      return;
    }
    upload.voided = true;
    this.#discard(upload, upload.file);
  }

  /** After a call that settled on a voided upload: its file closed and removed; `unavailable`. */
  #settledVoid(upload: Upload): ChunkOutcome {
    this.#discard(upload, upload.file);
    return FAILED;
  }

  /** The file closed if open, then removed: at once for the lockstep hub, else off the loop. */
  #discard(upload: Upload, file: UploadFile | undefined): void {
    upload.file = undefined;
    if (this.#onThread || typeof file === "number") {
      if (typeof file === "number")
        closeUploadFile(file).match(
          () => undefined,
          () => undefined,
        );
      removeFile(CALLER, upload.path).match(
        () => undefined,
        () => undefined,
      );
      return;
    }
    void (async () => {
      // Each settles with a result; a file left behind goes at the next start (`clearAll`).
      if (file !== undefined)
        (await closeOffLoop(file)).match(
          () => undefined,
          () => undefined,
        );
      (await removeOffLoop(upload.path)).match(
        () => undefined,
        () => undefined,
      );
    })();
  }
}

/** A chunk's outcome as the control socket answers it (section 6). */
export function controlChunkReply(outcome: ChunkOutcome):
  | { readonly ok: true; readonly result: { readonly kind: "fileChunk" } }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "opRefused";
        readonly message: string;
        readonly app: AppError;
      };
    } {
  return outcome.ok
    ? { ok: true, result: { kind: "fileChunk" } }
    : {
        ok: false,
        error: {
          code: "opRefused",
          message: `the chunk was refused: ${outcome.error.code}`,
          app: outcome.error,
        },
      };
}

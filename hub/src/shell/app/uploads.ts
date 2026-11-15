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
 */
import { join } from "node:path";
import { FILE_CHUNKS, type AppError, type AppOpBody } from "@hsn/protocol/app";
import { sha256 } from "@noble/hashes/sha2.js";
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { UploadRef } from "../../core/model/effects.ts";
import type { ConnId } from "../../core/model/ids.ts";
import { ensureDir, folderNames, removeFile } from "../safe/fs.ts";
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

/** A finished upload, for the file job that names it. */
export interface FinishedUpload {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: Uint8Array;
}

interface Upload {
  readonly job: number;
  readonly path: string;
  fd: number | undefined;
  next: number;
  bytes: number;
  readonly hash: ReturnType<typeof sha256.create>;
  /** The hash of the last chunk taken, so a repeat of it can be told from a different chunk. */
  lastChunk: Uint8Array | undefined;
  finished: FinishedUpload | undefined;
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

export class UploadStore {
  readonly #folder: string;
  readonly #limits: UploadLimits;
  /** Every upload, by connection, then job. */
  readonly #uploads = new Map<ConnId, Map<number, Upload>>();
  #nextFile = 1;

  constructor(dataDir: string, limits: UploadLimits = FILE_CHUNKS) {
    this.#folder = join(dataDir, UPLOADS_FOLDER);
    this.#limits = limits;
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

  /** Takes one chunk of `conn`'s upload `chunk.job`. */
  chunk(conn: ConnId, chunk: FileChunk): ChunkOutcome {
    const mine = this.#uploads.get(conn) ?? new Map<number, Upload>();
    const data = decodeData(chunk.data);
    if (data === undefined) return invalid("data", "format");
    if (data.length > this.#limits.maxChunkBytes) return invalid("data", "range");
    let upload = mine.get(chunk.job);
    if (upload === undefined) {
      if ([...mine.values()].some((u) => u.finished === undefined)) return BUSY;
      if (chunk.n !== 0) return invalid("n", "range");
      const started = this.#start(chunk.job);
      if (started === undefined) return FAILED;
      upload = started;
      mine.set(chunk.job, upload);
      this.#uploads.set(conn, mine);
    } else if (upload.finished !== undefined) {
      return chunk.n === upload.next - 1 &&
        upload.lastChunk !== undefined &&
        same(sha256(data), upload.lastChunk)
        ? { ok: true, done: true }
        : invalid("job", "taken");
    }
    if (chunk.n === upload.next - 1 && upload.lastChunk !== undefined && chunk.end === undefined) {
      return same(sha256(data), upload.lastChunk)
        ? { ok: true, done: false }
        : invalid("n", "range");
    }
    if (chunk.n !== upload.next) return invalid("n", "range");
    if (upload.bytes + data.length > this.#limits.maxUploadBytes) {
      this.#void(conn, upload);
      return invalid("data", "range");
    }
    if (upload.fd === undefined) return FAILED;
    const written = writeUploadFile(upload.fd, data);
    if (written.isErr()) {
      this.#void(conn, upload);
      return FAILED;
    }
    upload.hash.update(data);
    upload.bytes += data.length;
    upload.next += 1;
    upload.lastChunk = sha256(data);
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
    const closed = closeUploadFile(upload.fd);
    upload.fd = undefined;
    if (closed.isErr()) {
      this.#void(conn, upload);
      return FAILED;
    }
    upload.finished = { path: upload.path, bytes: upload.bytes, sha256: whole };
    return { ok: true, done: true };
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

  #start(job: number): Upload | undefined {
    const path = join(this.#folder, `upload-${process.pid}-${this.#nextFile++}`);
    const fd = createUploadFile(path);
    if (fd.isErr()) return undefined;
    return {
      job,
      path,
      fd: fd.value,
      next: 0,
      bytes: 0,
      hash: sha256.create(),
      lastChunk: undefined,
      finished: undefined,
    };
  }

  #void(conn: ConnId, upload: Upload): void {
    if (upload.fd !== undefined)
      closeUploadFile(upload.fd).match(
        () => undefined,
        () => undefined,
      );
    upload.fd = undefined;
    removeFile(CALLER, upload.path).match(
      () => undefined,
      () => undefined,
    );
    this.#uploads.get(conn)?.delete(upload.job);
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

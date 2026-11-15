/**
 * An export without history (m2-design.md section 9, "Export on demand"; section 3, "The loop's
 * time"): the configuration backup, exactly the file a scheduled backup writes (`.hsnb`, sealed,
 * every flag zero), restorable, streamed to the asking connection and never written to the hub's
 * disk. Its pieces:
 *
 * 1. The header's facts and the configuration's small database (`backupDatabase`, about 200 KB ‡,
 *    the configuration tables only: never the whole database, never history).
 * 2. Sealed `SEAL_PIECE_BYTES` ‡ of plaintext a piece (`SealStream`) and sent as 48 KB chunks,
 *    hashed as they go (`node:crypto`), the last with the end mark.
 *
 * An export with history is the history file instead (`history-export.ts`).
 */
import type { Database } from "bun:sqlite";
import { createHash, type Hash } from "node:crypto";
import { BACKUP_FORMAT, FILE_CHUNK_BYTES } from "@hsn/protocol/app";
import { Result } from "neverthrow";
import type { FileOutcome } from "../../core/model/events.ts";
import type { ConnId } from "../../core/model/ids.ts";
import { backupDatabase } from "./contents.ts";
import { SealStream } from "./sealing.ts";
import {
  base64url,
  type ExportChunk,
  type ExportSink,
  headerFacts,
  type WriteDeps,
} from "./write.ts";
import { joined } from "./files.ts";

export interface ExportWork {
  readonly conn: ConnId;
  readonly key: Uint8Array;
  readonly epoch: number;
}

type Phase = "start" | "send";

export class ExportPieces {
  readonly #db: Database;
  readonly #job: number;
  readonly #work: ExportWork;
  readonly #sink: ExportSink;
  readonly #deps: WriteDeps;
  #phase: Phase = "start";
  #key: Uint8Array;
  #stream: SealStream | undefined;
  #pending = new Uint8Array();
  #sent = 0;
  #hash: Hash = createHash("sha256");
  #ended: FileOutcome | undefined;

  constructor(db: Database, job: number, work: ExportWork, sink: ExportSink, deps: WriteDeps) {
    this.#db = db;
    this.#job = job;
    this.#work = work;
    this.#key = work.key;
    this.#sink = sink;
    this.#deps = deps;
  }

  /** Where it is, for measurements. */
  get phase(): Phase {
    return this.#phase;
  }

  next(): FileOutcome | undefined {
    if (this.#ended !== undefined) return this.#ended;
    const step = Result.fromThrowable(
      (): FileOutcome | undefined => this.#step(),
      (thrown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    )();
    if (step.isErr()) return this.abort(step.error);
    if (step.value !== undefined) this.#end(step.value);
    return step.value;
  }

  abort(message: string): FileOutcome {
    if (this.#ended !== undefined) return this.#ended;
    const outcome: FileOutcome = { kind: "failed", reason: "io", message };
    this.#end(outcome);
    return outcome;
  }

  #end(outcome: FileOutcome): void {
    this.#ended = outcome;
    this.#stream = undefined;
    this.#pending = new Uint8Array();
  }

  #step(): FileOutcome | undefined {
    switch (this.#phase) {
      case "start":
        return this.#start();
      case "send":
        return this.#send();
    }
  }

  /** Piece 1: the header's facts, and the configuration's database, its sealing begun. */
  #start(): FileOutcome | undefined {
    const facts = headerFacts(this.#db);
    if (facts.isErr()) return { kind: "failed", ...facts.error };
    const salt = this.#deps.salt();
    if (salt.isErr()) return { kind: "failed", reason: "io", message: salt.error };
    const plain = backupDatabase(this.#db);
    if (plain.isErr()) return { kind: "failed", reason: "io", message: plain.error.message };
    const stream = SealStream.start(
      this.#key,
      {
        format: BACKUP_FORMAT.format,
        flags: 0,
        identity: facts.value.identity,
        epoch: this.#work.epoch,
        madeMs: this.#deps.nowMs(),
        schema: facts.value.schema,
        salt: salt.value,
        lastChangeMs: facts.value.lastChangeMs,
      },
      plain.value,
    );
    if (typeof stream === "string")
      return { kind: "failed", reason: "io", message: `the export could not be sealed: ${stream}` };
    this.#stream = stream;
    this.#phase = "send";
    return undefined;
  }

  /** A piece's plaintext sealed, and every whole 48 KB chunk of it sent; the last with the end mark. */
  #send(): FileOutcome | undefined {
    const stream = this.#stream;
    if (stream === undefined)
      return { kind: "failed", reason: "io", message: "the export lost its file" };
    const sealed = stream.next();
    if (typeof sealed === "string")
      return { kind: "failed", reason: "io", message: `the export could not be sealed: ${sealed}` };
    const bytes = this.#pending.length === 0 ? sealed : joined([this.#pending, sealed]);
    const last = stream.done;
    let at = 0;
    while (bytes.length - at > FILE_CHUNK_BYTES || (last && at < bytes.length)) {
      const part = bytes.subarray(at, at + FILE_CHUNK_BYTES);
      at += part.length;
      this.#bytes += part.length;
      this.#hash.update(part);
      const end = last && at >= bytes.length;
      const chunk: ExportChunk = end
        ? {
            job: this.#job,
            n: this.#sent,
            data: base64url(part),
            end: { chunks: this.#sent + 1, sha256: this.#hash.digest("hex") },
          }
        : { job: this.#job, n: this.#sent, data: base64url(part) };
      const sent = this.#sink.send(this.#work.conn, chunk);
      if (sent.isErr())
        return {
          kind: "failed",
          reason: "io",
          message: `the export stopped after chunk ${this.#sent} of the file: ${sent.error}`,
        };
      this.#sent += 1;
      if (end) return { kind: "exportSent", bytes: this.#bytes };
    }
    this.#pending = bytes.slice(at);
    return undefined;
  }

  /** The file's bytes sent so far. */
  #bytes = 0;
}

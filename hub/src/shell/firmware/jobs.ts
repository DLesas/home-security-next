/**
 * The firmware store's file work (docs/m3-updates-design.md section 4; m2-design.md section 3,
 * "Jobs in pieces, the loop's contract"), started from `shell/backup/jobs.ts`'s `startJob`:
 *
 * - `stageFirmware`: an upload checked and staged, in pieces (`stage.ts`) on a worker thread
 *   (`stage-job.ts`), ending `firmwareStaged` or a refusal; a job whose upload is not there is
 *   `noUpload`.
 * - `removeFirmware`: the image's file removed, at once (`firmwareRemoved`), unless an image in
 *   the index names it when it is deleted (`store.ts`). Image 0 is a staged file the core refused
 *   as `storeFull`, which has no row: its file goes the same way.
 * - `sendFirmware` (`firmware.download`): the header and the payload streamed to the session that
 *   asked as `fileChunk`s, as `backup.export` streams (m2-design.md section 6), in pieces; the last
 *   chunk, which carries the end mark and the whole stream's SHA-256, is held back until the
 *   payload has hashed to the header's SHA-256, so a damaged file is never delivered as whole
 *   (`fileFailed` instead, by the loop's wiring of a failed job).
 *
 * The bytes never enter the core: each outcome carries only what the core's row needs.
 */
import { createHash, type Hash } from "node:crypto";
import { FILE_CHUNK_BYTES } from "@hsn/protocol/app";
import { IMAGE_HEADER } from "@hsn/protocol/update";
import type { FileWork } from "../../core/model/effects.ts";
import type { FileOutcome } from "../../core/model/events.ts";
import type { JobId } from "../../core/model/ids.ts";
import type { JobDeps, JobStart } from "../backup/jobs.ts";
import { base64url, type ExportSink } from "../backup/write.ts";
import { closeQuietly, openToRead, readAt } from "../safe/firmware-io.ts";
import { PUBLISHER_KEYS } from "../update/publisher-keys.ts";
import { hubSigner, hubSigningKeys } from "./sign.ts";
import { FIRMWARE_PIECE_BYTES, FirmwareStaging } from "./stage.ts";
import { FirmwareStagingJob } from "./stage-job.ts";
import { imagePath, indexedFile, removeImageFile } from "./store.ts";

/** The firmware store's file work. */
export type FirmwareWork = Extract<
  FileWork,
  { readonly kind: "stageFirmware" | "removeFirmware" | "sendFirmware" }
>;

export function isFirmwareWork(work: FileWork): work is FirmwareWork {
  return (
    work.kind === "stageFirmware" || work.kind === "removeFirmware" || work.kind === "sendFirmware"
  );
}

/** What the firmware's jobs need of `startJob`'s dependencies. */
export type FirmwareJobDeps = Pick<
  JobDeps,
  "db" | "dataDir" | "rules" | "uploads" | "exports" | "publisherKeys" | "wake" | "onThread"
>;

/** Starts one of the firmware store's jobs. */
export function firmwareJob(job: JobId, work: FirmwareWork, deps: FirmwareJobDeps): JobStart {
  switch (work.kind) {
    case "stageFirmware": {
      const path = deps.uploads.pathOf(work.upload);
      if (path === undefined)
        return ready({
          kind: "failed",
          reason: "noUpload",
          message: `no upload ${work.upload.job} on connection ${work.upload.conn}`,
        });
      const inputs = {
        job,
        path,
        own: work.own,
        dataDir: deps.dataDir,
        keys: deps.publisherKeys ?? PUBLISHER_KEYS,
        rules: deps.rules.firmware,
      };
      return {
        kind: "pieces",
        pieces:
          deps.onThread === true
            ? new FirmwareStaging({ ...inputs, signer: () => hubSigner(deps.db) })
            : new FirmwareStagingJob(
                { ...inputs, signingKeys: () => hubSigningKeys(deps.db) },
                deps.wake === undefined ? {} : { wake: deps.wake },
              ),
      };
    }
    case "removeFirmware": {
      const removed = removeImageFile(deps.dataDir, work.file, indexedFile(deps.db));
      return ready(
        removed.isOk()
          ? { kind: "firmwareRemoved", image: work.image }
          : { kind: "failed", reason: removed.error.reason, message: removed.error.message },
      );
    }
    case "sendFirmware":
      return {
        kind: "pieces",
        pieces: new FirmwareDownload(job, work, deps.dataDir, deps.exports),
      };
  }
}

function ready(outcome: FileOutcome): JobStart {
  return { kind: "ready", outcome };
}

/** `sendFirmware`: the file a device pulls, streamed as `fileChunk`s a piece at a time. */
export class FirmwareDownload {
  readonly #job: number;
  readonly #work: Extract<FileWork, { readonly kind: "sendFirmware" }>;
  readonly #dataDir: string;
  readonly #sink: ExportSink;
  #fd: number | undefined;
  #started = false;
  /** The payload's bytes, from the header. */
  #payloadBytes = 0;
  #readAt = 0;
  /** Bytes read but not yet sent: the last chunk waits for the hash. */
  #pending = new Uint8Array(0);
  #sent = 0;
  #bytes = 0;
  readonly #stream: Hash = createHash("sha256");
  readonly #payload: Hash = createHash("sha256");
  #ended: FileOutcome | undefined;

  constructor(
    job: number,
    work: Extract<FileWork, { readonly kind: "sendFirmware" }>,
    dataDir: string,
    sink: ExportSink,
  ) {
    this.#job = job;
    this.#work = work;
    this.#dataDir = dataDir;
    this.#sink = sink;
  }

  next(): FileOutcome | undefined {
    if (this.#ended !== undefined) return this.#ended;
    const step = this.#started ? this.#piece() : this.#start();
    if (step !== undefined) this.#end(step);
    return step;
  }

  abort(message: string): FileOutcome {
    if (this.#ended !== undefined) return this.#ended;
    const outcome: FileOutcome = { kind: "failed", reason: "io", message };
    this.#end(outcome);
    return outcome;
  }

  #end(outcome: FileOutcome): void {
    this.#ended = outcome;
    if (this.#fd !== undefined) closeQuietly(this.#fd);
    this.#fd = undefined;
    this.#pending = new Uint8Array(0);
  }

  #failed(message: string): FileOutcome {
    return { kind: "failed", reason: "io", message };
  }

  #start(): FileOutcome | undefined {
    this.#started = true;
    const header = this.#work.header;
    if (header.length !== IMAGE_HEADER.bytes)
      return this.#failed("the image's header is not 128 bytes");
    const path = imagePath(this.#dataDir, this.#work.file);
    if (path === undefined) return this.#failed(`"${this.#work.file}" is not a stored image`);
    const fd = openToRead(path);
    if (fd.isErr()) return { kind: "failed", reason: fd.error.reason, message: fd.error.message };
    this.#fd = fd.value;
    this.#payloadBytes = new DataView(header.buffer, header.byteOffset, header.length).getUint32(
      12,
      true,
    );
    this.#pending = header.slice();
    this.#stream.update(header);
    return undefined;
  }

  /** One piece: up to `FIRMWARE_PIECE_BYTES` read and every whole chunk before the last sent. */
  #piece(): FileOutcome | undefined {
    const fd = this.#fd;
    if (fd === undefined) return this.#failed("the download lost its file");
    const want = Math.min(FIRMWARE_PIECE_BYTES, this.#payloadBytes - this.#readAt);
    if (want > 0) {
      const piece = new Uint8Array(want);
      const read = readAt(fd, piece, this.#readAt, "an image");
      if (read.isErr())
        return { kind: "failed", reason: read.error.reason, message: read.error.message };
      if (read.value !== want)
        return this.#failed("the image's file is shorter than its header says");
      this.#readAt += want;
      this.#payload.update(piece);
      this.#stream.update(piece);
      const pending = new Uint8Array(this.#pending.length + piece.length);
      pending.set(this.#pending, 0);
      pending.set(piece, this.#pending.length);
      this.#pending = pending;
    }
    const last = this.#readAt >= this.#payloadBytes;
    if (last) {
      // The whole payload read: it must be the image the header signs, and nothing more.
      const extra = new Uint8Array(1);
      const beyond = readAt(fd, extra, this.#readAt, "an image");
      if (beyond.isErr() || beyond.value !== 0)
        return this.#failed("the image's file is longer than its header says");
      const digest = new Uint8Array(this.#payload.digest());
      const signed = this.#work.header.subarray(16, 48);
      if (!digest.every((b, i) => b === signed[i]))
        return this.#failed("the image's file does not hash to its header's SHA-256");
    }
    // Every whole chunk but the last; at the end, the rest, the last with the end mark.
    let at = 0;
    while (this.#pending.length - at > FILE_CHUNK_BYTES || (last && at < this.#pending.length)) {
      const part = this.#pending.subarray(at, at + FILE_CHUNK_BYTES);
      at += part.length;
      const end = last && at >= this.#pending.length;
      const sent = this.#sink.send(this.#work.conn, {
        job: this.#job,
        n: this.#sent,
        data: base64url(part),
        ...(end ? { end: { chunks: this.#sent + 1, sha256: this.#stream.digest("hex") } } : {}),
      });
      if (sent.isErr())
        return this.#failed(`the download stopped after chunk ${this.#sent}: ${sent.error}`);
      this.#sent += 1;
      this.#bytes += part.length;
      if (end) return { kind: "firmwareSent", bytes: this.#bytes };
    }
    this.#pending = this.#pending.slice(at);
    return undefined;
  }
}

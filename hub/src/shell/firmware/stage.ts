/**
 * `stageFirmware` (docs/m3-updates-design.md sections 3 and 4): an uploaded firmware file checked,
 * its payload copied into the store and its header made and signed, **in pieces between the loop's
 * turns** (m2-design.md section 3, "The loop's time"), as a hub release is staged
 * (`shell/update/stage.ts`): no piece reads more than `FIRMWARE_PIECE_BYTES` ‡.
 *
 * - **The first piece** checks everything but the hashes, in section 3's order. A publisher's
 *   `.hsnf`: its head, manifest and signature by a publisher key (`badFile`, `badSignature`), a
 *   target other than `esp32s3` or a payload whose ESP header names another chip (`wrongTarget`),
 *   a payload over the slot (`tooLarge`), a payload whose length is not the manifest's (`badFile`).
 *   An owner's own build (`own`: confirmed on the console, which the core checked): an ESP
 *   application image (`badFile`), for the ESP32-S3 (`wrongTarget`), within the slot
 *   (`tooLarge`), whose app description names the version given (`badFile`).
 * - **Pass 1** reads the payload a piece at a time and hashes it; for a release the hash must be
 *   the manifest's, and the app description's version the manifest's; for an own build every
 *   piece also goes through the layout check (`layout.ts`: segments, checksum, appended hash).
 *   Nothing is written before it passes. Then the store's room (four images ‡, 8 MB ‡, D140; the
 *   core checks the same, this is the shell's own guard), and the header made and signed.
 * - **Pass 2** copies the payload into a temporary file in the store's folder, hashing it again
 *   (an upload that changed between the passes is refused).
 * - **Then**, a piece each: the file synced and closed; renamed to `<sha256>.bin`; the folder
 *   synced. Then `firmwareStaged`, from which the core writes the image's row.
 *
 * A refusal, a failure, a stop (`abort`) at any piece before the rename deletes the temporary file:
 * nothing reaches the store that fails a check. After the rename the file stays: it holds exactly
 * the checked bytes, and if the core never indexes it (a power cut before its row's commit), the
 * store's check at the next start deletes it.
 */
import { join } from "node:path";
import { FIRMWARE_RELEASE } from "@hsn/protocol/release";
import { createHash, type Hash } from "node:crypto";
import type { Result } from "neverthrow";
import type { FileFailure, FileOutcome } from "../../core/model/events.ts";
import { ImageKind } from "../../core/model/rows.ts";
import type { HubRules } from "../../core/model/rules.ts";
import {
  closeQuietly,
  ensureFolder,
  openNew,
  openToRead,
  readAt,
  removeQuietly,
  renameFile,
  sizeOfOpen,
  syncFolder,
  syncOpen,
  writeAll,
} from "../safe/firmware-io.ts";
import { ESP_HEAD_BYTES, ESP_IMAGE, EspLayout, readEspHead } from "./layout.ts";
import {
  type FirmwareHead,
  HEAD_BYTES,
  manifestColumn,
  parseFirmwareHead,
  signedByOneOf,
} from "./release.ts";
import { headerVersion, type HubSigner, makeHeader, rolesMask } from "./sign.ts";
import { imageFileName, STAGING_PREFIX, storeFolder, storeUsage } from "./store.ts";

/** The bytes one piece reads ‡: 256 KB, as a hub release's staging (m2-design.md section 3). */
export const FIRMWARE_PIECE_BYTES = 256 * 1024;

export interface FirmwareStageInputs {
  /** The job's number: its temporary file is `.staging-<job>`. */
  readonly job: number;
  /** The upload in the data folder's `uploads/`. */
  readonly path: string;
  /** An owner's own build and the version given, or null for a publisher's `.hsnf`. */
  readonly own: { readonly version: string } | null;
  readonly dataDir: string;
  /** The publisher's keys a release must be signed by. */
  readonly keys: readonly Uint8Array[];
  readonly rules: HubRules["firmware"];
  /** The hub's signing key, read when the header is made. */
  readonly signer: () => Result<HubSigner, string>;
}

interface Failure {
  readonly reason: FileFailure;
  readonly message: string;
}

function failure(reason: FileFailure, message: string): Failure {
  return { reason, message };
}

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "reason" in value;
}

export type FirmwarePhase = "start" | "hash" | "copy" | "sync" | "rename" | "syncFolder";

/** What the first piece learned of the file. */
interface Plan {
  readonly payloadOffset: number;
  readonly payloadBytes: number;
  readonly version: { readonly major: number; readonly minor: number; readonly patch: number };
  readonly roles: number;
  /** A release's head; null for an own build. */
  readonly head: FirmwareHead | null;
}

/** The temporary file job `job` stages into: `.staging-<job>` in the store's folder. */
export function stagingFile(dataDir: string, job: number): string {
  return join(storeFolder(dataDir), `${STAGING_PREFIX}${job}`);
}

/** An image being staged, a bounded piece at a time. */
export class FirmwareStaging {
  readonly #inputs: FirmwareStageInputs;
  #phase: FirmwarePhase = "start";
  #ended: FileOutcome | undefined;
  #fd: number | undefined;
  #out: number | undefined;
  #plan: Plan | undefined;
  #readAt = 0;
  #hash: Hash = createHash("sha256");
  #copyHash: Hash = createHash("sha256");
  #layout: EspLayout | undefined;
  #sha256: Uint8Array | undefined;
  #header: Uint8Array | undefined;
  #placed = false;
  #bytesRead = 0;
  #largestPiece = 0;

  constructor(inputs: FirmwareStageInputs) {
    this.#inputs = inputs;
  }

  get phase(): FirmwarePhase {
    return this.#phase;
  }

  /** The upload's bytes read so far, both passes. */
  get bytesRead(): number {
    return this.#bytesRead;
  }

  /** The most bytes any one piece read: what a piece's time is bounded by. */
  get largestPiece(): number {
    return this.#largestPiece;
  }

  /** The temporary file this job writes. */
  get temporary(): string {
    return stagingFile(this.#inputs.dataDir, this.#inputs.job);
  }

  /** One piece; the outcome once staging has ended, undefined while there is more. */
  next(): FileOutcome | undefined {
    if (this.#ended !== undefined) return this.#ended;
    const read = this.#bytesRead;
    const step = this.#piece();
    this.#largestPiece = Math.max(this.#largestPiece, this.#bytesRead - read);
    if (step === undefined) return undefined;
    if (isFailure(step)) return this.#fail(step);
    this.#ended = step;
    this.#close();
    return step;
  }

  /** Ends staging now (a stop): what it wrote removed. */
  abort(message: string): FileOutcome {
    return this.#fail(failure("io", message));
  }

  #piece(): FileOutcome | Failure | undefined {
    switch (this.#phase) {
      case "start":
        return this.#start();
      case "hash":
        return this.#hashPiece();
      case "copy":
        return this.#copyPiece();
      case "sync":
        return this.#sync();
      case "rename":
        return this.#rename();
      case "syncFolder":
        return this.#syncFolder();
    }
  }

  #fail(why: Failure): FileOutcome {
    if (this.#ended !== undefined) return this.#ended;
    this.#close();
    if (!this.#placed) removeQuietly(this.temporary);
    this.#ended = { kind: "failed", reason: why.reason, message: why.message };
    return this.#ended;
  }

  #close(): void {
    if (this.#fd !== undefined) closeQuietly(this.#fd);
    if (this.#out !== undefined) closeQuietly(this.#out);
    this.#fd = undefined;
    this.#out = undefined;
  }

  #read(at: number, length: number): Uint8Array | Failure {
    const fd = this.#fd;
    if (fd === undefined) return failure("io", "staging lost its file");
    const bytes = new Uint8Array(length);
    const n = readAt(fd, bytes, at, "the upload");
    if (n.isErr()) return n.error;
    this.#bytesRead += n.value;
    return n.value === length ? bytes : bytes.subarray(0, n.value);
  }

  /** Every check but the hashes, in section 3's order; nothing written. */
  #start(): Failure | undefined {
    const fd = openToRead(this.#inputs.path);
    if (fd.isErr()) return fd.error;
    this.#fd = fd.value;
    const size = sizeOfOpen(fd.value, "the upload");
    if (size.isErr()) return size.error;
    const plan =
      this.#inputs.own === null
        ? this.#planRelease(size.value)
        : this.#planOwnBuild(size.value, this.#inputs.own.version);
    if (isFailure(plan)) return plan;
    this.#plan = plan;
    this.#readAt = plan.payloadOffset;
    if (this.#inputs.own !== null) this.#layout = new EspLayout();
    this.#phase = "hash";
    return undefined;
  }

  #planRelease(size: number): Plan | Failure {
    const head = this.#read(0, Math.min(size, HEAD_BYTES));
    if (isFailure(head)) return head;
    const parsed = parseFirmwareHead(head);
    if (parsed.isErr()) return parsed.error;
    const release = parsed.value;
    const manifest = release.manifest;
    if (!signedByOneOf(release, this.#inputs.keys))
      return failure("badSignature", "no publisher key signed this release");
    if (manifest.target !== FIRMWARE_RELEASE.target)
      return failure(
        "wrongTarget",
        `a release for ${manifest.target}, not ${FIRMWARE_RELEASE.target}`,
      );
    const payloadHead = this.#read(
      release.payloadOffset,
      Math.max(0, Math.min(ESP_HEAD_BYTES, size - release.payloadOffset)),
    );
    if (isFailure(payloadHead)) return payloadHead;
    const esp = readEspHead(payloadHead);
    if (esp.magic && esp.chip !== undefined && esp.chip !== ESP_IMAGE.chipEsp32s3)
      return failure("wrongTarget", `a payload for chip ${esp.chip}, not the ESP32-S3`);
    if (manifest.payloadBytes > this.#inputs.rules.slotBytes)
      return failure(
        "tooLarge",
        `a payload of ${manifest.payloadBytes} bytes: a slot holds ${this.#inputs.rules.slotBytes}`,
      );
    if (size - release.payloadOffset !== manifest.payloadBytes)
      return failure(
        "badFile",
        `the payload is ${size - release.payloadOffset} bytes, the manifest says ${manifest.payloadBytes}`,
      );
    if (!esp.magic) return failure("badFile", "the payload is not an ESP application image");
    if (esp.version !== manifest.version)
      return failure(
        "badFile",
        `the payload's app description names ${esp.version ?? "no version"}, the manifest ${manifest.version}`,
      );
    const version = headerVersion(manifest.version);
    if (version === undefined)
      return failure("badFile", `version ${manifest.version} does not fit an image header`);
    return {
      payloadOffset: release.payloadOffset,
      payloadBytes: manifest.payloadBytes,
      version,
      roles: rolesMask(manifest.roles),
      head: release,
    };
  }

  #planOwnBuild(size: number, given: string): Plan | Failure {
    const head = this.#read(0, Math.min(size, ESP_HEAD_BYTES));
    if (isFailure(head)) return head;
    const esp = readEspHead(head);
    if (!esp.magic || esp.chip === undefined)
      return failure("badFile", "not an ESP application image");
    if (esp.chip !== ESP_IMAGE.chipEsp32s3)
      return failure("wrongTarget", `an image for chip ${esp.chip}, not the ESP32-S3`);
    if (size > this.#inputs.rules.slotBytes)
      return failure(
        "tooLarge",
        `an image of ${size} bytes: a slot holds ${this.#inputs.rules.slotBytes}`,
      );
    if (esp.version !== given)
      return failure(
        "badFile",
        `the image's app description names ${esp.version ?? "no version"}, not ${given}`,
      );
    const version = headerVersion(given);
    if (version === undefined)
      return failure("badFile", `version ${given} does not fit an image header`);
    return { payloadOffset: 0, payloadBytes: size, version, roles: rolesMask("all"), head: null };
  }

  /** Pass 1: the payload's hash (and an own build's layout), a piece at a time; nothing written. */
  #hashPiece(): Failure | undefined {
    const plan = this.#plan;
    if (plan === undefined) return failure("io", "staging lost its plan");
    const end = plan.payloadOffset + plan.payloadBytes;
    const piece = this.#read(this.#readAt, Math.min(FIRMWARE_PIECE_BYTES, end - this.#readAt));
    if (isFailure(piece)) return piece;
    if (piece.length === 0 && this.#readAt < end) return failure("badFile", "the file ended early");
    this.#hash.update(piece);
    this.#layout?.add(piece);
    this.#readAt += piece.length;
    if (this.#readAt < end) return undefined;
    const sha256 = new Uint8Array(this.#hash.digest());
    if (
      plan.head !== null &&
      Buffer.from(sha256).toString("hex") !== plan.head.manifest.payloadSha256
    )
      return failure("badFile", "the payload's hash is not the manifest's");
    const problem = this.#layout?.finish();
    if (problem !== undefined) return failure("badFile", problem);
    this.#sha256 = sha256;
    // The store's room: four images ‡ and 8 MB ‡ (D140), an image already there replaced.
    const usage = storeUsage(this.#inputs.dataDir);
    if (usage.isErr()) return usage.error;
    const name = imageFileName(sha256);
    if (!usage.value.files.has(name)) {
      const rules = this.#inputs.rules;
      const bytes = [...usage.value.files.values()].reduce((sum, n) => sum + n, 0);
      if (
        usage.value.files.size >= rules.maxImages ||
        bytes + plan.payloadBytes > rules.storeMaxBytes
      )
        return failure(
          "storeFull",
          `the store holds ${usage.value.files.size} images, ${bytes} bytes`,
        );
    }
    const signer = this.#inputs.signer();
    if (signer.isErr()) return failure("io", signer.error);
    const header = makeHeader(
      {
        ownBuild: plan.head === null,
        roles: plan.roles,
        version: plan.version,
        imageBytes: plan.payloadBytes,
        imageSha256: sha256,
      },
      signer.value,
    );
    if (header.isErr()) return failure("io", header.error);
    this.#header = header.value;
    // Only now is anything written: the temporary file, after one an earlier run left.
    const folder = ensureFolder(storeFolder(this.#inputs.dataDir));
    if (folder.isErr()) return folder.error;
    removeQuietly(this.temporary);
    const out = openNew(this.temporary);
    if (out.isErr()) return out.error;
    this.#out = out.value;
    this.#readAt = plan.payloadOffset;
    this.#phase = "copy";
    return undefined;
  }

  /** Pass 2: the payload copied into the temporary file, a piece at a time, hashed again. */
  #copyPiece(): Failure | undefined {
    const plan = this.#plan;
    const out = this.#out;
    if (plan === undefined || out === undefined) return failure("io", "staging lost its file");
    const end = plan.payloadOffset + plan.payloadBytes;
    const piece = this.#read(this.#readAt, Math.min(FIRMWARE_PIECE_BYTES, end - this.#readAt));
    if (isFailure(piece)) return piece;
    if (piece.length === 0 && this.#readAt < end) return failure("badFile", "the file ended early");
    const written = writeAll(out, piece, this.temporary);
    if (written.isErr()) return written.error;
    this.#copyHash.update(piece);
    this.#readAt += piece.length;
    if (this.#readAt < end) return undefined;
    const copied = new Uint8Array(this.#copyHash.digest());
    if (!copied.every((b, i) => b === this.#sha256?.[i]))
      return failure("io", "the upload changed while it was staged");
    this.#phase = "sync";
    return undefined;
  }

  /** The temporary file's bytes on the disk, and the file closed. */
  #sync(): Failure | undefined {
    const out = this.#out;
    if (out === undefined) return failure("io", "staging lost its file");
    const synced = syncOpen(out, this.temporary);
    if (synced.isErr()) return synced.error;
    closeQuietly(out);
    this.#out = undefined;
    this.#phase = "rename";
    return undefined;
  }

  /** The file under its name: from here it stays, whatever follows. */
  #rename(): Failure | undefined {
    const sha256 = this.#sha256;
    if (sha256 === undefined) return failure("io", "staging lost its hash");
    const placed = renameFile(
      this.temporary,
      join(storeFolder(this.#inputs.dataDir), imageFileName(sha256)),
    );
    if (placed.isErr()) return placed.error;
    this.#placed = true;
    this.#phase = "syncFolder";
    return undefined;
  }

  /** The rename on the disk; then the image is staged. */
  #syncFolder(): FileOutcome | Failure {
    const synced = syncFolder(storeFolder(this.#inputs.dataDir));
    if (synced.isErr()) return synced.error;
    return this.#outcome();
  }

  #outcome(): FileOutcome | Failure {
    const plan = this.#plan;
    const sha256 = this.#sha256;
    const header = this.#header;
    if (plan === undefined || sha256 === undefined || header === undefined)
      return failure("io", "staging lost its image");
    const { major, minor, patch } = plan.version;
    return {
      kind: "firmwareStaged",
      image: {
        imageId: sha256.slice(0, 8),
        sha256,
        version: major * 65_536 + minor * 256 + patch,
        kind: plan.head === null ? ImageKind.OwnBuild : ImageKind.Official,
        roles: plan.roles,
        bytes: plan.payloadBytes,
        header,
        manifest: plan.head === null ? null : manifestColumn(plan.head),
        file: imageFileName(sha256),
      },
    };
  }
}

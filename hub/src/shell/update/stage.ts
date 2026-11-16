/**
 * `stageUpdate` (m2-design.md section 9, "Hub updates", step 1; release format 2), **in pieces
 * between the loop's turns** (section 3, "The loop's time"): no piece holds the loop for more
 * than about 20 ms on a Raspberry Pi, and the hub stays one thread with one order of events.
 *
 * - **The first piece** checks everything but the hashes, on the uploaded file itself, in section
 *   9's order: the head and the manifest (`badFile`: a wrong magic or format byte, a manifest the
 *   schema or `manifestProblem` refuses), its signature by a compiled-in key (`badSignature`), the
 *   platform (`wrongSystem`), the version above the running one (`notNewer`), the payload's length
 *   and the program among the files (`badFile`).
 * - **Pass 1** reads the payload `STAGING_PIECE_BYTES` ‡ a piece and computes its SHA-256 with
 *   `node:crypto`, which must be `payloadSha256`. Not a byte is written before it passes.
 * - **Pass 2** copies each file's byte range into a folder beside the hub's `staged/` versions, the same size a
 *   piece and at most `STAGING_FILES_PER_PIECE` ‡ files made, checking each file's own SHA-256 as it ends; the paths are the manifest's, already
 *   checked to stay inside.
 * - **Then** any version but the current one is removed, one a piece (at most two, section 9;
 *   never before the hashes, so a refused release costs the rollback nothing), and the folder is
 *   renamed to `staged/<version>/` in the hub's program tree (section 9, "The privilege boundary").
 *
 * A failure at any piece, `abort` (a stop) and a staging the core no longer wants (`wanted`: a
 * cancel, a restore; looked at before every piece) delete the folder: nothing is left behind.
 */
import { createHash, type Hash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Result } from "neverthrow";
import { installPaths, isVersionName, parseLauncherState } from "../../../launcher/src/layout.ts";
import type { FileFailure, FileOutcome } from "../../core/model/events.ts";
import { fileError, listFolder, readHead, rename } from "../backup/files.ts";
import { programName } from "./program-name.ts";
import {
  isNewer,
  type Manifest,
  parseHead,
  RELEASE,
  type ReleasePlatform,
  signedByOneOf,
} from "./release.ts";

/** The payload's bytes one piece reads ‡ (provisional): under about 20 ms on a Pi (section 3). */
export const STAGING_PIECE_BYTES = 256 * 1024;
/** Files one piece of pass 2 creates at most ‡: a file made and its mode set cost a card far more than its bytes. */
export const STAGING_FILES_PER_PIECE = 16;

export interface StageInputs {
  /** The upload in the data folder's `uploads/`. */
  readonly path: string;
  /** The hub's program tree, from the launcher (`HSN_PROGRAM`); none when it did not start this hub. */
  readonly prefix: string | undefined;
  readonly runningVersion: string;
  readonly platform: ReleasePlatform | undefined;
  readonly keys: readonly Uint8Array[];
  /** Whether the core still wants this staging (`upkeep`'s view); looked at before every piece. */
  readonly wanted?: () => boolean;
}

interface Failure {
  readonly reason: FileFailure;
  readonly message: string;
}

function failure(reason: FileFailure, message: string): Failure {
  return { reason, message };
}

/** The file pass 2 is writing. */
interface Writing {
  readonly index: number;
  readonly fd: number;
  readonly hash: Hash;
  written: number;
}

export type Phase = "start" | "hash" | "copy" | "place";

/** One release being staged, a bounded piece at a time. */
export class Staging {
  readonly #inputs: StageInputs;
  #phase: Phase = "start";
  #ended: FileOutcome | undefined;
  #fd: number | undefined;
  #manifest: Manifest | undefined;
  #payloadOffset = 0;
  #readAt = 0;
  #hash: Hash | undefined;
  #fileIndex = 0;
  #writing: Writing | undefined;
  #folder: string | undefined;
  #target: string | undefined;
  #versions: string | undefined;
  #launcherFile: string | undefined;
  #removing: string[] | undefined;
  #bytesRead = 0;

  constructor(inputs: StageInputs) {
    this.#inputs = inputs;
  }

  /** Where it is, for measurements: the checks, pass 1 (`hash`), pass 2 (`copy`), the placing. */
  get phase(): Phase {
    return this.#phase;
  }

  /** The release's bytes read so far, both passes: what a piece's work is bounded by. */
  get bytesRead(): number {
    return this.#bytesRead;
  }

  /** One piece; the outcome once staging has ended, undefined while there is more. */
  next(): FileOutcome | undefined {
    if (this.#ended !== undefined) return this.#ended;
    if (this.#inputs.wanted?.() === false) return this.abort("staging was cancelled");
    const done = Result.fromThrowable(() => this.#piece(), fileError("stage the release"))();
    if (done.isErr()) return this.#fail(done.error);
    const step = done.value;
    if (step === undefined) return undefined;
    if (!("kind" in step)) return this.#fail(step);
    this.#ended = step;
    this.#close();
    return step;
  }

  /** Ends staging now (a stop): everything it wrote removed. */
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
      case "place":
        return this.#place();
    }
  }

  #fail(why: Failure): FileOutcome {
    if (this.#ended !== undefined) return this.#ended;
    this.#close();
    const folder = this.#folder;
    if (folder !== undefined)
      Result.fromThrowable(() => {
        rmSync(folder, { recursive: true, force: true });
      })().match(
        () => undefined,
        () => undefined,
      );
    this.#ended = { kind: "failed", reason: why.reason, message: why.message };
    return this.#ended;
  }

  #close(): void {
    for (const fd of [this.#fd, this.#writing?.fd])
      if (fd !== undefined)
        Result.fromThrowable(() => {
          closeSync(fd);
        })().match(
          () => undefined,
          () => undefined,
        );
    this.#fd = undefined;
    this.#writing = undefined;
  }

  /** Every check but the hashes; nothing written. */
  #start(): Failure | undefined {
    const inputs = this.#inputs;
    const head = readHead(
      inputs.path,
      RELEASE.fixedBytes + RELEASE.maxManifestBytes + RELEASE.signatureBytes,
    );
    if (head.isErr()) return head.error;
    const parsed = parseHead(head.value);
    if (parsed.isErr()) return parsed.error;
    const release = parsed.value;
    const manifest = release.manifest;
    if (!signedByOneOf(release, inputs.keys))
      return failure("badSignature", "no trusted key signed this release");
    if (inputs.platform === undefined || manifest.platform !== inputs.platform)
      return failure(
        "wrongSystem",
        `a release for ${manifest.platform}, not ${inputs.platform ?? "this computer"}`,
      );
    if (!isNewer(manifest.version, inputs.runningVersion))
      return failure("notNewer", `${manifest.version} is not newer than ${inputs.runningVersion}`);
    const program = `bin/${programName(inputs.platform)}`;
    if (!manifest.files.some((file) => file.path === program && file.executable))
      return failure("badFile", `the release holds no ${program}`);
    // The file is judged first (section 9: a file that is not a release is `badFile` wherever it
    // is staged); only a good one asks where it would go.
    if (inputs.prefix === undefined)
      return failure("io", "not started by the launcher: no install to stage into");
    const fd = openSync(inputs.path, "r");
    this.#fd = fd;
    const size = fstatSync(fd).size;
    if (size - release.payloadOffset !== manifest.payloadBytes)
      return failure(
        "badFile",
        `the payload is ${size - release.payloadOffset} bytes, the manifest says ${manifest.payloadBytes}`,
      );
    this.#manifest = manifest;
    this.#payloadOffset = release.payloadOffset;
    this.#readAt = release.payloadOffset;
    this.#hash = createHash("sha256");
    const paths = installPaths(inputs.prefix);
    this.#versions = paths.staged;
    this.#launcherFile = paths.launcherFile;
    this.#folder = join(paths.staged, `.staging-${manifest.version}`);
    this.#target = join(paths.staged, manifest.version);
    this.#phase = "hash";
    return undefined;
  }

  #read(at: number, length: number): Uint8Array | Failure {
    const fd = this.#fd;
    if (fd === undefined) return failure("io", "staging lost its file");
    const bytes = new Uint8Array(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, bytes, got, length - got, at + got);
      if (n === 0) return failure("badFile", "the file ended early");
      got += n;
    }
    this.#bytesRead += length;
    return bytes;
  }

  /** Pass 1: the whole payload's hash, a piece at a time; nothing written. */
  #hashPiece(): Failure | undefined {
    const manifest = this.#manifest;
    const hash = this.#hash;
    if (manifest === undefined || hash === undefined)
      return failure("io", "staging lost its release");
    const end = this.#payloadOffset + manifest.payloadBytes;
    const piece = this.#read(this.#readAt, Math.min(STAGING_PIECE_BYTES, end - this.#readAt));
    if (!(piece instanceof Uint8Array)) return piece;
    hash.update(piece);
    this.#readAt += piece.length;
    if (this.#readAt < end) return undefined;
    if (hash.digest("hex") !== manifest.payloadSha256)
      return failure("badFile", "the payload's hash is not the manifest's");
    // Only now is anything written: a folder beside, what an earlier staging left removed first.
    const versions = this.#versions ?? "";
    mkdirSync(versions, { recursive: true });
    const names = listFolder(versions);
    if (names.isErr()) return names.error;
    for (const name of names.value)
      if (name.startsWith(".staging-"))
        rmSync(join(versions, name), { recursive: true, force: true });
    mkdirSync(this.#folder ?? "", { recursive: true });
    this.#readAt = this.#payloadOffset;
    this.#phase = "copy";
    return undefined;
  }

  /** Pass 2: the files copied out, at most a piece's bytes, each checked by its own hash. */
  #copyPiece(): Failure | undefined {
    const manifest = this.#manifest;
    const folder = this.#folder;
    if (manifest === undefined || folder === undefined)
      return failure("io", "staging lost its release");
    let budget = STAGING_PIECE_BYTES;
    let made = 0;
    while (budget > 0 || this.#writing === undefined) {
      const file = manifest.files[this.#fileIndex];
      if (file === undefined) {
        this.#prepareRemoval();
        this.#phase = "place";
        return undefined;
      }
      let writing = this.#writing;
      if (writing === undefined) {
        if (made >= STAGING_FILES_PER_PIECE) return undefined;
        made += 1;
        const path = join(folder, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writing = {
          index: this.#fileIndex,
          fd: openSync(path, "wx", 0o600),
          hash: createHash("sha256"),
          written: 0,
        };
        this.#writing = writing;
      }
      const take = Math.min(budget, file.bytes - writing.written);
      if (take > 0) {
        const bytes = this.#read(this.#readAt, take);
        if (!(bytes instanceof Uint8Array)) return bytes;
        let done = 0;
        while (done < bytes.length) done += writeSync(writing.fd, bytes, done, bytes.length - done);
        writing.hash.update(bytes);
        writing.written += take;
        this.#readAt += take;
        budget -= take;
      }
      if (writing.written < file.bytes) return undefined;
      closeSync(writing.fd);
      this.#writing = undefined;
      if (writing.hash.digest("hex") !== file.sha256)
        return failure("badFile", `${file.path}'s hash is not the manifest's`);
      if (process.platform !== "win32")
        chmodSync(join(folder, file.path), file.executable ? 0o755 : 0o644);
      this.#fileIndex += 1;
      if (budget <= 0) return undefined;
    }
    return undefined;
  }

  /** The versions to remove once every file is in: any but the current one (at most two). */
  #prepareRemoval(): void {
    const versions = this.#versions ?? "";
    const state = readHead(this.#launcherFile ?? "", 4096).map((b) =>
      parseLauncherState(new TextDecoder().decode(b)),
    );
    const current = state.isOk() ? state.value?.current : undefined;
    const names = listFolder(versions);
    this.#removing = names.isOk()
      ? names.value
          .filter((name) => name !== current && isVersionName(name))
          .map((name) => join(versions, name))
      : [];
  }

  /** One old version removed a piece, then the new one put in place. */
  #place(): FileOutcome | Failure | undefined {
    const manifest = this.#manifest;
    const folder = this.#folder;
    const target = this.#target;
    if (manifest === undefined || folder === undefined || target === undefined)
      return failure("io", "staging lost its release");
    const old = this.#removing?.shift();
    if (old !== undefined) {
      rmSync(old, { recursive: true, force: true });
      return undefined;
    }
    const placed = rename(folder, target);
    if (placed.isErr()) return placed.error;
    return { kind: "updateStaged", version: manifest.version };
  }
}

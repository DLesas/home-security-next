/**
 * The releases role's index (docs/m4-design.md section 6; the frozen `ReleaseIndex`): every signed
 * file in its folder, `hsn-hub-<version>-<platform>.hsnr` and `hsn-firmware-<version>.hsnf`, read
 * at start and every `RELEASES_RULES.refreshMs`, each manifest read with the matching schema of
 * `@hsn/protocol/release`, kept with its kind, version, platform or target and roles, length and
 * SHA-256 (of the whole file, which the hub checks as it fetches). It checks no signature: it is
 * not trusted to; the hub checks against `PUBLISHER_KEYS`.
 *
 * A file is left out of the index, and counted in the log, when its name is neither kind's, its
 * head or manifest does not read, its manifest's version or platform is not its name's, its
 * firmware target is not one the offer can name (`esp32s3`), or it is larger than its kind's cap
 * (`RELAY_LIMITS.maxHubReleaseBytes`, `maxFirmwareReleaseBytes`): the hub would refuse it before
 * fetching a byte, and offering it would hide an older one it could take. Files whose size and
 * change time have not changed are not read or hashed again.
 */
import { join } from "node:path";
import {
  FIRMWARE_RELEASE,
  firmwareManifestSchema,
  HUB_RELEASE,
  hubManifestSchema,
  parseReleaseFileName,
} from "@hsn/protocol/release";
import {
  RELAY_LIMITS,
  type ReleaseCheck,
  type ReleaseOffer,
  releaseOffer,
} from "@hsn/protocol/relay";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type { RelayLog } from "../shell/log.ts";
import type { ReleaseIndex, ReleaseIndexEntry, ReleaseReadError } from "./release-index.ts";
import { fileFacts, listFiles, readRange, sha256FileInPieces } from "./safe/fs.ts";

/** Compares two `MAJOR.MINOR.PATCH` versions as numbers: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
/** `TextDecoder.decode` and `JSON.parse` throw; neverthrow turns that into an error (no `try` here). */
const decodeUtf8 = Result.fromThrowable(
  (bytes: Uint8Array) => decoder.decode(bytes),
  () => "badText" as const,
);
const parseJsonText = Result.fromThrowable(
  (text: string) => JSON.parse(text) as unknown,
  () => "badJson" as const,
);

interface Cached {
  readonly bytes: number;
  readonly changedMs: number;
  readonly entry: ReleaseIndexEntry | undefined;
}

/** Reads one file's head and manifest: its entry, or undefined when it is not one to offer. */
async function readEntry(
  folder: string,
  name: string,
  bytes: number,
): Promise<ReleaseIndexEntry | undefined> {
  const named = parseReleaseFileName(name);
  if (named === undefined) return undefined;
  const path = join(folder, name);
  const layout = named.kind === "hub" ? HUB_RELEASE : FIRMWARE_RELEASE;
  const cap =
    named.kind === "hub" ? RELAY_LIMITS.maxHubReleaseBytes : RELAY_LIMITS.maxFirmwareReleaseBytes;
  if (bytes > cap || bytes < layout.fixedBytes) return undefined;
  const fixed = readRange(path, 0, layout.fixedBytes);
  if (fixed.isErr()) return undefined;
  const head = fixed.value;
  const magic = String.fromCharCode(...head.subarray(0, 4));
  if (magic !== layout.magic || head[4] !== layout.format) return undefined;
  const manifestBytes = new DataView(head.buffer, head.byteOffset).getUint32(8, true);
  if (
    manifestBytes === 0 ||
    manifestBytes > layout.maxManifestBytes ||
    layout.fixedBytes + manifestBytes + layout.signatureBytes > bytes
  ) {
    return undefined;
  }
  const manifestRead = readRange(path, layout.fixedBytes, manifestBytes);
  if (manifestRead.isErr()) return undefined;
  const json = decodeUtf8(manifestRead.value).andThen(parseJsonText);
  if (json.isErr()) return undefined;
  const hashed = await sha256FileInPieces(path, RELAY_LIMITS.maxReleasePieceBytes);
  if (hashed.isErr()) return undefined;
  let offer: ReleaseOffer;
  if (named.kind === "hub") {
    const manifest = hubManifestSchema.safeParse(json.value);
    if (
      !manifest.success ||
      manifest.data.version !== named.version ||
      manifest.data.platform !== named.platform
    ) {
      return undefined;
    }
    offer = {
      kind: "hub",
      version: named.version,
      platform: named.platform,
      file: name,
      bytes,
      sha256: hashed.value,
    };
  } else {
    const manifest = firmwareManifestSchema.safeParse(json.value);
    if (
      !manifest.success ||
      manifest.data.version !== named.version ||
      manifest.data.target !== FIRMWARE_RELEASE.target
    ) {
      return undefined;
    }
    offer = {
      kind: "firmware",
      version: named.version,
      target: FIRMWARE_RELEASE.target,
      roles: [...manifest.data.roles],
      file: name,
      bytes,
      sha256: hashed.value,
    };
  }
  // What the hub would read from the offer frame, checked here, so nothing it refuses is offered.
  const checked = releaseOffer.safeParse(offer);
  return checked.success ? { ...checked.data, path } : undefined;
}

function sortKey(entry: ReleaseIndexEntry): string {
  return entry.kind === "hub" ? `hub/${entry.platform}` : `firmware/${entry.target}`;
}

export class FolderReleaseIndex implements ReleaseIndex {
  private list: readonly ReleaseIndexEntry[] = [];
  private readonly cache = new Map<string, Cached>();
  private running: Promise<Result<void, ReleaseReadError>> | undefined;

  constructor(
    readonly folder: string,
    private readonly log: RelayLog,
  ) {}

  entries(): readonly ReleaseIndexEntry[] {
    return this.list;
  }

  /** The entry of a file, by name. */
  find(file: string): ReleaseIndexEntry | undefined {
    return this.list.find((entry) => entry.file === file);
  }

  offer(check: ReleaseCheck): readonly ReleaseOffer[] {
    const strip = (e: ReleaseIndexEntry): ReleaseOffer =>
      e.kind === "hub"
        ? {
            kind: e.kind,
            version: e.version,
            platform: e.platform,
            file: e.file,
            bytes: e.bytes,
            sha256: e.sha256,
          }
        : {
            kind: e.kind,
            version: e.version,
            target: e.target,
            roles: e.roles,
            file: e.file,
            bytes: e.bytes,
            sha256: e.sha256,
          };
    const hub = this.list.find(
      (entry) =>
        entry.kind === "hub" &&
        entry.platform === check.platform &&
        compareVersions(entry.version, check.running) > 0,
    );
    const firmware = this.list.find(
      (entry) =>
        entry.kind === "firmware" &&
        (check.firmware === undefined || compareVersions(entry.version, check.firmware) > 0),
    );
    return [hub, firmware].filter((e) => e !== undefined).map(strip);
  }

  read(file: string, offset: number, length: number): ResultAsync<Uint8Array, ReleaseReadError> {
    const entry = this.find(file);
    if (entry === undefined) return errAsync({ kind: "notFound" });
    if (offset < 0 || length < 1 || offset + length > entry.bytes)
      return errAsync({ kind: "range" });
    const read = readRange(entry.path, offset, length);
    return read.isOk() ? okAsync(read.value) : errAsync({ kind: "unavailable" });
  }

  /**
   * Reads the folder again. A new or changed file is hashed in pieces, the relay serving its links
   * between them (`sha256FileInPieces`); the index changes only once the whole folder is read. A
   * refresh asked while one runs joins it.
   */
  refresh(): ResultAsync<void, ReleaseReadError> {
    this.running ??= this.refreshAll().finally(() => {
      this.running = undefined;
    });
    return new ResultAsync(this.running);
  }

  private async refreshAll(): Promise<Result<void, ReleaseReadError>> {
    const names = listFiles(this.folder);
    if (names.isErr()) {
      this.log.write("error", "releaseIndex", {}, names.error);
      return err({ kind: "unavailable" });
    }
    const seen = new Set<string>();
    let refused = 0;
    for (const name of names.value) {
      if (parseReleaseFileName(name) === undefined) continue;
      seen.add(name);
      const facts = fileFacts(join(this.folder, name));
      if (facts.isErr()) continue;
      const cached = this.cache.get(name);
      if (cached?.bytes === facts.value.bytes && cached.changedMs === facts.value.changedMs) {
        if (cached.entry === undefined) refused += 1;
        continue;
      }
      const entry = await readEntry(this.folder, name, facts.value.bytes);
      if (entry === undefined) refused += 1;
      this.cache.set(name, { ...facts.value, entry });
    }
    for (const name of [...this.cache.keys()]) if (!seen.has(name)) this.cache.delete(name);
    this.list = [...this.cache.values()]
      .map((c) => c.entry)
      .filter((e) => e !== undefined)
      .sort((a, b) => {
        const k = sortKey(a).localeCompare(sortKey(b));
        return k !== 0 ? k : compareVersions(b.version, a.version);
      });
    this.log.write("info", "releaseIndex", { files: this.list.length, refused });
    return ok(undefined);
  }
}

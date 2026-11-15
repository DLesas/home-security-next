#!/usr/bin/env bun
/**
 * `bun make-release.ts --folder <versions/<v> folder> --version <v> --platform <p> --seed <file> --out <folder>`:
 * a release file, format 2 (`hub/src/shell/update/release.ts`; m2-design.md section 9), of one
 * version's folder as `build-program.ts` lays it out: every file, in path order, its path, size,
 * SHA-256 and whether it is executable (the bits on macOS and Linux; on Windows, where there are
 * none, every file under `bin/`) in the manifest, the files' bytes concatenated uncompressed after
 * it, the manifest signed with the publisher's Ed25519 key (`--seed`: a file holding its 32-byte
 * seed, the product owner's, never in the repository). Prints the file's path.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { err, ok, Result } from "neverthrow";
import {
  isSafePath,
  makeRelease,
  type Manifest,
  RELEASE,
  RELEASE_PLATFORMS,
  type ReleaseFile,
  type ReleasePlatform,
  versionNumbers,
} from "../../src/shell/update/release.ts";
import { joined } from "../../src/shell/backup/files.ts";

export interface ReleaseEntry {
  readonly path: string;
  readonly data: Uint8Array;
  readonly executable: boolean;
}

/** Every file under `root`, in path order (folders are implied). */
export function filesOf(
  root: string,
  platform: ReleasePlatform,
): Result<readonly ReleaseEntry[], string> {
  return Result.fromThrowable(
    () => {
      const out: ReleaseEntry[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir).toSorted()) {
          const full = join(dir, name);
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else {
            const path = relative(root, full).split("\\").join("/");
            const executable =
              platform === "windows-x64" ? path.startsWith("bin/") : (st.mode & 0o111) !== 0;
            out.push({ path, data: new Uint8Array(readFileSync(full)), executable });
          }
        }
      };
      walk(root);
      return out;
    },
    (thrown) => String(thrown),
  )();
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The release file's bytes for these files. */
export function releaseOfFiles(
  entries: readonly ReleaseEntry[],
  version: string,
  platform: ReleasePlatform,
  seed: Uint8Array,
  madeMs: number,
): Result<Uint8Array, string> {
  if (versionNumbers(version) === undefined) return err(`not MAJOR.MINOR.PATCH: ${version}`);
  const unsafe = entries.find((e) => !isSafePath(e.path));
  if (unsafe !== undefined) return err(`a path a release may not carry: ${unsafe.path}`);
  const files: ReleaseFile[] = entries.map((e) => ({
    path: e.path,
    bytes: e.data.length,
    sha256: sha(e.data),
    executable: e.executable,
  }));
  const payload = joined(entries.map((e) => e.data));
  const manifest: Manifest = {
    version,
    platform,
    madeMs,
    payloadBytes: payload.length,
    payloadSha256: sha(payload),
    files,
  };
  return makeRelease(manifest, payload, seed);
}

/** The release file's bytes for a folder. */
export function releaseOf(
  folder: string,
  version: string,
  platform: ReleasePlatform,
  seed: Uint8Array,
  madeMs: number,
): Result<Uint8Array, string> {
  return filesOf(folder, platform).andThen((entries) =>
    releaseOfFiles(entries, version, platform, seed, madeMs),
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string) => args[args.indexOf(flag) + 1];
  const platform = get("--platform") ?? "";
  const folder = get("--folder");
  const version = get("--version");
  const seedFile = get("--seed");
  const out = get("--out");
  if (
    !(RELEASE_PLATFORMS as readonly string[]).includes(platform) ||
    folder === undefined ||
    version === undefined ||
    seedFile === undefined ||
    out === undefined
  ) {
    process.stderr.write(
      "usage: make-release.ts --folder <dir> --version <v> --platform <p> --seed <file> --out <dir>\n",
    );
    process.exit(2);
  }
  const made = Result.fromThrowable(() => new Uint8Array(readFileSync(seedFile)), String)()
    .andThen((seed) => (seed.length === 32 ? ok(seed) : err("the seed is not 32 bytes")))
    .andThen((seed) => releaseOf(folder, version, platform as ReleasePlatform, seed, Date.now()))
    .andThen((file) => {
      const path = join(out, `hsn-hub-${version}-${platform}${RELEASE.extension}`);
      return Result.fromThrowable(() => {
        writeFileSync(path, file);
        return path;
      }, String)();
    });
  if (made.isErr()) {
    process.stderr.write(`make-release: ${made.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`${made.value}\n`);
}

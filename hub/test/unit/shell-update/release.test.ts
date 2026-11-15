/**
 * The release file and its staging (m2-design.md section 9, "Hub updates"), on real files: a
 * release made by the release tool and checked in section 9's order, each refusal (`badFile`,
 * `badSignature`, `wrongSystem`, `notNewer`), nothing unpacked unless every check passed, the
 * archive's paths kept inside, at most two versions, numeric versions, the compiled-in keys (at
 * most two, never the tests'), and a switch refused without room for the database's copy.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
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
import { Database } from "bun:sqlite";
import { ok } from "neverthrow";
import { releaseOf } from "../../../packaging/shared/make-release.ts";
import { createHash } from "node:crypto";
import { installPaths } from "../../../launcher/src/layout.ts";
import { connId, jobId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { runToEnd } from "../../../src/shell/backup/jobs.ts";
import {
  PUBLISHER_KEYS,
  releaseKeysProblem,
  TEST_PUBLISHER_KEY,
} from "../../../src/shell/update/publisher-keys.ts";
import {
  isNewer,
  makeRelease,
  platformOf,
  publicOfSeed,
  RELEASE,
} from "../../../src/shell/update/release.ts";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import {
  STAGING_FILES_PER_PIECE,
  type StageInputs,
  Staging,
} from "../../../src/shell/update/stage.ts";

const SEED = new Uint8Array(32).fill(7);
const OTHER_SEED = new Uint8Array(32).fill(8);
const folders: string[] = [];
afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

let prefix: string;
let source: string;
let upload: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "hsn-release-"));
  folders.push(root);
  prefix = join(root, "prefix");
  for (const v of ["0.0.9", "0.1.0"])
    mkdirSync(join(prefix, "versions", v, "bin"), { recursive: true });
  mkdirSync(join(prefix, "state"), { recursive: true });
  writeFileSync(
    installPaths(prefix).launcherFile,
    JSON.stringify({ current: "0.1.0", previous: "0.0.9", trial: null, rolledBack: null }),
  );
  source = join(root, "source");
  mkdirSync(join(source, "bin"), { recursive: true });
  mkdirSync(join(source, "web"), { recursive: true });
  mkdirSync(join(source, "drizzle"), { recursive: true });
  writeFileSync(join(source, "bin", "hsn-hub"), "#!/bin/sh\necho hub\n", { mode: 0o755 });
  writeFileSync(join(source, "web", "index.html"), "<html></html>");
  writeFileSync(join(source, "drizzle", "0000.sql"), "CREATE TABLE x (a);");
  upload = join(root, "upload.hsnr");
});

function release(
  version = "1.0.0",
  platform: "darwin-arm64" | "linux-x64" = "darwin-arm64",
  seed = SEED,
): Uint8Array {
  const made = releaseOf(source, version, platform, seed, 0);
  expect(made.isOk()).toBe(true);
  return made._unsafeUnwrap();
}

/** A release of these files, signed, its manifest as given (a file's hash or the sizes made wrong). */
function signed(
  files: readonly { path: string; data: Uint8Array; executable: boolean; sha256?: string }[],
  options: { extraBytes?: number } = {},
): Uint8Array {
  const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const payload = Uint8Array.from(Buffer.concat(files.map((f) => f.data)));
  return makeRelease(
    {
      version: "1.0.0",
      platform: "darwin-arm64",
      madeMs: 0,
      payloadBytes: payload.length + (options.extraBytes ?? 0),
      payloadSha256: hex(payload),
      files: files.map((f) => ({
        path: f.path,
        bytes: f.data.length,
        sha256: f.sha256 ?? hex(f.data),
        executable: f.executable,
      })),
    },
    payload,
    SEED,
  )._unsafeUnwrap();
}

/** A text holding `part`, as a matcher's value with a type. */
function containing(part: string): string {
  const matcher: unknown = expect.stringContaining(part);
  return matcher as string;
}

/** Every piece of a staging, one after another, as the loop would run them a turn apart. */
function stageRelease(inputs: StageInputs): FileOutcome {
  const staging = new Staging(inputs);
  for (;;) {
    const outcome = staging.next();
    if (outcome !== undefined) return outcome;
  }
}

function stage(
  file: Uint8Array,
  keys: readonly Uint8Array[] = [TEST_PUBLISHER_KEY],
): ReturnType<typeof stageRelease> {
  writeFileSync(upload, file);
  return stageRelease({
    path: upload,
    prefix,
    runningVersion: "0.1.0",
    platform: "darwin-arm64",
    keys,
  });
}

function versions(): string[] {
  return readdirSync(join(prefix, "versions")).toSorted();
}

describe("a release", () => {
  test("checked and unpacked beside the running version; at most two versions kept", () => {
    expect(stage(release())).toEqual({ kind: "updateStaged", version: "1.0.0" });
    expect(versions()).toEqual(["0.1.0", "1.0.0"]);
    const program = join(prefix, "versions", "1.0.0", "bin", "hsn-hub");
    expect(statSync(program).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(prefix, "versions", "1.0.0", "web", "index.html"), "utf8")).toBe(
      "<html></html>",
    );
  });

  test("a payload changed by one byte: badFile, and nothing unpacked", () => {
    const file = release();
    file[file.length - 20] = (file[file.length - 20] ?? 0) ^ 1;
    // Caught in pass 1, by the whole payload's hash, before a byte is written.
    expect(stage(file)).toMatchObject({
      kind: "failed",
      reason: "badFile",
      message: "the payload's hash is not the manifest's",
    });
    expect(versions()).toEqual(["0.0.9", "0.1.0"]);
  });

  test("a file whose own hash is wrong, the payload's right: badFile in pass 2, nothing left behind", () => {
    const data = new TextEncoder().encode("#!/bin/sh\n");
    const file = signed([{ path: "bin/hsn-hub", data, executable: true, sha256: "0".repeat(64) }]);
    expect(stage(file)).toMatchObject({
      kind: "failed",
      reason: "badFile",
      message: containing("bin/hsn-hub"),
    });
    expect(versions()).toEqual(["0.0.9", "0.1.0"]);
  });

  test("a manifest whose sizes do not add up to payloadBytes: badFile", () => {
    const data = new TextEncoder().encode("#!/bin/sh\n");
    expect(
      stage(signed([{ path: "bin/hsn-hub", data, executable: true }], { extraBytes: 1 })),
    ).toMatchObject({ reason: "badFile", message: containing("add up") });
  });

  test.each([
    ["a path twice", ["bin/hsn-hub", "web/a", "web/a"]],
    ["a path that climbs out", ["bin/hsn-hub", "../escape"]],
    ["an absolute path", ["bin/hsn-hub", "/etc/x"]],
    ["an empty part", ["bin/hsn-hub", "web//a"]],
    ["a dot", ["bin/hsn-hub", "web/./a"]],
    ["a backslash", ["bin/hsn-hub", "web\\a"]],
    ["a part too long", ["bin/hsn-hub", `web/${"a".repeat(65)}`]],
    ["a file where a folder must be", ["bin/hsn-hub", "web", "web/a"]],
  ])("%s: badFile, and nothing written outside", (_what, paths) => {
    const file = signed(
      paths.map((path) => ({
        path,
        data: new Uint8Array([1]),
        executable: path === "bin/hsn-hub",
      })),
    );
    expect(stage(file)).toMatchObject({ kind: "failed", reason: "badFile" });
    expect(existsSync(join(prefix, "escape"))).toBe(false);
    expect(versions()).toEqual(["0.0.9", "0.1.0"]);
  });

  test("a release without its program: badFile", () => {
    expect(
      stage(signed([{ path: "web/index.html", data: new Uint8Array([1]), executable: false }])),
    ).toMatchObject({ reason: "badFile", message: containing("bin/hsn-hub") });
  });

  test("a file that is not a release is badFile even on a hub the launcher did not start; a good one there is io", () => {
    writeFileSync(upload, new Uint8Array(1000));
    const junk = stageRelease({
      path: upload,
      prefix: undefined,
      runningVersion: "0.1.0",
      platform: "darwin-arm64",
      keys: [TEST_PUBLISHER_KEY],
    });
    expect(junk).toMatchObject({ kind: "failed", reason: "badFile" });
    writeFileSync(upload, release());
    const good = stageRelease({
      path: upload,
      prefix: undefined,
      runningVersion: "0.1.0",
      platform: "darwin-arm64",
      keys: [TEST_PUBLISHER_KEY],
    });
    expect(good).toMatchObject({ kind: "failed", reason: "io" });
  });

  test("format 1 (a gzip'd tar) is refused: badFile", () => {
    const file = release();
    file[4] = 1;
    expect(stage(file)).toMatchObject({
      reason: "badFile",
      message: containing("format 1"),
    });
  });

  test("pass 2 makes at most STAGING_FILES_PER_PIECE files a piece, however small they are", () => {
    const files = [
      { path: "bin/hsn-hub", data: new Uint8Array([1]), executable: true },
      ...Array.from({ length: 100 }, (_, i) => ({
        path: `web/f${String(i).padStart(3, "0")}`,
        data: new Uint8Array([i]),
        executable: false,
      })),
    ];
    writeFileSync(upload, signed(files));
    const job = new Staging({
      path: upload,
      prefix,
      runningVersion: "0.1.0",
      platform: "darwin-arm64",
      keys: [TEST_PUBLISHER_KEY],
    });
    const folder = join(prefix, "versions", ".staging-1.0.0");
    let before = 0;
    let outcome;
    while ((outcome = job.next()) === undefined) {
      if (!existsSync(folder)) continue;
      const files = readdirSync(folder, { recursive: true, encoding: "utf8" }).filter((n) =>
        statSync(join(folder, n)).isFile(),
      ).length;
      expect(files - before).toBeLessThanOrEqual(STAGING_FILES_PER_PIECE);
      before = files;
    }
    expect(outcome).toEqual({ kind: "updateStaged", version: "1.0.0" });
  });

  test("the program is executable, the rest not", () => {
    stage(release());
    expect(statSync(join(prefix, "versions", "1.0.0", "bin", "hsn-hub")).mode & 0o777).toBe(0o755);
    expect(statSync(join(prefix, "versions", "1.0.0", "web", "index.html")).mode & 0o777).toBe(
      0o644,
    );
  });

  test("a payload cut short: badFile", () => {
    expect(stage(release().subarray(0, -10))).toMatchObject({
      kind: "failed",
      reason: "badFile",
      message: containing("the manifest says"),
    });
  });

  test("a manifest changed after signing: badSignature", () => {
    const file = release();
    const text = Buffer.from(file)
      .toString("latin1")
      .replace('"version":"1.0.0"', '"version":"9.0.0"');
    expect(stage(Uint8Array.from(Buffer.from(text, "latin1")))).toMatchObject({
      kind: "failed",
      reason: "badSignature",
    });
    expect(versions()).toEqual(["0.0.9", "0.1.0"]);
  });

  test("signed by a key this hub does not trust, or with no key compiled in: badSignature", () => {
    expect(stage(release("1.0.0", "darwin-arm64", OTHER_SEED))).toMatchObject({
      reason: "badSignature",
    });
    expect(stage(release(), PUBLISHER_KEYS)).toMatchObject({ reason: "badSignature" });
  });

  test("for another system: wrongSystem", () => {
    expect(stage(release("1.0.0", "linux-x64"))).toMatchObject({
      kind: "failed",
      reason: "wrongSystem",
    });
  });

  test("not above the running version, as numbers: notNewer", () => {
    expect(stage(release("0.1.0"))).toMatchObject({ reason: "notNewer" });
    expect(stage(release("0.0.10"))).toMatchObject({ reason: "notNewer" });
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0-rc1", "0.1.0")).toBe(false);
  });

  test("not a release, a reserved byte, or a version that is not MAJOR.MINOR.PATCH: badFile", () => {
    expect(stage(new TextEncoder().encode("hello, world, not a release at all"))).toMatchObject({
      reason: "badFile",
    });
    const file = release();
    file[5] = 1;
    expect(stage(file)).toMatchObject({ reason: "badFile" });
    expect(releaseOf(source, "01.0.0", "darwin-arm64", SEED, 0).isErr()).toBe(true);
  });

  test("the file's layout: HSNR, format 2, three zero bytes, the manifest's length, the files uncompressed", () => {
    const file = release();
    expect(new TextDecoder().decode(file.subarray(0, 4))).toBe(RELEASE.magic);
    expect([...file.subarray(4, 8)]).toEqual([2, 0, 0, 0]);
    const length = new DataView(file.buffer, file.byteOffset).getUint32(8, true);
    const manifest = JSON.parse(new TextDecoder().decode(file.subarray(12, 12 + length))) as {
      files: { path: string; bytes: number }[];
      payloadBytes: number;
    };
    expect(manifest).toMatchObject({ version: "1.0.0", platform: "darwin-arm64" });
    expect(manifest.files.map((f) => f.path)).toEqual([
      "bin/hsn-hub",
      "drizzle/0000.sql",
      "web/index.html",
    ]);
    const payload = file.subarray(12 + length + 64);
    expect(payload.length).toBe(manifest.payloadBytes);
    expect(new TextDecoder().decode(payload)).toContain("CREATE TABLE x (a);");
  });

  test("the platform names", () => {
    expect(platformOf("win32", "x64")).toBe("windows-x64");
    expect(platformOf("linux", "arm64")).toBe("linux-arm64");
    expect(platformOf("darwin", "x64")).toBeUndefined();
  });
});

describe("the publisher's keys", () => {
  test("the test key is the public half of the tests' seed, and a release build refuses it", () => {
    expect(publicOfSeed(SEED)._unsafeUnwrap()).toEqual(TEST_PUBLISHER_KEY);
    expect(releaseKeysProblem([TEST_PUBLISHER_KEY])).toContain("test key");
    const a = publicOfSeed(OTHER_SEED)._unsafeUnwrap();
    expect(releaseKeysProblem([a])).toBeUndefined();
    expect(releaseKeysProblem([a, a, a])).toContain("at most 2");
    expect(releaseKeysProblem(PUBLISHER_KEYS)).toBeUndefined();
  });
});

describe("the switch's room", () => {
  test("too little free space for the database's copy: full, and no switch note", () => {
    const done = runToEnd(
      jobId(1),
      { kind: "switchUpdate", version: "0.0.9" },
      {
        db: new Database(":memory:"),
        dataDir: prefix,
        migrationsFolder: "/nowhere",
        rules: DEFAULT_RULES,
        uploads: { pathOf: () => undefined },
        exports: { send: () => ok(undefined) },
        prefix,
        switchBlockedBy: () => undefined,
        nowMs: () => 0,
        salt: () => ok(new Uint8Array(8)),
        room: () => ({ freeBytes: 60 * 1024 * 1024, databaseBytes: 20 * 1024 * 1024 }),
      },
    );
    expect(done).toMatchObject({ kind: "ready", outcome: { kind: "failed", reason: "full" } });
    expect(existsSync(installPaths(prefix).switchFile)).toBe(false);
  });

  test("staged through the job, with the test key", () => {
    writeFileSync(upload, release());
    const done = runToEnd(
      jobId(1),
      { kind: "stageUpdate", upload: { conn: connId(1), job: 1 } },
      {
        db: new Database(":memory:"),
        dataDir: prefix,
        migrationsFolder: "/nowhere",
        rules: DEFAULT_RULES,
        uploads: { pathOf: () => upload },
        exports: { send: () => ok(undefined) },
        prefix,
        switchBlockedBy: () => undefined,
        nowMs: () => 0,
        salt: () => ok(new Uint8Array(8)),
        version: "0.1.0",
        publisherKeys: [TEST_PUBLISHER_KEY],
      },
    );
    expect(done).toEqual({ kind: "ready", outcome: { kind: "updateStaged", version: "1.0.0" } });
  });
});

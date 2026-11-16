/**
 * The publisher keys are a parameter of the hub's start, not something it reads (m2-design.md
 * section 9, "Hub updates"): the product's entries (`src/shell/main.ts`, `hub/packaging`) pass the
 * compiled-in `PUBLISHER_KEYS`; no command-line option, environment variable or file adds one.
 * A release signed with the tests' key is refused by the product's `main.ts` however it is
 * started, and staged by a test's own entry (`hub-with-test-key.ts`), the same hub with that key.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMainArgs } from "../../../src/shell/main.ts";
import { makeRelease, platformOf } from "../../../src/shell/update/release.ts";
import { endProcesses, spawnTracked } from "../../world/processes.ts";

const HUB = join(import.meta.dir, "..", "..", "..");
const MAIN = join(HUB, "src", "shell", "main.ts");
const TEST_ENTRY = join(import.meta.dir, "hub-with-test-key.ts");
const HSN = join(HUB, "cli", "hsn.ts");
const root = mkdtempSync("/tmp/hsn-keys-");
afterAll(async () => {
  await endProcesses();
  rmSync(root, { recursive: true, force: true });
});

/** The tests' signing seed: its public half is `TEST_PUBLISHER_KEY`. */
const TEST_SEED = new Uint8Array(32).fill(7);
const TEST_KEY_HEX = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";

/** A release of one file for this computer, newer than the running hub, signed with the test key. */
function testRelease(): string {
  const data = new TextEncoder().encode("#!/bin/sh\necho test release\n");
  const platform = platformOf(process.platform, process.arch);
  expect(platform).toBeDefined();
  const file = makeRelease(
    {
      version: "99.0.0",
      platform: platform ?? "darwin-arm64",
      madeMs: 0,
      payloadBytes: data.length,
      payloadSha256: createHash("sha256").update(data).digest("hex"),
      files: [
        {
          path: "bin/hsn-hub",
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
          executable: true,
        },
      ],
    },
    data,
    TEST_SEED,
  )._unsafeUnwrap();
  const path = join(root, "test-release.hsnr");
  writeFileSync(path, file);
  return path;
}

/** Every way an environment might try to admit the test key. */
const HOSTILE_ENV = {
  HSN_PUBLISHER_KEYS: TEST_KEY_HEX,
  HSN_PUBLISHER_KEY: TEST_KEY_HEX,
  HSN_TEST_PUBLISHER_KEY: "1",
  HSN_TRUST_TEST_KEY: "1",
  NODE_ENV: "test",
  BUN_ENV: "test",
};

/** A hub started by `entry`, then `hsn update install` of the test release; what `hsn` says. */
async function install(
  entry: string,
  env: Readonly<Record<string, string>>,
  args: readonly string[] = [],
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const data = mkdtempSync(join(root, "d"));
  const prefix = mkdtempSync(join(root, "p"));
  const hub = spawnTracked(
    ["bun", entry, "--data", data, "--port", "0", "--no-usb-watch", "--app-ports", "0,0", ...args],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, ...env, HSN_PROGRAM: prefix } },
  );
  const sock = join(data, "control.sock");
  for (let i = 0; i < 200 && !existsSync(sock); i++) await Bun.sleep(50);
  await Bun.sleep(300);
  const run = spawnTracked(["bun", HSN, "--data", data, "update", "install", testRelease()], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  hub.kill("SIGTERM");
  await hub.exited;
  return { code, out, err };
}

describe("the publisher keys are the start's, never the hub's to read (section 9)", () => {
  test("no command-line option names a key: any such option is refused", () => {
    for (const option of ["--publisher-key", "--publisher-keys", "--trust-test-key", "--test-key"])
      expect(parseMainArgs([option, TEST_KEY_HEX], {})).toBe(`unknown option ${option}`);
  });

  test("the product's entries pass the compiled-in keys and never name the test key", () => {
    for (const entry of [MAIN, join(HUB, "packaging", "shared", "program.ts")]) {
      const source = readFileSync(entry, "utf8");
      expect([entry, source.includes("TEST_PUBLISHER_KEY")]).toEqual([entry, false]);
      expect([entry, /runHub\([^)]*\{ publisherKeys: PUBLISHER_KEYS \}\)/u.test(source)]).toEqual([
        entry,
        true,
      ]);
    }
  });

  test("main.ts refuses a release signed with the test key, whatever its environment says", async () => {
    const refused = await install(MAIN, HOSTILE_ENV);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("badSignature");
  }, 60_000);

  test("a test's own entry, the same hub with the test key, stages it", async () => {
    const staged = await install(TEST_ENTRY, {});
    expect(staged.err).toBe("");
    expect(staged.out).toContain("staged: version 99.0.0");
    expect(staged.code).toBe(0);
  }, 60_000);
});

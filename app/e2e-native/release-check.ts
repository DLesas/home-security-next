#!/usr/bin/env bun
/**
 * The bundle half of "the release bundle holds no bridge" (m3-design.md section 9;
 * `tools/ble-bench/src/bridge/client.ts` says why it cannot ship). It builds the release bundles
 * as a release build makes them (`expo export --platform ios --platform android`: no `--dev`, so
 * `__DEV__` is folded to false, minified, Hermes bytecode) into a folder of the caller's, and
 * searches every file there for the bench's markers: the bridge wire's version (a string literal
 * of the client's own wire) and the test stand-in's label. Any found fails it. It also runs the
 * source rule (`release-guard.ts`) over `app/src`.
 *
 * `bun app/e2e-native/release-check.ts <output folder>`, from the repository's root; about a
 * minute. It prints what it found and exits 1 on a problem. With `--expect-found <folder>` it
 * searches a folder already made (a development export, say) and fails if the marker is NOT
 * there: the check of the check.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STAND_IN_LABEL } from "../../tools/ble-bench/src/boards/pairing-security.ts";
import { BRIDGE_WIRE } from "../../tools/ble-bench/src/bridge/wire.ts";
import { guardProblems } from "../../tools/ble-bench/src/release-guard.ts";

const REPO = join(import.meta.dirname, "..", "..");
const APP = join(REPO, "app");
const MARKERS = [BRIDGE_WIRE, STAND_IN_LABEL.slice(0, 18)];

/** Walks regular files only so asset directories are never passed to readFileSync. */
function files(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

/** Files under `folder` holding a marker, as bytes (Hermes keeps string literals as they are). */
function found(folder: string): string[] {
  const hits: string[] = [];
  for (const file of files(folder)) {
    const bytes = readFileSync(file, { flag: "r" });
    for (const marker of MARKERS)
      if (bytes.includes(Buffer.from(marker))) hits.push(`${file}: ${marker}`);
  }
  return hits;
}

const expectFound = process.argv.indexOf("--expect-found");
if (expectFound >= 0) {
  const folder = process.argv[expectFound + 1] ?? "";
  const hits = found(folder);
  for (const hit of hits) console.log(`found ${hit}`);
  process.exit(hits.length > 0 ? 0 : 1);
}

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: release-check.ts <output folder> | --expect-found <folder>");
  process.exit(2);
}

const problems: string[] = [];
for (const file of files(join(APP, "src")).filter((f) => /\.(?:ts|tsx)$/u.test(f))) {
  for (const p of guardProblems(readFileSync(file, "utf8")))
    problems.push(`${file}:${String(p.line)} ${p.why}`);
}

const exported = spawnSync(
  join(APP, "node_modules", ".bin", "expo"),
  ["export", "--platform", "ios", "--platform", "android", "--output-dir", out],
  {
    cwd: APP,
    stdio: "inherit",
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1", EXPO_OFFLINE: "1" },
  },
);
if (exported.status !== 0) problems.push("expo export failed");
const bundles = exported.status === 0 ? files(out).filter((f) => /\.(?:hbc|js)$/u.test(f)) : [];
if (exported.status === 0 && bundles.length < 2)
  problems.push("no iOS and Android bundles were made");
for (const hit of exported.status === 0 ? found(out) : [])
  problems.push(`in a release bundle: ${hit}`);

for (const bundle of bundles) console.log(`searched ${bundle}`);
for (const problem of problems) console.error(problem);
console.log(
  problems.length === 0
    ? "release check: no bench in the release bundles"
    : "release check: FAILED",
);
process.exit(problems.length === 0 ? 0 : 1);

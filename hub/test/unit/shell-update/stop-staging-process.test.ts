/**
 * A stop while an update is staged, on the real hub process (`main.ts`'s `runHub`, with the tests'
 * publisher key): the stop (SIGTERM; WinSW's console event on Windows) ends the process within its
 * bound, whatever the staging worker is doing, and the next staging is not hurt by what a stop
 * could not remove.
 *
 * On every system: a stop while the worker writes files (it answers before its next piece and
 * removes its folder), and a stop as a staging starts. The worst case is a worker stuck in a file
 * call, which no flag can reach: the program tree's launcher file made a FIFO with no writer,
 * which staging opens at the end of its second pass (Linux and macOS only), so the worker blocks
 * in `open()` with every file copied. The stop waits for it at most `STOP_WAIT_MS`, then the hub's
 * exit ends the thread. On Windows nothing blocks a file call so without a hook in the product
 * (the hub's own worker cannot be swapped for a stand-in, nor reached by a test's plugin); the
 * job's side of it is `stage-job.test.ts`'s held stand-in, on every system.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPaths } from "../../../launcher/src/layout.ts";
import { releaseOfFiles } from "../../../packaging/shared/make-release.ts";
import { HUB_VERSION } from "../../../src/shell/hub-facts.ts";
import { programName } from "../../../src/shell/update/program-name.ts";
import { platformOf } from "../../../src/shell/update/release.ts";
import { STOP_WAIT_MS } from "../../../src/shell/worker/job.ts";
import {
  endProcesses,
  spawnTestHub,
  spawnTracked,
  stopTestHub,
  testCli,
} from "../../world/processes.ts";
import { isWindows, shapeFolder } from "../shell-control/windows-folders.ts";

const HUB = join(import.meta.dir, "..", "..", "..");
const TEST_ENTRY = join(HUB, "test", "unit", "shell-main", "hub-with-test-key.ts");
const PLATFORM = platformOf(process.platform, process.arch);
const root = mkdtempSync(join(tmpdir(), "hsn-stop-staging-"));
const VERSION = "99.0.0";
/** The stop's own wait, and the rest of a clean stop on a loaded machine. */
const EXIT_BOUND_MS = STOP_WAIT_MS + 8000;

setDefaultTimeout(90_000);

afterAll(async () => {
  await endProcesses();
  rmSync(root, { recursive: true, force: true });
});

async function until(done: () => boolean, ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (!done()) {
    expect(performance.now()).toBeLessThan(end);
    await Bun.sleep(5);
  }
}

const LAUNCHER_STATE = JSON.stringify({
  current: HUB_VERSION,
  previous: null,
  trial: null,
  rolledBack: null,
});

/** The program tree the launcher would have made, running this version. */
function programTree(fifo: boolean): string {
  const prefix = mkdtempSync(join(root, "p"));
  mkdirSync(join(prefix, "staged", HUB_VERSION, "bin"), { recursive: true });
  mkdirSync(join(prefix, "state"), { recursive: true });
  const launcher = installPaths(prefix).launcherFile;
  if (fifo) expect(Bun.spawnSync(["mkfifo", launcher]).exitCode).toBe(0);
  else writeFileSync(launcher, LAUNCHER_STATE);
  return prefix;
}

/** A release for this computer, newer than the hub, signed with the tests' key; `files` web files. */
function release(files = 40): string {
  const text = (s: string) => new TextEncoder().encode(s);
  const entries = [
    {
      path: `bin/${programName(PLATFORM ?? "linux-x64")}`,
      data: text("a program\n".repeat(100_000)),
    },
    { path: "drizzle/0000.sql", data: text("CREATE TABLE x (a);") },
    ...Array.from({ length: files }, (_, i) => ({
      path: `web/f${i}.js`,
      data: text(`export const x${i} = 1;\n`),
    })),
  ].map((entry) => ({ ...entry, executable: entry.path.startsWith("bin/") }));
  const bytes = releaseOfFiles(
    entries.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    VERSION,
    PLATFORM ?? "linux-x64",
    new Uint8Array(32).fill(7),
    0,
  )._unsafeUnwrap();
  const path = join(root, "release.hsnr");
  writeFileSync(path, bytes);
  return path;
}

/** The hub process, with `prefix` as its program tree; its control socket open. */
async function hubWith(prefix: string) {
  const data = mkdtempSync(join(root, "d"));
  if (isWindows) shapeFolder(data);
  const hub = spawnTestHub(
    [TEST_ENTRY, "--data", data, "--port", "0", "--no-usb-watch", "--app-ports", "0,0"],
    "ignore",
    { ...process.env, HSN_PROGRAM: prefix },
  );
  await until(() => existsSync(join(data, "control.sock")), 30_000);
  await Bun.sleep(300);
  return { hub, data };
}

function install(data: string, file: string) {
  return spawnTracked(["bun", testCli, "--data", data, "update", "install", file], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** How long the hub took to exit after the stop, and its code. */
async function stopped(hub: ReturnType<typeof spawnTestHub>) {
  const start = performance.now();
  stopTestHub(hub);
  const code = await Promise.race([
    hub.exited,
    Bun.sleep(EXIT_BOUND_MS * 2).then(() => "still running"),
  ]);
  const ms = performance.now() - start;
  console.log(`the hub ended ${ms.toFixed(0)} ms after the stop, code ${String(code)}`);
  return { code, ms };
}

describe.skipIf(PLATFORM === undefined)("a stop while an update is staged (the real hub)", () => {
  test.skipIf(isWindows)(
    "the worker stuck in a file call: the process still ends cleanly within the bound; the next staging stages",
    async () => {
      const prefix = programTree(true);
      const file = release();
      const { hub, data } = await hubWith(prefix);
      const installing = install(data, file);
      const folder = join(installPaths(prefix).staged, `.staging-${VERSION}`);
      // Every file copied: the worker is in open() on the launcher file, and stays there.
      await until(() => existsSync(join(folder, "web", "f9.js")), 30_000);
      await Bun.sleep(100);
      const { code, ms } = await stopped(hub);
      expect(code).toBe(0);
      expect(ms).toBeLessThan(EXIT_BOUND_MS);
      // The stop waited for the worker for its bound, which it could not answer within.
      expect(ms).toBeGreaterThanOrEqual(STOP_WAIT_MS - 50);
      expect(await installing.exited).not.toBe(0);
      // What the stuck worker could not remove is still there, for the next staging's first pass.
      expect(existsSync(folder)).toBe(true);

      rmSync(installPaths(prefix).launcherFile);
      writeFileSync(installPaths(prefix).launcherFile, LAUNCHER_STATE);
      const next = await hubWith(prefix);
      const again = install(next.data, file);
      const out = await new Response(again.stdout).text();
      expect(await again.exited).toBe(0);
      expect(out).toContain(`staged: version ${VERSION}`);
      expect(readdirSync(installPaths(prefix).staged).toSorted()).toEqual(
        [HUB_VERSION, VERSION].toSorted(),
      );
      expect((await stopped(next.hub)).code).toBe(0);
    },
  );

  test("a stop while the worker writes files: it answers, removes its folder; the process ends cleanly within the bound", async () => {
    const prefix = programTree(false);
    const { hub, data } = await hubWith(prefix);
    // 4000 files (a release holds at most 4096): the stop comes mid-way on any computer.
    const installing = install(data, release(4000));
    const web = join(installPaths(prefix).staged, `.staging-${VERSION}`, "web");
    await until(() => existsSync(web) && readdirSync(web).length > 0, 30_000);
    const { code, ms } = await stopped(hub);
    expect(code).toBe(0);
    expect(ms).toBeLessThan(EXIT_BOUND_MS);
    expect(await installing.exited).not.toBe(0);
    // Neither placed nor left half made: the worker saw the stop and removed its folder.
    expect(readdirSync(installPaths(prefix).staged)).toEqual([HUB_VERSION]);
  });

  test("a stop as a staging starts: the process ends cleanly within the bound, no staging folder left", async () => {
    const prefix = programTree(false);
    const { hub, data } = await hubWith(prefix);
    const installing = install(data, release());
    // Once the upload has reached the hub (its uploads folder holds it), stop.
    await until(
      () => readdirSync(data).includes("uploads") && readdirSync(join(data, "uploads")).length > 0,
      30_000,
    );
    const { code, ms } = await stopped(hub);
    expect(code).toBe(0);
    expect(ms).toBeLessThan(EXIT_BOUND_MS);
    await installing.exited;
    const left = readdirSync(installPaths(prefix).staged);
    expect(left.filter((name) => name.startsWith(".staging-"))).toEqual([]);
  });
});

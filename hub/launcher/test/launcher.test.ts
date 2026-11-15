/**
 * The launcher (m2-design.md section 9) on real child processes: the hub restarted on any exit but
 * 0 with the backoff (here scaled down: 50, 200, 400, 800 ms while failing within a second), a
 * clean stop passed on, a switch to a new version, the new version kept once healthy and the third
 * version removed, and the rollbacks: on an exit before health, on a hang, and with the
 * pre-migration copy put back.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endProcesses, spawnTracked } from "../../test/world/processes.ts";
import { Backoff } from "../src/backoff.ts";
import { Launcher, type LauncherOptions, STATUS_FILE } from "../src/launcher.ts";
import { installPaths, isVersionName, parseLauncherState, parseSwitchNote } from "../src/layout.ts";
import { parseLauncherArgs } from "../src/main.ts";
import { selectVersion } from "../src/select.ts";

const FAKE_HUB = join(import.meta.dir, "fake-hub.ts");
const RULES = {
  restartDelaysMs: [50, 200, 400, 800],
  failingWithinMs: 1000,
  restartMeExitCode: 70,
};
const folders: string[] = [];

afterAll(async () => {
  await endProcesses();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

interface Install {
  readonly prefix: string;
  readonly data: string;
}

let install: Install;

/** An install folder with these versions, each a fake hub, and a data folder. */
function installWith(versions: readonly string[]): Install {
  const root = mkdtempSync(join(tmpdir(), "hsn-launcher-"));
  folders.push(root);
  const prefix = join(root, "prefix");
  const data = join(root, "data");
  mkdirSync(join(prefix, "state"), { recursive: true });
  mkdirSync(data, { recursive: true });
  for (const version of versions) {
    const bin = join(prefix, "versions", version, "bin");
    mkdirSync(bin, { recursive: true });
    const program = join(bin, "hsn-hub");
    writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HUB}" ${version} "$@"\n`);
    chmodSync(program, 0o755);
  }
  return { prefix, data };
}

function plan(version: string, steps: readonly object[]): void {
  writeFileSync(join(install.data, `plan-${version}.json`), JSON.stringify(steps));
}

function startsLog(): string[] {
  const path = join(install.data, "starts.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

function state(): ReturnType<typeof parseLauncherState> {
  return parseLauncherState(readFileSync(installPaths(install.prefix).launcherFile, "utf8"));
}

function current(version: string, previous: string | null = null): void {
  writeFileSync(
    installPaths(install.prefix).launcherFile,
    JSON.stringify({ current: version, previous, trial: null, rolledBack: null }),
  );
}

function launcher(options: Partial<LauncherOptions> = {}): Launcher {
  return new Launcher({
    prefix: install.prefix,
    dataDir: install.data,
    rules: RULES,
    healthyWithinMs: 1500,
    stopGraceMs: 800,
    pollMs: 20,
    spawn: (command, env) =>
      spawnTracked([...command], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    log: () => undefined,
    systemLog: () => undefined,
    ...options,
  });
}

/** Waits until `ready`, at most `ms`. */
async function until(ready: () => boolean, ms = 8000): Promise<boolean> {
  const end = performance.now() + ms;
  while (!ready() && performance.now() < end) await Bun.sleep(10);
  return ready();
}

describe("the backoff", () => {
  test("1 s, 10 s, 30 s, then every 5 minutes while failing within a minute, never stopping", () => {
    const backoff = new Backoff();
    const crash = { code: 71, ranMs: 1000 };
    expect([1, 2, 3, 4, 5, 6].map(() => backoff.after(crash))).toEqual([
      { kind: "restart", afterMs: 1000, failure: true, failures: 1 },
      { kind: "restart", afterMs: 10_000, failure: true, failures: 2 },
      { kind: "restart", afterMs: 30_000, failure: true, failures: 3 },
      { kind: "restart", afterMs: 300_000, failure: true, failures: 4 },
      { kind: "restart", afterMs: 300_000, failure: true, failures: 5 },
      { kind: "restart", afterMs: 300_000, failure: true, failures: 6 },
    ]);
    // A run of a minute ends the spell.
    expect(backoff.after({ code: 71, ranMs: 60_000 })).toEqual({
      kind: "restart",
      afterMs: 1000,
      failure: true,
      failures: 1,
    });
  });

  test("exit 70 is a request: restarted at once, not a failure; a third quick one in a row is", () => {
    const backoff = new Backoff();
    backoff.after({ code: 71, ranMs: 10 });
    expect(backoff.after({ code: 70, ranMs: 10 })).toEqual({
      kind: "restart",
      afterMs: 0,
      failure: false,
      failures: 1,
    });
    expect(backoff.after({ code: 70, ranMs: 10 })).toMatchObject({ afterMs: 0, failure: false });
    expect(backoff.after({ code: 70, ranMs: 10 })).toMatchObject({
      afterMs: 10_000,
      failure: true,
    });
    // Requests a minute apart never add up.
    const calm = new Backoff();
    for (let i = 0; i < 5; i++)
      expect(calm.after({ code: 70, ranMs: 120_000 })).toMatchObject({
        afterMs: 0,
        failure: false,
      });
  });

  test("exit 0 is a clean stop; a signal is a failure", () => {
    expect(new Backoff().after({ code: 0, ranMs: 10 })).toEqual({ kind: "stop" });
    expect(new Backoff().after({ code: null, ranMs: 10 })).toMatchObject({ failure: true });
  });
});

describe("the notes", () => {
  test("version names cannot climb out of versions/", () => {
    expect(isVersionName("1.2.3")).toBe(true);
    expect(isVersionName("1.2.3-rc.1+build")).toBe(true);
    expect(isVersionName("../etc")).toBe(false);
    expect(isVersionName("a/b")).toBe(false);
    expect(parseSwitchNote('{"to":"../../bin"}')).toBeUndefined();
    expect(parseLauncherState("not json")).toBeUndefined();
  });

  test("the arguments", () => {
    expect(parseLauncherArgs(["--prefix", "/p", "--data", "/d", "--", "--port", "0"])).toEqual({
      prefix: "/p",
      dataDir: "/d",
      hubArgs: ["--port", "0"],
    });
    expect(parseLauncherArgs(["--data", "/d"])).toBe("--prefix needs the install folder");
  });
});

describe("restarts", () => {
  beforeEach(() => {
    install = installWith(["1.0.0"]);
  });

  test("on any exit but 0, after 50, 200, 400 ms while it keeps failing; a stop ends it cleanly", async () => {
    plan("1.0.0", [{ exit: 3 }, { exit: 3 }, { exit: 78 }, { hang: true }]);
    // Each start's time, taken when the launcher starts it.
    const times: number[] = [];
    const l = launcher({
      spawn: (command, env) => {
        times.push(performance.now());
        return spawnTracked([...command], {
          env,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      },
    });
    const ran = l.run();
    expect(await until(() => startsLog().length === 4)).toBe(true);
    expect(times).toHaveLength(4);
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? 0));
    expect(gaps[0]).toBeGreaterThanOrEqual(45);
    expect(gaps[1]).toBeGreaterThanOrEqual(195);
    expect(gaps[2]).toBeGreaterThanOrEqual(395);
    l.stop();
    expect(await ran).toBe(0);
    expect(startsLog().at(-1)).toBe("1.0.0 clean");
    expect(l.starts).toBe(4);
  });

  test("exit 0: no restart, and the launcher exits 0", async () => {
    plan("1.0.0", [{ exit: 0 }]);
    const l = launcher();
    expect(await l.run()).toBe(0);
    expect(l.starts).toBe(1);
  });

  test("exit 70 is restarted at once; the third quick one in a row waits as a failure", async () => {
    plan("1.0.0", [{ exit: 70 }, { exit: 70 }, { exit: 70 }, { exit: 0 }]);
    const logged: string[] = [];
    const l = launcher({ systemLog: (line) => logged.push(line) });
    expect(await l.run()).toBe(0);
    expect(l.starts).toBe(4);
    expect(logged).toHaveLength(1);
  });

  test("each failure to the system log; after the third, launcher-status.json; a run of a minute clears it", async () => {
    writeFileSync(join(install.data, "fatal.log"), "one\ntwo\nuncaught: boom\n");
    plan("1.0.0", [
      { exit: 71 },
      { exit: 71 },
      { exit: 71 },
      { exit: 71, afterMs: 1300 },
      { hang: true },
    ]);
    const logged: string[] = [];
    const l = launcher({ systemLog: (line) => logged.push(line) });
    const ran = l.run();
    const status = join(install.data, STATUS_FILE);
    expect(await until(() => existsSync(status))).toBe(true);
    const written = JSON.parse(readFileSync(status, "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({
      failures: 3,
      lastExitCode: 71,
      fatalLog: ["one", "two", "uncaught: boom"],
    });
    expect(logged.length).toBeGreaterThanOrEqual(3);
    expect(await until(() => startsLog().length === 5)).toBe(true);
    expect(existsSync(status)).toBe(false);
    l.stop();
    expect(await ran).toBe(0);
  });

  test("a hub that ignores SIGTERM is killed after the grace, and the launcher still exits 0", async () => {
    plan("1.0.0", [{ hang: true, ignoreTerm: true }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => startsLog().length === 1)).toBe(true);
    await Bun.sleep(200);
    l.stop();
    expect(await ran).toBe(0);
    expect(startsLog()).toEqual(["1.0.0 1"]);
  });

  test("a program that cannot start is a failure, retried with the backoff", async () => {
    current("2.0.0");
    const l = launcher();
    const ran = l.run();
    await Bun.sleep(400);
    l.stop();
    expect(await ran).toBe(0);
    expect(l.starts).toBe(0);
  });

  test("with no state, the one installed version is current, and current points at it", async () => {
    plan("1.0.0", [{ exit: 0 }]);
    expect(await launcher().run()).toBe(0);
    expect(state()).toEqual({ current: "1.0.0", previous: null, trial: null, rolledBack: null });
    expect(readlinkSync(installPaths(install.prefix).current)).toBe(
      join(install.prefix, "versions", "1.0.0"),
    );
  });
});

describe("updates", () => {
  beforeEach(() => {
    install = installWith(["0.9.0", "1.0.0", "1.1.0"]);
    current("1.0.0", "0.9.0");
    writeFileSync(join(install.data, "hub.db"), "the database of 1.0.0");
  });

  test("a switch: the new version on trial; healthy, it stays, the old one is kept and the third removed", async () => {
    plan("1.0.0", [{ switchTo: "1.1.0" }]);
    plan("1.1.0", [{ healthy: true }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => state()?.trial === null && state()?.current === "1.1.0")).toBe(true);
    expect(state()).toEqual({ current: "1.1.0", previous: "1.0.0", trial: null, rolledBack: null });
    expect(existsSync(join(install.prefix, "versions", "0.9.0"))).toBe(false);
    expect(existsSync(join(install.prefix, "versions", "1.0.0"))).toBe(true);
    expect(existsSync(installPaths(install.prefix).switchFile)).toBe(false);
    expect(readlinkSync(installPaths(install.prefix).current)).toBe(
      join(install.prefix, "versions", "1.1.0"),
    );
    l.stop();
    expect(await ran).toBe(0);
    expect(startsLog()).toEqual(["1.0.0 1", "1.1.0 1", "1.1.0 clean"]);
  });

  test("the new version exits before it is healthy: the old one again, and the rollback noted", async () => {
    plan("1.0.0", [{ switchTo: "1.1.0" }, { hang: true }]);
    plan("1.1.0", [{ exit: 1 }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => startsLog().length === 3)).toBe(true);
    expect(startsLog()).toEqual(["1.0.0 1", "1.1.0 1", "1.0.0 2"]);
    expect(state()).toMatchObject({ current: "1.0.0", trial: null, rolledBack: { from: "1.1.0" } });
    l.stop();
    expect(await ran).toBe(0);
  });

  test("the new version asks for a restart before it is healthy: no restart, the rollback", async () => {
    plan("1.0.0", [{ switchTo: "1.1.0" }, { hang: true }]);
    plan("1.1.0", [{ exit: 70 }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => startsLog().length === 3)).toBe(true);
    expect(startsLog()).toEqual(["1.0.0 1", "1.1.0 1", "1.0.0 2"]);
    expect(state()).toMatchObject({ current: "1.0.0", rolledBack: { from: "1.1.0" } });
    l.stop();
    expect(await ran).toBe(0);
  });

  test("the new version hangs: stopped after the 60 s (here 1.5 s), and the old one started", async () => {
    plan("1.0.0", [{ switchTo: "1.1.0" }, { hang: true }]);
    plan("1.1.0", [{ hang: true, ignoreTerm: true }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => startsLog().length === 3, 6000)).toBe(true);
    expect(startsLog()).toEqual(["1.0.0 1", "1.1.0 1", "1.0.0 2"]);
    expect(state()?.rolledBack?.reason).toContain("update_healthy");
    l.stop();
    expect(await ran).toBe(0);
  });

  test("a failed migration: its copy put back, the migrated database's log removed", async () => {
    plan("1.0.0", [{ switchTo: "1.1.0" }, { hang: true }]);
    plan("1.1.0", [{ migrate: 3, exit: 78 }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => startsLog().length === 3)).toBe(true);
    expect(readFileSync(join(install.data, "hub.db"), "utf8")).toBe("the database of 1.0.0");
    expect(existsSync(join(install.data, "hub.db-wal"))).toBe(false);
    l.stop();
    expect(await ran).toBe(0);
  });

  test("a copy that was there before the switch is not put back", async () => {
    writeFileSync(join(install.data, "hub.db.before-1"), "an older copy");
    plan("1.0.0", [{ switchTo: "1.1.0" }, { hang: true }]);
    plan("1.1.0", [{ exit: 1 }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => startsLog().length === 3)).toBe(true);
    expect(readFileSync(join(install.data, "hub.db"), "utf8")).toBe("the database of 1.0.0");
    l.stop();
    expect(await ran).toBe(0);
  });

  test("a switch to a version that is not installed is refused, and the hub restarted as it was", async () => {
    plan("1.0.0", [{ switchTo: "2.0.0" }, { exit: 0 }]);
    const l = launcher();
    expect(await l.run()).toBe(0);
    expect(startsLog()).toEqual(["1.0.0 1", "1.0.0 2"]);
    expect(state()?.current).toBe("1.0.0");
  });

  test("a stop during the trial keeps it: the next launcher goes on with it", async () => {
    plan("1.0.0", [{ switchTo: "1.1.0" }]);
    plan("1.1.0", [{ hang: true }, { healthy: true }]);
    const first = launcher();
    const ran = first.run();
    expect(await until(() => startsLog().length === 2)).toBe(true);
    first.stop();
    expect(await ran).toBe(0);
    expect(state()?.trial?.version).toBe("1.1.0");
    const second = launcher();
    const again = second.run();
    expect(await until(() => state()?.trial === null)).toBe(true);
    expect(state()?.current).toBe("1.1.0");
    second.stop();
    expect(await again).toBe(0);
  });
});

describe("an installer's choice of version", () => {
  test("the version put in becomes current, the one before is kept, a third removed", () => {
    install = installWith(["0.9.0", "1.0.0", "1.1.0"]);
    current("1.0.0", "0.9.0");
    expect(selectVersion(install.prefix, "1.1.0").isOk()).toBe(true);
    expect(state()).toEqual({ current: "1.1.0", previous: "1.0.0", trial: null, rolledBack: null });
    expect(existsSync(join(install.prefix, "versions", "0.9.0"))).toBe(false);
    expect(readlinkSync(installPaths(install.prefix).current)).toBe(
      join(install.prefix, "versions", "1.1.0"),
    );
    // Again with the same version (a reinstall): nothing lost.
    expect(selectVersion(install.prefix, "1.1.0").isOk()).toBe(true);
    expect(state()?.previous).toBe("1.0.0");
  });

  test("a version that is not installed, or not a version's name, is refused", () => {
    install = installWith(["1.0.0"]);
    expect(selectVersion(install.prefix, "2.0.0").isErr()).toBe(true);
    expect(selectVersion(install.prefix, "../x").isErr()).toBe(true);
  });
});

describe("as a process", () => {
  test("hsn-launcher runs the hub and exits 0 on SIGTERM, after the hub's clean stop", async () => {
    install = installWith(["1.0.0"]);
    plan("1.0.0", [{ hang: true }]);
    const process = spawnTracked(
      [
        Bun.argv[0] ?? "bun",
        join(import.meta.dir, "..", "src", "main.ts"),
        "--prefix",
        install.prefix,
        "--data",
        install.data,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await until(() => startsLog().length === 1)).toBe(true);
    process.kill("SIGTERM");
    expect(await process.exited).toBe(0);
    expect(startsLog()).toEqual(["1.0.0 1", "1.0.0 clean"]);
  });
});

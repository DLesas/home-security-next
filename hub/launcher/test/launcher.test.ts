/**
 * The launcher (m2-design.md section 9) on real child processes: the hub restarted on any exit but
 * 0 with the backoff (here scaled down: 50, 200, 400, 800 ms while failing within a second), a
 * clean stop passed on, a switch to a new version, the new version kept once healthy and the third
 * version removed, and the rollbacks: on an exit before health, on a hang, and with the
 * pre-migration copy put back.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err } from "neverthrow";
import { icacls, ownSid } from "../../test/unit/shell-control/windows-folders.ts";
import { endProcesses, spawnTracked } from "../../test/world/processes.ts";
import { Backoff } from "../src/backoff.ts";
import * as io from "../src/io.ts";
import { Launcher, type LauncherOptions, STATUS_FILE } from "../src/launcher.ts";
import {
  installPaths,
  programIn,
  isVersionName,
  parseLauncherState,
  parseSwitchNote,
} from "../src/layout.ts";
import { parseLauncherArgs } from "../src/main.ts";

const FAKE_HUB = join(import.meta.dir, "fake-hub.ts");
const RULES = {
  restartDelaysMs: [50, 200, 400, 800],
  failingWithinMs: 1000,
  restartMeExitCode: 70,
};
const folders: string[] = [];
let restoreListing: (() => void) | undefined;
afterEach(() => {
  restoreListing?.();
  restoreListing = undefined;
});
// Real child processes: on a machine running the whole suite a start can take seconds; the
// waits below (`until`, 8 s) bound each test, not the runner's 5 s default.
setDefaultTimeout(20_000);

// Build once with the running Bun so the real launcher can execute the same stand-in on every host.
let executable: string;
beforeAll(() => {
  const folder = mkdtempSync(join(tmpdir(), "hsn-fake-"));
  folders.push(folder);
  executable = join(folder, process.platform === "win32" ? "fake.exe" : "fake");
  const built = Bun.spawnSync([
    process.execPath,
    "build",
    "--compile",
    FAKE_HUB,
    "--outfile",
    executable,
  ]);
  expect(built.exitCode).toBe(0);
});

afterAll(async () => {
  await endProcesses();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

interface Install {
  /** The package's tree: `packaged/<version>/`. */
  readonly packageRoot: string;
  /** The hub's program tree: `staged/<version>/`, `state/`. */
  readonly programRoot: string;
  readonly data: string;
}

let install: Install;

/** The two trees with these versions, each a fake hub, and a data folder. */
function installWith(packaged: readonly string[], staged: readonly string[] = []): Install {
  const root = mkdtempSync(join(tmpdir(), "hsn-launcher-"));
  folders.push(root);
  const packageRoot = join(root, "package");
  const programRoot = join(root, "program");
  const data = join(root, "data");
  mkdirSync(join(packageRoot, "packaged"), { recursive: true });
  mkdirSync(join(programRoot, "state"), { recursive: true });
  mkdirSync(data, { recursive: true });
  const all = [
    ...packaged.map((v) => join(packageRoot, "packaged", v)),
    ...staged.map((v) => join(programRoot, "staged", v)),
  ];
  for (const folder of all) {
    mkdirSync(join(folder, "bin"), { recursive: true });
    linkSync(executable, programIn(folder));
  }
  return { packageRoot, programRoot, data };
}

/** WinSW signals the hub separately on Windows; tell the stand-in when the service stops. */
function stop(launcher: Launcher): void {
  launcher.stop();
  if (process.platform === "win32") writeFileSync(join(install.data, "service-stop"), "");
}

function paths(): ReturnType<typeof installPaths> {
  return installPaths(install.programRoot, install.packageRoot);
}

function plan(version: string, steps: readonly object[]): void {
  writeFileSync(join(install.data, `plan-${version}.json`), JSON.stringify(steps));
}

function startsLog(): string[] {
  const path = join(install.data, "starts.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

function state(): ReturnType<typeof parseLauncherState> {
  return parseLauncherState(readFileSync(paths().launcherFile, "utf8"));
}

function current(version: string, previous: string | null = null): void {
  writeFileSync(
    paths().launcherFile,
    JSON.stringify({ current: version, previous, trial: null, rolledBack: null }),
  );
}

function launcher(options: Partial<LauncherOptions> = {}): Launcher {
  return new Launcher({
    packageRoot: install.packageRoot,
    programRoot: install.programRoot,
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
    expect(
      parseLauncherArgs([
        "--package",
        "/k",
        "--program",
        "/p",
        "--data",
        "/d",
        "--",
        "--port",
        "0",
      ]),
    ).toEqual({ packageRoot: "/k", programRoot: "/p", dataDir: "/d", hubArgs: ["--port", "0"] });
    expect(parseLauncherArgs(["--program", "/p", "--data", "/d"])).toBe(
      "--package needs the package's tree",
    );
    // No installer chooses a version any more (section 9, "The privilege boundary").
    expect(
      parseLauncherArgs(["--package", "/k", "--program", "/p", "--data", "/d", "--select", "1"]),
    ).toBe("unknown argument --select");
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
    stop(l);
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
    stop(l);
    expect(await ran).toBe(0);
  });

  test("a hub that ignores SIGTERM is killed after the grace, and the launcher still exits 0", async () => {
    plan("1.0.0", [{ hang: true, ignoreTerm: true }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => startsLog().length === 1)).toBe(true);
    await Bun.sleep(200);
    stop(l);
    expect(await ran).toBe(0);
    expect(startsLog()).toEqual(["1.0.0 1"]);
  });

  test("a program that cannot start is a failure, retried with the backoff", async () => {
    rmSync(programIn(join(install.packageRoot, "packaged", "1.0.0")));
    const l = launcher();
    const ran = l.run();
    await Bun.sleep(400);
    stop(l);
    expect(await ran).toBe(0);
    expect(l.starts).toBe(0);
  });

  test("with no state, the newest packaged version is current, with no trial", async () => {
    plan("1.0.0", [{ exit: 0 }]);
    expect(await launcher().run()).toBe(0);
    expect(state()).toEqual({
      current: "1.0.0",
      previous: null,
      trial: null,
      rolledBack: null,
      failed: [],
    });
  });
});

describe("updates", () => {
  beforeEach(() => {
    // 1.0.0 the package's; 0.9.0 and 1.1.0 staged by the hub (1.1.0 not yet switched to).
    install = installWith(["1.0.0"], ["0.9.0", "1.1.0"]);
    current("1.0.0", "0.9.0");
    writeFileSync(join(install.data, "hub.db"), "the database of 1.0.0");
  });

  test("a switch: the new version on trial; healthy, it stays, the old one is kept and the third removed", async () => {
    plan("1.0.0", [{ switchTo: "1.1.0" }]);
    plan("1.1.0", [{ healthy: true }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => state()?.trial === null && state()?.current === "1.1.0")).toBe(true);
    expect(state()).toEqual({
      current: "1.1.0",
      previous: "1.0.0",
      trial: null,
      rolledBack: null,
      failed: [],
    });
    // The hub's tree pruned; the package's never touched.
    expect(existsSync(join(install.programRoot, "staged", "0.9.0"))).toBe(false);
    expect(existsSync(join(install.packageRoot, "packaged", "1.0.0"))).toBe(true);
    expect(existsSync(paths().switchFile)).toBe(false);
    stop(l);
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
    stop(l);
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
    stop(l);
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
    stop(l);
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
    stop(l);
    expect(await ran).toBe(0);
  });

  test("rollback puts back only a whole copy new since the trial began: a leftover hub.db.copying never, and hub.db stays", async () => {
    writeFileSync(join(install.data, "hub.db.before-1"), "an older copy");
    plan("1.0.0", [{ switchTo: "1.1.0" }, { hang: true }]);
    plan("1.1.0", [{ leftover: true, exit: 71 }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => startsLog().length === 3)).toBe(true);
    expect(readFileSync(join(install.data, "hub.db"), "utf8")).toBe("the database of 1.0.0");
    expect(readFileSync(join(install.data, "hub.db.copying"), "utf8")).toBe("half a cop");
    stop(l);
    expect(await ran).toBe(0);
  });

  test("no copy made at all (nothing to migrate, or stopped before): nothing put back", async () => {
    plan("1.0.0", [{ switchTo: "1.1.0" }, { hang: true }]);
    plan("1.1.0", [{ exit: 1 }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => startsLog().length === 3)).toBe(true);
    expect(readFileSync(join(install.data, "hub.db"), "utf8")).toBe("the database of 1.0.0");
    stop(l);
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
    stop(l);
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
    stop(first);
    expect(await ran).toBe(0);
    expect(state()?.trial?.version).toBe("1.1.0");
    const second = launcher();
    const again = second.run();
    expect(await until(() => state()?.trial === null)).toBe(true);
    expect(state()?.current).toBe("1.1.0");
    stop(second);
    expect(await again).toBe(0);
  });
});

describe('a package\'s version (section 9, "The privilege boundary")', () => {
  test("a failed package listing starts only a version already recorded in state", async () => {
    install = installWith(["1.1.0"], ["1.0.0"]);
    const packaged = join(install.packageRoot, "packaged");
    const message = "FindFirstFileW failed with Windows error 5";
    const list = io.names;
    const listing = spyOn(io, "names").mockImplementation((path) =>
      path === packaged ? err({ what: `list ${path}`, code: "WIN32_5", message }) : list(path),
    );
    restoreListing = () => {
      listing.mockRestore();
    };
    const logged: string[] = [];
    const fresh = launcher({
      log: (line) => {
        logged.push(line);
      },
    });
    expect(await fresh.run()).toBe(1);
    expect(logged).toContain(`cannot start: ${message}`);
    expect(startsLog()).toEqual([]);

    current("1.0.0");
    plan("1.0.0", [{ exit: 0 }]);
    expect(await launcher().run()).toBe(0);
    expect(listing).toHaveBeenCalledTimes(2);
    expect(startsLog()).toEqual(["1.0.0 1"]);
    expect(state()).toMatchObject({ current: "1.0.0", trial: null });
  });

  test("a newer packaged version: on trial at the next start, told so; healthy as an update is, it stays", async () => {
    install = installWith(["1.0.0", "1.1.0"]);
    current("1.0.0");
    writeFileSync(join(install.data, "hub.db.before-1"), "an older copy");
    // The hub's shell writes healthy.json for a package's trial as for an update (notes.ts).
    plan("1.1.0", [{ healthy: true }]);
    const seen: (ReturnType<typeof state> | undefined)[] = [];
    const envs: Readonly<Record<string, string | undefined>>[] = [];
    const l = launcher({
      spawn: (command, env) => {
        seen.push(state());
        envs.push(env);
        return spawnTracked([...command], {
          env,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      },
    });
    const ran = l.run();
    expect(await until(() => state()?.trial === null && state()?.current === "1.1.0")).toBe(true);
    expect(seen[0]?.trial).toMatchObject({ version: "1.1.0", from: "1.0.0", byPackage: true });
    expect(seen[0]?.trial?.copiesBefore.map((c) => c.name)).toEqual(["hub.db.before-1"]);
    expect(envs[0]?.HSN_PACKAGE_TRIAL).toBe("1.1.0");
    expect(state()).toEqual({
      current: "1.1.0",
      previous: "1.0.0",
      trial: null,
      rolledBack: null,
      failed: [],
    });
    stop(l);
    expect(await ran).toBe(0);
  });

  test("a packaged version that fails its first start: rolled back, its copy put back, never tried again", async () => {
    install = installWith(["1.0.0", "1.1.0"]);
    current("1.0.0");
    writeFileSync(join(install.data, "hub.db"), "the database of 1.0.0");
    plan("1.1.0", [{ migrate: 4, exit: 78 }]);
    plan("1.0.0", [{ exit: 3 }, { hang: true }]);
    const l = launcher();
    const ran = l.run();
    expect(await until(() => startsLog().length === 3)).toBe(true);
    // After the rollback 1.0.0 fails once and is restarted: 1.1.0 is not tried again.
    expect(startsLog()).toEqual(["1.1.0 1", "1.0.0 1", "1.0.0 2"]);
    expect(state()).toMatchObject({
      current: "1.0.0",
      trial: null,
      rolledBack: { from: "1.1.0" },
      failed: ["1.1.0"],
    });
    expect(readFileSync(join(install.data, "hub.db"), "utf8")).toBe("the database of 1.0.0");
    stop(l);
    expect(await ran).toBe(0);
  });

  test("a packaged version that runs but never becomes healthy: rolled back after the 60 s (here 1.5 s)", async () => {
    install = installWith(["1.0.0", "1.1.0"]);
    current("1.0.0");
    plan("1.1.0", [{ hang: true }]);
    plan("1.0.0", [{ hang: true }]);
    const l = launcher();
    const ran = l.run();
    // The new version is stopped (its "clean" line), then the old one started.
    expect(await until(() => startsLog().includes("1.0.0 1"), 6000)).toBe(true);
    expect(state()).toMatchObject({ current: "1.0.0", rolledBack: { from: "1.1.0" } });
    stop(l);
    expect(await ran).toBe(0);
  });

  test("a version the hub staged but has not switched to never runs by itself", async () => {
    install = installWith(["1.0.0"], ["2.0.0"]);
    current("1.0.0");
    plan("1.0.0", [{ exit: 0 }]);
    expect(await launcher().run()).toBe(0);
    expect(startsLog()).toEqual(["1.0.0 1"]);
  });

  test("the hub is told both trees: HSN_PROGRAM and HSN_PACKAGE", async () => {
    install = installWith(["1.0.0"]);
    plan("1.0.0", [{ exit: 0 }]);
    const envs: Readonly<Record<string, string | undefined>>[] = [];
    const l = launcher({
      spawn: (command, env) => {
        envs.push(env);
        return spawnTracked([...command], {
          env,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      },
    });
    expect(await l.run()).toBe(0);
    expect(envs[0]).toMatchObject({
      HSN_PROGRAM: install.programRoot,
      HSN_PACKAGE: install.packageRoot,
    });
  });

  test("the same version in both trees runs from the package's", async () => {
    install = installWith(["1.0.0"], ["1.0.0"]);
    current("1.0.0");
    plan("1.0.0", [{ exit: 0 }]);
    const commands: string[] = [];
    const l = launcher({
      spawn: (command, env) => {
        commands.push(command[0] ?? "");
        return spawnTracked([...command], {
          env,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      },
    });
    expect(await l.run()).toBe(0);
    expect(commands[0]?.startsWith(join(install.packageRoot, "packaged"))).toBe(true);
  });

  test("a current version no tree holds any more gives way to the newest packaged one", async () => {
    install = installWith(["1.2.0"]);
    current("1.0.0");
    plan("1.2.0", [{ exit: 0 }]);
    expect(await launcher().run()).toBe(0);
    expect(startsLog()).toEqual(["1.2.0 1"]);
    expect(state()?.current).toBe("1.2.0");
  });

  test("the launcher never writes the package's tree", async () => {
    install = installWith(["1.0.0", "1.1.0"]);
    current("1.0.0");
    plan("1.1.0", [{ exit: 1 }]);
    plan("1.0.0", [{ exit: 0 }]);
    if (process.platform === "win32")
      expect(icacls(install.packageRoot, "/deny", `*${ownSid()}:(OI)(CI)(WD,AD,DC)`).code).toBe(0);
    chmodSync(install.packageRoot, 0o555);
    chmodSync(join(install.packageRoot, "packaged"), 0o555);
    const l = launcher();
    expect(await l.run()).toBe(0);
    expect(startsLog()).toEqual(["1.1.0 1", "1.0.0 1"]);
    chmodSync(join(install.packageRoot, "packaged"), 0o755);
    chmodSync(install.packageRoot, 0o755);
    if (process.platform === "win32")
      expect(icacls(install.packageRoot, "/remove:d", `*${ownSid()}`).code).toBe(0);
  });
});

describe("as a process", () => {
  // Windows has no POSIX SIGTERM; WinSW delivers a console event to the service process tree.
  test.skipIf(process.platform === "win32")(
    "hsn-launcher runs the hub and exits 0 on SIGTERM, after the hub's clean stop",
    async () => {
      install = installWith(["1.0.0"]);
      plan("1.0.0", [{ hang: true }]);
      const process = spawnTracked(
        [
          Bun.argv[0] ?? "bun",
          join(import.meta.dir, "..", "src", "main.ts"),
          "--package",
          install.packageRoot,
          "--program",
          install.programRoot,
          "--data",
          install.data,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      expect(await until(() => startsLog().length === 1)).toBe(true);
      process.kill("SIGTERM");
      expect(await process.exited).toBe(0);
      expect(startsLog()).toEqual(["1.0.0 1", "1.0.0 clean"]);
    },
  );
});

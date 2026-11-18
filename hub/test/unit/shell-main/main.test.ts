/**
 * The hub's process (`shell/main.ts`; hub-design.md sections 7 and 10): its command line, the
 * starts it refuses, and a clean stop. A crash is the `kill -9` layer's (`test/crash/kill.test.ts`).
 */
import { shortTempFolder } from "../../world/temp-folder.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { socketPath } from "../../../cli/paths.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { SystemClock } from "../../../src/shell/clock/system-clock.ts";
import { DEFAULT_PORT, parseMainArgs, runHub } from "../../../src/shell/main.ts";
import { openStore } from "../../../src/shell/storage/store.ts";
import { endProcesses, spawnTestHub, stopTestHub } from "../../world/processes.ts";

const MAIN = join(import.meta.dir, "..", "..", "..", "src", "shell", "main.ts");
const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "drizzle");
// Short, so the control socket's path stays under 104 bytes (section 9).
const root = shortTempFolder("hsn-m-");
// Every hub this file starts is ended, also when a test fails before its own stop.
afterAll(async () => {
  await endProcesses();
  rmSync(root, { recursive: true, force: true });
});

describe("the command line", () => {
  test("defaults, every option, and the data folder from the environment", () => {
    expect(parseMainArgs([], { HSN_DATA_DIR: "/var/lib/hsn" })).toEqual({
      dataDir: "/var/lib/hsn",
      port: DEFAULT_PORT,
      serial: [],
      watchUsb: true,
      lockstep: undefined,
      appPorts: { lan: 8444, console: 8445 },
    });
    expect(
      parseMainArgs(
        [
          "--data",
          "/d",
          "--port",
          "9000",
          "--serial",
          "/dev/a",
          "--serial",
          "/dev/b",
          "--no-usb-watch",
          "--app-ports",
          "0,0",
        ],
        {},
      ),
    ).toEqual({
      dataDir: "/d",
      port: 9000,
      serial: ["/dev/a", "/dev/b"],
      watchUsb: false,
      lockstep: undefined,
      appPorts: { lan: 0, console: 0 },
    });
    expect(parseMainArgs(["--data", "/d", "--bench-lockstep", "/tmp/l.sock"], {})).toMatchObject({
      lockstep: "/tmp/l.sock",
    });
  });

  test("what it refuses, and why", () => {
    expect(parseMainArgs(["--port", "x"], { HSN_DATA_DIR: "/d" })).toBe("--port needs a number");
    expect(parseMainArgs(["--data"], {})).toBe("--data needs a folder");
    expect(parseMainArgs(["--serial"], { HSN_DATA_DIR: "/d" })).toBe("--serial needs a path");
    expect(parseMainArgs(["--loud"], { HSN_DATA_DIR: "/d" })).toBe("unknown option --loud");
    expect(parseMainArgs([], {})).toBe("no data folder: give --data or set HSN_DATA_DIR");
    expect(parseMainArgs(["--app-ports", "8444"], { HSN_DATA_DIR: "/d" })).toBe(
      "--app-ports needs <lan>,<console>",
    );
  });

  test("--serial preserves Windows COM port names", () => {
    expect(
      parseMainArgs(["--data", "/d", "--serial", "COM1", "--serial", "COM10"], {}),
    ).toMatchObject({
      serial: ["COM1", "COM10"],
    });
  });
});

describe("starts it refuses (section 10)", () => {
  test("a data folder that is a file: exit 78, nothing started", async () => {
    const file = join(root, "not-a-folder");
    writeFileSync(file, "x");
    expect(
      await runHub(
        {
          dataDir: file,
          port: 0,
          serial: [],
          watchUsb: false,
          lockstep: undefined,
          appPorts: { lan: 0, console: 0 },
        },
        { publisherKeys: [] },
      ),
    ).toBe(78);
  });

  test("a bad command line: exit 2", async () => {
    const hub = spawnTestHub([MAIN, "--port", "nope"], "pipe");
    expect(await hub.exited).toBe(2);
    expect(await new Response(hub.stderr).text()).toContain("--port needs a number");
  });
});

describe("a clean stop (section 7)", () => {
  test("SIGTERM: exit 0, and the next start reads the last run as a clean stop", async () => {
    const dataDir = join(root, "clean");
    const hub = spawnTestHub(
      [MAIN, "--data", dataDir, "--port", "0", "--no-usb-watch", "--app-ports", "0,0"],
      "ignore",
    );
    // Up once the control socket is there.
    const deadline = Date.now() + 10_000;
    while (!existsSync(socketPath(dataDir)) && Date.now() < deadline) await Bun.sleep(20);
    const up = existsSync(socketPath(dataDir));
    // Stopped whether it came up or not: a failed check must not leave it running.
    if (up) stopTestHub(hub);
    else hub.kill("SIGKILL");
    const code = await hub.exited;
    expect(up).toBe(true);
    expect(code).toBe(0);
    // The clean stop checkpointed and closed `hub.db`: its write-ahead log empty or gone (macOS's
    // SQLite keeps the empty file), so a switch's last step finds the database whole (section 9).
    const wal = join(dataDir, "hub.db-wal");
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
    // The hub's process makes its files its own alone (umask 077, section 9).
    if (process.platform !== "win32")
      expect(statSync(join(dataDir, "hub.db")).mode & 0o077).toBe(0);
  }, 20_000);

  test("SIGTERM as soon as the process runs, while it starts: still a clean stop", async () => {
    const dataDir = join(root, "early");
    const hub = spawnTestHub(
      [MAIN, "--data", dataDir, "--port", "0", "--no-usb-watch", "--app-ports", "0,0"],
      "ignore",
    );
    // As soon as the database exists: the start is under way, the control socket not yet open.
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dataDir, "hub.db")) && Date.now() < deadline) await Bun.sleep(1);
    stopTestHub(hub);
    const code = await hub.exited;
    // Killed before the handler was listening at all (143) is possible only before the database.
    expect([0, 143]).toContain(code);
    if (code !== 0) return;
    const store = openStore({
      dataDir,
      migrationsFolder: MIGRATIONS,
      clock: new SystemClock({ wallTrusted: () => true }),
      rules: DEFAULT_RULES,
      platform: process.platform,
    })._unsafeUnwrap();
    expect(store.boot.previousExit).toBe("clean");
    store.db.close(true);
  }, 20_000);

  test("SIGTERM once the control socket is there: exit 0 (the next start reads a clean stop)", async () => {
    const dataDir = join(root, "clean2");
    const hub = spawnTestHub(
      [MAIN, "--data", dataDir, "--port", "0", "--no-usb-watch", "--app-ports", "0,0"],
      "ignore",
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(socketPath(dataDir)) && Date.now() < deadline) await Bun.sleep(20);
    const up = existsSync(socketPath(dataDir));
    if (up) stopTestHub(hub);
    else hub.kill("SIGKILL");
    const code = await hub.exited;
    expect(up).toBe(true);
    expect(code).toBe(0);
    const store = openStore({
      dataDir,
      migrationsFolder: MIGRATIONS,
      clock: new SystemClock({ wallTrusted: () => true }),
      rules: DEFAULT_RULES,
      platform: process.platform,
    })._unsafeUnwrap();
    expect(store.boot.previousExit).toBe("clean");
    store.db.close(true);
  }, 20_000);
});

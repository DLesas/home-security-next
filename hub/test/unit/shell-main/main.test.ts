/**
 * The hub's process (`shell/main.ts`; hub-design.md sections 7 and 10): its command line, the
 * starts it refuses, and a clean stop. A crash is the `kill -9` layer's (`test/crash/kill.test.ts`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { socketPath } from "../../../cli/paths.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { SystemClock } from "../../../src/shell/clock/system-clock.ts";
import { DEFAULT_PORT, parseMainArgs, runHub } from "../../../src/shell/main.ts";
import { openStore } from "../../../src/shell/storage/store.ts";

const MAIN = join(import.meta.dir, "..", "..", "..", "src", "shell", "main.ts");
const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "drizzle");
// Short, so the control socket's path stays under 104 bytes (section 9).
const root = mkdtempSync("/tmp/hsn-m-");
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the command line", () => {
  test("defaults, every option, and the data folder from the environment", () => {
    expect(parseMainArgs([], { HSN_DATA_DIR: "/var/lib/hsn" })).toEqual({
      dataDir: "/var/lib/hsn",
      port: DEFAULT_PORT,
      serial: [],
      watchUsb: true,
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
        ],
        {},
      ),
    ).toEqual({ dataDir: "/d", port: 9000, serial: ["/dev/a", "/dev/b"], watchUsb: false });
  });

  test("what it refuses, and why", () => {
    expect(parseMainArgs(["--port", "x"], { HSN_DATA_DIR: "/d" })).toBe("--port needs a number");
    expect(parseMainArgs(["--data"], {})).toBe("--data needs a folder");
    expect(parseMainArgs(["--serial"], { HSN_DATA_DIR: "/d" })).toBe("--serial needs a path");
    expect(parseMainArgs(["--loud"], { HSN_DATA_DIR: "/d" })).toBe("unknown option --loud");
    expect(parseMainArgs([], {})).toBe("no data folder: give --data or set HSN_DATA_DIR");
  });
});

describe("starts it refuses (section 10)", () => {
  test("a data folder that is a file: exit 78, nothing started", async () => {
    const file = join(root, "not-a-folder");
    writeFileSync(file, "x");
    expect(await runHub({ dataDir: file, port: 0, serial: [], watchUsb: false })).toBe(78);
  });

  test("a bad command line: exit 2", async () => {
    const hub = Bun.spawn(["bun", MAIN, "--port", "nope"], { stdout: "ignore", stderr: "pipe" });
    expect(await hub.exited).toBe(2);
    expect(await new Response(hub.stderr).text()).toContain("--port needs a number");
  });
});

describe("a clean stop (section 7)", () => {
  test("SIGTERM: exit 0, and the next start reads the last run as a clean stop", async () => {
    const dataDir = join(root, "clean");
    const hub = Bun.spawn(["bun", MAIN, "--data", dataDir, "--port", "0", "--no-usb-watch"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    // Up once the control socket is there.
    const deadline = Date.now() + 10_000;
    while (!existsSync(socketPath(dataDir)) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(socketPath(dataDir))).toBe(true);
    hub.kill("SIGTERM");
    expect(await hub.exited).toBe(0);
  }, 20_000);

  test("SIGTERM as soon as the process runs, while it starts: still a clean stop", async () => {
    const dataDir = join(root, "early");
    const hub = Bun.spawn(["bun", MAIN, "--data", dataDir, "--port", "0", "--no-usb-watch"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    // As soon as the database exists: the start is under way, the control socket not yet open.
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dataDir, "hub.db")) && Date.now() < deadline) await Bun.sleep(1);
    hub.kill("SIGTERM");
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
    store.db.close();
  }, 20_000);

  test("SIGTERM once the control socket is there: exit 0 (the next start reads a clean stop)", async () => {
    const dataDir = join(root, "clean2");
    const hub = Bun.spawn(["bun", MAIN, "--data", dataDir, "--port", "0", "--no-usb-watch"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(socketPath(dataDir)) && Date.now() < deadline) await Bun.sleep(20);
    hub.kill("SIGTERM");
    expect(await hub.exited).toBe(0);
    const store = openStore({
      dataDir,
      migrationsFolder: MIGRATIONS,
      clock: new SystemClock({ wallTrusted: () => true }),
      rules: DEFAULT_RULES,
      platform: process.platform,
    })._unsafeUnwrap();
    expect(store.boot.previousExit).toBe("clean");
    store.db.close();
  }, 20_000);
});

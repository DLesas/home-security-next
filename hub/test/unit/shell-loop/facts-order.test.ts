/**
 * The hub's facts before any client (m2-design.md section 2), with the ports the listeners really
 * hold (`--app-ports`, or ports the system chose): `AppSide.open` binds the listeners, then, in the
 * same synchronous run, queues `hubFacts` (both ports) and `timeZone`. Bun binds and listens in one
 * call, so a connection can reach the system before the facts are queued, but nothing it does
 * runs until that run ends: whatever it causes is queued after them. Here a client connects and
 * sends at once, and what the hub queues for it comes after the facts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_PATHS,
  LISTENER_PORTS,
  linkPrologue,
  NOISE_PATTERNS,
  secretLookup,
  secretPsk,
  startHandshake,
  x25519StaticKey,
} from "@hsn/protocol/app";
import { sha256 } from "@noble/hashes/sha2.js";
import { ok } from "neverthrow";
import { installPaths, parseHealthyNote } from "../../../launcher/src/layout.ts";
import type { HubError } from "../../../src/core/model/errors.ts";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { makeCore, MODULES } from "../../../src/core/step.ts";
import { ensureHubKeys } from "../../../src/shell/advertise/hub-keys.ts";
import { AppSide, type AppWiringOptions, startApp } from "../../../src/shell/app-wiring.ts";
import type { OpenedStore } from "../../../src/shell/storage/store.ts";
import { endProcesses, spawnTracked } from "../../world/processes.ts";
import { MIGRATIONS, openTestStore, tempDir, TestClock } from "../storage/fixtures.ts";

function must<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string },
): T {
  expect(result.ok ? "ok" : result.error).toBe("ok");
  return (result as { readonly value: T }).value;
}

let dir: ReturnType<typeof tempDir> | undefined;
let store: OpenedStore | undefined;
let side: AppSide | undefined;

afterEach(async () => {
  await endProcesses();
  side?.stop();
  store?.db.close(true);
  dir?.remove();
});

/** Builds the app side of boot with a real store and a scripted core. */
async function makeSide(env: (dir: string) => AppWiringOptions["env"] = () => ({})) {
  dir = tempDir("facts");
  store = openTestStore(dir.path, new TestClock());
  const reports: HubError[] = [];
  const options = {
    dataDir: dir.path,
    db: store.db,
    writer: store.writer,
    random: (length: number) => ok(crypto.getRandomValues(new Uint8Array(length))),
    nowMs: () => Date.now(),
    rules: DEFAULT_RULES,
    paths: { migrations: MIGRATIONS, web: mkdtempSync(join(dir.path, "web-")) },
    ports: { lan: 0, console: 0 },
    env: env(dir.path),
    writerStatus: () => ({
      lastCommitMs: null,
      stagedItems: 0,
      databaseBytes: null,
      historyShortened: false,
    }),
    report: (error: HubError) => reports.push(error),
    history: { rows: () => ok([]), staged: () => [] },
    publisherKeys: [],
  };
  // The signing keys first, as `main.ts` makes them.
  (await ensureHubKeys(store.snapshot.hubKeys, store.writer))._unsafeUnwrap();
  const start = startApp(options, [])._unsafeUnwrap();
  const queued: HubEvent[] = [];
  const state = makeCore(MODULES).emptyState();
  const app = AppSide.make(
    options,
    start,
    () => state,
    (event) => queued.push(event),
  )._unsafeUnwrap();
  side = app;
  return { app, queued, reports };
}

describe("the hub's facts come before any client, with the listeners' real ports (section 2)", () => {
  test("ports the system chose: hubFacts names them, queued before open returns; a client's events after", async () => {
    const { app, queued, reports } = await makeSide();
    let clientAt = -1;
    const opened = app.open((event) => {
      queued.push(event);
    });
    expect(opened.isOk()).toBe(true);
    const lan = app.lanPort ?? 0;
    const console = app.consolePort ?? 0;
    // A client at once, in the same run: it reaches the system now, and the hub later.
    const ws = new WebSocket(`ws://127.0.0.1:${String(console)}${APP_PATHS.link}`, {
      headers: { Origin: `http://127.0.0.1:${String(console)}` },
    } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    // A link's first message for a token the hub never made: refused, and the core is told so
    // (`clientRefused`, gathered a minute at a time and given at the latest when the hub stops).
    const secret = new Uint8Array(16).fill(7);
    const hs = startHandshake({
      pattern: NOISE_PATTERNS.link,
      initiator: true,
      prologue: linkPrologue("link"),
      staticKey: must(x25519StaticKey(sha256(Uint8Array.of(9)))),
      psk: secretPsk(sha256, secret),
    });
    const first = must(
      await must(hs).writeMessage(
        new TextEncoder().encode(
          JSON.stringify({ proto: [1, 1], find: secretLookup(sha256, secret) }),
        ),
      ),
    );
    ws.onopen = () => {
      clientAt = queued.length;
      ws.send(first);
    };
    // What open queued before it returned: the facts with the real ports, then the time zone.
    expect(queued.map((e) => e.kind)).toEqual(["hubFacts", "timeZone"]);
    expect(queued[0]).toMatchObject({ kind: "hubFacts", appsPort: lan, consolePort: console });
    expect([lan, console]).not.toContain(0);
    expect(lan).not.toBe(LISTENER_PORTS.lan);
    for (let i = 0; i < 100 && clientAt < 0; i++) await Bun.sleep(20);
    await Bun.sleep(200);
    app.stop();
    side = undefined;
    ws.close();
    expect(clientAt).toBeGreaterThanOrEqual(2);
    // Whatever the client's connection made the hub queue came after the facts.
    expect(queued.slice(0, 2).map((e) => e.kind)).toEqual(["hubFacts", "timeZone"]);
    expect(queued.length).toBeGreaterThan(2);
    expect(reports.filter((r) => r.kind !== "link")).toEqual([]);
  });
});

test("a package trial becomes healthy after its first commit and both app and control listeners", async () => {
  let healthy = "";
  const { app } = await makeSide((folder) => {
    const paths = installPaths(folder);
    mkdirSync(paths.state, { recursive: true });
    healthy = paths.healthyFile;
    return { HSN_PROGRAM: folder, HSN_PACKAGE_TRIAL: "1.1.0" };
  });
  app.committed([]);
  expect(existsSync(healthy)).toBe(false);
  expect(app.open(() => undefined).isOk()).toBe(true);
  // A package upgrade must not end its trial while the command socket is still opening.
  expect(existsSync(healthy)).toBe(false);
  app.controlSettled({ has: () => false, download: () => false });
  expect(parseHealthyNote(readFileSync(healthy, "utf8"))).toEqual({ version: "1.1.0" });
});

test("a package trial becomes healthy after the control socket fails to open", async () => {
  dir = tempDir("facts");
  const paths = installPaths(dir.path);
  mkdirSync(paths.state, { recursive: true });
  const opening = Promise.withResolvers<undefined>();
  const ended = Promise.withResolvers<undefined>();
  const hub = spawnTracked(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "../../world/console-stop.ts"),
      "--preload",
      join(import.meta.dir, "fail-control-open.ts"),
      join(import.meta.dir, "../../world/hub-entry.ts"),
      "--data",
      join(dir.path, "data"),
      "--port",
      "0",
      "--app-ports",
      "0,0",
      "--no-usb-watch",
    ],
    {
      env: { ...process.env, HSN_PROGRAM: dir.path, HSN_PACKAGE_TRIAL: "1.1.0" },
      stderr: "pipe",
      stdout: "ignore",
      ipc(message: unknown) {
        if (message === "control-opening") opening.resolve(undefined);
        if (message === "control-open-ended") ended.resolve(undefined);
      },
    },
  );
  const stderr = new Response(hub.stderr).text();
  await opening.promise;
  expect(existsSync(paths.healthyFile)).toBe(false);
  hub.send("fail-control-open");
  await ended.promise;
  const healthy = existsSync(paths.healthyFile);
  hub.send("console-stop");
  expect(await hub.exited).toBe(0);
  expect(await stderr).toContain("the control socket could not open: injected open failure");
  expect(healthy).toBe(true);
  expect(parseHealthyNote(readFileSync(paths.healthyFile, "utf8"))).toEqual({ version: "1.1.0" });
});

/**
 * The hub's facts before any client (m2-design.md section 2), with the ports the listeners really
 * hold (`--app-ports`, or ports the system chose): `AppSide.open` binds the listeners, then, in the
 * same synchronous run, queues `hubFacts` (both ports) and `timeZone`. Bun binds and listens in one
 * call, so a connection can reach the system before the facts are queued, but nothing it does
 * runs until that run ends: whatever it causes is queued after them. Here a client connects and
 * sends at once, and what the hub queues for it comes after the facts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
import type { HubError } from "../../../src/core/model/errors.ts";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { makeCore, MODULES } from "../../../src/core/step.ts";
import { ensureHubKeys } from "../../../src/shell/advertise/hub-keys.ts";
import { AppSide, startApp } from "../../../src/shell/app-wiring.ts";
import type { OpenedStore } from "../../../src/shell/storage/store.ts";
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

afterEach(() => {
  side?.stop();
  store?.db.close();
  dir?.remove();
});

describe("the hub's facts come before any client, with the listeners' real ports (section 2)", () => {
  test("ports the system chose: hubFacts names them, queued before open returns; a client's events after", async () => {
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
      env: {},
      writerStatus: () => ({
        lastCommitMs: null,
        stagedItems: 0,
        databaseBytes: null,
        historyShortened: false,
      }),
      report: (error: HubError) => reports.push(error),
      history: { rows: () => ok([]), staged: () => [] },
    };
    // The signing keys first, as `main.ts` makes them.
    (await ensureHubKeys(store.snapshot.hubKeys, store.writer))._unsafeUnwrap();
    const start = startApp(options, [])._unsafeUnwrap();
    const queued: HubEvent[] = [];
    const state = makeCore(MODULES).emptyState();
    side = AppSide.make(
      options,
      start,
      () => state,
      (event) => queued.push(event),
    )._unsafeUnwrap();
    let clientAt = -1;
    const opened = side.open((event) => {
      queued.push(event);
    });
    expect(opened.isOk()).toBe(true);
    const lan = side.lanPort ?? 0;
    const console = side.consolePort ?? 0;
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
    side.stop();
    side = undefined;
    ws.close();
    expect(clientAt).toBeGreaterThanOrEqual(2);
    // Whatever the client's connection made the hub queue came after the facts.
    expect(queued.slice(0, 2).map((e) => e.kind)).toEqual(["hubFacts", "timeZone"]);
    expect(queued.length).toBeGreaterThan(2);
    expect(reports.filter((r) => r.kind !== "link")).toEqual([]);
  });
});

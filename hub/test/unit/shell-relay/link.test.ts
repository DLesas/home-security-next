/**
 * The hub's link to its relay (docs/m4-design.md section 4, "Connecting, back-off, keepalive";
 * section 3's close codes), on B2's real relay on loopback where the relay can do what is asked of
 * it, and on a relay scripted in memory for the closes and silences a real one gives only by
 * accident. The hub's own time is the test's (`ManualTimers`); the jitter's draw is 0.5 unless a
 * test says otherwise, so every wait is exact.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { RELAY_LIMITS } from "@hsn/protocol/relay";
import { JOIN_WITHIN_MS } from "../../../src/shell/relay/link.ts";
import { openRelaySocket, type RelaySocketFactory } from "../../../src/shell/safe/relay-socket.ts";
import {
  identityOf,
  makeClient,
  NOWHERE,
  ScriptedRelay,
  settle,
  startRelayRun,
  staticKeyOf,
  stopAll,
  until,
} from "./support.ts";

afterEach(async () => {
  await stopAll();
});

let seed = 1;
function hubKey() {
  return staticKeyOf(seed++);
}

/** The real socket factory, counting attempts. */
function counting(): { factory: RelaySocketFactory; attempts: () => number } {
  let attempts = 0;
  return {
    factory: (url, events) => {
      attempts += 1;
      return openRelaySocket(url, events);
    },
    attempts: () => attempts,
  };
}

describe("on B2's relay", () => {
  test("up: XN with the hub's app key, joined under its identity, relayLink up with the URL and roles", async () => {
    const run = startRelayRun();
    const key = hubKey();
    const side = makeClient({ key });
    side.client.perform({ kind: "relayConnect", url: run.url });
    await until(() => side.client.state.kind === "up", "the link up");
    expect(side.of("relayLink")).toEqual([
      { kind: "relayLink", state: "up", url: run.url, roles: ["relay", "releases"] },
    ]);
    expect(run.joined).toBe(1);
    expect(run.relay?.recordOf(identityOf(key, sha256))).toBeDefined();
  });

  test("lost and regained, with the exact back-off steps, then reset by a link that lasted 60 s", async () => {
    const run = startRelayRun();
    const count = counting();
    const side = makeClient({ key: hubKey(), connect: count.factory });
    side.client.perform({ kind: "relayConnect", url: run.url });
    await until(() => side.client.state.kind === "up", "the link up");
    expect(count.attempts()).toBe(1);

    await run.stop();
    await until(() => side.client.state.kind === "waiting", "the link lost");
    expect(side.links()).toEqual(["up", "down:closed"]);
    const steps = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    for (const [i, ms] of steps.entries()) {
      expect(side.client.state).toEqual({ kind: "waiting", url: run.url, ms });
      side.timers.advance(ms - 1);
      expect(count.attempts()).toBe(1 + i);
      side.timers.advance(1);
      expect(count.attempts()).toBe(2 + i);
      await until(() => side.client.state.kind === "waiting", `attempt ${String(i + 1)} to fail`);
    }
    expect(side.of("relayLink").every((e) => e.url === run.url)).toBe(true);
    expect(side.links().slice(2)).toEqual(steps.map(() => "down:connect"));

    // The relay is back on its port: the next attempt, 60 s on, finds it.
    run.start();
    side.timers.advance(60000);
    await until(() => side.client.state.kind === "up", "the link regained");
    expect(side.links().at(-1)).toBe("up");

    // Up for under 60 s: the steps go on where they were.
    side.timers.advance(30_000);
    await settle(40);
    await run.stop();
    await until(() => side.client.state.kind === "waiting", "lost again");
    expect(side.client.state).toEqual({ kind: "waiting", url: run.url, ms: 60000 });

    // Up for 60 s, kept alive by its pings and the relay's pongs: the steps start again.
    run.start();
    side.timers.advance(60000);
    await until(() => side.client.state.kind === "up", "regained");
    for (let i = 0; i < 2; i++) {
      side.timers.advance(RELAY_LIMITS.hubPingEveryMs);
      await settle(40);
    }
    expect(side.client.state.kind).toBe("up");
    await run.stop();
    await until(() => side.client.state.kind === "waiting", "lost a third time");
    expect(side.client.state).toEqual({ kind: "waiting", url: run.url, ms: 1000 });
  });

  test("the keepalive: a ping every 30 s, answered, keeps a link the relay would close at 75 s", async () => {
    const run = startRelayRun();
    const side = makeClient({ key: hubKey() });
    side.client.perform({ kind: "relayConnect", url: run.url });
    await until(() => side.client.state.kind === "up", "the link up");
    // The hub's clock and the relay's move together, 2 minutes in all, past the relay's 75 s.
    for (let i = 0; i < 4; i++) {
      side.timers.advance(RELAY_LIMITS.hubPingEveryMs);
      await settle(40);
      run.clock.advance(RELAY_LIMITS.hubPingEveryMs);
      await settle(10);
    }
    expect(side.client.state.kind).toBe("up");
    expect(side.links()).toEqual(["up"]);
    expect(run.joined).toBe(1);
  });

  test("4001 replaced: another computer joined with this hub's key; the hub waits 10 minutes", async () => {
    const run = startRelayRun();
    const key = hubKey();
    const first = makeClient({ key });
    first.client.perform({ kind: "relayConnect", url: run.url });
    await until(() => first.client.state.kind === "up", "the first link");
    const second = makeClient({ key });
    second.client.perform({ kind: "relayConnect", url: run.url });
    await until(() => first.client.state.kind === "waiting", "the first replaced");
    expect(first.links()).toEqual(["up", "down:replaced"]);
    expect(first.client.state).toEqual({ kind: "waiting", url: run.url, ms: 600_000 });
    expect(second.client.state.kind).toBe("up");
  });

  test("4403: the relay refuses the key; reported once, never tried again until the setting changes", async () => {
    const key = hubKey();
    const run = startRelayRun({ refused: new Set([identityOf(key, sha256)]) });
    const count = counting();
    const side = makeClient({ key, connect: count.factory });
    side.client.perform({ kind: "relayConnect", url: run.url });
    await until(() => side.client.state.kind === "refused", "the refusal");
    expect(side.links()).toEqual(["down:closed"]);
    expect(side.reports.map((r) => r.message)).toEqual([
      "the relay refuses this hub's key (4403): no link until the setting changes or the hub restarts",
    ]);
    side.timers.advance(24 * 3_600_000);
    await settle();
    expect(count.attempts()).toBe(1);
    // A new setting: tried again.
    const other = startRelayRun();
    side.client.perform({ kind: "relayConnect", url: other.url });
    await until(() => side.client.state.kind === "up", "the other relay");
    expect(count.attempts()).toBe(2);
  });
});

describe("each close code's reaction (a scripted relay)", () => {
  const cases: readonly [string, number, string, number][] = [
    // [what, code, down reason, wait]
    ["a normal close", 1000, "closed", 1000],
    ["the relay stopping", 1001, "closed", 1000],
    ["dropped without a close", 1006, "connect", 1000],
    ["a frame it cannot read", 4400, "closed", 1000],
    ["the handshake not finished in time", 4408, "handshake", 1000],
    ["replaced", 4001, "replaced", 600_000],
    ["no shared version", 4426, "version", 600_000],
    ["over a limit, with no limit frame", 4429, "limited", 600_000],
  ];
  for (const [what, code, reason, ms] of cases) {
    test(`${String(code)}, ${what}: down as ${reason}, the next attempt after ${String(ms)} ms`, async () => {
      const relay = new ScriptedRelay();
      const side = makeClient({ key: hubKey(), connect: relay.connect });
      side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
      await until(() => side.client.state.kind === "up", "up");
      relay.last?.close(code);
      await until(() => side.client.state.kind === "waiting", "down");
      expect(side.links()).toEqual(["up", `down:${reason}`]);
      expect(side.client.state).toEqual({ kind: "waiting", url: "ws://127.0.0.1:1", ms });
      side.timers.advance(ms - 1);
      expect(relay.links).toHaveLength(1);
      side.timers.advance(1);
      expect(relay.links).toHaveLength(2);
    });
  }

  test("4429 after a limit frame: its retryAfterMs", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: hubKey(), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    relay.last?.send({ t: "limit", what: "pushes", retryAfterMs: 12_345 });
    relay.last?.close(4429);
    await until(() => side.client.state.kind === "waiting", "down");
    expect(side.client.state).toEqual({ kind: "waiting", url: "ws://127.0.0.1:1", ms: 12_345 });
  });

  test("4403 before joining: refused, with no timer", async () => {
    const relay = new ScriptedRelay();
    relay.silent = true;
    const side = makeClient({ key: hubKey(), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await settle();
    relay.last?.close(4403);
    await until(() => side.client.state.kind === "refused", "refused");
    expect(side.timers.pending).toBe(0);
  });

  test("no pong within 15 s: the hub closes the link (noPong) and backs off", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: hubKey(), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    const link = relay.last;
    if (link !== undefined) link.pong = false;
    side.timers.advance(RELAY_LIMITS.hubPingEveryMs - 1);
    expect(link?.sent("ping")).toHaveLength(0);
    side.timers.advance(1);
    expect(link?.sent("ping")).toEqual([{ t: "ping", n: 1 }]);
    side.timers.advance(RELAY_LIMITS.pongWithinMs - 1);
    expect(side.client.state.kind).toBe("up");
    side.timers.advance(1);
    expect(side.links()).toEqual(["up", "down:noPong"]);
    expect(link?.closedByHub).toBe(1000);
    expect(side.client.state).toEqual({ kind: "waiting", url: "ws://127.0.0.1:1", ms: 1000 });
  });

  test("a pong for an older ping keeps nothing alive", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: hubKey(), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    const link = relay.last;
    if (link !== undefined) link.pong = false;
    side.timers.advance(RELAY_LIMITS.hubPingEveryMs);
    link?.send({ t: "pong", n: 99 });
    side.timers.advance(RELAY_LIMITS.pongWithinMs);
    expect(side.links()).toEqual(["up", "down:noPong"]);
  });

  test("one keepalive timer at a time, and none while waiting but the next attempt's", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: hubKey(), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    // The keepalive's, and the daily release check's.
    expect(side.timers.pending).toBe(2);
    relay.last?.close(1001);
    await until(() => side.client.state.kind === "waiting", "down");
    expect(side.timers.pending).toBe(1);
  });

  test("the handshake not finished within its time: the hub gives up (handshake)", async () => {
    const relay = new ScriptedRelay();
    relay.silent = true;
    const side = makeClient({ key: hubKey(), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await settle();
    side.timers.advance(JOIN_WITHIN_MS - 1);
    expect(side.links()).toEqual([]);
    side.timers.advance(1);
    expect(side.links()).toEqual(["down:handshake"]);
    expect(relay.last?.closedByHub).toBe(1000);
  });

  test("a frame the hub cannot read closes the link with 4400", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: hubKey(), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    relay.last?.sendRaw('{"t":"nonsense"}');
    await until(() => side.client.state.kind === "waiting", "down");
    expect(relay.last?.closedByHub).toBe(4400);
    expect(side.links()).toEqual(["up", "down:closed"]);
  });
});

describe("the setting", () => {
  test("null closes the link and nothing is tried again; the same URL again changes nothing", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: hubKey(), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    expect(relay.links).toHaveLength(1);
    side.client.perform({ kind: "relayConnect", url: null });
    expect(side.client.state).toEqual({ kind: "off" });
    expect(relay.last?.closedByHub).toBe(1000);
    side.timers.advance(3_600_000);
    expect(relay.links).toHaveLength(1);
    // The old link's end is no URL's: told to nobody.
    expect(side.links()).toEqual(["up"]);
  });

  test("a URL the link cannot use: reported, down, and not tried", () => {
    const side = makeClient({ key: hubKey(), connect: NOWHERE });
    side.client.perform({ kind: "relayConnect", url: "http://example.invalid" });
    expect(side.client.state).toEqual({ kind: "badUrl", url: "http://example.invalid" });
    expect(side.links()).toEqual(["down:connect"]);
    expect(side.reports).toHaveLength(1);
    expect(side.timers.pending).toBe(0);
  });

  test("a change of the computer's addresses: a wait cut short, the steps reset; a link up probed", async () => {
    const relay = new ScriptedRelay();
    relay.down = true;
    const side = makeClient({ key: hubKey(), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "waiting", "down");
    side.timers.advance(1000);
    await until(() => side.client.failures === 2, "a second failure");
    relay.down = false;
    side.client.networkChanged();
    await until(() => side.client.state.kind === "up", "up at once");
    expect(side.client.failures).toBe(0);
    if (relay.last !== undefined) relay.last.pong = false;
    side.client.networkChanged();
    expect(relay.last?.sent("ping")).toEqual([{ t: "ping", n: 1 }]);
    // A second probe while a pong is awaited sends nothing more.
    side.client.networkChanged();
    expect(relay.last?.sent("ping")).toHaveLength(1);
    // Unanswered, it ends the link as any ping does.
    side.timers.advance(RELAY_LIMITS.pongWithinMs);
    expect(side.links().at(-1)).toBe("down:noPong");
  });

  test("the jitter: each wait within ±20% of its step, from the generator's draw", async () => {
    const low = makeClient({ key: hubKey(), connect: NOWHERE, jitter: Uint8Array.of(0, 0, 0, 0) });
    low.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => low.client.state.kind === "waiting", "down");
    expect(low.client.state).toEqual({ kind: "waiting", url: "ws://127.0.0.1:1", ms: 800 });
    const high = makeClient({
      key: hubKey(),
      connect: NOWHERE,
      jitter: Uint8Array.of(0xff, 0xff, 0xff, 0xff),
    });
    high.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => high.client.state.kind === "waiting", "down");
    expect(high.client.state).toEqual({ kind: "waiting", url: "ws://127.0.0.1:1", ms: 1200 });
  });
});

/**
 * Presence and the hub-unreachable alerts through a real relay (docs/m4-design.md section 3,
 * "Presence"; D64, D96): the clock at its edges (179 s, 180 s), an announced restart, the relay
 * restarting, `back`, and what goes to `PushSender`: each target's pre-sealed `h`, as it is.
 * Time is the test's (`ManualClock`); nothing is slept.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RELAY_BACKOFF, RELAY_CLOSE } from "@hsn/protocol/relay";
import { stepPresence } from "../src/core/presence-core.ts";
import type { PresenceCore } from "../src/core/presence.ts";
import { PRESENCE_RULES } from "../src/core/rules.ts";
import { STALL_FLOOR_MS } from "../src/shell/relay.ts";
import {
  cleanup,
  events,
  hubKey,
  ManualClock,
  RecordingSender,
  settle,
  StandInHub,
  startRelay,
  target,
  tempFolder,
  type TestRelay,
  until,
} from "./helpers.ts";

const S = 1000;
let folder: string;
let t: TestRelay;

beforeEach(() => {
  folder = tempFolder();
  t = startRelay(folder);
});

afterEach(async () => {
  await t.stop();
  cleanup(folder);
});

/** A hub joined with a roster of `n` targets, acknowledged. */
async function hubWithRoster(n = 2, key = hubKey()): Promise<StandInHub> {
  const hub = await StandInHub.connect(t.url, { key });
  await hub.next("joined");
  hub.send({ t: "roster", rev: 1, targets: Array.from({ length: n }, (_, i) => target(i + 1)) });
  await hub.next("rosterAck");
  return hub;
}

/** The hub's link is cut at the relay's `now`: its last frame was then. */
async function cut(hub: StandInHub): Promise<void> {
  hub.client.close(1000);
  await until(() => t.relay.counts.joined === 0, "the link to close");
}

describe("the unreachable alert", () => {
  test("goes 180 s after the last frame, not at 179 s, to every target with its sealed `h`", async () => {
    const hub = await hubWithRoster(2);
    const last = t.clock.now();
    await cut(hub);
    t.clock.to(last + 179 * S);
    await settle();
    expect(t.push.items).toEqual([]);
    t.clock.to(last + 180 * S);
    await until(() => t.push.items.length === 2, "the alerts");
    expect(t.push.items.map((i) => ({ ...i, id: 0 }))).toEqual(
      [target(1), target(2)].map((x) => ({
        id: 0,
        hub: hub.identity,
        platform: x.platform,
        env: x.env,
        token: x.token,
        h: x.unreachable,
      })),
    );
    expect(t.relay.presenceOf(hub.identity)?.state).toBe("alerted");
    // Once per outage.
    t.clock.advance(3600 * S);
    await settle();
    expect(t.push.items).toHaveLength(2);
  });

  test("a silent link is closed at 75 s with 4408, and the alert follows at 180 s", async () => {
    const hub = await hubWithRoster(1);
    const last = t.clock.now();
    t.clock.to(last + PRESENCE_RULES.silentCloseMs - 1);
    await settle();
    expect(hub.client.closeCode).toBeUndefined();
    t.clock.to(last + PRESENCE_RULES.silentCloseMs);
    expect(await hub.client.closed()).toBe(RELAY_CLOSE.handshakeTimeout);
    t.clock.to(last + PRESENCE_RULES.alertAfterMs);
    await until(() => t.push.items.length === 1, "the alert");
  });

  test("a hub that keeps pinging is never alerted", async () => {
    const hub = await hubWithRoster(1);
    for (let i = 0; i < 20; i++) {
      t.clock.advance(30 * S);
      hub.send({ t: "ping", n: i });
      await hub.next("pong");
    }
    expect(t.push.items).toEqual([]);
    expect(hub.client.closeCode).toBeUndefined();
  });

  test("`back` goes when the hub returns, each target's sealed `back`", async () => {
    const key = hubKey();
    const hub = await hubWithRoster(2, key);
    const last = t.clock.now();
    await cut(hub);
    t.clock.to(last + 180 * S);
    await until(() => t.push.items.length === 2, "the alerts");
    t.clock.advance(600 * S);
    const again = await StandInHub.connect(t.url, { key });
    await again.next("joined");
    await until(() => t.push.items.length === 4, "back");
    expect(t.push.items.slice(2).map((i) => i.h)).toEqual([target(1).back, target(2).back]);
    expect(t.relay.presenceOf(key.identity)?.state).toBe("online");
  });
});

describe("an announced restart", () => {
  test("is acknowledged and silent within its grace; back in time, nothing is sent", async () => {
    const key = hubKey();
    const hub = await hubWithRoster(1, key);
    hub.send({ t: "restarting", reason: "update", withinMs: 600 * S });
    await hub.next("restartingAck");
    const last = t.clock.now();
    await cut(hub);
    t.clock.to(last + 599 * S);
    await settle();
    expect(t.push.items).toEqual([]);
    const back = await StandInHub.connect(t.url, { key });
    await back.next("joined");
    for (let i = 0; i < 40; i++) {
      t.clock.advance(30 * S);
      back.send({ t: "ping", n: i });
      await back.next("pong");
    }
    expect(t.push.items).toEqual([]);
  });

  test("back at once, then silent: alerted 180 s after its last contact, not at the grace's end", async () => {
    const key = hubKey();
    const hub = await hubWithRoster(1, key);
    hub.send({ t: "restarting", reason: "update", withinMs: 600 * S });
    await hub.next("restartingAck");
    await cut(hub);
    const back = await StandInHub.connect(t.url, { key });
    await back.next("joined");
    const last = t.clock.now();
    await cut(back);
    t.clock.to(last + 180 * S - 1);
    await settle();
    expect(t.push.items).toEqual([]);
    t.clock.to(last + 180 * S);
    await until(() => t.push.items.length === 1, "the alert");
  });

  test("a second announcement after a return starts a new grace", async () => {
    const key = hubKey();
    const hub = await hubWithRoster(1, key);
    hub.send({ t: "restarting", reason: "update", withinMs: 600 * S });
    await hub.next("restartingAck");
    await cut(hub);
    const back = await StandInHub.connect(t.url, { key });
    await back.next("joined");
    back.send({ t: "restarting", reason: "restore", withinMs: 400 * S });
    await back.next("restartingAck");
    const last = t.clock.now();
    await cut(back);
    t.clock.to(last + 400 * S - 1);
    await settle();
    expect(t.push.items).toEqual([]);
    t.clock.to(last + 400 * S);
    await until(() => t.push.items.length === 1, "the alert");
  });

  test("not back by its grace end: the alert goes at once", async () => {
    const hub = await hubWithRoster(1);
    hub.send({ t: "restarting", reason: "restore", withinMs: 300 * S });
    await hub.next("restartingAck");
    const last = t.clock.now();
    await cut(hub);
    t.clock.to(last + 300 * S - 1);
    await settle();
    expect(t.push.items).toEqual([]);
    t.clock.to(last + 300 * S);
    await until(() => t.push.items.length === 1, "the alert");
  });
});

describe("the relay restarting (D96)", () => {
  test("starts the 3-minute clock afresh; an alerted hub stays alerted and gets `back`", async () => {
    const quietKey = hubKey();
    const alertedKey = hubKey();
    const quiet = await hubWithRoster(1, quietKey);
    const alerted = await hubWithRoster(1, alertedKey);
    // The alerted one: cut, past 180 s. The quiet one keeps pinging until the relay stops.
    alerted.client.close(1000);
    await until(() => t.relay.counts.joined === 1, "one link left");
    for (let i = 0; i < 7; i++) {
      t.clock.advance(30 * S);
      quiet.send({ t: "ping", n: i });
      await quiet.next("pong");
    }
    await until(() => t.push.items.length === 1, "the first hub's alert");
    expect(t.relay.presenceOf(alertedKey.identity)?.state).toBe("alerted");
    // The relay stops for an hour.
    const dbPath = t.dbPath;
    await t.stop();
    const clock = new ManualClock(t.clock.now() + 3600 * S);
    const push = new RecordingSender();
    t = startRelay(folder, { clock, push, dbPath });
    const start = clock.now();
    expect(t.relay.presenceOf(quietKey.identity)?.lastContactMs).toBe(start);
    expect(t.relay.presenceOf(alertedKey.identity)?.state).toBe("alerted");
    clock.to(start + 179 * S);
    await settle();
    expect(push.items).toEqual([]);
    clock.to(start + 180 * S);
    await until(() => push.items.length === 1, "the fresh clock's alert");
    expect(push.items[0]?.h).toBe(target(1).unreachable);
    // The alerted hub returns: `back`, without a second `unreachable`.
    const returning = await StandInHub.connect(t.url, { key: alertedKey });
    await returning.next("joined");
    await until(() => push.items.length === 2, "back");
    expect(push.items[1]?.h).toBe(target(1).back);
  });
});

describe("the alerts' hand-off", () => {
  test("an alert whose items fail is tried again on the back-off's steps while it holds", async () => {
    const hub = await hubWithRoster(2);
    t.push.error = { kind: "linkDown" };
    const last = t.clock.now();
    await cut(hub);
    t.clock.to(last + 180 * S);
    await until(() => t.push.sent.length === 1, "the first try");
    await settle();
    t.push.error = undefined;
    t.push.outcome = (item) => (item.h === target(1).unreachable ? "accepted" : "failed");
    t.clock.advance(RELAY_BACKOFF.stepsMs[0] ?? 0);
    await until(() => t.push.sent.length === 2, "the second try");
    expect(t.push.sent[1]).toHaveLength(2);
    await settle();
    // Only the target that failed is tried again.
    t.clock.advance(RELAY_BACKOFF.stepsMs[1] ?? 0);
    await until(() => t.push.sent.length === 3, "the third try");
    expect(t.push.sent[2]?.map((i) => i.h)).toEqual([target(2).unreachable]);
    // Every step taken, then it stops.
    await settle();
    t.push.outcome = () => "failed";
    for (const step of RELAY_BACKOFF.stepsMs) {
      t.clock.advance(step);
      await settle();
    }
    const tries = t.push.sent.length;
    expect(tries).toBe(1 + RELAY_BACKOFF.stepsMs.length);
    t.clock.advance(3600 * S);
    await settle();
    expect(t.push.sent.length).toBe(tries);
  });

  test("a token the push service refuses drops its target, kept until the hub's next roster", async () => {
    const key = hubKey();
    const hub = await hubWithRoster(2, key);
    t.push.outcome = (item) => (item.h === target(1).unreachable ? "badToken" : "accepted");
    const last = t.clock.now();
    await cut(hub);
    t.clock.to(last + 180 * S);
    await until(() => t.push.items.length === 2, "the alerts");
    await settle();
    expect(
      t.store
        .targets(key.identity)
        .unwrapOr([])
        .map((x) => x.key),
    ).toEqual([target(2).key]);
    const again = await StandInHub.connect(t.url, { key });
    await again.next("joined");
    await until(() => t.push.items.length === 3, "back to the target left");
    expect(t.push.items[2]?.h).toBe(target(2).back);
    expect(events(t.log, "alertSent").length).toBeGreaterThanOrEqual(2);
  });

  test("a hub without targets is never alerted", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const last = t.clock.now();
    await cut(hub);
    t.clock.to(last + 3600 * S);
    await settle();
    expect(t.push.sent).toEqual([]);
    expect(t.relay.presenceOf(hub.identity)?.state).toBe("quiet");
  });
});

describe("a due deadline never spins", () => {
  test("a core that makes no progress on a tick is woken again after the floor, and logged once", async () => {
    await t.stop();
    let ticks = 0;
    // A core with the mistake of leaving a due hub as it was: its deadline stays due.
    const stuck: PresenceCore = (hubs, input) => {
      if (input.kind !== "tick") return stepPresence(hubs, input);
      ticks += 1;
      return { hubs, out: [], nextWakeMs: null };
    };
    t = startRelay(folder, { presenceCore: stuck });
    const hub = await hubWithRoster(1);
    const last = t.clock.now();
    await cut(hub);
    // The first tick, at the silent close, makes no progress; then one a floor apart, no more.
    t.clock.to(last + PRESENCE_RULES.silentCloseMs);
    expect(ticks).toBe(1);
    t.clock.advance(10 * STALL_FLOOR_MS);
    expect(ticks).toBe(11);
    expect(events(t.log, "presenceStalled")).toHaveLength(1);
    expect(t.clock.pending).toBeLessThanOrEqual(2);
  });

  test("the test clock fails a timer that re-arms at the same instant without end", () => {
    const clock = new ManualClock(0);
    const again = () => {
      clock.after(0, again);
    };
    clock.after(0, again);
    expect(() => {
      clock.advance(1);
    }).toThrow();
  });
});

/**
 * The push hand-off on a hub link (docs/m4-design.md sections 3 and 5): the roster stored and
 * acknowledged; a hub's `push` items turned into the push service's through the roster and each
 * answered in `pushResult`; an unknown key `failed`; the push service's `limited` passed on with
 * `limit {what: "pushes"}`; a refused token dropping its target; push frames in hand bounded.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PUSH_SERVICE_LIMITS } from "../src/push/limits.ts";
import {
  cleanup,
  hubKey,
  settle,
  sealedH,
  StandInHub,
  startRelay,
  target,
  tempFolder,
  type TestRelay,
  until,
} from "./helpers.ts";

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

async function hubWithRoster(n: number): Promise<StandInHub> {
  const hub = await StandInHub.connect(t.url);
  await hub.next("joined");
  hub.send({ t: "roster", rev: 9, targets: Array.from({ length: n }, (_, i) => target(i + 1)) });
  expect(await hub.next("rosterAck")).toEqual({ t: "rosterAck", rev: 9 });
  return hub;
}

describe("the roster", () => {
  test("is stored whole each time, replacing the last", async () => {
    const hub = await hubWithRoster(3);
    expect(t.store.targets(hub.identity).unwrapOr([])).toEqual([target(1), target(2), target(3)]);
    hub.send({ t: "roster", rev: 10, targets: [target(2)] });
    await hub.next("rosterAck");
    expect(t.store.targets(hub.identity).unwrapOr([])).toEqual([target(2)]);
    hub.send({ t: "roster", rev: 11, targets: [] });
    await hub.next("rosterAck");
    expect(t.store.targets(hub.identity).unwrapOr([])).toEqual([]);
    expect(t.relay.presenceOf(hub.identity)?.hasTargets).toBe(false);
  });

  test("a roster over 128 KiB is a frame the relay cannot read: 4400", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const many = Array.from({ length: 40 }, (_, i) => target(i + 1));
    const text = JSON.stringify({ t: "roster", rev: 1, targets: many });
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(128 * 1024);
    hub.client.send(text);
    expect(await hub.client.closed()).toBe(4400);
    expect(t.store.targets(hub.identity).unwrapOr([])).toEqual([]);
  });
});

describe("a hub's pushes", () => {
  test("go to the push service with the roster's targets, and every item is answered", async () => {
    const hub = await hubWithRoster(2);
    const h1 = sealedH(target(1).key, "a");
    const h2 = sealedH(target(2).key, "b");
    hub.send({
      t: "push",
      items: [
        { id: 11, key: target(1).key, h: h1 },
        { id: 12, key: target(2).key, h: h2 },
        { id: 13, key: "00000000000000ff", h: h2 },
      ],
    });
    const result = await hub.next("pushResult");
    expect(result.results).toEqual([
      { id: 11, outcome: "accepted" },
      { id: 12, outcome: "accepted" },
      { id: 13, outcome: "failed" },
    ]);
    expect(t.push.items.map((i) => ({ hub: i.hub, token: i.token, h: i.h }))).toEqual([
      { hub: hub.identity, token: "token-1", h: h1 },
      { hub: hub.identity, token: "token-2", h: h2 },
    ]);
    // The relay's ids on its link are its own, never reused.
    const ids = t.push.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("outcomes are passed back item by item; a refused token drops its target", async () => {
    const hub = await hubWithRoster(2);
    t.push.outcome = (item) => (item.token === "token-1" ? "badToken" : "limited");
    hub.send({
      t: "push",
      items: [
        { id: 1, key: target(1).key, h: sealedH(target(1).key) },
        { id: 2, key: target(2).key, h: sealedH(target(2).key) },
      ],
    });
    expect((await hub.next("pushResult")).results).toEqual([
      { id: 1, outcome: "badToken" },
      { id: 2, outcome: "limited" },
    ]);
    expect(
      t.store
        .targets(hub.identity)
        .unwrapOr([])
        .map((x) => x.key),
    ).toEqual([target(2).key]);
  });

  test('the push service\'s limit is passed on as `limit {what: "pushes"}` and `limited`', async () => {
    const hub = await hubWithRoster(1);
    t.push.error = { kind: "limited", retryAfterMs: 12_345 };
    hub.send({ t: "push", items: [{ id: 3, key: target(1).key, h: sealedH(target(1).key) }] });
    expect(await hub.next("limit")).toEqual({ t: "limit", what: "pushes", retryAfterMs: 12_345 });
    expect((await hub.next("pushResult")).results).toEqual([{ id: 3, outcome: "limited" }]);
    t.push.error = { kind: "linkDown" };
    hub.send({ t: "push", items: [{ id: 4, key: target(1).key, h: sealedH(target(1).key) }] });
    expect((await hub.next("pushResult")).results).toEqual([{ id: 4, outcome: "failed" }]);
  });

  test(`a link has at most ${PUSH_SERVICE_LIMITS.framesInHand} push frames in hand; the next is answered limited`, async () => {
    const hub = await hubWithRoster(1);
    let release: () => void = () => undefined;
    t.push.hold = new Promise((resolve) => {
      release = resolve;
    });
    const item = (id: number) => ({ id, key: target(1).key, h: sealedH(target(1).key) });
    for (let i = 1; i <= PUSH_SERVICE_LIMITS.framesInHand; i++) {
      hub.send({ t: "push", items: [item(i)] });
    }
    await until(() => t.push.sent.length === PUSH_SERVICE_LIMITS.framesInHand, "frames in hand");
    hub.send({ t: "push", items: [item(99)] });
    expect((await hub.next("pushResult")).results).toEqual([{ id: 99, outcome: "limited" }]);
    expect(t.push.sent).toHaveLength(PUSH_SERVICE_LIMITS.framesInHand);
    release();
    await settle();
    for (let i = 0; i < PUSH_SERVICE_LIMITS.framesInHand; i++) {
      expect((await hub.next("pushResult")).results[0]?.outcome).toBe("accepted");
    }
    hub.send({ t: "push", items: [item(100)] });
    expect((await hub.next("pushResult")).results).toEqual([{ id: 100, outcome: "accepted" }]);
  });

  test("a new link of the same hub has its stored roster", async () => {
    const key = hubKey();
    const first = await StandInHub.connect(t.url, { key });
    await first.next("joined");
    first.send({ t: "roster", rev: 1, targets: [target(5)] });
    await first.next("rosterAck");
    first.client.close();
    await until(() => t.relay.counts.joined === 0, "the link to close");
    const second = await StandInHub.connect(t.url, { key });
    await second.next("joined");
    second.send({ t: "push", items: [{ id: 1, key: target(5).key, h: sealedH(target(5).key) }] });
    expect((await second.next("pushResult")).results).toEqual([{ id: 1, outcome: "accepted" }]);
  });
});

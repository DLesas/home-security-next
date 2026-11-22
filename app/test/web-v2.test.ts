/** Browser negotiation and version 2 events that need precise control of the hub's frames. */
import { expect, test } from "bun:test";
import { APP_RECONNECT_MS, type AppEventV2 } from "@hsn/protocol/app";
import type { RequestOutcome } from "../src/hub/channel";
import type { HubClient } from "../src/hub/client";
import { createWebHubClient } from "../src/hub/start.web";
import { memoryRecordStore } from "../src/platform/client-key";
import { HubEnd } from "./support/hub-end";
import { busHub, lockManager } from "./support/tabs";
import { manualTimers, settle } from "./support/timers";

const DEVICE_UPDATE = {
  t: "evt",
  ev: "deviceUpdate",
  body: {
    device: 3,
    image: 1,
    state: "planned",
    held: null,
    method: "ownLink",
    bytes: 0,
    of: 1000,
  },
} as const satisfies Omit<Extract<AppEventV2, { ev: "deviceUpdate" }>, "rev">;

/** Starts and links the supplied browser client, then lets its messages settle. */
async function startAndLink(hub: HubEnd, client: HubClient): Promise<void> {
  client.start();
  await client.link(
    { kind: "secret", secret: hub.tokenWithSecret("console"), identity: undefined },
    "console",
    { kind: "web", name: "Test browser" },
  );
  await settle();
}

/** Starts the same client as the web build and links it to a controllable hub. */
async function browserAt(speaks: HubEnd["speaks"]) {
  const hub = new HubEnd();
  hub.speaks = speaks;
  const timers = manualTimers();
  const client = createWebHubClient({
    connect: hub.connect,
    records: memoryRecordStore(),
    timers,
    app: "0.1.0",
  });
  await startAndLink(hub, client);
  return { hub, client, timers };
}

/** Links one tab to a version 2 hub and starts a second tab on its shared session. */
async function browserTabs() {
  const hub = new HubEnd();
  hub.speaks = [2, 2];
  const deps = {
    connect: hub.connect,
    records: memoryRecordStore(),
    timers: manualTimers(),
    app: "0.1.0",
  };
  const locks = lockManager();
  const bus = busHub();
  const ownerBus = bus("owner");
  const followerBus = bus("follower");
  const owner = createWebHubClient({
    ...deps,
    tabs: { id: "owner", locks: locks(), bus: ownerBus },
  });
  const follower = createWebHubClient({
    ...deps,
    tabs: { id: "follower", locks: locks(), bus: followerBus },
  });
  await startAndLink(hub, owner);
  follower.start();
  await settle();
  expect(owner.live.getState().hub?.proto).toBe(2);
  expect(follower.live.getState()).toEqual(owner.live.getState());
  expect(hub.paths).toEqual(["link", "session"]);
  /** Stops both tabs, giving the queued lock callback a turn before stopping its client. */
  const close = async () => {
    owner.stop();
    ownerBus.close();
    await settle(1);
    follower.stop();
    followerBus.close();
  };
  return { hub, owner, follower, close };
}

test("the web client links to a version 2-only hub and refuses a version 1 HubHello", async () => {
  const { hub, client, timers } = await browserAt([2, 2]);
  expect(client.local.getState().link.kind).toBe("linked");
  expect(client.live.getState().hub?.proto).toBe(2);

  hub.helloProtoOverride = 1;
  hub.dropAll();
  await settle();
  timers.advance(APP_RECONNECT_MS[0]);
  await settle();
  expect(client.live.getState().connection).toMatchObject({
    kind: "waiting",
    failure: "protocol",
  });
  expect(hub.seen.filter((request) => request.op === "snapshot")).toHaveLength(1);
  client.stop();
});

test("a version 1-only hub refuses the web link without a fallback attempt", async () => {
  const { hub, client, timers } = await browserAt([1, 1]);
  expect(client.local.getState().link).toEqual({
    kind: "failed",
    from: "console",
    failure: "refused",
  });
  timers.advance(60_000);
  await settle();
  expect(hub.paths).toEqual(["link"]);
  client.stop();
});

test("relay and offer events refresh both tabs without notices and deviceUpdate reaches subscribers", async () => {
  const { hub, owner, follower, close } = await browserTabs();
  const ownerV2 = owner.v2 ?? expect.unreachable();
  const followerV2 = follower.v2 ?? expect.unreachable();
  const ownerEvents: AppEventV2[] = [];
  const followerEvents: AppEventV2[] = [];
  const sharedEvents: string[] = [];
  const off = ownerV2.onNewEvent((event) => ownerEvents.push(event));
  const offFollower = followerV2.onNewEvent((event) => followerEvents.push(event));
  const offShared = owner.onEvent((event) =>
    sharedEvents.push(event.ev === "hub" ? event.body.what : event.ev),
  );
  const initial = owner.live.getState();
  const rev = initial.rev ?? expect.unreachable();
  for (const [offset, what] of [
    [1, "relay"],
    [2, "updateOffered"],
  ] as const) {
    hub.emitFrame({ t: "evt", rev: rev + offset, ev: "hub", body: { what, detail: {} } });
    await settle();
    const state = owner.live.getState();
    expect(state.rev).toBe(rev + offset);
    expect(state.stale.hub).toBe(initial.stale.hub + offset);
    expect(state.hubNotices).toEqual([]);
    expect(follower.live.getState()).toEqual(state);
  }
  expect(ownerEvents).toEqual([]);
  expect(followerEvents).toEqual([]);

  const ownerState = owner.live.getState();
  const followerState = follower.live.getState();
  const update = { ...DEVICE_UPDATE, rev: rev + 3 };
  hub.emitFrame(update);
  await settle();
  expect(ownerEvents).toEqual([update]);
  expect(followerEvents).toEqual([update]);
  expect(owner.live.getState()).toBe(ownerState);
  expect(follower.live.getState()).toBe(followerState);
  expect(sharedEvents).toEqual(["relay", "updateOffered"]);

  off();
  const next = { ...update, rev: rev + 4 };
  hub.emitFrame(next);
  await settle();
  expect(ownerEvents).toEqual([update]);
  expect(followerEvents).toEqual([update, next]);
  offFollower();
  offShared();
  await close();
});

test("early deviceUpdate events wait for the snapshot and only newer revisions reach subscribers", async () => {
  const hub = new HubEnd();
  hub.speaks = [2, 2];
  const rev = hub.rev;
  const newer = { ...DEVICE_UPDATE, rev: rev + 1 };
  hub.beforeSnapshot = () => {
    hub.emitFrame({ ...DEVICE_UPDATE, rev: rev - 1 });
    hub.emitFrame({ ...DEVICE_UPDATE, rev });
    hub.emitFrame(newer);
  };
  const client = createWebHubClient({
    connect: hub.connect,
    records: memoryRecordStore(),
    timers: manualTimers(),
    app: "0.1.0",
  });
  const v2 = client.v2 ?? expect.unreachable();
  const delivered: { event: AppEventV2; snapshotRev: number | null }[] = [];
  const off = v2.onNewEvent((event) => {
    delivered.push({ event, snapshotRev: client.live.getState().rev });
  });
  await startAndLink(hub, client);
  expect(client.live.getState().rev).toBe(rev);
  expect(delivered).toEqual([{ event: newer, snapshotRev: rev }]);
  off();
  client.stop();
});

/** Turns a stalled tab request into an assertion value. */
function within<T>(outcome: Promise<T>, ms: number): Promise<T | "no reply"> {
  return Promise.race([outcome, Bun.sleep(ms).then(() => "no reply" as const)]);
}

test("owner and follower give the same legacy outcome for a version 2-only refusal", async () => {
  const { hub, owner, follower, close } = await browserTabs();
  hub.handleV2("people.list", () => ({
    ok: false,
    error: { code: "invalid", detail: { field: "identity", reason: "pairedElsewhere" } },
  }));
  const expected: RequestOutcome<"people.list"> = {
    ok: false,
    error: { code: "protoUnsupported", detail: { speaks: [1, 2] } },
  };
  const outcomes = Promise.all([
    owner.request("people.list", {}),
    follower.request("people.list", {}),
  ]);
  expect(await within(outcomes, 500)).toEqual([expected, expected]);
  expect(hub.seen.filter((request) => request.op === "people.list")).toHaveLength(2);
  await close();
});

test("a tab with no known owner returns offline for forward and request before the deadline", async () => {
  const hub = new HubEnd();
  const bus = busHub()("waiting");
  const client = createWebHubClient({
    connect: hub.connect,
    records: memoryRecordStore(),
    timers: manualTimers(),
    app: "0.1.0",
    tabs: { id: "waiting", bus, locks: { request: () => new Promise(() => undefined) } },
  });
  client.start();
  const v2 = client.v2 ?? expect.unreachable();
  const outcomes = Promise.all([v2.forward("relay.status", {}), client.request("people.list", {})]);
  const offline = { ok: false, local: "offline" } as const;
  expect(await within(outcomes, 100)).toEqual([offline, offline]);
  expect(hub.paths).toEqual([]);
  client.stop();
  bus.close();
});

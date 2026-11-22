/** Browser negotiation and version 2 events that need precise control of the hub's frames. */
import { expect, test } from "bun:test";
import { APP_RECONNECT_MS, type AppEvent, type AppEventV2 } from "@hsn/protocol/app";
import { createWebHubClient } from "../src/hub/start.web";
import { memoryRecordStore } from "../src/platform/client-key";
import { HubEnd } from "./support/hub-end";
import { manualTimers, settle } from "./support/timers";

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
  client.start();
  await client.link(
    { kind: "secret", secret: hub.tokenWithSecret("console"), identity: undefined },
    "console",
    { kind: "web", name: "Test browser" },
  );
  await settle();
  return { hub, client, timers };
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

test("version 2 hub events past the snapshot reach subscribers without entering legacy notices", async () => {
  const { hub, client } = await browserAt([1, 2]);
  const v2 = client.v2 ?? expect.unreachable();
  const events: AppEventV2[] = [];
  const legacy: AppEvent[] = [];
  const off = v2.onNewEvent((event) => events.push(event));
  const offLegacy = client.onEvent((event) => legacy.push(event));
  const rev = client.live.getState().rev ?? expect.unreachable();
  const relay: AppEventV2 = {
    t: "evt",
    rev,
    ev: "hub",
    body: { what: "relay", detail: { state: "off" } },
  };
  const offer: AppEventV2 = {
    t: "evt",
    rev: rev + 2,
    ev: "hub",
    body: { what: "updateOffered", detail: { version: "2.0.0" } },
  };
  hub.emitFrame(relay);
  hub.emitFrame({ ...relay, rev: rev + 1 });
  hub.emitFrame(offer);
  await settle();
  expect(events).toEqual([{ ...relay, rev: rev + 1 }, offer]);
  expect(legacy).toEqual([]);
  expect(client.live.getState().hubNotices).toEqual([]);
  off();
  hub.emitFrame({ ...offer, rev: rev + 3 });
  await settle();
  expect(events).toHaveLength(2);
  offLegacy();
  client.stop();
});

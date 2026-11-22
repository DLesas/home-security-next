/** The web build's version 2 requests and live events over a real hub's app listener. */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeSha256 } from "@hsn/protocol";
import { type AppEventV2, parseConsoleFragment } from "@hsn/protocol/app";
import { imageFileName, storeFolder } from "../../hub/src/shell/firmware/store";
import { fileBytes, imageRow, S1, siteSnapshot } from "../../hub/test/unit/firmware/support";
import type { HubClient } from "../src/hub/client";
import { createWebHubClient } from "../src/hub/start.web";
import { type Connect, realTimers } from "../src/hub/wire";
import { phoneRequest } from "../src/pairing/hub";
import { memoryRecordStore } from "../src/platform/client-key";
import { seedPairingSite } from "./support/pairing-site";
import { connectFrom, type RealHub, startRealHub, stopAllHubs } from "./support/real-hub";
import { busHub, lockManager } from "./support/tabs";

/** Links the browser to the hub's own console without exposing the one-time code. */
async function linkConsole(hub: RealHub, client: HubClient): Promise<void> {
  const url = await hub.consoleCode();
  const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1)) ?? expect.unreachable();
  await client.link({ kind: "secret", secret, identity: undefined }, "console", {
    kind: "web",
    name: "Test browser",
  });
  expect(client.local.getState().link.kind).toBe("linked");
}

/** Bounds waits so a dropped state update produces an assertion failure. */
async function until(check: () => boolean): Promise<boolean> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

/** Gives a missing reply its own assertion value, even when the owner ignores the request. */
function reply<T>(outcome: Promise<T>): Promise<T | "no reply"> {
  return Promise.race([outcome, Bun.sleep(4000).then(() => "no reply" as const)]);
}

afterAll(stopAllHubs);

test("the web client agrees version 2 and receives real relay and firmware answers with no device", async () => {
  const hub = await startRealHub();
  const client = createWebHubClient({
    connect: connectFrom(hub.consoleOrigin),
    records: memoryRecordStore(),
    timers: realTimers,
    app: "0.1.0",
  });
  const v2 = client.v2 ?? expect.unreachable();
  client.start();
  await linkConsole(hub, client);
  expect(await until(() => client.live.getState().rev !== null)).toBe(true);
  expect(client.live.getState().hub?.proto).toBe(2);
  expect(await reply(phoneRequest(v2, "relay.status", {}))).toEqual({
    ok: true,
    value: { url: null, isDefault: true, state: "off", sinceMs: null, roles: [] },
  });
  expect(await reply(phoneRequest(v2, "firmware.list", {}))).toEqual({
    ok: true,
    value: { images: [], devices: [] },
  });
  client.stop();
}, 30_000);

test("the follower sends a rollout through the owner, both see its event, and version 2 survives handover", async () => {
  const row = imageRow();
  const file = new Uint8Array(fileBytes(row));
  file.set(row.header);
  const sha256 = nodeSha256(file);
  const image = {
    ...row,
    imageId: sha256.slice(0, 8),
    sha256,
    file: imageFileName(sha256),
    addedBy: "test",
  };
  const sensor = siteSnapshot().devices.find((row) => row.id === S1) ?? expect.unreachable();
  const hub = await startRealHub((dataDir) => {
    // The running hub checks each indexed image's file and hash at startup.
    const folder = storeFolder(dataDir);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, image.file), file);
    expect(
      seedPairingSite(dataDir, [
        { table: "devices", op: "upsert", row: sensor },
        { table: "firmware_images", op: "upsert", row: image },
      ]),
    ).toBe(true);
  });
  const records = memoryRecordStore();
  const locks = lockManager();
  const bus = busHub();
  const sessions: string[] = [];
  /** Builds a tab on the shared record and tracks which tab actually acquires each socket. */
  const tab = (id: string) => {
    const channel = bus(id);
    const open = connectFrom(hub.consoleOrigin);
    const connect: Connect = async (path, handlers) => {
      const wire = await open(path, handlers);
      if (path === "session" && wire !== undefined) sessions.push(id);
      return wire;
    };
    const client = createWebHubClient({
      connect,
      records,
      timers: realTimers,
      app: "0.1.0",
      tabs: { id, locks: locks(), bus: channel },
    });
    const v2 = client.v2 ?? expect.unreachable();
    const events: AppEventV2[] = [];
    const off = v2.onNewEvent((event) => events.push(event));
    /** Releases this tab's resources as when its page closes. */
    const close = () => {
      off();
      client.stop();
      channel.close();
    };
    return { client, v2, events, close };
  };
  const owner = tab("owner");
  owner.client.start();
  await linkConsole(hub, owner.client);
  expect(await until(() => owner.client.live.getState().rev !== null)).toBe(true);
  // Wait for the hub to process the subscription before starting the rollout.
  expect(await reply(owner.client.request("subscribe", { topics: ["devices"] }))).toMatchObject({
    ok: true,
  });

  const follower = tab("follower");
  follower.client.start();
  expect(await until(() => follower.client.live.getState().hub?.proto === 2)).toBe(true);
  expect(sessions).toEqual(["owner"]);
  expect(await reply(follower.v2.forward("rollout.start", { image: 404 }))).toEqual({
    ok: false,
    error: { code: "notFound", detail: { what: "image", id: 404 } },
  });
  expect(
    await reply(follower.v2.forward("rollout.start", { image: image.id, devices: [sensor.id] })),
  ).toMatchObject({ ok: true, repeat: false, body: { image: image.id } });
  expect(await until(() => owner.events.length > 0 && follower.events.length > 0)).toBe(true);
  expect(owner.events).toHaveLength(1);
  const [event] = owner.events;
  expect(event?.ev).toBe("deviceUpdate");
  expect(event?.body).toEqual({
    device: sensor.id,
    image: image.id,
    state: "planned",
    held: null,
    method: "joinWifi",
    bytes: 0,
    of: fileBytes(image),
  });
  expect(follower.events).toEqual(owner.events);
  expect(sessions).toEqual(["owner"]);

  owner.close();
  expect(
    await until(
      () =>
        sessions[1] === "follower" && follower.client.live.getState().connection.kind === "open",
    ),
  ).toBe(true);
  expect(await reply(phoneRequest(follower.v2, "firmware.list", {}))).toMatchObject({
    ok: true,
    value: {
      images: [{ id: image.id }],
      devices: [{ device: sensor.id, update: { state: "planned" } }],
    },
  });
  expect(sessions).toEqual(["owner", "follower"]);
  follower.close();
}, 30_000);

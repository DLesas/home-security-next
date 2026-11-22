/**
 * Two homes on one phone, against two real hubs (`hub/test/world/hub-entry.ts` as processes,
 * `support/real-hub.ts`): one phone client, as the app builds it, linked to both over `wss://` at
 * this computer's home-network address; its homes (`src/ui/homes.ts`) list both; choosing the
 * other closes the chosen one's session (its socket closed) and opens the other's, where a change
 * (renaming the phone) reaches that hub only; a name given on this phone is kept across a restart; and removing a home
 * runs its three steps in order, the hub forgets the phone, and the other home goes on working.
 * Push registration on the phone is faked while the version 2 hub handles the actual operation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseConsoleFragment } from "@hsn/protocol/app";
import assert from "node:assert/strict";
import { createHubClient, type HubClient } from "../src/hub/client";
import {
  type MakeSocket,
  NO_FINDER,
  type PhoneLinkSecret,
  readCode,
  type SocketLike,
} from "../src/hub/finder";
import { type PhoneClient, startPhoneClient } from "../src/hub/phone-client";
import { PHONE_PROTO } from "../src/hub/restore";
import { realTimers } from "../src/hub/wire";
import { memoryRecordStore } from "../src/platform/client-key";
import * as phoneKeys from "../src/platform/keys.native";
import { memorySecureItems, type SecureItems } from "../src/platform/vault";
import { followHomes, type Homes, type HomesDeps, phoneHomes } from "../src/ui/homes";
import {
  connectFrom,
  homeAddress,
  type RealHub,
  startRealHub,
  stopAllHubs,
} from "./support/real-hub";

/** Every socket the phone opened, with the port it went to. */
const sockets: { readonly port: number; readonly socket: WebSocket }[] = [];

/** Bun's WebSocket as the phone opens one: the `Origin` it sends, the hub's certificate taken. */
const bunSocket: MakeSocket = (url, origin) => {
  const options = { headers: { Origin: origin }, tls: { rejectUnauthorized: false } };
  const socket = new WebSocket(url, options as unknown as string[]);
  sockets.push({ port: Number(new URL(url).port), socket });
  return socket as unknown as SocketLike;
};

/** Counts the phone’s open sockets at one hub. */
const openTo = (port: number) =>
  sockets.filter((s) => s.port === port && s.socket.readyState === WebSocket.OPEN).length;

const HOME = homeAddress();
let hubA: RealHub;
let hubB: RealHub;
let consoleA: HubClient;
let consoleB: HubClient;

/** Waits for a local hub observation with a bounded deadline. */
async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

/** Links a local console for creating codes and inspecting each hub. */
async function consoleOf(hub: RealHub): Promise<HubClient> {
  const client = createHubClient({
    connect: connectFrom(hub.consoleOrigin),
    records: memoryRecordStore(),
    timers: realTimers,
    app: "0.1.0",
  });
  client.start();
  const url = await hub.consoleCode();
  const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1));
  assert(secret !== undefined, "console code");
  await client.link({ kind: "secret", secret, identity: undefined }, "console", {
    name: "The hub computer",
    kind: "web",
  });
  expect(await until(() => client.live.getState().session !== null)).toBe(true);
  return client;
}

/** Creates and parses a hub link without exposing the code in test output. */
async function qrCode(console: HubClient, name: string): Promise<PhoneLinkSecret> {
  const made = await console.request("link.create", { kind: { newPerson: { name } }, form: "qr" });
  assert(made.ok && made.body.qr !== undefined, "created QR code");
  const read = readCode(made.body.qr);
  assert(read.ok && read.value.kind === "link", "read QR code");
  return read.value.secret;
}

/** The phone as the app builds it, over real sockets and memory storage. */
function phoneOn(items: SecureItems): PhoneClient {
  return startPhoneClient({
    items,
    makeSocket: bunSocket,
    finder: NO_FINDER,
    timers: realTimers,
    app: "0.1.0",
    proto: PHONE_PROTO,
    keys: phoneKeys,
  });
}

/** Its homes as the phone's wiring makes them (`phone-wiring.native.tsx`), with `log` of each step. */
function homesOf(phone: PhoneClient, log: string[], registered = false): Homes {
  const hub = phone.client;
  const deps: HomesDeps = {
    records: {
      list: () => phone.records.list(),
      chosen: () => phone.records.chosen(),
      hub: (identity) => phone.records.hub(identity),
      remove: (identity) => {
        log.push(`delete ${identity}`);
        return phone.records.remove(identity);
      },
    },
    choose: (identity) => phone.choose(identity),
    live: hub.live,
    request: (op, body) => {
      log.push(op);
      return hub.request(op, body);
    },
    unregister: () => {
      log.push("push.unregister");
      return phone.forward("push.unregister", {});
    },
    pushRegistered: () => Promise.resolve(registered),
    timers: realTimers,
    defaultName: (n) => (n === 1 ? "Home" : `Home ${String(n)}`),
  };
  const homes = phoneHomes(deps);
  followHomes(homes, hub.live);
  return homes;
}

/** Checks that the phone has installed a snapshot. */
const sessionOpen = (phone: PhoneClient) => () => {
  const state = phone.client.live.getState();
  return state.connection.kind === "open" && state.session !== null;
};

/** The phone's client number at a hub, from its record there. */
async function clientAt(phone: PhoneClient, identity: string): Promise<number> {
  const record = await phone.records.hub(identity).read();
  assert(record.ok && record.value !== undefined, "linked phone record");
  return record.value.hub.client;
}

/** Reads client IDs from the hub for removal assertions. */
async function clientIds(console: HubClient): Promise<readonly number[]> {
  const listed = await console.request("clients.list", {});
  assert(listed.ok, "listed hub clients");
  return listed.body.clients.map((c) => c.id);
}

/** Reads client names to check where edits land. */
async function clientNames(console: HubClient): Promise<readonly string[]> {
  const listed = await console.request("clients.list", {});
  assert(listed.ok, "listed hub clients");
  return listed.body.clients.map((c) => c.name);
}

beforeAll(async () => {
  assert(HOME !== undefined, "these tests need this computer on a home network");
  [hubA, hubB] = await Promise.all([startRealHub(), startRealHub()]);
  [consoleA, consoleB] = await Promise.all([consoleOf(hubA), consoleOf(hubB)]);
}, 90_000);

afterAll(async () => {
  await stopAllHubs();
});

describe("two homes on one phone", () => {
  const items = memorySecureItems();
  let heldWrite:
    | {
        readonly item: string;
        readonly release: ReturnType<typeof Promise.withResolvers<undefined>>;
        entered: boolean;
      }
    | undefined;
  const gatedItems: SecureItems = {
    ...items,
    /** Can pause a sequence reservation before its vault write, across a home switch. */
    set: async (name, value) => {
      const held = heldWrite;
      if (held?.item === name) {
        held.entered = true;
        await held.release.promise;
      }
      return items.set(name, value);
    },
  };
  let phone: PhoneClient;
  let homes: Homes;
  const log: string[] = [];
  let identityA = "";
  let identityB = "";

  test("linked to both, the Homes list shows both, in the order linked; the newest is chosen", async () => {
    phone = phoneOn(gatedItems);
    phone.client.start();
    await phone.client.link(await qrCode(consoleA, "Pat"), "qr", {
      name: "Pat's phone",
      kind: "phone",
    });
    expect(await until(sessionOpen(phone))).toBe(true);
    // "Link another home": the same link, while linked to the first.
    await phone.client.link(await qrCode(consoleB, "Pat"), "qr", {
      name: "Pat's phone",
      kind: "phone",
    });
    expect(phone.client.local.getState().link).toEqual({ kind: "linked", from: "qr" });
    expect(await until(sessionOpen(phone))).toBe(true);
    const listed = await phone.records.list();
    assert(listed.ok && listed.value.length === 2, "two linked records");
    [identityA = "", identityB = ""] = listed.value;
    homes = homesOf(phone, log);
    expect(await until(() => homes.store.getState().homes.length === 2)).toBe(true);
    expect(homes.store.getState()).toMatchObject({
      chosen: identityB,
      homes: [
        { identity: identityA, name: "Home" },
        { identity: identityB, name: "Home 2" },
      ],
    });
    // One session: B's socket open, A's closed.
    expect(await until(() => openTo(hubA.lanPort) === 0 && openTo(hubB.lanPort) === 1)).toBe(true);
  }, 60_000);

  test("choosing Home closes Home 2's session and opens Home's: a change reaches Home's hub only", async () => {
    await homes.choose(identityA);
    expect(homes.store.getState().chosen).toBe(identityA);
    expect(await until(sessionOpen(phone))).toBe(true);
    expect(await until(() => openTo(hubB.lanPort) === 0 && openTo(hubA.lanPort) === 1)).toBe(true);
    expect(phone.client.live.getState().session?.client).toBe(await clientAt(phone, identityA));
    const named = await phone.client.request("client.rename", {
      client: await clientAt(phone, identityA),
      name: "Pat's phone, renamed",
    });
    expect(named.ok).toBe(true);
    expect(await clientNames(consoleA)).toContain("Pat's phone, renamed");
    expect(await clientNames(consoleB)).not.toContain("Pat's phone, renamed");
    // And back: Home 2's session, Home's closed.
    await homes.choose(identityB);
    expect(await until(sessionOpen(phone))).toBe(true);
    expect(await until(() => openTo(hubA.lanPort) === 0 && openTo(hubB.lanPort) === 1)).toBe(true);
    expect(phone.client.live.getState().session?.client).toBe(await clientAt(phone, identityB));
  }, 60_000);

  test("a change still reserving its sequence cannot reach the next home", async () => {
    const release = Promise.withResolvers<undefined>();
    const pendingWrite = { item: `hub.${identityB}.record`, release, entered: false };
    const clientsA = await clientNames(consoleA);
    const clientsB = await clientNames(consoleB);
    const b = await clientAt(phone, identityB);
    heldWrite = pendingWrite;
    const change = phone.client.request("client.rename", { client: b, name: "Wrong home" });
    const entered = await until(() => pendingWrite.entered, 3_000);
    if (!entered) release.resolve(undefined);
    expect(entered).toBe(true);
    const chosen = await phone.choose(identityA);
    const switched = await until(() => openTo(hubA.lanPort) === 1 && sessionOpen(phone)(), 5_000);
    heldWrite = undefined;
    release.resolve(undefined);
    expect(chosen.ok).toBe(true);
    expect(switched).toBe(true);
    expect(await Promise.race([change, Bun.sleep(1_000).then(() => "pending")])).toEqual({
      ok: false,
      local: "lost",
    });
    expect(await clientNames(consoleA)).toEqual(clientsA);
    expect(await clientNames(consoleB)).toEqual(clientsB);
    expect((await phone.choose(identityB)).ok).toBe(true);
    await homes.refresh();
    expect(await until(() => openTo(hubB.lanPort) === 1 && sessionOpen(phone)())).toBe(true);
  }, 20_000);

  test("a name given on this phone is kept across a restart, with the chosen home", async () => {
    const beforeRename = await clientNames(consoleB);
    expect((await homes.rename(identityB, "The flat")).ok).toBe(true);
    expect(await clientNames(consoleB)).toEqual(beforeRename);
    expect(log).toEqual([]);
    phone.client.stop();
    phone = phoneOn(memorySecureItems(items.disk));
    phone.client.start();
    homes = homesOf(phone, log, true);
    expect(await until(() => homes.store.getState().homes.length === 2)).toBe(true);
    expect(homes.store.getState()).toMatchObject({
      chosen: identityB,
      homes: [
        { identity: identityA, name: "Home" },
        { identity: identityB, name: "The flat" },
      ],
    });
    expect(await until(sessionOpen(phone))).toBe(true);
  }, 60_000);

  test("removing The flat: push.unregister, client.remove, the record, in order; its hub forgets the phone; Home goes on working", async () => {
    const clientB = await clientAt(phone, identityB);
    expect(await clientIds(consoleB)).toContain(clientB);
    log.length = 0;
    expect(await homes.remove(identityB)).toEqual({ ok: true, value: undefined });
    expect(log).toEqual(["push.unregister", "client.remove", `delete ${identityB}`]);
    expect(await until(async () => !(await clientIds(consoleB)).includes(clientB))).toBe(true);
    expect([...items.disk.keys()].some((k) => k.startsWith(`hub.${identityB}`))).toBe(false);
    // The other home, chosen and working.
    expect(homes.store.getState()).toMatchObject({
      chosen: identityA,
      homes: [{ identity: identityA, name: "Home" }],
    });
    expect(await until(sessionOpen(phone))).toBe(true);
    expect(phone.client.live.getState().session?.client).toBe(await clientAt(phone, identityA));
    const named = await phone.client.request("client.rename", {
      client: await clientAt(phone, identityA),
      name: "Pat's phone, still here",
    });
    expect(named.ok).toBe(true);
    expect(await clientNames(consoleA)).toContain("Pat's phone, still here");
    expect(await clientIds(consoleA)).toContain(await clientAt(phone, identityA));
    phone.client.stop();
  }, 60_000);
});

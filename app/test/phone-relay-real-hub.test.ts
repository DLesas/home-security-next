/**
 * The app's phone client against the real hub and relay executables. Bun supplies the sockets.
 * Away from home, LAN connections are redirected to a refused loopback port; relay sockets
 * use the real local relay. Each process and socket belongs to this test run.
 */
import "./support/render";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseConsoleFragment, SESSION_LIMITS } from "@hsn/protocol/app";
import { createElement } from "react";
import { createStore } from "zustand/vanilla";
import {
  HUB_TEST_ENTRY,
  programTree,
  RelayProgram,
  shortFolder,
} from "../../hub/test/relay/processes";
import { RELEASE_VERSION, writeTestRelease } from "../../hub/test/relay/pushes";
import { endProcesses } from "../../hub/test/world/processes";
import { freePort } from "../../hub/test/world/test-ports";
import { createHubClient, type HubClient } from "../src/hub/client";
import { downloadFile, sendFile, uploadJob } from "../src/hub/files";
import { type MakeSocket, NO_FINDER, readCode } from "../src/hub/finder";
import { type PhoneClient, startPhoneClient } from "../src/hub/phone-client";
import { PHONE_PROTO } from "../src/hub/restore";
import { realTimers } from "../src/hub/wire";
import { memoryRecordStore } from "../src/platform/client-key";
import * as phoneKeys from "../src/platform/keys.native";
import { memorySecureItems } from "../src/platform/vault";
import {
  connectFrom,
  homeAddress,
  type RealHub,
  startRealHub,
  stopAllHubs,
} from "./support/real-hub";
import { phoneRequest } from "../src/pairing/hub";
import { clientScreen, screenAct } from "./support/client-screen";
import { renderWith, screenWorld, textOf } from "./support/screens";

const { PhoneProvider } = await import("../src/ui/phone-parts");
const { SiteScreen } = await import("../src/ui/site");
const { standInPhoneParts } = await import("../src/ui/stand-ins");
const { HubProvider } = await import("../src/ui/hub-context");
const { UpdatesScreen } = await import("../src/ui/updates");
const { VersionTwoProvider } = await import("../src/ui/version-two");

const home = homeAddress();
const clients: HubClient[] = [];
const sockets: WebSocket[] = [];
const homeUrls: string[] = [];
const relayUrls: string[] = [];
const relayCloses: number[] = [];
let root: string | undefined;
let relay: RelayProgram;
let hubA: RealHub;
let consoleA: HubClient;
let refusedPort: number;
let away = false;
let release: ReturnType<typeof writeTestRelease>;
let mountedUpdate: ReturnType<typeof clientScreen> | undefined;

/** Opens the hub LAN socket with Bun's per-connection TLS and Origin options. */
function lanSocket(url: string, origin: string): WebSocket {
  const options = { headers: { Origin: origin }, tls: { rejectUnauthorized: false } };
  return new WebSocket(url, options as unknown as string[]);
}

/** Routes only the phone's home sockets to a refused port while away. */
const homeSocket: MakeSocket = (url, origin) => {
  homeUrls.push(url);
  const target = away ? url.replace(/^wss:\/\/[^/]+/u, `wss://127.0.0.1:${refusedPort}`) : url;
  return lanSocket(target, origin) as unknown as ReturnType<MakeSocket>;
};

/** Polls a process or client condition with an upper bound and a boolean result. */
async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = performance.now() + ms;
  do {
    if (await check()) return true;
    await Bun.sleep(25);
  } while (performance.now() < end);
  return false;
}

/** Opens the real hub's console, using the one-time local console token. */
async function linkConsole(hub: RealHub): Promise<HubClient> {
  const client = createHubClient({
    connect: connectFrom(hub.consoleOrigin),
    records: memoryRecordStore(),
    timers: realTimers,
    app: "0.1.0",
  });
  clients.push(client);
  client.start();
  const url = await hub.consoleCode();
  const token = parseConsoleFragment(url.slice(url.indexOf("#") + 1));
  assert(token !== undefined, "The hub issued a console token.");
  await client.link({ kind: "secret", secret: token, identity: undefined }, "console", {
    name: "The hub computer",
    kind: "web",
  });
  expect(await until(() => client.live.getState().connection.kind === "open")).toBe(true);
  return client;
}

/** Runs a relay operation on the hub's local control socket. */
async function relayOp(hub: RealHub, op: "relay.set" | "relay.status", body: object) {
  const answer = (await hub.control({ kind: "op", op, body })) as {
    reply?: { ok: boolean; result?: { body?: { state?: string } } };
  };
  return answer.reply;
}

/** Configures the relay and waits for the hub's authenticated link. */
async function joinRelay(hub: RealHub): Promise<void> {
  expect((await relayOp(hub, "relay.set", { url: relay.url }))?.ok).toBe(true);
  expect(
    await until(async () => (await relayOp(hub, "relay.status", {}))?.result?.body?.state === "up"),
  ).toBe(true);
}

/** Starts the app's phone client with Bun WebSockets and isolated key storage. */
function startPhone(defaultUrl: string | null, homeAgainMs?: number): PhoneClient {
  const phone = startPhoneClient({
    items: memorySecureItems(),
    makeSocket: homeSocket,
    finder: NO_FINDER,
    timers: realTimers,
    app: "0.1.0",
    proto: PHONE_PROTO,
    keys: phoneKeys,
    relay: {
      make: (url) => {
        relayUrls.push(url);
        const socket = new WebSocket(url);
        socket.addEventListener("close", (event) => relayCloses.push(event.code));
        return socket as unknown as ReturnType<MakeSocket>;
      },
      defaultUrl,
      build: { development: true },
      ...(homeAgainMs === undefined ? {} : { homeAgainMs }),
    },
  });
  clients.push(phone.client);
  phone.client.start();
  return phone;
}

/** Links the phone with the real hub's QR code without exposing the code in assertions. */
async function linkPhone(phone: PhoneClient, name: string): Promise<string> {
  const made = await consoleA.request("link.create", { kind: { newPerson: { name } }, form: "qr" });
  assert(made.ok && made.body.qr !== undefined, "The hub issued a link QR code.");
  const read = readCode(made.body.qr);
  assert(
    read.ok && read.value.kind === "link" && read.value.secret.kind === "secret",
    "Read the link code.",
  );
  expect(read.value.secret.reach?.relay).toBe(relay.url);
  await phone.client.link(read.value.secret, "qr", { name: "Phone", kind: "phone" });
  expect(phone.client.local.getState().link).toEqual({ kind: "linked", from: "qr" });
  assert(read.value.secret.identity !== undefined, "The code names the hub.");
  return read.value.secret.identity;
}

/** Waits for the session to open on the specified path. */
async function expectPath(phone: PhoneClient, path: "home" | "relay", ms?: number): Promise<void> {
  expect(
    await until(
      () =>
        phone.reach.getState().path === path &&
        phone.client.live.getState().connection.kind === "open",
      ms,
    ),
  ).toBe(true);
}

/** Renders This home in English against the current phone state. */
async function thisHome(phone: PhoneClient): Promise<string> {
  const parts = {
    ...standInPhoneParts(phone.client),
    reach: createStore(() => phone.reach.getState()),
  };
  return textOf(
    await renderWith(
      createElement(PhoneProvider, { parts, children: createElement(SiteScreen) }),
      phone.client.live.getState(),
    ),
  );
}

/** Holds a set of sockets open before they send the first handshake message. */
async function holdHandshakes(make: () => WebSocket, count: number): Promise<void> {
  const batch = Array.from({ length: count }, make);
  sockets.push(...batch);
  expect(
    await until(() => batch.every((socket) => socket.readyState !== WebSocket.CONNECTING), 3_000),
  ).toBe(true);
  expect(batch.filter((socket) => socket.readyState === WebSocket.OPEN)).toHaveLength(count);
}

/** Releases the handshakes opened by the current test. */
function releaseHandshakes(): void {
  for (const socket of sockets.splice(0)) socket.close();
}

beforeAll(async () => {
  assert(home !== undefined, "These tests need a home-network IPv4 address.");
  refusedPort = await freePort();
  root = shortFolder("hsn-m5r-");
  const releases = join(root, "releases");
  mkdirSync(releases);
  release = writeTestRelease(releases);
  relay = new RelayProgram(root, {
    pushUrl: `ws+unix://${join(root, "no-push.sock")}:/v1/relay`,
    releases: { folder: releases },
  });
  await relay.start();
  hubA = await startRealHub(undefined, { entry: HUB_TEST_ENTRY, program: programTree(root) });
  consoleA = await linkConsole(hubA);
  await joinRelay(hubA);
}, 45_000);

afterEach(async () => {
  await mountedUpdate?.close();
  mountedUpdate = undefined;
  releaseHandshakes();
  for (const client of clients.splice(1)) client.stop();
  away = false;
  homeUrls.length = 0;
  relayUrls.length = 0;
  relayCloses.length = 0;
});

afterAll(async () => {
  for (const client of clients) client.stop();
  await stopAllHubs();
  await endProcesses();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

test("links and opens a session through the real relay, then moves home on the periodic check", async () => {
  away = true;
  const phone = startPhone(null, 2000);
  const identity = await linkPhone(phone, "Pat");
  await expectPath(phone, "relay");
  expect(homeUrls.some((url) => url.endsWith("/app/link"))).toBe(true);
  expect(relayUrls).toEqual([
    `${relay.url}/v1/phone/${identity}/link`,
    `${relay.url}/v1/phone/${identity}/session`,
  ]);
  expect((await thisHome(phone)).startsWith("Connected through the relay")).toBe(true);
  expect((await phone.client.request("site.set", { countdown: 20 })).ok).toBe(true);
  const record = phone.records.hub(identity);
  const before = await record.read();
  assert(before.ok && before.value !== undefined, "The phone kept its record.");
  expect(before.value.reach?.relayUrl).toBe(relay.url);
  expect(before.value.reach?.addresses).toContain(home);
  expect(before.value.reach?.lastAddress).toBeNull();

  away = false;
  await expectPath(phone, "home");
  expect((await thisHome(phone)).startsWith("Connected at home")).toBe(true);
  expect((await phone.client.request("site.set", { countdown: 21 })).ok).toBe(true);
  const after = await record.read();
  expect(after.ok && after.value?.lastSeq).toBe(before.value.lastSeq + 1);
  expect(after.ok && after.value?.reach?.lastAddress).toBe(home);
}, 45_000);

test("the real hub's 1013 and the real relay's 4429 each show the busy words, then retry", async () => {
  const phone = startPhone(null);
  const identity = await linkPhone(phone, "Alex");
  await expectPath(phone, "home");
  phone.client.stop();
  away = true;

  const origin = hubA.lanOrigin;
  assert(origin !== undefined, "The hub has a LAN listener.");
  const lan = () => lanSocket(`${origin.replace(/^https/u, "wss")}/app`, origin);
  // Stay within the hub's per-address rate while filling its handshake slots.
  const half = SESSION_LIMITS.maxOpenHandshakes / 2;
  await Bun.sleep(1050);
  await holdHandshakes(lan, half);
  await Bun.sleep(1050);
  await holdHandshakes(lan, half);
  phone.client.start();
  expect(await until(() => relayCloses.includes(1013), 4_000)).toBe(true);
  expect((await thisHome(phone)).startsWith("The relay is busy. Trying again.")).toBe(true);
  releaseHandshakes();
  await expectPath(phone, "relay");

  phone.client.stop();
  const url = `${relay.url}/v1/phone/${identity}/session`;
  // Close events above are asynchronous; leave time for the app's old stream to be freed.
  await Bun.sleep(1050);
  await holdHandshakes(() => new WebSocket(url), 8);
  phone.client.start();
  expect(await until(() => relayCloses.includes(4429), 4_000)).toBe(true);
  expect((await thisHome(phone)).startsWith("The relay is busy. Trying again.")).toBe(true);
  releaseHandshakes();
  await expectPath(phone, "relay");
}, 45_000);

test("real relay 4404 shows the hub is disconnected, and the phone opens when it returns", async () => {
  const phone = startPhone(null);
  await linkPhone(phone, "Sam");
  await expectPath(phone, "home");
  phone.client.stop();
  away = true;

  expect((await relayOp(hubA, "relay.set", { url: null }))?.ok).toBe(true);
  phone.client.start();
  expect(await until(() => relayCloses.includes(4404))).toBe(true);
  expect(phone.client.live.getState().connection).toMatchObject({
    kind: "waiting",
    failure: "unreachable",
    mayBeRemoved: false,
  });
  expect(
    (await thisHome(phone)).startsWith("The hub is not connected to the internet relay."),
  ).toBe(true);
  await joinRelay(hubA);
  await expectPath(phone, "relay");
}, 45_000);

test("the app reads the real relay status, downloads its offer and shows it ready to approve", async () => {
  away = true;
  const phone = startPhone(null);
  await linkPhone(phone, "Lee");
  await expectPath(phone, "relay");
  const relayStatus = await phoneRequest(phone, "relay.status", {});
  expect(relayStatus).toMatchObject({ ok: true, value: { state: "up", url: relay.url } });
  expect(
    await until(async () => {
      const offer = await phoneRequest(phone, "update.offers", {});
      return offer.ok && offer.value.offer?.version === RELEASE_VERSION;
    }, 10_000),
  ).toBe(true);

  const world = await screenWorld({});
  const screen = clientScreen();
  mountedUpdate = screen;
  await screen.render(
    world.wrap(
      createElement(HubProvider, {
        client: phone.client,
        children: createElement(VersionTwoProvider, {
          client: { forward: phone.forward, testAlert: true },
          children: createElement(UpdatesScreen),
        }),
      }),
    ),
  );
  /** Waits for a real hub reply and its React render, with a bounded assertion on the text. */
  async function visible(words: string) {
    const untilMs = performance.now() + 15_000;
    while (!textOf(screen.html()).includes(words) && performance.now() < untilMs) {
      await screenAct(() => Bun.sleep(25));
    }
    expect(textOf(screen.html())).toContain(words);
  }
  await visible(
    `Version ${RELEASE_VERSION} is available (${release.size.toLocaleString("en")} bytes).`,
  );
  expect(await screen.press("Download")).toBe(true);
  await visible(`Version ${RELEASE_VERSION} is ready.`);
  expect(screen.html()).toContain(`aria-label="Approve version ${RELEASE_VERSION}"`);
  const status = await phone.client.request("update.status", {});
  expect(status).toMatchObject({ ok: true, body: { staged: RELEASE_VERSION, approvedBy: null } });
}, 45_000);

test("restores a second real hub through the relay, then reaches the restored hub by relay and at home on resume", async () => {
  // The real hub emits no r= in a restore code, so configure this test's deployment relay.
  const phone = startPhone(relay.url);
  const identity = await linkPhone(phone, "Rae");
  await expectPath(phone, "home");
  const file = await downloadFile(consoleA, false, realTimers);
  assert(file.ok && "bytes" in file, "The console downloaded the backup.");

  const hubB = await startRealHub();
  const consoleB = await linkConsole(hubB);
  await joinRelay(hubB);
  const job = uploadJob();
  expect((await sendFile(consoleB, job, file.bytes)).ok).toBe(true);
  const started = await consoleB.request("restore.start", { job });
  assert(started.ok, "The new hub accepted the backup.");
  const read = readCode(started.body.qr);
  assert(read.ok && read.value.kind === "restore", "Read the restore code.");
  const code = read.value.restore;

  phone.client.stop();
  await hubA.stop();
  away = true;
  let offered: string | undefined;
  const restored = await phone.restore(code, (offer) => {
    offered = offer.identity;
  });
  expect(restored.ok).toBe(true);
  expect(offered).toBe(identity);
  expect(homeUrls.some((url) => url.endsWith("/app/restore"))).toBe(true);
  expect(relayUrls).toContain(`${relay.url}/v1/phone/${code.identity}/restore`);

  await hubB.stop();
  await hubB.start();
  await expectPath(phone, "relay", 35_000);
  expect(relayUrls).toContain(`${relay.url}/v1/phone/${identity}/session`);
  expect((await phone.client.request("site.set", { countdown: 45 })).ok).toBe(true);
  const record = await phone.records.hub(identity).read();
  expect(record.ok && record.value?.reach?.appsPort).toBe(hubB.lanPort);
  expect(record.ok && (record.value?.lastSeq ?? 0) > 2 ** 32).toBe(true);

  away = false;
  phone.resume();
  await expectPath(phone, "home");
  expect((await thisHome(phone)).startsWith("Connected at home")).toBe(true);
}, 100_000);

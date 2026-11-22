/**
 * The flow a phone at channel version 2 could not complete before the hub spoke version 2 in full
 * (H1, for P2): the phone's own client code (`startPhoneClient`, as the app builds it, at
 * `PHONE_PROTO`, version 2 only) against the real hub as a process (`support/real-hub.ts`), at
 * this computer's home-network address, with the hub's own certificate: linked by a QR code, its
 * session agrees version 2, its snapshot passes version 2's strict schema (it closed there before,
 * missing `hub.addresses`, `appsPort`, `relay`, `push`, `backupKeyEpoch` and `happenedAtMs`), it
 * makes a change and receives the change's event, and `hub.info` names the addresses it keeps.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hubInfoV2, parseConsoleFragment } from "@hsn/protocol/app";
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
import { memoryRecordStore } from "../src/platform/client-key";
import * as phoneKeys from "../src/platform/keys.native";
import { memorySecureItems } from "../src/platform/vault";
import { realTimers } from "../src/hub/wire";
import { phoneRequest } from "../src/pairing/hub";
import {
  connectFrom,
  homeAddress,
  type RealHub,
  startRealHub,
  stopAllHubs,
} from "./support/real-hub";

const bunSocket: MakeSocket = (url, origin) => {
  const options = { headers: { Origin: origin }, tls: { rejectUnauthorized: false } };
  return new WebSocket(url, options as unknown as string[]) as unknown as SocketLike;
};

const HOME = homeAddress();
let hub: RealHub;
let console0: HubClient;

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

beforeAll(async () => {
  if (HOME === undefined) throw new Error("these tests need this computer on a home network");
  hub = await startRealHub();
  console0 = createHubClient({
    connect: connectFrom(hub.consoleOrigin),
    records: memoryRecordStore(),
    timers: realTimers,
    app: "0.1.0",
  });
  console0.start();
  const url = await hub.consoleCode();
  const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1));
  if (secret === undefined) throw new Error("no console code");
  await console0.link({ kind: "secret", secret, identity: undefined }, "console", {
    name: "The hub computer",
    kind: "web",
  });
  if (!(await until(() => console0.live.getState().connection.kind === "open")))
    throw new Error("console not open");
}, 60_000);

afterAll(async () => {
  await stopAllHubs();
});

async function qrCode(name: string): Promise<PhoneLinkSecret> {
  const made = await console0.request("link.create", { kind: { newPerson: { name } }, form: "qr" });
  if (!made.ok || made.body.qr === undefined) throw new Error(JSON.stringify(made));
  const read = readCode(made.body.qr);
  if (!read.ok || read.value.kind !== "link") throw new Error("not a link code");
  return read.value.secret;
}

describe("a phone at version 2 against the real hub", () => {
  let phone: PhoneClient;

  test("links, agrees version 2, and keeps its session past the snapshot", async () => {
    expect(PHONE_PROTO).toEqual([2, 2]);
    phone = startPhoneClient({
      items: memorySecureItems(),
      makeSocket: bunSocket,
      finder: NO_FINDER,
      timers: realTimers,
      app: "0.1.0",
      proto: PHONE_PROTO,
      keys: phoneKeys,
    });
    phone.client.start();
    await phone.client.link(await qrCode("Pat"), "qr", { name: "Pat's phone", kind: "phone" });
    expect(phone.client.local.getState().link.kind).toBe("linked");
    expect(await until(() => phone.client.live.getState().connection.kind === "open")).toBe(true);
    // Still open a moment later: the snapshot was taken (before, a strict client closed here).
    await Bun.sleep(300);
    const live = phone.client.live.getState();
    expect(live.connection.kind).toBe("open");
    expect(live.rev).not.toBeNull();
    expect(live.session?.kind).toBe("phone");
  }, 30_000);

  test("hub.info names the home addresses and the apps' port, as version 2 has it", async () => {
    const info = await phone.client.request("hub.info", {});
    if (!info.ok) throw new Error(JSON.stringify(info));
    const parsed = hubInfoV2.safeParse(info.body);
    expect(parsed.success ? "ok" : JSON.stringify(parsed.error.issues)).toBe("ok");
    const body = info.body as unknown as { addresses: string[]; appsPort: number; proto: number };
    expect(body.proto).toBe(2);
    expect(body.appsPort).toBe(hub.lanPort);
    expect(body.addresses).toContain(HOME ?? "");
    expect(body.addresses.some((a) => a.toLowerCase().startsWith("fe80"))).toBe(false);
  }, 30_000);

  test("the shared hub client exposes the phone's version 2 channel", async () => {
    const v2 = phone.client.v2 ?? expect.unreachable();
    expect(v2.forward).toBe(phone.forward);
    expect(v2.onNewEvent).toBe(phone.onNewEvent);
    expect(await phoneRequest(v2, "firmware.list", {})).toEqual({
      ok: true,
      value: { images: [], devices: [] },
    });
  }, 20_000);

  test("makes a change and receives its event", async () => {
    const events: string[] = [];
    const off = phone.client.onEvent((event) => {
      events.push(event.ev);
    });
    const subscribed = await phone.client.request("subscribe", { topics: ["config", "people"] });
    expect(subscribed.ok).toBe(true);
    const made = await phone.client.request("group.create", {
      name: "Upstairs",
      sensors: [],
      sirens: "all",
    });
    expect(made.ok ? "ok" : JSON.stringify(made)).toBe("ok");
    expect(await until(() => events.includes("config"))).toBe(true);
    expect(phone.client.live.getState().connection.kind).toBe("open");
    off();
  }, 30_000);
});

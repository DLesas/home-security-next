/**
 * A typed link code with no address, linking a phone through `hub-net`'s finder, against the real
 * hub (`support/real-hub.ts`, at this computer's home-network address, over `wss://` with the
 * hub's own certificate): the case that works only when the person also types the address while
 * the browse is `NO_FINDER`. The native browse is stood in for here, and reports what the hub's
 * mDNS record says (`hub/src/shell/advertise/mdns.ts`: `id`, `app`, `aid`, as TXT bytes); the
 * simulators show the real browse (P1's report). A second hub's record, at an address where no hub
 * answers, is found first, so the phone tries each found hub in turn, as a typed code names none.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseConsoleFragment } from "@hsn/protocol/app";
import { hubNetOver } from "../modules/hub-net/src/finder";
import type { HubNetNative } from "../modules/hub-net/src/contract";
import { createHubClient, type HubClient } from "../src/hub/client";
import { type MakeSocket, readTypedCode, type SocketLike } from "../src/hub/finder";
import { startPhoneClient } from "../src/hub/phone-client";
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

/** Bun's WebSocket as the phone opens one: the `Origin` it sends, the hub's certificate taken. */
const bunSocket: MakeSocket = (url, origin) => {
  const options = { headers: { Origin: origin }, tls: { rejectUnauthorized: false } };
  return new WebSocket(url, options as unknown as string[]) as unknown as SocketLike;
};

const HOME = homeAddress();
let hub: RealHub;
let console_: HubClient;

const ascii = (text: string) => [...new TextEncoder().encode(text)];
const wire = (...strings: readonly string[]) =>
  strings.flatMap((s) => [ascii(s).length, ...ascii(s)]);

async function until(check: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

/**
 * The native browse, stood in for: once started, it reports a decoy hub (another app identity,
 * where nothing listens) and then the real hub's record, as the system's resolve would.
 */
function browseFinding(identity: string, port: number): { native: HubNetNative; starts: number[] } {
  const listeners = new Set<(event: unknown) => void>();
  const starts: number[] = [];
  const service = (session: number, name: string, address: string, app: string, aid: string) => ({
    kind: "service",
    session,
    name,
    port: 1,
    addresses: [address],
    txt: { raw: wire("id=00112233445566ff", `app=${app}`, `aid=${aid}`) },
  });
  const native: HubNetNative = {
    start: (_type, session) => {
      starts.push(session);
      setTimeout(() => {
        for (const l of [...listeners]) {
          l(service(session, "hsn-decoy", "127.0.0.1", "9", "aaaaaaaaaaaaaaaaaaaaaaaaaa"));
          l(service(session, "hsn-real", HOME ?? "", String(port), identity));
        }
      }, 50);
      return Promise.resolve({ started: true });
    },
    stop: () => Promise.resolve(null),
    permission: () => Promise.resolve({ state: "granted", canAskAgain: true }),
    ask: () => Promise.resolve({ state: "granted", canAskAgain: true }),
    listen: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return { native, starts };
}

beforeAll(async () => {
  if (HOME === undefined) throw new Error("this test needs this computer on a home network");
  hub = await startRealHub();
  console_ = createHubClient({
    connect: connectFrom(hub.consoleOrigin),
    records: memoryRecordStore(),
    timers: realTimers,
    app: "0.1.0",
  });
  console_.start();
  const url = await hub.consoleCode();
  const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1));
  if (secret === undefined) throw new Error("no console code");
  await console_.link({ kind: "secret", secret, identity: undefined }, "console", {
    name: "The hub computer",
    kind: "web",
  });
  if (!(await until(() => console_.live.getState().connection.kind === "open")))
    throw new Error("console not open");
}, 60_000);

afterAll(async () => {
  console_.stop();
  await stopAllHubs();
});

describe("a typed code with no address, through hub-net's finder", () => {
  test("the browse finds the hub by its record, and the phone links (version 2, as built)", async () => {
    const info = await console_.request("hub.info", {});
    if (!info.ok) throw new Error(JSON.stringify(info));
    const identity = (info.body as { identity?: unknown }).identity;
    if (typeof identity !== "string") throw new Error("no identity");
    const made = await console_.request("link.create", {
      kind: { newPerson: { name: "Ty" } },
      form: "code",
    });
    if (!made.ok || made.body.code === undefined) throw new Error(JSON.stringify(made));
    const typed = readTypedCode(made.body.code);
    if (!typed.ok) throw new Error(typed.fault);
    expect("reach" in typed.value).toBe(false);

    const browse = browseFinding(identity, hub.lanPort);
    const net = hubNetOver(browse.native, realTimers);
    const phone = startPhoneClient({
      items: memorySecureItems(),
      makeSocket: bunSocket,
      finder: net.finder,
      timers: realTimers,
      app: "0.1.0",
      proto: PHONE_PROTO,
      keys: phoneKeys,
    });
    phone.client.start();
    await phone.client.link(typed.value, "typed", { name: "Ty's phone", kind: "phone" });
    expect(phone.client.local.getState().link).toEqual({ kind: "linked", from: "typed" });
    expect(browse.starts.length).toBeGreaterThanOrEqual(1);
    // The path and the relay's last close are the session's (relay-path tests), not the browse's.
    expect(phone.reach.getState()).toMatchObject({ localNetworkDenied: false, browse: null });
    // The record the browse read, and the address the phone now keeps for this hub.
    const list = await phone.records.list();
    expect(list.ok && list.value).toEqual([identity]);
    const record = await phone.records.hub(identity).read();
    expect(record.ok && record.value?.reach?.lastAddress).toBe(HOME);
    expect(record.ok && record.value?.reach?.appsPort).toBe(hub.lanPort);
    expect(net.diagnostics()).toMatchObject({ browsing: false, found: 2 });
    phone.client.stop();
  }, 45_000);
});

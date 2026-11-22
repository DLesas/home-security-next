/**
 * The phone away from home (`src/hub/relay.ts`, `src/hub/phone-client.ts`; m3-design.md section
 * 6, "Home or relay"; m4-design.md section 3, "Phones"), against a scripted hub at version 2
 * (`support/hub-end.ts`) and a scripted relay (`support/relay-sockets.ts`), with timers the tests
 * move: which relay, which URLs the phone may open, the socket, its closes in words, the order (home
 * first, the relay last) for a session, a link and a restore, coming home again every 60 s and when
 * the app comes to the front, and the one line under This home. `phone-relay-real-hub.test.ts`
 * runs the same client against the real hub and the real relay as processes.
 */
import "./support/render";
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import assert from "node:assert/strict";
import { formatLinkQr } from "@hsn/protocol/app";
import { PHONE_CLOSE, PHONE_CLOSE_FROM_HUB } from "@hsn/protocol/relay";
import { createStore } from "zustand/vanilla";
import { NO_FINDER, type PhoneLinkSecret, readCode, readTypedCode } from "../src/hub/finder";
import {
  HOME_AGAIN_MS,
  NO_REACH,
  type ReachState,
  startPhoneClient,
} from "../src/hub/phone-client";
import {
  homeThenRelay,
  isRelayOwnClose,
  RELAY_OPEN_MS,
  relayClosedOf,
  relayConnect,
  relayUrlAllowed,
  relayUrlFor,
} from "../src/hub/relay";
import { PHONE_PROTO } from "../src/hub/restore";
import type { SocketLike } from "../src/hub/finder";
import type { Connect, Wire } from "../src/hub/wire";
import * as phoneKeys from "../src/platform/keys.native";
import { memorySecureItems } from "../src/platform/vault";
import type { PhoneParts } from "../src/ui/phone-parts";
import type { HubFinder } from "../src/platform/finder";
import { HubEnd } from "./support/hub-end";
import { phoneSockets } from "./support/phone-sockets";
import { relaySockets, type RelayBehaviour } from "./support/relay-sockets";
import { renderWith, textOf } from "./support/screens";
import { manualTimers, settle } from "./support/timers";

const { PhoneProvider } = await import("../src/ui/phone-parts");
const { standInPhoneParts } = await import("../src/ui/stand-ins");
const site = await import("../src/ui/site");
const HomeRoute = (await import("../src/app/index")).default;

const HOME = "192.168.1.20";
const DISCOVERED_HOME = "192.168.1.21";
const RELAY = "wss://relay.example.test";
const KEY = (n: number) => new Uint8Array(32).fill(n);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const DEV = { development: true };
const RELEASE = { development: false };

/** Fails with an assertion if a promise under the manual clock stops settling. */
async function finish<T>(pending: Promise<T>): Promise<T> {
  let cancel: (() => void) | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    cancel = () => {
      clearTimeout(timeout);
    };
  });
  const result = await Promise.race([pending.then((value) => ({ value })), deadline]);
  cancel?.();
  assert(result !== undefined, "The operation settled with the manual clock advanced.");
  return result.value;
}

// ----- relay.ts's rules -----

describe("which relay (RD 3)", () => {
  test("the hub's or the code's, else the deployment's default, else none", () => {
    expect(relayUrlFor("wss://mine.test", "wss://default.test")).toBe("wss://mine.test");
    expect(relayUrlFor(null, "wss://default.test")).toBe("wss://default.test");
    expect(relayUrlFor(undefined, "wss://default.test")).toBe("wss://default.test");
    expect(relayUrlFor("", "wss://default.test")).toBe("wss://default.test");
    // The placeholder domain gives no default (`defaultRelayUrl`): no away path at all.
    expect(relayUrlFor(null, null)).toBeUndefined();
    expect(relayUrlFor("wss://mine.test", null)).toBe("wss://mine.test");
  });
});

describe("which relay URLs the phone opens (m3-design.md sections 2 and 6)", () => {
  test("wss:// to any host, in any build", () => {
    for (const build of [DEV, RELEASE]) {
      expect(relayUrlAllowed("wss://relay.example.test", build)).toBe(true);
      expect(relayUrlAllowed("WSS://relay.example.test:8443", build)).toBe(true);
      expect(relayUrlAllowed("wss://relay.example.test/base", build)).toBe(true);
      expect(relayUrlAllowed("wss://[2001:db8::1]:443", build)).toBe(true);
    }
  });

  test("ws:// only in a development build, and only to a loopback or private address", () => {
    for (const url of [
      "ws://127.0.0.1:8080",
      "ws://localhost:8080",
      "ws://10.0.0.5",
      "ws://172.16.0.1",
      "ws://172.31.255.255",
      "ws://192.168.1.9:9000",
      "ws://[::1]:8080",
      "ws://[fd00::5]",
    ]) {
      expect([url, relayUrlAllowed(url, DEV)]).toEqual([url, true]);
      expect([url, relayUrlAllowed(url, RELEASE)]).toEqual([url, false]);
    }
    for (const url of [
      "ws://relay.example.test",
      "ws://8.8.8.8",
      "ws://172.15.0.1",
      "ws://172.32.0.1",
      "ws://169.254.1.1",
      "ws://hub.local",
      "ws://[2001:db8::1]",
    ])
      expect([url, relayUrlAllowed(url, DEV)]).toEqual([url, false]);
  });

  test("anything that is not a relay's base URL is refused", () => {
    for (const url of [
      "https://relay.example.test",
      "http://127.0.0.1",
      "wss://relay.example.test?x=1",
      "wss://relay.example.test#f",
      "wss://user@relay.example.test",
      "wss://",
      "relay.example.test",
      "",
    ])
      expect([url, relayUrlAllowed(url, DEV)]).toEqual([url, false]);
  });
});

describe("the relay's closes (m4-design.md section 3)", () => {
  test("4404 is the hub not connected; 1013 and 4429 the relay busy; nothing else has words", () => {
    expect(relayClosedOf(4404)).toBe("notConnected");
    expect(relayClosedOf(1013)).toBe("busy");
    expect(relayClosedOf(4429)).toBe("busy");
    for (const code of [1000, 1001, 1003, 1006, 1008, 1009, 1012, 1014, 4000, 4002, 4003, 4004])
      expect([code, relayClosedOf(code)]).toEqual([code, undefined]);
    for (const code of [4400, 4403, 4405, 4410, 4428, 4430])
      expect([code, relayClosedOf(code)]).toEqual([code, undefined]);
  });

  test("the relay's own closes are told apart from the hub's, which pass through as at home", () => {
    for (const code of [1001, 1003, 1009, 1013, 4400, 4404, 4410, 4429])
      expect([code, isRelayOwnClose(code)]).toEqual([code, true]);
    for (const code of PHONE_CLOSE_FROM_HUB)
      expect([code, isRelayOwnClose(code)]).toEqual([code, false]);
    for (const code of [1006, 1011, 4005, 4401]) expect(isRelayOwnClose(code)).toBe(false);
    expect(Object.values(PHONE_CLOSE).every((code) => isRelayOwnClose(code))).toBe(true);
  });
});

// ----- The socket -----

/** A socket the test drives: it opens, sends, closes when told. */
function fakeSocket() {
  const sent: Uint8Array[] = [];
  const closes: (number | undefined)[] = [];
  const socket: SocketLike = {
    binaryType: "blob",
    readyState: 0,
    send: (data) => sent.push(data),
    close: (code) => closes.push(code),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const open = () => {
    (socket as { readyState: number }).readyState = 1;
    socket.onopen?.({});
  };
  return { socket, sent, closes, open };
}

const IDENTITY = new HubEnd().identity;

describe("the relay's Connect", () => {
  const made: string[] = [];
  const handlers = () => {
    const got: { messages: number[][]; closed: number[] } = { messages: [], closed: [] };
    return {
      got,
      handlers: {
        message: (data: Uint8Array) => got.messages.push([...data]),
        closed: (code: number) => got.closed.push(code),
      },
    };
  };

  test("refuses a URL the phone may not open, before any socket", () => {
    const connect = relayConnect(
      (url) => {
        made.push(url);
        return fakeSocket().socket;
      },
      manualTimers(),
      RELEASE,
    );
    expect(connect({ relayUrl: "ws://127.0.0.1:9", identity: IDENTITY })).toEqual({
      ok: false,
      fault: "notSecure",
    });
    expect(made).toEqual([]);
  });

  test("opens <relay>/v1/phone/<identity>/<path>; the Wire carries binary messages both ways; a text message closes it", async () => {
    const urls: string[] = [];
    const fake = fakeSocket();
    const timers = manualTimers();
    const closes: number[] = [];
    const made = relayConnect(
      (url) => {
        urls.push(url);
        return fake.socket;
      },
      timers,
      RELEASE,
      { closed: (code) => closes.push(code) },
    )({ relayUrl: `${RELAY}/base/`, identity: IDENTITY });
    assert(made.ok, "The relay URL is accepted.");
    const { got, handlers: h } = handlers();
    const pending = made.value("link", h);
    fake.open();
    const wire = await finish(pending);
    expect(urls).toEqual([`${RELAY}/base/v1/phone/${IDENTITY}/link`]);
    expect(fake.socket.binaryType).toBe("arraybuffer");
    wire?.send(Uint8Array.of(1, 2, 3));
    expect(fake.sent.map((d) => [...d])).toEqual([[1, 2, 3]]);
    fake.socket.onmessage?.({ data: Uint8Array.of(9, 8).buffer });
    expect(got.messages).toEqual([[9, 8]]);
    fake.socket.onmessage?.({ data: "text" });
    expect(fake.closes).toEqual([4002]);
    fake.socket.onclose?.({ code: 4410 });
    expect(got.closed).toEqual([4410]);
    expect(closes).toEqual([4410]);
    // One close only, whatever comes after.
    fake.socket.onclose?.({ code: 1000 });
    expect(got.closed).toEqual([4410]);
  });

  test("each path names its own handshake", async () => {
    const urls: string[] = [];
    const connect = relayConnect(
      (url) => {
        urls.push(url);
        const fake = fakeSocket();
        setTimeout(fake.open, 0);
        return fake.socket;
      },
      manualTimers(),
      RELEASE,
    )({ relayUrl: RELAY, identity: IDENTITY });
    assert(connect.ok, "The relay URL is accepted.");
    for (const path of ["session", "link", "restore"] as const)
      expect(await finish(connect.value(path, handlers().handlers))).toBeDefined();
    expect(urls).toEqual(
      ["session", "link", "restore"].map((p) => `${RELAY}/v1/phone/${IDENTITY}/${p}`),
    );
  });

  test("closed before it opens: undefined, and the code told; one that throws, or a bad identity: undefined", async () => {
    const fake = fakeSocket();
    const closes: number[] = [];
    const made = relayConnect(() => fake.socket, manualTimers(), RELEASE, {
      closed: (code) => closes.push(code),
    })({ relayUrl: RELAY, identity: IDENTITY });
    assert(made.ok, "The relay URL is accepted.");
    const pending = made.value("session", handlers().handlers);
    fake.socket.onclose?.({ code: 1006 });
    expect(await finish(pending)).toBeUndefined();
    expect(closes).toEqual([1006]);

    const throws = relayConnect(
      () => new WebSocket("not a URL") as unknown as SocketLike,
      manualTimers(),
      RELEASE,
    )({ relayUrl: RELAY, identity: IDENTITY });
    assert(throws.ok, "The relay URL is accepted.");
    expect(await finish(throws.value("session", handlers().handlers))).toBeUndefined();

    const urls: string[] = [];
    const bad = relayConnect(
      (url) => {
        urls.push(url);
        return fakeSocket().socket;
      },
      manualTimers(),
      RELEASE,
    )({ relayUrl: RELAY, identity: "NOT-AN-IDENTITY" });
    assert(bad.ok, "The relay URL is accepted.");
    expect(await finish(bad.value("session", handlers().handlers))).toBeUndefined();
    expect(urls).toEqual([]);
  });

  test("a socket that does not open is given RELAY_OPEN_MS exactly; one that opens later is closed", async () => {
    expect(RELAY_OPEN_MS).toBe(10_000);
    const fake = fakeSocket();
    const timers = manualTimers();
    const made = relayConnect(
      () => fake.socket,
      timers,
      RELEASE,
    )({
      relayUrl: RELAY,
      identity: IDENTITY,
    });
    assert(made.ok, "The relay URL is accepted.");
    let result: Wire | undefined | "pending" = "pending";
    void made.value("session", handlers().handlers).then((wire) => {
      result = wire;
    });
    timers.advance(RELAY_OPEN_MS - 1);
    await settle();
    expect(result).toBe("pending");
    timers.advance(1);
    await settle();
    expect(result).toBeUndefined();
    expect(fake.closes).toEqual([undefined]);
    fake.open();
    expect(fake.closes).toEqual([undefined, 1000]);
  });
});

describe("home first, the relay last", () => {
  const wire: Wire = { send: () => undefined, close: () => undefined };
  const noHandlers = { message: () => undefined, closed: () => undefined };

  test("home answers: the relay is not tried; home does not: the relay; neither, or no relay: undefined", async () => {
    const tried: string[] = [];
    const used: string[] = [];
    const answer =
      (name: string, gives: Wire | undefined): Connect =>
      () => {
        tried.push(name);
        return Promise.resolve(gives);
      };
    const both = homeThenRelay(
      answer("home", wire),
      () => answer("relay", wire),
      (p) => used.push(p),
    );
    expect(await both("session", noHandlers)).toBe(wire);
    expect([tried.splice(0), used.splice(0)]).toEqual([["home"], ["home"]]);
    const away = homeThenRelay(
      answer("home", undefined),
      () => answer("relay", wire),
      (p) => used.push(p),
    );
    expect(await away("session", noHandlers)).toBe(wire);
    expect([tried.splice(0), used.splice(0)]).toEqual([["home", "relay"], ["relay"]]);
    const neither = homeThenRelay(
      answer("home", undefined),
      () => answer("relay", undefined),
      (p) => used.push(p),
    );
    expect(await neither("session", noHandlers)).toBeUndefined();
    expect([tried.splice(0), used.splice(0)]).toEqual([["home", "relay"], []]);
    const none = homeThenRelay(answer("home", undefined), () => undefined);
    expect(await none("session", noHandlers)).toBeUndefined();
    expect(tried.splice(0)).toEqual(["home"]);
  });
});

// ----- The phone's client -----

interface Setup {
  readonly defaultUrl?: string | null;
  readonly build?: { readonly development: boolean };
  readonly relay?: RelayBehaviour;
  readonly hubRelay?: string;
  readonly noRelay?: boolean;
  readonly finder?: HubFinder;
}

function world(setup: Setup = {}) {
  const hub = new HubEnd();
  hub.speaks = [1, 2];
  hub.backupKey = { key: b64(KEY(3)), epoch: 3 };
  hub.v2 = {
    addresses: [HOME],
    appsPort: 8444,
    backupKeyEpoch: 3,
    ...(setup.hubRelay === undefined ? {} : { relay: setup.hubRelay }),
  };
  hub.handle("site.set", () => ({ ok: true, body: hub.snapshot.site }));
  const homes = new Map<string, HubEnd>([[HOME, hub]]);
  const sockets = phoneSockets(homes);
  const relay = relaySockets(hub, setup.relay);
  const timers = manualTimers();
  const phone = startPhoneClient({
    items: memorySecureItems(),
    makeSocket: sockets.make,
    finder: setup.finder ?? NO_FINDER,
    timers,
    app: "0.1.0",
    proto: PHONE_PROTO,
    keys: phoneKeys,
    ...(setup.noRelay === true
      ? {}
      : {
          relay: {
            make: relay.make,
            defaultUrl: setup.defaultUrl === undefined ? null : setup.defaultUrl,
            build: setup.build ?? RELEASE,
          },
        }),
  });
  const statuses: string[] = [];
  phone.client.live.subscribe((state) => {
    const c = state.connection;
    statuses.push(c.kind === "waiting" ? `waiting:${c.failure}` : c.kind);
  });
  /** The phone leaves home: no address there answers. */
  const leave = () => homes.delete(HOME);
  const comeHome = () => homes.set(HOME, hub);
  /**
   * Moves time on in steps, letting the sockets and awaits run between them; the hub pings its
   * sessions at each step, as the real one does every 20 s, so a live session is never closed for
   * silence.
   */
  const pass = async (ms: number, step = 500) => {
    for (let gone = 0; gone < ms; gone += step) {
      timers.advance(Math.min(step, ms - gone));
      await settle(40);
      hub.emit("ping", {});
      await settle(10);
    }
  };
  return {
    hub,
    homes,
    sockets,
    relay,
    timers,
    phone,
    client: phone.client,
    statuses,
    leave,
    comeHome,
    pass,
  };
}

function qrFor(
  hub: HubEnd,
  relay?: string,
  addresses: readonly string[] = [HOME],
): PhoneLinkSecret {
  const secret = hub.tokenWithSecret("newPerson", null, "Ana");
  const read = readCode(
    formatLinkQr({
      identity: hub.identity,
      secret,
      addresses,
      port: 8444,
      fingerprint: KEY(1),
      ...(relay === undefined ? {} : { relay }),
    }),
  );
  assert(read.ok && read.value.kind === "link", "Read the link code.");
  return read.value.secret;
}

type World = ReturnType<typeof world>;

async function linkAtHome(w: World, relay?: string): Promise<void> {
  w.client.start();
  await settle();
  await finish(w.client.link(qrFor(w.hub, relay), "qr", { name: "Ana's phone", kind: "phone" }));
  await settle(60);
  expect(w.client.live.getState().connection.kind).toBe("open");
}

/**
 * The phone away: home's session dropped; the client reconnects after its first wait (1 s), finds
 * no home address answering, and goes on to the relay, all at the same moment of the test's clock.
 */
async function goAway(w: World): Promise<void> {
  w.leave();
  w.hub.dropAll();
  await settle(40);
  w.timers.advance(1000);
  await settle(80);
}

const relayPaths = (w: World) => w.relay.opened.map((s) => s.url);
const record = async (w: World) => {
  const read = await w.phone.records.hub(w.hub.identity).read();
  assert(read.ok && read.value !== undefined, "The phone kept its record.");
  return read.value;
};

describe("a session away from home", () => {
  test("home does not answer: through the relay the hub names in hub.info, at /v1/phone/<identity>/session; at home, the relay is never tried", async () => {
    const w = world({ hubRelay: RELAY, defaultUrl: "wss://default.test" });
    await linkAtHome(w, "wss://from-the-code.test");
    expect(w.phone.reach.getState().path).toBe("home");
    expect(relayPaths(w)).toEqual([]);
    expect((await record(w)).reach?.relayUrl).toBe(RELAY);
    await goAway(w);
    expect(w.client.live.getState().connection.kind).toBe("open");
    expect(relayPaths(w)).toEqual([`${RELAY}/v1/phone/${w.hub.identity}/session`]);
    expect(w.phone.reach.getState()).toEqual({ ...NO_REACH, path: "relay" });
    // The same session as at home: changes go on, numbered after the last.
    const before = (await record(w)).lastSeq;
    const made = await finish(w.client.request("site.set", { countdown: 20 }));
    expect(made.ok).toBe(true);
    expect((await record(w)).lastSeq).toBe(before + 1);
  });

  test("no hub.info relay: the code's r=; neither: the deployment's default", async () => {
    const coded = world({ defaultUrl: "wss://default.test" });
    await linkAtHome(coded, "wss://from-the-code.test");
    await goAway(coded);
    expect(relayPaths(coded)).toEqual([
      `wss://from-the-code.test/v1/phone/${coded.hub.identity}/session`,
    ]);
    const plain = world({ defaultUrl: "wss://default.test" });
    await linkAtHome(plain);
    await goAway(plain);
    expect(relayPaths(plain)).toEqual([
      `wss://default.test/v1/phone/${plain.hub.identity}/session`,
    ]);
    expect(plain.phone.reach.getState().path).toBe("relay");
  });

  test("no relay named and the deployment's domain the placeholder: no away path, nothing opened", async () => {
    const w = world({ defaultUrl: null });
    await linkAtHome(w);
    await goAway(w);
    expect(relayPaths(w)).toEqual([]);
    expect(w.statuses).toContain("waiting:unreachable");
    expect(w.phone.reach.getState()).toEqual(NO_REACH);
    // And a phone built without the relay at all, the same.
    const without = world({ noRelay: true, defaultUrl: RELAY });
    await linkAtHome(without);
    await goAway(without);
    expect(relayPaths(without)).toEqual([]);
  });

  test("a ws:// relay is used in a development build only", async () => {
    const release = world({ hubRelay: "ws://127.0.0.1:9", build: RELEASE });
    await linkAtHome(release);
    await goAway(release);
    expect(relayPaths(release)).toEqual([]);
    expect(release.client.live.getState().connection.kind).not.toBe("open");
    const dev = world({ hubRelay: "ws://127.0.0.1:9", build: DEV });
    await linkAtHome(dev);
    await goAway(dev);
    expect(relayPaths(dev)).toEqual([`ws://127.0.0.1:9/v1/phone/${dev.hub.identity}/session`]);
    expect(dev.phone.reach.getState().path).toBe("relay");
  });
});

describe("the relay's closes in words", () => {
  test("4404: the hub not connected to the relay; never 'refused', so never 'may have been removed', however long", async () => {
    const w = world({ hubRelay: RELAY, relay: { kind: "close", code: 4404 } });
    await linkAtHome(w);
    await goAway(w);
    expect(w.phone.reach.getState()).toEqual({ ...NO_REACH, relayClosed: "notConnected" });
    await w.pass(90_000, 1000);
    const connection = w.client.live.getState().connection;
    expect(connection.kind).toBe("waiting");
    expect(connection.kind === "waiting" && connection.failure).toBe("unreachable");
    expect(connection.kind === "waiting" && connection.mayBeRemoved).toBe(false);
    expect(w.relay.opened.length).toBeGreaterThanOrEqual(8);
    expect(w.statuses).not.toContain("waiting:refused");
  }, 30_000);

  test("1013 and 4429: the relay busy", async () => {
    for (const code of [1013, 4429]) {
      const w = world({ hubRelay: RELAY, relay: { kind: "close", code } });
      await linkAtHome(w);
      await goAway(w);
      expect([code, w.phone.reach.getState()]).toEqual([
        code,
        { ...NO_REACH, relayClosed: "busy" },
      ]);
    }
  });

  test("a hub's own close passes through as at home: refused, five in a minute 'may have been removed'; and it clears the relay's words", async () => {
    const w = world({ hubRelay: RELAY, relay: { kind: "close", code: 4404 } });
    await linkAtHome(w);
    await goAway(w);
    expect(w.phone.reach.getState().relayClosed).toBe("notConnected");
    w.relay.behaviour = { kind: "close", code: 1008 };
    await w.pass(90_000, 1000);
    expect(w.phone.reach.getState().relayClosed).toBeNull();
    expect(w.statuses).toContain("waiting:refused");
    const connection = w.client.live.getState().connection;
    expect(connection.kind === "waiting" && connection.mayBeRemoved).toBe(true);
  }, 30_000);

  test("a session through the relay opens: the relay's words go", async () => {
    const w = world({ hubRelay: RELAY, relay: { kind: "close", code: 4429 } });
    await linkAtHome(w);
    await goAway(w);
    expect(w.phone.reach.getState().relayClosed).toBe("busy");
    w.relay.behaviour = { kind: "carry" };
    await w.pass(12_000);
    expect(w.phone.reach.getState()).toEqual({ ...NO_REACH, path: "relay" });
  });
});

describe("coming home again (every 60 s †, and when the app comes to the front)", () => {
  /** Linked at home, then away on the relay; the home sockets tried so far. */
  async function onRelay() {
    const w = world({ hubRelay: RELAY });
    await linkAtHome(w);
    await goAway(w);
    expect(w.phone.reach.getState().path).toBe("relay");
    return w;
  }
  const homeTries = (w: World) => w.sockets.opened.filter((s) => s.url.endsWith("/app")).length;

  test("home is tried 60 s after the relay session opened, not before; again 60 s after each miss", async () => {
    expect(HOME_AGAIN_MS).toBe(60_000);
    const w = await onRelay();
    const tries = homeTries(w);
    await w.pass(59_000, 1000);
    expect(homeTries(w)).toBe(tries);
    await w.pass(999);
    expect(homeTries(w)).toBe(tries);
    await w.pass(1);
    expect(homeTries(w)).toBe(tries + 1);
    await w.pass(1000);
    expect(homeTries(w)).toBe(tries + 1);
    // Still away (the address refuses at once): the session stays on the relay, and home is
    // tried again a minute after the miss.
    expect(w.phone.reach.getState().path).toBe("relay");
    await w.pass(58_999, 1000);
    expect(homeTries(w)).toBe(tries + 1);
    await w.pass(1);
    expect(homeTries(w)).toBe(tries + 2);
  }, 30_000);

  test("home answers: the session moves home, the relay socket closed by the phone, a change in flight not lost", async () => {
    const w = await onRelay();
    const relaySocket = w.relay.opened.at(-1);
    w.comeHome();
    const before = (await record(w)).lastSeq;
    w.hub.dropReplies = true;
    const result: { outcome?: Awaited<ReturnType<typeof w.client.request<"site.set">>> } = {};
    void w.client.request("site.set", { countdown: 25 }).then((outcome) => {
      result.outcome = outcome;
    });
    await settle(40);
    expect(w.hub.seen.filter((r) => r.op === "site.set").map((r) => r.seq)).toEqual([before + 1]);
    expect(result.outcome).toBeUndefined();
    w.hub.dropReplies = false;
    await w.pass(HOME_AGAIN_MS, 1000);
    await w.pass(3000);
    expect(w.phone.reach.getState()).toEqual({ ...NO_REACH, path: "home" });
    expect(relaySocket?.phoneClosed).toBe(1000);
    expect(w.client.live.getState().connection.kind).toBe("open");
    expect(result.outcome).toMatchObject({ ok: true, repeat: true });
    expect(w.hub.seen.filter((r) => r.op === "site.set").map((r) => r.seq)).toEqual([
      before + 1,
      before + 1,
    ]);
    expect((await record(w)).lastSeq).toBe(before + 1);
    // At home nothing more is tried.
    const tries = homeTries(w);
    await w.pass(2 * HOME_AGAIN_MS, 5000);
    expect(homeTries(w)).toBe(tries);
    expect(w.relay.opened.length).toBe(1);
  }, 30_000);

  test("a home socket belonging to another hub leaves the authenticated relay session in use", async () => {
    const w = await onRelay();
    const wrongHub = new HubEnd(KEY(8));
    w.homes.set(HOME, wrongHub);
    w.phone.resume();
    await settle(80);
    expect(wrongHub.paths).toEqual(["session"]);
    expect(w.phone.reach.getState().path).toBe("relay");
    expect(w.relay.opened).toHaveLength(1);
    expect(w.relay.opened[0]?.phoneClosed).toBeUndefined();
    const changed = await finish(w.client.request("site.set", { countdown: 28 }));
    expect(changed.ok).toBe(true);

    w.comeHome();
    w.phone.resume();
    await settle(80);
    expect(w.phone.reach.getState().path).toBe("home");
  });

  test("the app comes to the front: home is tried at once, and the session moves when it answers", async () => {
    const w = await onRelay();
    const tries = homeTries(w);
    w.phone.resume();
    await settle(40);
    expect(homeTries(w)).toBe(tries + 1);
    w.timers.advance(1500);
    await settle(40);
    expect(w.phone.reach.getState().path).toBe("relay");
    w.comeHome();
    w.phone.resume();
    await settle(60);
    await w.pass(2000);
    expect(w.phone.reach.getState().path).toBe("home");
  });

  test("at home, coming to the front tries nothing; stopped, the minute's try is cancelled", async () => {
    const w = world({ hubRelay: RELAY });
    await linkAtHome(w);
    const tries = homeTries(w);
    w.phone.resume();
    await settle(40);
    expect(homeTries(w)).toBe(tries);
    const away = await onRelay();
    const awayTries = homeTries(away);
    away.client.stop();
    await away.pass(2 * HOME_AGAIN_MS, 5000);
    expect(homeTries(away)).toBe(awayTries);
    expect(away.phone.reach.getState().path).toBeNull();
  }, 30_000);
});

describe("linking and restoring away from home", () => {
  test("a QR code whose addresses do not answer links through the code's relay (r=); the session opens there", async () => {
    const w = world({ defaultUrl: "wss://default.test" });
    w.leave();
    w.client.start();
    await settle();
    await finish(w.client.link(qrFor(w.hub, RELAY), "qr", { name: "Ana's phone", kind: "phone" }));
    await w.pass(3000);
    expect(w.client.local.getState().link).toEqual({ kind: "linked", from: "qr" });
    expect(relayPaths(w)).toEqual([
      `${RELAY}/v1/phone/${w.hub.identity}/link`,
      `${RELAY}/v1/phone/${w.hub.identity}/session`,
    ]);
    expect((await record(w)).reach).toEqual({
      addresses: [HOME],
      appsPort: 8444,
      lastAddress: null,
      relayUrl: RELAY,
      homeName: "",
    });
    expect(w.phone.reach.getState().path).toBe("relay");
    expect([...w.hub.clients.values()].map((c) => c.kind)).toEqual(["phone"]);
  });

  test("no r=: the deployment's default; none: unreachable, and no relay socket", async () => {
    const w = world({ defaultUrl: RELAY });
    w.leave();
    await finish(w.client.link(qrFor(w.hub), "qr", { name: "Ana's phone", kind: "phone" }));
    expect(w.client.local.getState().link).toEqual({ kind: "linked", from: "qr" });
    expect(relayPaths(w)[0]).toBe(`${RELAY}/v1/phone/${w.hub.identity}/link`);
    const none = world({ defaultUrl: null });
    none.leave();
    const pending = none.client.link(qrFor(none.hub), "qr", { name: "Ana's phone", kind: "phone" });
    await none.pass(3000);
    await finish(pending);
    expect(none.client.local.getState().link).toEqual({
      kind: "failed",
      from: "qr",
      failure: "unreachable",
    });
    expect(relayPaths(none)).toEqual([]);
  });

  test("home answers a link: the relay is never tried", async () => {
    const w = world({ defaultUrl: RELAY });
    await finish(w.client.link(qrFor(w.hub, RELAY), "qr", { name: "Ana's phone", kind: "phone" }));
    expect(w.client.local.getState().link).toEqual({ kind: "linked", from: "qr" });
    expect(relayPaths(w).filter((u) => u.endsWith("/link"))).toEqual([]);
  });

  test("after stale QR addresses, a matching mDNS hub is tried before the relay", async () => {
    const browses: number[] = [];
    const w = world({
      finder: {
        browse: (ms) => {
          browses.push(ms);
          return Promise.resolve({
            ok: true,
            value: [
              {
                identity: new HubEnd(KEY(8)).identity,
                addresses: ["192.168.1.22"],
                appsPort: 8444,
              },
              { identity: IDENTITY, addresses: [HOME, DISCOVERED_HOME], appsPort: 8444 },
            ],
          });
        },
      },
    });
    w.leave();
    w.homes.set(DISCOVERED_HOME, w.hub);
    await finish(w.client.link(qrFor(w.hub, RELAY), "qr", { name: "Phone", kind: "phone" }));
    expect(w.client.local.getState().link).toEqual({ kind: "linked", from: "qr" });
    expect(w.sockets.opened.filter((s) => s.url.endsWith("/link")).map((s) => s.url)).toEqual([
      `wss://${HOME}:8444/app/link`,
      `wss://${DISCOVERED_HOME}:8444/app/link`,
    ]);
    expect(browses).toEqual([2000]);
    expect(relayPaths(w)).toEqual([]);
  });

  test("a relay that says 4404 to a link: unreachable, not refused", async () => {
    const w = world({ relay: { kind: "close", code: 4404 } });
    w.leave();
    const pending = w.client.link(qrFor(w.hub, RELAY), "qr", {
      name: "Ana's phone",
      kind: "phone",
    });
    await w.pass(3000);
    await finish(pending);
    expect(w.client.local.getState().link).toEqual({
      kind: "failed",
      from: "qr",
      failure: "unreachable",
    });
    expect(w.phone.reach.getState().relayClosed).toBe("notConnected");
  });

  test("a typed code names no hub, so it links at home only", async () => {
    const w = world({ defaultUrl: RELAY });
    w.leave();
    const code = w.hub.typedCode("newPerson", null, "Ty");
    const typed = readTypedCode(code, `${HOME}:8444`);
    assert(typed.ok, "Read the typed code.");
    const pending = w.client.link(typed.value, "typed", { name: "Ty's phone", kind: "phone" });
    await w.pass(3000);
    await finish(pending);
    expect(w.client.local.getState().link).toMatchObject({
      kind: "failed",
      failure: "unreachable",
    });
    expect(relayPaths(w)).toEqual([]);
  });

  test("a restore whose addresses do not answer goes through the relay to the new hub the code names: its r=, else the default", async () => {
    const restoreCode = (relay?: string) => {
      const read = readCode(
        formatLinkQr(
          {
            identity: IDENTITY,
            secret: new Uint8Array(16).fill(4),
            addresses: [HOME],
            port: 8444,
            fingerprint: KEY(1),
            ...(relay === undefined ? {} : { relay }),
          },
          "restore",
        ),
      );
      assert(read.ok && read.value.kind === "restore", "Read the restore code.");
      return read.value.restore;
    };
    expect(restoreCode(RELAY).reach.relay).toBe(RELAY);
    expect(restoreCode().reach.relay).toBeUndefined();
    const w = world({
      defaultUrl: "wss://default.test",
      relay: { kind: "close", code: 4404 },
      finder: {
        browse: () =>
          Promise.resolve({
            ok: true,
            value: [{ identity: IDENTITY, addresses: [HOME, DISCOVERED_HOME], appsPort: 8444 }],
          }),
      },
    });
    w.leave();
    const pending = w.phone.restore(restoreCode());
    await w.pass(3000);
    expect(await finish(pending)).toEqual({ ok: false, fault: "unreachable" });
    expect(w.sockets.opened.map((s) => s.url)).toEqual([
      `wss://${HOME}:8444/app/restore`,
      `wss://${DISCOVERED_HOME}:8444/app/restore`,
    ]);
    expect(relayPaths(w)).toEqual([`wss://default.test/v1/phone/${IDENTITY}/restore`]);
    expect(w.phone.reach.getState().relayClosed).toBe("notConnected");
    const named = world({ defaultUrl: "wss://default.test", relay: { kind: "close", code: 1008 } });
    named.leave();
    const refused = named.phone.restore(restoreCode(RELAY));
    await named.pass(3000);
    // The hub's own close before message 2: refused, as at home.
    expect(await finish(refused)).toEqual({ ok: false, fault: "refused" });
    expect(relayPaths(named)).toEqual([`${RELAY}/v1/phone/${IDENTITY}/restore`]);

    const none = world({ defaultUrl: null });
    none.leave();
    const unreachable = none.phone.restore(restoreCode());
    await none.pass(3000);
    expect(await finish(unreachable)).toEqual({ ok: false, fault: "unreachable" });
    expect(relayPaths(none)).toEqual([]);

    const local = world({ defaultUrl: RELAY });
    const atHome = local.phone.restore(restoreCode());
    await local.pass(3000);
    // This scripted hub closes restore before message 2. Its socket still answers at home.
    expect(await finish(atHome)).toEqual({ ok: false, fault: "refused" });
    expect(local.hub.paths).toEqual(["restore"]);
    expect(relayPaths(local)).toEqual([]);
  });
});

// ----- The line under This home -----

const SITE = {
  channel: 1,
  rate: 2,
  countdownS: 30,
  autoStopS: 180,
  wifiName: "",
  retentionRoutineDays: 30,
  retentionEventDays: 365,
};

const WORDS = {
  home: "Connected at home",
  relay: "Connected through the relay",
  notConnected: "The hub is not connected to the internet relay.",
  busy: "The relay is busy. Trying again.",
};

async function siteOnPhone(reach: ReachState, withSite = true): Promise<string> {
  const { client } = await import("./support/screens").then((m) => m.screenWorld({}));
  const parts: PhoneParts = {
    ...standInPhoneParts(client),
    reach: createStore<ReachState>()(() => reach),
  };
  const html = await renderWith(
    createElement(PhoneProvider, { parts, children: createElement(site.SiteScreen) }),
    withSite ? { site: SITE } : {},
  );
  return textOf(html);
}

describe("which path is in use, under This home (one line), never on Home", () => {
  test("each state in its words, at the top of This home, with the site loaded or not", async () => {
    const cases: readonly [ReachState, string][] = [
      [{ ...NO_REACH, path: "home" }, WORDS.home],
      [{ ...NO_REACH, path: "relay" }, WORDS.relay],
      [{ ...NO_REACH, relayClosed: "notConnected" }, WORDS.notConnected],
      [{ ...NO_REACH, relayClosed: "busy" }, WORDS.busy],
    ];
    for (const [reach, said] of cases) {
      for (const withSite of [true, false]) {
        const text = await siteOnPhone(reach, withSite);
        expect(text.startsWith(said)).toBe(true);
        expect(text.split(said)).toHaveLength(2);
        for (const other of Object.values(WORDS).filter((w) => w !== said))
          expect(text).not.toContain(other);
      }
    }
    expect(site.pathSaid({ ...NO_REACH, path: "relay", relayClosed: "busy" })).toBe("relay");
  });

  test("nothing known: no line; in a browser, no line at all", async () => {
    const text = await siteOnPhone(NO_REACH);
    for (const said of Object.values(WORDS)) expect(text).not.toContain(said);
    expect(text.startsWith("Countdown for new sensors")).toBe(true);
    const browser = textOf(await renderWith(createElement(site.SiteScreen), { site: SITE }));
    for (const said of Object.values(WORDS)) expect(browser).not.toContain(said);
  });

  test("Home never says the path", async () => {
    const { client } = await import("./support/screens").then((m) => m.screenWorld({}));
    for (const path of ["home", "relay"] as const) {
      const parts: PhoneParts = {
        ...standInPhoneParts(client),
        reach: createStore<ReachState>()(() => ({ ...NO_REACH, path })),
      };
      const text = textOf(
        await renderWith(
          createElement(PhoneProvider, { parts, children: createElement(HomeRoute) }),
          {
            site: SITE,
          },
        ),
      );
      for (const said of Object.values(WORDS)) expect(text).not.toContain(said);
    }
  });
});

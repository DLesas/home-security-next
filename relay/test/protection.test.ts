/**
 * D142's layer 1 through real sockets (docs/m4-design.md section 3): every row the program can
 * meet on one Mac, at its edge (one below, at, one above), with the designed answer: HTTP 429 or
 * 503 before any upgrade, 4429 for caps, `limit {what: "newIdentity"}` for new identities, a slow
 * reader closed; and a flood from one address leaving an established hub link alone. Addresses
 * come through `X-Forwarded-For` from a trusted loopback proxy, as behind a filter (layer 2),
 * since this Mac has one loopback address. The rows too large to reach through sockets in a test
 * (20,000 links, 40,000 streams, 500 MB a day) are at their edges in `core/admission.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { connect, type Socket } from "node:net";
import { PHONE_CLOSE, RELAY_CLOSE, RELAY_LIMITS } from "@hsn/protocol/relay";
import { PROTECTION_LIMITS as L } from "../src/core/rules.ts";
import { untilNextUtcDay } from "../src/core/time.ts";
import { HubLink, type HubLinkHost } from "../src/shell/hub-link.ts";
import { SILENT_LOG } from "../src/shell/log.ts";
import type { RelaySocket } from "../src/shell/safe/websocket.ts";
import {
  Client,
  cleanup,
  events,
  hubKey,
  ManualClock,
  settle,
  StandInHub,
  startRelay,
  tempFolder,
  type TestRelay,
  until,
} from "./helpers.ts";

let folder: string;
let t: TestRelay;

beforeEach(() => {
  folder = tempFolder();
  t = startRelay(folder, { trustedProxies: ["127.0.0.1"] });
});

afterEach(async () => {
  await t.stop();
  cleanup(folder);
});

/** A raw HTTP upgrade from `address`: its status, and the socket (kept open when asked). */
async function rawUpgrade(
  port: number,
  path: string,
  address: string,
  keep = false,
): Promise<{ status: number; socket: Socket }> {
  const socket = connect(port, "127.0.0.1");
  const status = await new Promise<number>((resolve) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
      const line = text.split("\r\n")[0];
      if (line !== undefined && text.includes("\r\n")) resolve(Number(line.split(" ")[1]));
    });
    socket.on("error", () => {
      resolve(0);
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
        `X-Forwarded-For: ${address}\r\n\r\n`,
    );
  });
  if (!keep) socket.destroy();
  return { status, socket };
}

const addressOf = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

describe("before any state is kept", () => {
  test(`the ${L.beforeState.hubAndRelayUpgradesPerMinutePerAddress + 1}th hub upgrade a minute from one address is 429, and nothing is kept`, async () => {
    const limit = L.beforeState.hubAndRelayUpgradesPerMinutePerAddress;
    for (let i = 0; i < limit; i++) {
      expect((await rawUpgrade(t.listener.port, "/v1/hub", "192.0.2.10")).status).toBe(101);
      await until(() => t.relay.counts.unauthenticated === 0, "the socket to go");
    }
    expect((await rawUpgrade(t.listener.port, "/v1/hub", "192.0.2.10")).status).toBe(429);
    expect(t.relay.counts.unauthenticated).toBe(0);
    expect((await rawUpgrade(t.listener.port, "/v1/hub", "192.0.2.11")).status).toBe(101);
    t.clock.advance(60_000);
    expect((await rawUpgrade(t.listener.port, "/v1/hub", "192.0.2.10")).status).toBe(101);
    expect(events(t.log, "upgradeRefused")).toMatchObject([{ link: "hub", why: "rate" }]);
  });

  test(`the ${L.beforeState.handshakesPerSecondInAll + 1}th link handshake in a second is 503`, async () => {
    for (let i = 0; i < L.beforeState.handshakesPerSecondInAll; i++) {
      expect((await rawUpgrade(t.listener.port, "/v1/hub", addressOf(i))).status).toBe(101);
    }
    expect((await rawUpgrade(t.listener.port, "/v1/hub", "192.0.2.99")).status).toBe(503);
    t.clock.advance(1000);
    expect((await rawUpgrade(t.listener.port, "/v1/hub", "192.0.2.99")).status).toBe(101);
  });

  test(`the ${L.beforeState.phoneOpensPerMinutePerAddress + 1}th phone open a minute from one address is 429`, async () => {
    const path = `/v1/phone/${hubKey().identity}/session`;
    for (let i = 0; i < L.beforeState.phoneOpensPerMinutePerAddress; i++) {
      expect((await rawUpgrade(t.listener.port, path, "192.0.2.20")).status).toBe(101);
    }
    expect((await rawUpgrade(t.listener.port, path, "192.0.2.20")).status).toBe(429);
    expect((await rawUpgrade(t.listener.port, path, "192.0.2.21")).status).toBe(101);
  });

  test("a request with no address it can count by is 400; an untrusted peer's header is ignored", async () => {
    expect((await rawUpgrade(t.listener.port, "/v1/hub", "not-an-address")).status).toBe(400);
    await t.stop();
    t = startRelay(folder);
    // Without a trusted proxy every request counts as the socket's own address.
    for (let i = 0; i < L.beforeState.hubAndRelayUpgradesPerMinutePerAddress; i++) {
      await rawUpgrade(t.listener.port, "/v1/hub", addressOf(i));
    }
    expect((await rawUpgrade(t.listener.port, "/v1/hub", "192.0.2.1")).status).toBe(429);
  });
});

describe("unauthenticated hub links", () => {
  test(`the ${L.unauthenticated.perAddress + 1}th unfinished handshake from one address is closed 4429`, async () => {
    const held: Socket[] = [];
    for (let i = 0; i < L.unauthenticated.perAddress; i++) {
      const up = await rawUpgrade(t.listener.port, "/v1/hub", "192.0.2.30", true);
      expect(up.status).toBe(101);
      held.push(up.socket);
    }
    await until(() => t.relay.counts.unauthenticated === L.unauthenticated.perAddress, "4 held");
    const fifth = new Client(`${t.url}/v1/hub`, "192.0.2.30");
    expect(await fifth.closed()).toBe(RELAY_CLOSE.overLimit);
    expect(t.relay.counts.unauthenticated).toBe(L.unauthenticated.perAddress);
    const other = new Client(`${t.url}/v1/hub`, "192.0.2.31");
    await other.open();
    expect(other.closeCode).toBeUndefined();
    for (const s of held) s.destroy();
  });

  test("one message queued during a handshake step; a second closes 4429", async () => {
    const hub = new Client(`${t.url}/v1/hub`, "192.0.2.32");
    await hub.open();
    // Three binary messages at once: one in hand, one queued, the third over.
    hub.send(new Uint8Array(32));
    hub.send(new Uint8Array(32));
    hub.send(new Uint8Array(32));
    const code = await hub.closed();
    // The first is not a valid message 1, so 4400 may come first; never anything kept.
    expect([RELAY_CLOSE.overLimit, RELAY_CLOSE.badFrame] as number[]).toContain(code ?? 0);
    expect(t.relay.counts.unauthenticated).toBe(0);
  });
});

describe("authenticated hub links", () => {
  test(`the ${L.hubLinks.perAddress + 1}th hub link from one address is refused 4429; the others stay`, async () => {
    // Identities known first, from addresses of their own (new ones are limited per address).
    const keys = Array.from({ length: L.hubLinks.perAddress + 1 }, () => hubKey());
    for (const [i, key] of keys.entries()) {
      const hub = await StandInHub.connect(t.url, { key, address: `192.0.2.${100 + i}` });
      await hub.next("joined");
      hub.client.close();
    }
    await until(() => t.relay.counts.joined === 0, "the first links to close");
    const joined: StandInHub[] = [];
    for (const key of keys.slice(0, -1)) {
      const hub = await StandInHub.connect(t.url, { key, address: "192.0.2.40" });
      await hub.next("joined");
      joined.push(hub);
    }
    const ninth = await StandInHub.connect(t.url, {
      key: keys.at(-1) ?? hubKey(),
      address: "192.0.2.40",
    });
    expect(await ninth.client.closed()).toBe(RELAY_CLOSE.overLimit);
    expect(ninth.joined).toBe(false);
    for (const hub of joined) {
      hub.send({ t: "ping", n: 1 });
      await hub.next("pong");
      expect(hub.client.closeCode).toBeUndefined();
    }
    // The same identity again from that address replaces its own link: never refused for room.
    const again = await StandInHub.connect(t.url, {
      key: keys[0] ?? hubKey(),
      address: "192.0.2.40",
    });
    await again.next("joined");
    expect(await joined[0]?.client.closed()).toBe(RELAY_CLOSE.replaced);
  });
});

describe("new hub identities", () => {
  test(`the ${L.newIdentities.perDayPerAddress + 1}th new identity a day from one address gets limit, then 4429`, async () => {
    for (let i = 0; i < L.newIdentities.perDayPerAddress; i++) {
      const hub = await StandInHub.connect(t.url, { address: "192.0.2.50" });
      await hub.next("joined");
    }
    const fourth = await StandInHub.connect(t.url, { address: "192.0.2.50" });
    expect(await fourth.next("limit")).toEqual({
      t: "limit",
      what: "newIdentity",
      retryAfterMs: untilNextUtcDay(t.clock.now()),
    });
    expect(await fourth.client.closed()).toBe(RELAY_CLOSE.overLimit);
    expect(t.relay.counts.hubs).toBe(L.newIdentities.perDayPerAddress);
    // Nothing of it is stored.
    expect(t.relay.recordOf(fourth.identity)).toBeUndefined();
  });

  test(`at ${L.newIdentities.storedMax} stored, new identities are refused and the operator alerted; stored hubs are not`, async () => {
    const known = hubKey();
    const dbPath = t.dbPath;
    await t.stop();
    // Fill the table to one below the cap, the known hub among them.
    const db = new Database(dbPath);
    const insert = db.prepare(
      "INSERT INTO hubs (identity, first_seen_ms, days_seen, last_day, seen_ms, state, grace_end_ms) VALUES (?, ?, 3, ?, ?, 'quiet', 0)",
    );
    const now = Date.UTC(2026, 10, 18, 12);
    db.transaction(() => {
      insert.run(known.identity, now, Math.floor(now / 86_400_000), now);
      for (let i = 1; i < L.newIdentities.storedMax - 1; i++) {
        insert.run(`h${i.toString().padStart(25, "0")}`, now, Math.floor(now / 86_400_000), now);
      }
    })();
    db.close();
    t = startRelay(folder, { dbPath, trustedProxies: ["127.0.0.1"], clock: new ManualClock(now) });
    expect(t.relay.counts.hubs).toBe(L.newIdentities.storedMax - 1);
    const last = await StandInHub.connect(t.url, { address: "192.0.2.60" });
    await last.next("joined");
    expect(t.relay.counts.hubs).toBe(L.newIdentities.storedMax);
    const over = await StandInHub.connect(t.url, { address: "192.0.2.61" });
    expect(await over.next("limit")).toEqual({
      t: "limit",
      what: "newIdentity",
      retryAfterMs: RELAY_LIMITS.limitWaitMs,
    });
    expect(await over.client.closed()).toBe(RELAY_CLOSE.overLimit);
    expect(events(t.log, "operatorAlert")).toMatchObject([
      { what: "storedIdentities", stored: L.newIdentities.storedMax },
    ]);
    // Another refused the same UTC day: no second alert. The next day: one more.
    const again = await StandInHub.connect(t.url, { address: "192.0.2.63" });
    expect(await again.client.closed()).toBe(RELAY_CLOSE.overLimit);
    expect(events(t.log, "operatorAlert")).toHaveLength(1);
    t.clock.to(now + untilNextUtcDay(now));
    const tomorrow = await StandInHub.connect(t.url, { address: "192.0.2.64" });
    expect(await tomorrow.client.closed()).toBe(RELAY_CLOSE.overLimit);
    expect(events(t.log, "operatorAlert")).toHaveLength(2);
    const existing = await StandInHub.connect(t.url, { key: known, address: "192.0.2.62" });
    await existing.next("joined");
  }, 30_000);
});

describe("phone streams", () => {
  test(`the ${L.phoneStreams.perHub + 1}th stream to one hub is 4429`, async () => {
    const hub = await StandInHub.connect(t.url, { address: "192.0.2.70" });
    await hub.next("joined");
    const phones: Client[] = [];
    for (let i = 0; i < L.phoneStreams.perHub; i++) {
      const phone = new Client(`${t.url}/v1/phone/${hub.identity}/session`, `198.51.100.${i}`);
      await phone.open();
      await hub.next("open");
      phones.push(phone);
    }
    const over = new Client(`${t.url}/v1/phone/${hub.identity}/session`, "198.51.100.200");
    expect(await over.closed()).toBe(PHONE_CLOSE.overLimit);
    phones[0]?.close();
    await hub.next("close");
    const room = new Client(`${t.url}/v1/phone/${hub.identity}/session`, "198.51.100.201");
    await room.open();
    expect((await hub.next("open")).stream).toBe(L.phoneStreams.perHub);
  });

  test(`the ${L.phoneStreams.openPerAddress + 1}th stream open from one address is 4429`, async () => {
    const hubs: StandInHub[] = [];
    for (let i = 0; i < 2; i++) {
      const hub = await StandInHub.connect(t.url, { address: `192.0.2.${80 + i}` });
      await hub.next("joined");
      hubs.push(hub);
    }
    for (let i = 0; i < L.phoneStreams.openPerAddress; i++) {
      const phone = new Client(
        `${t.url}/v1/phone/${hubs[i % 2]?.identity ?? ""}/session`,
        "198.51.100.50",
      );
      await phone.open();
      expect(phone.closeCode).toBeUndefined();
    }
    const over = new Client(
      `${t.url}/v1/phone/${hubs[0]?.identity ?? ""}/session`,
      "198.51.100.50",
    );
    expect(await over.closed()).toBe(PHONE_CLOSE.overLimit);
  });
});

describe("memory per connection", () => {
  test("a phone too slow to take its data is closed 4429, and the hub told", async () => {
    const hub = await StandInHub.connect(t.url, { address: "192.0.2.90" });
    await hub.next("joined");
    const up = await rawUpgrade(
      t.listener.port,
      `/v1/phone/${hub.identity}/session`,
      "198.51.100.90",
      true,
    );
    expect(up.status).toBe(101);
    up.socket.pause();
    const open = await hub.next("open");
    const message = new Uint8Array(RELAY_LIMITS.maxPhoneMessageBytes);
    for (let i = 0; i < 400; i++) hub.sendStream(open.stream, message);
    expect(await hub.next("close")).toEqual({
      t: "close",
      stream: open.stream,
      code: PHONE_CLOSE.overLimit,
    });
    expect(events(t.log, "slowReader").some((e) => e.link === "phone")).toBe(true);
    // The hub's link is untouched.
    hub.send({ t: "ping", n: 2 });
    await hub.next("pong");
    up.socket.destroy();
  });

  test("a hub link too slow to take its data is closed 4429", () => {
    let closed: number | undefined;
    const sends: boolean[] = [true, false];
    const socket: RelaySocket = {
      sendText: () => sends.shift() ?? false,
      sendBinary: () => sends.shift() ?? false,
      close: (code) => {
        closed = code;
      },
      pending: L.memory.pendingToHubLinkBytes + 1,
    };
    const clock = new ManualClock(0);
    const host: HubLinkHost = {
      clock,
      log: SILENT_LOG,
      welcome: () => ({
        relay: "0.1.0",
        roles: ["relay"],
        limits: {
          maxRosterBytes: 1,
          maxPushItemsPerFrame: 1,
          maxReleasePieceBytes: 1,
          maxRestartWithinMs: 0,
        },
      }),
      join: () => "ok",
      heard: () => undefined,
      text: () => undefined,
      streamData: () => undefined,
      gone: () => undefined,
    };
    const link = new HubLink(socket, host, "192.0.2.1");
    expect(link.send({ t: "pong", n: 1 })).toBe(true);
    expect(closed).toBeUndefined();
    expect(link.send({ t: "pong", n: 2 })).toBe(false);
    expect(closed).toBe(RELAY_CLOSE.overLimit);
    expect(link.sendBinary(new Uint8Array([1]))).toBe(false);
  });

  test("a message larger than the largest frame is closed before it is buffered", async () => {
    const hub = await StandInHub.connect(t.url, { address: "192.0.2.91" });
    await hub.next("joined");
    hub.client.send(new Uint8Array(300 * 1024));
    // Bun drops the connection (the client sees 1006, or 1009 when Bun says why).
    expect([1006, 1009]).toContain((await hub.client.closed()) ?? 0);
    await until(() => t.relay.counts.joined === 0, "the link to go");
  });
});

describe("a flood from one address", () => {
  test("does not disturb an established hub link or its streams", async () => {
    const hub = await StandInHub.connect(t.url, { address: "192.0.2.1" });
    await hub.next("joined");
    const phone = new Client(`${t.url}/v1/phone/${hub.identity}/session`, "198.51.100.1");
    await phone.open();
    const open = await hub.next("open");
    // The flood: upgrades past the rate, unfinished handshakes past their cap, phone streams
    // past theirs; in batches, so the system's listen queue does not refuse the connections.
    const answers: { status: number; socket: Socket }[] = [];
    const paths = [
      ...Array.from({ length: 200 }, () => "/v1/hub"),
      ...Array.from({ length: 100 }, () => `/v1/phone/${hub.identity}/session`),
    ];
    for (let at = 0; at < paths.length; at += 50) {
      answers.push(
        ...(await Promise.all(
          paths
            .slice(at, at + 50)
            .map((path) => rawUpgrade(t.listener.port, path, "203.0.113.66", true)),
        )),
      );
    }
    const tally = new Map<number, number>();
    for (const a of answers) tally.set(a.status, (tally.get(a.status) ?? 0) + 1);
    expect(Object.fromEntries(tally)).toEqual({
      101:
        L.beforeState.hubAndRelayUpgradesPerMinutePerAddress +
        L.beforeState.phoneOpensPerMinutePerAddress,
      429:
        paths.length -
        L.beforeState.hubAndRelayUpgradesPerMinutePerAddress -
        L.beforeState.phoneOpensPerMinutePerAddress,
    });
    // Through all of it the established link and its stream carry on.
    for (let i = 0; i < 5; i++) {
      hub.send({ t: "ping", n: i });
      await hub.next("pong");
      phone.send(new Uint8Array([i]));
      hub.sendStream(open.stream, new Uint8Array([i, i]));
    }
    await until(() => hub.streamMessages(open.stream).length === 5, "the phone's messages");
    await until(() => phone.binaries.length === 5, "the hub's messages");
    expect(hub.client.closeCode).toBeUndefined();
    expect(t.relay.counts.joined).toBe(1);
    expect(t.relay.counts.unauthenticated).toBeLessThanOrEqual(L.unauthenticated.perAddress);
    for (const a of answers) a.socket.destroy();
    await settle();
  });
});

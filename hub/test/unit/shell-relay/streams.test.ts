/**
 * Phones' streams through B2's real relay into the hub's real app channel (docs/m4-design.md
 * section 4, "Relayed streams in the app channel"): the same session layer, under the same
 * handshake and session limits as the home network's listener, the relay's pseudonym of the
 * phone's address standing for its address; the console's key refused; every relayed connection
 * closed when the link drops; and the home listener, beside it, unchanged.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { formatIdentity } from "@hsn/protocol/app";
import { clientId } from "../../../src/core/model/ids.ts";
import { ClientKind } from "../../../src/core/model/rows.ts";
import {
  clientRow,
  type HubOptions,
  IkClient,
  LinkClient,
  ManualTimers,
  openHub,
  session,
  staticKey,
  stopHubs,
  type HubSide,
} from "../shell-app/support.ts";
import { expectNoKeyLeaks } from "../setup/support/leak-guard.ts";
import {
  makeClient,
  RelayPhone,
  type RelayRun,
  ScriptedRelay,
  settle,
  startRelayRun,
  stopAll,
  until,
} from "./support.ts";

afterEach(async () => {
  await stopAll();
  stopHubs();
});

const anna = staticKey(21);
const ben = staticKey(22);
const hubConsole = staticKey(23);

function clients() {
  return [
    clientRow(7, anna.key.publicKey, ClientKind.Phone),
    clientRow(8, ben.key.publicKey, ClientKind.Web),
    clientRow(9, hubConsole.key.publicKey, ClientKind.Console),
  ];
}

/** The hub's channel and its relay client, joined to a fresh relay. */
async function hubOnRelay(options: HubOptions = {}): Promise<{
  side: HubSide;
  run: RelayRun;
  identity: string;
  client: ReturnType<typeof makeClient>;
}> {
  const side = openHub({ clients: clients(), ...options });
  const run = startRelayRun();
  const client = makeClient({ key: side.hub.key, channel: side.channel });
  client.client.perform({ kind: "relayConnect", url: run.url });
  await until(() => client.client.state.kind === "up", "the hub's link");
  return { side, run, identity: formatIdentity(side.hub.identity), client };
}

/** A phone's session through the relay: message 1, HubHello, then its first request. */
async function relayedSession(
  side: HubSide,
  run: RelayRun,
  identity: string,
  key = anna.key,
  proto: [number, number] = [2, 2],
): Promise<{ phone: RelayPhone; ik: IkClient; hello: unknown }> {
  const phone = await RelayPhone.open(run.url, identity, "session");
  const ik = new IkClient(side, key);
  phone.send(await ik.message1({ proto, app: "2.0.0" }));
  const m2 = await phone.next();
  expect(m2).toBeDefined();
  const hello = await ik.message2(m2 ?? new Uint8Array(0));
  return { phone, ik, hello };
}

describe("a phone's whole session through the relay", () => {
  test("version 2: HubHello, the session admitted on the relay listener, a request, a reply, an event", async () => {
    const { side, run, identity } = await hubOnRelay();
    const { phone, ik, hello } = await relayedSession(side, run, identity);
    expect(hello).toMatchObject({ proto: 2, client: { id: 7, kind: "phone" } });
    phone.send(ik.seal({ t: "req", id: 1, op: "relay.status", body: {} }));
    const connected = await side.waitFor("clientConnected");
    expect(connected).toMatchObject({ client: clientId(7), listener: "relay", proto: 2 });
    const request = await side.waitFor("clientRequest");
    expect(request.request).toEqual({
      id: 1,
      seq: undefined,
      op: { op: "relay.status", body: {} },
    });
    side.channel.perform({
      kind: "appSend",
      conn: connected.conn,
      message: { t: "res", id: 1, ok: true, body: { state: "up" } },
    });
    expect(ik.open((await phone.next()) ?? new Uint8Array(0))).toEqual({
      t: "res",
      id: 1,
      ok: true,
      body: { state: "up" },
    });
    side.channel.perform({
      kind: "appSend",
      conn: connected.conn,
      message: { t: "evt", rev: 42, ev: "door", body: { sensor: 3, open: true, atMs: 1 } },
    });
    expect(ik.open((await phone.next()) ?? new Uint8Array(0))).toMatchObject({
      t: "evt",
      rev: 42,
      ev: "door",
    });
    // The phone goes: the session closes as any does.
    phone.close();
    const closed = await side.waitFor("clientClosed");
    expect(closed).toEqual({ kind: "clientClosed", conn: connected.conn, reason: "remote" });
  });

  test("linking through the relay: XXpsk3 on the link path, LinkResult, then the hub closes it", async () => {
    const { side, run, identity } = await hubOnRelay();
    const secret = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const newKey = staticKey(31);
    const link = new LinkClient("link", secret, newKey.key);
    side.channel.perform({
      kind: "linkSecret",
      token: 5 as never,
      purpose: "link",
      askName: false,
      lookup: link.lookup,
      psk: link.psk,
    });
    const phone = await RelayPhone.open(run.url, identity, "link");
    phone.send(await link.write({ proto: [1, 2], find: link.lookup }));
    const m2 = await phone.next();
    expect(await link.read(m2 ?? new Uint8Array(0))).toMatchObject({ proto: 2, askName: false });
    phone.send(await link.write({ name: "Anna's phone", kind: "phone" }));
    const completed = await side.waitFor("linkCompleted");
    expect(completed).toMatchObject({
      listener: "relay",
      link: { name: "Anna's phone", kind: "phone" },
    });
    side.channel.perform({
      kind: "appSend",
      conn: completed.conn,
      message: { kind: "handshake", body: { client: 12, person: 2 } },
    });
    expect(link.open((await phone.next()) ?? new Uint8Array(0))).toEqual({ client: 12, person: 2 });
    expect(await phone.closed()).toBe(1000);
  });

  test("the home listener beside it, unchanged: a version 1 web client on the home network", async () => {
    const { side, run, identity } = await hubOnRelay();
    const home = await session(side, ben.key, "lan");
    expect(home.hello).toMatchObject({ proto: 1, client: { id: 8, kind: "web" } });
    const relayed = await relayedSession(side, run, identity);
    relayed.phone.send(relayed.ik.seal({ t: "req", id: 1, op: "pong", body: {} }));
    await until(() => side.of("clientConnected").length === 2, "both sessions");
    expect(side.of("clientConnected").map((e) => [e.client, e.listener, e.proto])).toEqual([
      [clientId(8), "lan", 1],
      [clientId(7), "relay", 2],
    ]);
  });

  test("the relay link drops: every relayed connection is closed, the home one is not", async () => {
    const { side, run, identity } = await hubOnRelay();
    const home = await session(side, ben.key, "lan");
    const relayed = await relayedSession(side, run, identity);
    relayed.phone.send(relayed.ik.seal({ t: "req", id: 1, op: "pong", body: {} }));
    await until(() => side.channel.sessions === 2, "two sessions");
    const conn = side.of("clientConnected").find((e) => e.listener === "relay")?.conn;
    await run.stop();
    await until(() => side.channel.sessions === 1, "the relayed one closed");
    expect(side.of("clientClosed").map((e) => `${String(e.conn)}:${e.reason}`)).toEqual([
      `${String(conn)}:remote`,
    ]);
    expect(home.ws.closedWith).toBeUndefined();
  });
});

test("a change of relay (relay.set, or none) closes the relayed connections of the old link", async () => {
  const { side, run, identity, client } = await hubOnRelay();
  const relayed = await relayedSession(side, run, identity);
  relayed.phone.send(relayed.ik.seal({ t: "req", id: 1, op: "pong", body: {} }));
  await until(() => side.channel.sessions === 1, "the session");
  client.client.perform({ kind: "relayConnect", url: null });
  expect(side.channel.sessions).toBe(0);
  expect(side.of("clientClosed").map((e) => e.reason)).toEqual(["remote"]);
  expect(await relayed.phone.closed()).toBe(4410);
});

describe("the same limits as the home listener", () => {
  test("the console's key is refused through the relay (consoleNotLocal), by the relay's pseudonym", async () => {
    const { side, run, identity } = await hubOnRelay({ timers: new ManualTimers() });
    const phone = await RelayPhone.open(run.url, identity, "session");
    phone.send(await new IkClient(side, hubConsole.key).message1({ proto: [1, 2], app: "x" }));
    expect(await phone.closed()).toBe(1008);
    side.channel.stop();
    expect(side.refusals).toHaveLength(1);
    expect(side.refusals[0]?.reason).toBe("consoleNotLocal");
    expect(side.refusals[0]?.address).toMatch(/^relay-[0-9a-f]{16}$/u);
  });

  test("open handshakes: past the limit the relay is told 1013, and the phone hears it", async () => {
    const { side, run, identity } = await hubOnRelay({
      limits: { maxOpenHandshakes: 2 },
      timers: new ManualTimers(),
    });
    const first = await RelayPhone.open(run.url, identity, "session");
    const second = await RelayPhone.open(run.url, identity, "session");
    await until(() => side.channel.handshakes === 2, "two handshakes");
    const third = await RelayPhone.open(run.url, identity, "session");
    expect(await third.closed()).toBe(1013);
    expect(first.closedWith).toBeUndefined();
    expect(second.closedWith).toBeUndefined();
    // One closes: a new one gets in.
    first.close();
    await until(() => side.channel.handshakes === 1, "a slot free");
    const fourth = await RelayPhone.open(run.url, identity, "session");
    await settle(30);
    expect(fourth.closedWith).toBeUndefined();
  });

  test("handshakes a second from one address: the pseudonym is the address", async () => {
    const { run, identity } = await hubOnRelay({
      limits: { handshakesPerSecondPerAddress: 2 },
      timers: new ManualTimers(),
    });
    const phones = [];
    for (let i = 0; i < 3; i++) phones.push(await RelayPhone.open(run.url, identity, "session"));
    expect(await phones[2]?.closed()).toBe(1013);
    expect(phones[0]?.closedWith).toBeUndefined();
  });

  test("a handshake not proven within 5 s is closed, as at home", async () => {
    const timers = new ManualTimers();
    const { side, run, identity } = await hubOnRelay({ timers });
    const phone = await RelayPhone.open(run.url, identity, "session");
    await until(() => side.channel.handshakes === 1, "the handshake");
    timers.advance(4999);
    await settle(20);
    expect(phone.closedWith).toBeUndefined();
    timers.advance(1);
    expect(await phone.closed()).toBe(1008);
  });

  test("a client's fifth session closes its oldest (4002), through the relay", async () => {
    const { side, run, identity } = await hubOnRelay({ timers: new ManualTimers() });
    const sessions = [];
    for (let i = 0; i < 5; i++) {
      const s = await relayedSession(side, run, identity);
      s.phone.send(s.ik.seal({ t: "req", id: 1, op: "pong", body: {} }));
      await until(() => side.of("clientConnected").length === i + 1, `session ${String(i + 1)}`);
      sessions.push(s);
    }
    expect(await sessions[0]?.phone.closed()).toBe(4002);
    expect(side.channel.sessionsOf(clientId(7))).toHaveLength(4);
  });

  test("an unknown key is refused with no message 2, counted under the pseudonym", async () => {
    const { side, run, identity } = await hubOnRelay({ timers: new ManualTimers() });
    const phone = await RelayPhone.open(run.url, identity, "session");
    phone.send(await new IkClient(side, staticKey(99).key).message1({ proto: [2, 2], app: "x" }));
    expect(await phone.next(500)).toBeUndefined();
    expect(await phone.closed()).toBe(1008);
    side.channel.stop();
    expect(side.refusals.map((r) => [r.reason, /^relay-[0-9a-f]{16}$/u.test(r.address)])).toEqual([
      ["unknownKey", true],
    ]);
  });

  test("stream numbers only grow on a link: one seen before is refused with 1008", async () => {
    const relay = new ScriptedRelay();
    const side = openHub({ clients: clients(), timers: new ManualTimers() });
    const client = makeClient({ key: side.hub.key, channel: side.channel, connect: relay.connect });
    client.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => client.client.state.kind === "up", "up");
    const link = relay.last;
    link?.send({ t: "open", stream: 3, path: "session", peer: "relay-0123456789abcdef" });
    link?.send({ t: "open", stream: 2, path: "session", peer: "relay-0123456789abcdef" });
    link?.send({ t: "open", stream: 3, path: "session", peer: "relay-0123456789abcdef" });
    expect(client.client.streams).toBe(1);
    expect(link?.sent("close")).toEqual([
      { t: "close", stream: 2, code: 1008 },
      { t: "close", stream: 3, code: 1008 },
    ]);
    // Data for a stream the hub does not hold is dropped; the relay's close of one it holds ends it.
    link?.sendBinary(Uint8Array.of(1, 9, 0, 0, 0, 7));
    link?.send({ t: "close", stream: 3, code: 1000 });
    expect(client.client.streams).toBe(0);
    expect(side.channel.handshakes).toBe(0);
  });

  test("a close the relay does not carry for a hub (1001 at a stop) goes as 1008", async () => {
    const relay = new ScriptedRelay();
    const side = openHub({ clients: clients(), timers: new ManualTimers() });
    const client = makeClient({ key: side.hub.key, channel: side.channel, connect: relay.connect });
    client.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => client.client.state.kind === "up", "up");
    relay.last?.send({ t: "open", stream: 0, path: "session", peer: "relay-0123456789abcdef" });
    side.channel.stop();
    expect(relay.last?.sent("close")).toEqual([{ t: "close", stream: 0, code: 1008 }]);
  });
});

test("no key in any event or report", () => {
  expectNoKeyLeaks();
});

/**
 * Hub links and phone streams through a real relay on loopback (docs/m4-design.md section 3):
 * a hub joining by its key, a second link of the same identity replacing the first, a wrong key,
 * refused keys, version and frame errors; and a phone's stream end to end, the bytes unchanged
 * both ways, with every close code the design gives a phone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  encodeRelayHello,
  PHONE_CLOSE,
  RELAY_CLOSE,
  RELAY_LIMITS,
  startRelayInitiator,
} from "@hsn/protocol/relay";
import { PRESENCE_RULES, PROTECTION_LIMITS } from "../src/core/rules.ts";
import {
  Client,
  cleanup,
  events,
  hubKey,
  must,
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
  t = startRelay(folder);
});

afterEach(async () => {
  await t.stop();
  cleanup(folder);
});

function phoneUrl(identity: string, path = "session"): string {
  return `${t.url}/v1/phone/${identity}/${path}`;
}

describe("a hub joining", () => {
  test("proves its key and is told its identity, with the relay's limits in message 2", async () => {
    const hub = await StandInHub.connect(t.url);
    const joined = await hub.next("joined");
    expect(joined.identity).toBe(hub.identity);
    expect(hub.welcome).toEqual({
      proto: 1,
      relay: "0.1.0",
      roles: ["relay", "releases"],
      limits: {
        maxRosterBytes: PROTECTION_LIMITS.memory.rosterBytes,
        maxPushItemsPerFrame: RELAY_LIMITS.maxPushItemsPerFrame,
        maxReleasePieceBytes: RELAY_LIMITS.maxReleasePieceBytes,
        maxRestartWithinMs: PRESENCE_RULES.graceMaxMs,
      },
    });
    expect(t.relay.counts.joined).toBe(1);
    expect(t.relay.recordOf(hub.identity)?.daysSeen).toBe(1);
    hub.send({ t: "ping", n: 7 });
    expect(await hub.next("pong")).toEqual({ t: "pong", n: 7 });
  });

  test("a second link of the same identity replaces the first with 4001", async () => {
    const key = hubKey();
    const first = await StandInHub.connect(t.url, { key });
    await first.next("joined");
    const phone = new Client(phoneUrl(key.identity));
    await phone.open();
    await first.next("open");
    const second = await StandInHub.connect(t.url, { key });
    expect((await second.next("joined")).identity).toBe(key.identity);
    expect(await first.client.closed()).toBe(RELAY_CLOSE.replaced);
    // The first link's streams end with it.
    expect(await phone.closed()).toBe(PHONE_CLOSE.hubGone);
    expect(t.relay.counts.joined).toBe(1);
    expect(t.relay.counts.authenticated).toBe(1);
    // The new link carries the identity's streams.
    const again = new Client(phoneUrl(key.identity));
    await again.open();
    expect((await second.next("open")).stream).toBe(0);
  });

  test("a message 3 made with a key other than the one message 1 began is refused 4400", async () => {
    // XN binds message 3 to the handshake: a key's proof cannot be lifted into another's.
    const hub = new Client(`${t.url}/v1/hub`);
    await hub.open();
    const honest = must(startRelayInitiator("hub", hubKey().key));
    const other = must(startRelayInitiator("hub", hubKey().key));
    const hello = must(encodeRelayHello({ proto: [1, 1], hub: "0.1.0" }));
    hub.send(must(await honest.writeMessage(hello)));
    await until(() => hub.binaries.length > 0, "message 2");
    // The other handshake never saw message 2: its message 3 cannot verify.
    must(await other.writeMessage(hello));
    const stray = await other.writeMessage(new Uint8Array(0));
    hub.send(stray.ok ? stray.value : new Uint8Array(96));
    expect(await hub.closed()).toBe(RELAY_CLOSE.badFrame);
    expect(t.relay.counts.joined).toBe(0);
    expect(t.relay.counts.unauthenticated).toBe(0);
  });

  test("a message 3 with bytes changed is refused 4400 and nothing is joined", async () => {
    const hub = new Client(`${t.url}/v1/hub`);
    await hub.open();
    const handshake = must(startRelayInitiator("hub", hubKey().key));
    hub.send(
      must(await handshake.writeMessage(must(encodeRelayHello({ proto: [1, 1], hub: "0.1.0" })))),
    );
    await until(() => hub.binaries.length > 0, "message 2");
    must(await handshake.readMessage(hub.binaries[0] ?? new Uint8Array()));
    const message3 = must(await handshake.writeMessage(new TextEncoder().encode("{}")));
    message3[10] = (message3[10] ?? 0) ^ 1;
    hub.send(message3);
    expect(await hub.closed()).toBe(RELAY_CLOSE.badFrame);
    expect(t.relay.counts.joined).toBe(0);
  });

  test("no shared version is closed 4426", async () => {
    const hub = await StandInHub.connect(t.url, { proto: [2, 3] });
    expect(await hub.client.closed()).toBe(RELAY_CLOSE.noSharedVersion);
    expect(hub.welcome).toBeUndefined();
  });

  test("a text message during the handshake is closed 4400", async () => {
    const hub = new Client(`${t.url}/v1/hub`);
    await hub.open();
    hub.send('{"t":"release.get","id":1,"file":"hsn-firmware-1.0.0.hsnf","offset":0,"length":1}');
    expect(await hub.closed()).toBe(RELAY_CLOSE.badFrame);
  });

  test("a frame no schema accepts, and an unknown binary kind, are closed 4400", async () => {
    const a = await StandInHub.connect(t.url);
    await a.next("joined");
    a.client.send('{"t":"nonsense"}');
    expect(await a.client.closed()).toBe(RELAY_CLOSE.badFrame);
    const b = await StandInHub.connect(t.url);
    await b.next("joined");
    b.client.send(new Uint8Array([3, 0, 0, 0, 0, 1]));
    expect(await b.client.closed()).toBe(RELAY_CLOSE.badFrame);
    const c = await StandInHub.connect(t.url);
    await c.next("joined");
    // A release piece is the relay's to send, never a hub's.
    c.client.send(new Uint8Array([2, 0, 0, 0, 0, 1]));
    expect(await c.client.closed()).toBe(RELAY_CLOSE.badFrame);
  });

  test("a key the operator refuses is closed 4403, at join and when refused later", async () => {
    const refusedKey = hubKey();
    await t.stop();
    t = startRelay(folder, { refused: new Set([refusedKey.identity]) });
    const refused = await StandInHub.connect(t.url, { key: refusedKey });
    expect(await refused.client.closed()).toBe(RELAY_CLOSE.refused);
    expect(refused.joined).toBe(false);
    const later = await StandInHub.connect(t.url);
    await later.next("joined");
    t.relay.setRefused(new Set([later.identity]));
    expect(await later.client.closed()).toBe(RELAY_CLOSE.refused);
  });

  test("the handshake not finished within 10 s is closed 4408", async () => {
    const hub = new Client(`${t.url}/v1/hub`);
    await hub.open();
    await settle();
    t.clock.advance(PROTECTION_LIMITS.unauthenticated.message3WithinMs - 1);
    await settle();
    expect(hub.closeCode).toBeUndefined();
    t.clock.advance(1);
    expect(await hub.closed()).toBe(RELAY_CLOSE.handshakeTimeout);
    expect(t.relay.counts.unauthenticated).toBe(0);
  });

  test("other paths are 404 and never upgraded", async () => {
    const response = await fetch(`http://127.0.0.1:${t.listener.port}/v1/relay`);
    expect(response.status).toBe(404);
    const root = await fetch(`http://127.0.0.1:${t.listener.port}/`);
    expect(root.status).toBe(404);
  });
});

describe("a phone's stream", () => {
  test("carries each message one for one, unchanged both ways", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const phone = new Client(phoneUrl(hub.identity, "link"));
    await phone.open();
    const open = await hub.next("open");
    expect(open.path).toBe("link");
    expect(open.peer).toMatch(/^relay-[0-9a-f]{16}$/u);
    const toHub = [
      new Uint8Array(randomBytes(1)),
      new Uint8Array(randomBytes(RELAY_LIMITS.maxPhoneMessageBytes)),
      new Uint8Array(randomBytes(300)),
    ];
    for (const m of toHub) phone.send(m);
    await until(
      () => hub.streamMessages(open.stream).length === toHub.length,
      "the phone's messages",
    );
    expect(hub.streamMessages(open.stream)).toEqual(toHub);
    const toPhone = [
      new Uint8Array(randomBytes(48)),
      new Uint8Array(randomBytes(RELAY_LIMITS.maxPhoneMessageBytes)),
    ];
    for (const m of toPhone) hub.sendStream(open.stream, m);
    await until(() => phone.binaries.length === toPhone.length, "the hub's messages");
    expect(phone.binaries).toEqual(toPhone);
    // The phone closes: the hub hears its code.
    phone.close(1000);
    const close = await hub.next("close");
    expect(close).toEqual({ t: "close", stream: open.stream, code: 1000 });
  });

  test("stream numbers count up on a link and are never reused", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const numbers: number[] = [];
    for (let i = 0; i < 3; i++) {
      const phone = new Client(phoneUrl(hub.identity));
      await phone.open();
      numbers.push((await hub.next("open")).stream);
      phone.close();
      await hub.next("close");
    }
    expect(numbers).toEqual([0, 1, 2]);
  });

  test("the hub's close is passed to the phone unchanged", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    for (const code of [1008, 4003, PHONE_CLOSE.tryLater]) {
      const phone = new Client(phoneUrl(hub.identity));
      await phone.open();
      const open = await hub.next("open");
      hub.send({ t: "close", stream: open.stream, code });
      expect(await phone.closed()).toBe(code);
    }
  });

  test("a hub not connected is 4404; a malformed path or identity is 4400", async () => {
    const absent = new Client(phoneUrl(hubKey().identity));
    expect(await absent.closed()).toBe(PHONE_CLOSE.hubNotConnected);
    for (const bad of [
      `${t.url}/v1/phone/ABCDEFGHIJKLMNOPQRSTUVWXYZ/session`,
      `${t.url}/v1/phone/${hubKey().identity}/other`,
      `${t.url}/v1/phone/${hubKey().identity}/session/more`,
      `${t.url}/v1/phone/${hubKey().identity}/session?x=1`,
    ]) {
      const phone = new Client(bad);
      expect(await phone.closed()).toBe(PHONE_CLOSE.badPath);
    }
  });

  test("a text message is 1003, an empty one 1003, one over 65,535 bytes 1009", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const cases: [string | Uint8Array, number][] = [
      ["hello", PHONE_CLOSE.textMessage],
      [new Uint8Array(0), PHONE_CLOSE.textMessage],
      [new Uint8Array(RELAY_LIMITS.maxPhoneMessageBytes + 1), PHONE_CLOSE.tooLarge],
    ];
    for (const [message, code] of cases) {
      const phone = new Client(phoneUrl(hub.identity));
      await phone.open();
      const open = await hub.next("open");
      phone.send(message);
      expect(await phone.closed()).toBe(code);
      expect(await hub.next("close")).toEqual({ t: "close", stream: open.stream, code });
      expect(hub.streamMessages(open.stream)).toEqual([]);
    }
  });

  test("the hub's link closing ends its streams with 4410", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const phone = new Client(phoneUrl(hub.identity));
    await phone.open();
    await hub.next("open");
    hub.client.close(1000);
    expect(await phone.closed()).toBe(PHONE_CLOSE.hubGone);
  });

  test("a stream idle 90 s is closed 4410 both ways; one message resets the clock", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const phone = new Client(phoneUrl(hub.identity));
    await phone.open();
    const open = await hub.next("open");
    // Keep the hub's link alive meanwhile: presence closes a link silent 75 s.
    const ping = async () => {
      hub.send({ t: "ping", n: 1 });
      await hub.next("pong");
    };
    t.clock.advance(PROTECTION_LIMITS.slowClients.idlePhoneStreamMs / 2);
    await ping();
    phone.send(new Uint8Array([1]));
    await until(() => hub.streamMessages(open.stream).length === 1, "a message");
    t.clock.advance(PROTECTION_LIMITS.slowClients.idlePhoneStreamMs / 2);
    await ping();
    t.clock.advance(PROTECTION_LIMITS.slowClients.idlePhoneStreamMs / 2 - 1);
    await settle();
    expect(phone.closeCode).toBeUndefined();
    t.clock.advance(1);
    expect(await phone.closed()).toBe(PHONE_CLOSE.hubGone);
    expect(await hub.next("close")).toEqual({
      t: "close",
      stream: open.stream,
      code: PHONE_CLOSE.hubGone,
    });
  });

  test("the pseudonym is the same for one address, and never the address", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const peers: string[] = [];
    for (let i = 0; i < 2; i++) {
      const phone = new Client(phoneUrl(hub.identity));
      await phone.open();
      peers.push((await hub.next("open")).peer);
    }
    expect(peers[0]).toBe(peers[1]);
    expect(peers[0]).not.toContain("127");
    expect(events(t.log, "streamRefused")).toEqual([]);
  });
});

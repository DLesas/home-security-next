/**
 * Sessions on real loopback sockets (m2-design.md section 5, "Admitting a session (IK)";
 * section 10, "Shell tests": a replayed message 1 never takes a session; handshakes close after
 * 5 s; a client's fifth session closes its oldest; liveness only inside Noise; the order of
 * transport messages under load), with the protocol package's Noise as the client and a scripted
 * core. Limits are shortened where waiting for them would be slow; the 24-hour lifetime runs on
 * timers the test moves.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex, toHex } from "@hsn/protocol";
import { noiseVector, x25519StaticKey } from "@hsn/protocol/app";
import { clientId, connId } from "../../../src/core/model/ids.ts";
import { ClientKind } from "../../../src/core/model/rows.ts";
import { AppChannel, CLOSE, ConnIds } from "../../../src/shell/app/channel.ts";
import { MemoryClientKeys } from "../../../src/shell/app/client-keys.ts";
import { MemoryLinkSecrets } from "../../../src/shell/app/link-secrets.ts";
import { expectNoKeyLeaks } from "../setup/support/leak-guard.ts";
import {
  clientRow,
  IkClient,
  ManualTimers,
  must,
  openHub,
  rawRequest,
  session,
  sleep,
  staticKey,
  stopHubs,
  upgradeLines,
  WsClient,
} from "./support.ts";

afterEach(() => {
  stopHubs();
});

afterAll(() => {
  expectNoKeyLeaks();
});

const anna = staticKey(10);
const ben = staticKey(11);
const consoleKey = staticKey(12);
const stranger = staticKey(13);

function clients() {
  return [
    clientRow(7, anna.key.publicKey),
    clientRow(8, ben.key.publicKey),
    clientRow(9, consoleKey.key.publicKey, ClientKind.Console),
  ];
}

describe("admitting a session", () => {
  test("message 2 is HubHello; the session counts only from the first transport message", async () => {
    const side = openHub({ clients: clients() });
    const ws = await WsClient.open(side, "lan");
    const ik = new IkClient(side, anna.key);
    ws.send(await ik.message1({ proto: [1, 3], app: "1.2.3" }));
    const m2 = await ws.next();
    expect(await ik.message2(m2 ?? new Uint8Array(0))).toEqual({
      proto: 1,
      hub: "0.1.0",
      boot: 3,
      rev: 41,
      client: { id: 7, person: 2, kind: "web" },
      features: [],
    });
    await sleep(50);
    expect(side.of("clientConnected")).toEqual([]);
    expect(side.channel.sessions).toBe(0);
    ws.send(ik.seal({ t: "req", id: 1, op: "snapshot", body: {} }));
    const connected = await side.waitFor("clientConnected");
    expect(connected).toMatchObject({
      client: clientId(7),
      listener: "lan",
      proto: 1,
      app: "1.2.3",
    });
    const request = await side.waitFor("clientRequest");
    expect(request).toMatchObject({
      conn: connected.conn,
      client: clientId(7),
      request: { id: 1, seq: undefined, op: { op: "snapshot", body: {} } },
    });
    expect(side.events.indexOf(connected)).toBeLessThan(side.events.indexOf(request));
    expect(side.channel.sessions).toBe(1);
  });

  test("the hub's message 2 is the vector's, byte for byte, given the vector's message 1", async () => {
    const file = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../../packages/protocol/vectors/app-noise.json"),
        "utf8",
      ),
    ) as { vectors: unknown[] };
    const vector = noiseVector.parse(
      file.vectors.find((v) => (v as { name: string }).name.startsWith("session (IK), a browser")),
    );
    const hubPrivate = fromHex(vector.responder.static.private);
    const hubKey = { key: must(x25519StaticKey(hubPrivate)), privateKey: hubPrivate };
    const side = openHub({
      hubKey,
      hubVersion: "0.2.0",
      clients: [clientRow(7, fromHex(vector.initiator.static.public))],
      ephemeral: () => ({
        publicKey: fromHex(vector.responder.ephemeral.public),
        privateKey: fromHex(vector.responder.ephemeral.private),
      }),
    });
    const ws = await WsClient.open(side, "lan");
    ws.send(fromHex(vector.messages[0]?.message ?? ""));
    const m2 = await ws.next();
    expect(toHex(m2 ?? new Uint8Array(0))).toBe(vector.messages[1]?.message ?? "");
  });

  test("a replayed message 1 draws a message 2 but never takes a session, and its slot closes after 5 s ‡", async () => {
    const side = openHub({ clients: clients(), limits: { handshakeTimeoutMs: 300 } });
    const ik = new IkClient(side, anna.key);
    const m1 = await ik.message1();
    const first = await WsClient.open(side, "lan");
    first.send(m1);
    await ik.message2((await first.next()) ?? new Uint8Array(0));
    first.send(ik.seal({ t: "req", id: 1, op: "pong", body: {} }));
    await side.waitFor("clientConnected");
    // The replayer has message 1's bytes and nothing else.
    const replay = await WsClient.open(side, "lan");
    replay.send(m1);
    expect(await replay.next()).toBeDefined();
    expect(side.channel.handshakes).toBe(1);
    expect((await replay.waitClosed(2000))?.code).toBe(CLOSE.policy);
    expect(side.of("clientConnected")).toHaveLength(1);
    expect(side.channel.handshakes).toBe(0);
    expect(side.channel.sessions).toBe(1);
  });

  test("a connection that never speaks Noise is closed by the handshake rule", async () => {
    const side = openHub({ clients: clients(), limits: { handshakeTimeoutMs: 200 } });
    const idle = await WsClient.open(side, "lan");
    expect((await idle.waitClosed(2000))?.code).toBe(CLOSE.policy);
    expect(side.events).toEqual([]);
  });

  test("an unknown key gets no message 2", async () => {
    const side = openHub({ clients: clients() });
    const ws = await WsClient.open(side, "lan");
    ws.send(await new IkClient(side, stranger.key).message1());
    expect(await ws.next()).toBeUndefined();
    expect(ws.closedWith?.code).toBe(CLOSE.policy);
    expect(side.events).toEqual([]);
  });

  test("a removed client's key gets no message 2, from the commit that removed it", async () => {
    const side = openHub({ clients: clients() });
    side.keys.applyCommitted([
      {
        table: "clients",
        op: "upsert",
        row: { ...clientRow(7, anna.key.publicKey), removedMs: 5 },
      },
    ]);
    const ws = await WsClient.open(side, "lan");
    ws.send(await new IkClient(side, anna.key).message1());
    expect(await ws.next()).toBeUndefined();
  });

  test("a console client is accepted on the console's listener only", async () => {
    const side = openHub({ clients: clients() });
    const lan = await WsClient.open(side, "lan");
    lan.send(await new IkClient(side, consoleKey.key).message1());
    expect(await lan.next()).toBeUndefined();
    const { hello } = await session(side, consoleKey.key, "console");
    expect(hello).toMatchObject({ client: { id: 9, person: null, kind: "console" } });
    expect((await side.waitFor("clientConnected")).listener).toBe("console");
  });

  test("no version both speak: closed before message 2", async () => {
    const side = openHub({ clients: clients() });
    const ws = await WsClient.open(side, "lan");
    ws.send(await new IkClient(side, anna.key).message1({ proto: [2, 4], app: "9.0.0" }));
    expect(await ws.next()).toBeUndefined();
  });

  test("a malformed ClientHello gets no message 2", async () => {
    const side = openHub({ clients: clients() });
    for (const hello of [{ proto: [1, 1] }, { proto: [1, 1], app: "x", extra: 1 }, "hello"]) {
      const ws = await WsClient.open(side, "lan");
      ws.send(await new IkClient(side, anna.key).message1(hello));
      expect(await ws.next()).toBeUndefined();
    }
  });

  test("a client removed between message 1 and its proof gets no session", async () => {
    const side = openHub({ clients: clients() });
    const ws = await WsClient.open(side, "lan");
    const ik = new IkClient(side, anna.key);
    ws.send(await ik.message1());
    await ik.message2((await ws.next()) ?? new Uint8Array(0));
    side.keys.applyCommitted([{ table: "clients", op: "delete", key: { id: clientId(7) } }]);
    ws.send(ik.seal({ t: "req", id: 1, op: "pong", body: {} }));
    expect((await ws.waitClosed())?.code).toBe(CLOSE.removed);
    expect(side.of("clientConnected")).toEqual([]);
  });
});

describe("first", () => {
  test("is given to the core after clientConnected, and only once the session is proven", async () => {
    const side = openHub({ clients: clients() });
    const ws = await WsClient.open(side, "lan");
    const ik = new IkClient(side, anna.key);
    const first = { t: "req", id: 1, seq: 9, op: "disarm", body: { target: "mine" } };
    const m1 = await ik.message1({ proto: [1, 1], app: "1.0.0", first });
    ws.send(m1);
    await ik.message2((await ws.next()) ?? new Uint8Array(0));
    // A replay of message 1 alone: never reaches the core.
    const replay = await WsClient.open(side, "lan");
    replay.send(m1);
    await replay.next();
    await sleep(50);
    expect(side.of("clientRequest")).toEqual([]);
    ws.send(ik.seal({ t: "req", id: 2, op: "snapshot", body: {} }));
    const requests = [
      await side.waitFor("clientRequest"),
      await side.waitFor("clientRequest", (r) => r.request.id === 2),
    ];
    expect(requests[0]?.request).toEqual({
      id: 1,
      seq: 9,
      op: { op: "disarm", body: { target: "mine" } },
    });
    expect(side.events.map((e) => e.kind)).toEqual([
      "clientConnected",
      "clientRequest",
      "clientRequest",
    ]);
  });

  test("a first without seq, or a chunk, gets no message 2", async () => {
    const side = openHub({ clients: clients() });
    for (const first of [
      { t: "req", id: 1, op: "snapshot", body: {} },
      { t: "req", id: 1, op: "disarm", body: { target: "mine" } },
    ]) {
      const ws = await WsClient.open(side, "lan");
      ws.send(await new IkClient(side, anna.key).message1({ proto: [1, 1], app: "1", first }));
      expect(await ws.next()).toBeUndefined();
    }
  });
});

describe("limits", () => {
  test("at most 16 handshakes ‡ are open at once: the next upgrade is refused before any Noise", async () => {
    const side = openHub({
      clients: clients(),
      limits: { maxOpenHandshakes: 3, handshakesPerSecondPerAddress: 100 },
    });
    const open = await Promise.all([1, 2, 3].map(() => WsClient.open(side, "lan")));
    const host = `127.0.0.1:${side.lanPort}`;
    expect(
      (await rawRequest(side.lanPort, true, upgradeLines(host, `https://${host}`))).status,
    ).toBe(503);
    open[0]?.close();
    await sleep(50);
    expect(
      (await rawRequest(side.lanPort, true, upgradeLines(host, `https://${host}`))).status,
    ).toBe(101);
  });

  test("at most 10 handshakes a second ‡ from one address", async () => {
    const side = openHub({
      clients: clients(),
      limits: {
        handshakesPerSecondPerAddress: 4,
        handshakesPerSecond: 100,
        maxOpenHandshakes: 100,
      },
    });
    const host = `127.0.0.1:${side.consolePort}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (await rawRequest(side.consolePort, false, upgradeLines(host, `http://${host}`))).status,
      );
    expect(statuses).toEqual([101, 101, 101, 101, 503, 503]);
    await sleep(1050);
    expect(
      (await rawRequest(side.consolePort, false, upgradeLines(host, `http://${host}`))).status,
    ).toBe(101);
  });

  test("at most 100 handshakes a second ‡ in all", () => {
    const channel = new AppChannel({
      staticKey: anna.key,
      identity: new Uint8Array(16),
      hubVersion: "0",
      clientKeys: new MemoryClientKeys([]),
      linkSecrets: new MemoryLinkSecrets(),
      core: { hello: () => undefined, rev: () => 0 },
      emit: () => undefined,
      connIds: new ConnIds(),
      hubStatus: () => ({
        lastCommitMs: null,
        stagedItems: 0,
        databaseBytes: null,
        historyShortened: false,
        missingAfterRestartMs: null,
      }),
      limits: { handshakesPerSecond: 5, handshakesPerSecondPerAddress: 5, maxOpenHandshakes: 1000 },
      now: () => 0,
    });
    const admitted = ["a", "b", "c", "d", "e", "f", "g"].map(
      (address) => !channel.admit(address).refused,
    );
    expect(admitted).toEqual([true, true, true, true, true, false, false]);
  });

  test("a client's fifth session ‡ closes its oldest", async () => {
    const side = openHub({ clients: clients() });
    const sessions = [];
    for (let i = 0; i < 4; i++) {
      sessions.push(await session(side, anna.key));
      await side.waitFor("clientConnected", () => side.of("clientConnected").length === i + 1);
    }
    await session(side, ben.key);
    await side.waitFor("clientConnected", () => side.of("clientConnected").length === 5);
    const oldest = side.of("clientConnected")[0]?.conn;
    await session(side, anna.key);
    expect((await sessions[0]?.ws.waitClosed())?.code).toBe(CLOSE.replaced);
    expect(await side.waitFor("clientClosed")).toEqual({
      kind: "clientClosed",
      conn: oldest ?? connId(0),
      reason: "replaced",
    });
    expect(side.channel.sessionsOf(clientId(7))).toHaveLength(4);
    expect(side.channel.sessionsOf(clientId(8))).toHaveLength(1);
  });

  test("with 64 sessions ‡ in all, new handshakes are refused until one closes", async () => {
    const side = openHub({ clients: clients(), limits: { maxSessions: 2 } });
    const a = await session(side, anna.key);
    await session(side, ben.key);
    await side.waitFor("clientConnected", () => side.of("clientConnected").length === 2);
    const host = `127.0.0.1:${side.lanPort}`;
    expect(
      (await rawRequest(side.lanPort, true, upgradeLines(host, `https://${host}`))).status,
    ).toBe(503);
    a.ws.close();
    await side.waitFor("clientClosed");
    expect(
      (await rawRequest(side.lanPort, true, upgradeLines(host, `https://${host}`))).status,
    ).toBe(101);
  });

  test("a handshake proven while the hub is full is closed, not admitted", async () => {
    const side = openHub({ clients: clients(), limits: { maxSessions: 1 } });
    const ws = await WsClient.open(side, "lan");
    const ik = new IkClient(side, ben.key);
    ws.send(await ik.message1());
    await ik.message2((await ws.next()) ?? new Uint8Array(0));
    await session(side, anna.key);
    await side.waitFor("clientConnected");
    ws.send(ik.seal({ t: "req", id: 1, op: "pong", body: {} }));
    expect((await ws.waitClosed())?.code).toBe(CLOSE.policy);
    expect(side.of("clientConnected")).toHaveLength(1);
  });
});

describe("liveness, inside Noise", () => {
  test("a quiet session is sent an encrypted ping, and closed when nothing authenticated comes", async () => {
    const side = openHub({
      clients: clients(),
      limits: { pingAfterQuietMs: 150, livenessMs: 500 },
    });
    const { ws, ik } = await session(side, anna.key);
    const ping = await ws.next(2000);
    expect(ik.open(ping ?? new Uint8Array(0))).toEqual({ t: "evt", rev: 41, ev: "ping", body: {} });
    const closed = await ws.waitClosed(2000);
    expect(closed?.code).toBe(CLOSE.liveness);
    expect((await side.waitFor("clientClosed")).reason).toBe("liveness");
  });

  test("a pong keeps it open; WebSocket pings do not", async () => {
    const side = openHub({
      clients: clients(),
      limits: { pingAfterQuietMs: 100, livenessMs: 400 },
    });
    const answering = await session(side, anna.key);
    const silent = await session(side, ben.key);
    let id = 10;
    const timer = setInterval(() => {
      answering.ws.send(answering.ik.seal({ t: "req", id: id++, op: "pong", body: {} }));
    }, 100);
    const pinging = setInterval(() => {
      (silent.ws as unknown as { ping?: () => void }).ping?.();
    }, 50);
    const closed = await silent.ws.waitClosed(2000);
    clearInterval(timer);
    clearInterval(pinging);
    expect(closed?.code).toBe(CLOSE.liveness);
    expect(answering.ws.closedWith).toBeUndefined();
  });
});

describe("the 24-hour lifetime ‡", () => {
  test("closes the session with code 4000 and clientClosed lifetime, sending nothing first", async () => {
    const timers = new ManualTimers();
    const day = 24 * 3_600_000;
    // Liveness out of the way: only the lifetime can close it here.
    const side = openHub({
      clients: clients(),
      timers,
      now: () => timers.now,
      limits: { livenessMs: 2 * day, pingAfterQuietMs: 2 * day },
    });
    timers.advance(5_000);
    const { ws } = await session(side, anna.key);
    const connected = await side.waitFor("clientConnected");
    timers.advance(day - 1);
    await sleep(20);
    expect(ws.closedWith).toBeUndefined();
    timers.advance(1);
    const closed = await ws.waitClosed();
    expect(closed?.code).toBe(4000);
    expect(await ws.next(50)).toBeUndefined();
    expect(side.of("clientClosed")).toEqual([
      { kind: "clientClosed", conn: connected.conn, reason: "lifetime" },
    ]);
  });
});

describe("order and failure", () => {
  test("transport messages under load leave in order, each decrypting with the next nonce", async () => {
    const side = openHub({ clients: clients() });
    const { ws, ik } = await session(side, anna.key);
    const connected = await side.waitFor("clientConnected");
    for (let i = 0; i < 500; i++) {
      side.channel.perform({
        kind: "appSend",
        conn: connected.conn,
        message: { t: "evt", rev: 100 + i, ev: "ping", body: {} },
      });
    }
    for (let i = 0; i < 500; i++) {
      const message = await ws.next();
      expect(ik.open(message ?? new Uint8Array(0))).toEqual({
        t: "evt",
        rev: 100 + i,
        ev: "ping",
        body: {},
      });
    }
  });

  test("a message that fails to decrypt closes the session at once", async () => {
    const side = openHub({ clients: clients() });
    const { ws, ik } = await session(side, anna.key);
    await side.waitFor("clientConnected");
    const sealed = ik.seal({ t: "req", id: 2, op: "pong", body: {} });
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
    ws.send(sealed);
    expect((await ws.waitClosed())?.code).toBe(CLOSE.decryptFailed);
    expect((await side.waitFor("clientClosed")).reason).toBe("decryptFailed");
  });

  test("closeClient closes every session of the removed client", async () => {
    const side = openHub({ clients: clients() });
    const one = await session(side, anna.key);
    const two = await session(side, anna.key);
    const other = await session(side, ben.key);
    await side.waitFor("clientConnected", () => side.of("clientConnected").length === 3);
    side.channel.perform({ kind: "closeClient", client: clientId(7), reason: "removed" });
    expect((await one.ws.waitClosed())?.code).toBe(CLOSE.removed);
    expect((await two.ws.waitClosed())?.code).toBe(CLOSE.removed);
    expect(side.of("clientClosed").map((e) => e.reason)).toEqual(["removed", "removed"]);
    expect(other.ws.closedWith).toBeUndefined();
  });

  test("hubStatusRead is answered on its session with the writer's status", async () => {
    const side = openHub({ clients: clients() });
    const { ws, ik } = await session(side, anna.key);
    const connected = await side.waitFor("clientConnected");
    side.channel.perform({ kind: "hubStatusRead", conn: connected.conn, id: 4 });
    expect(ik.open((await ws.next()) ?? new Uint8Array(0))).toEqual({
      t: "res",
      id: 4,
      ok: true,
      body: {
        lastCommitMs: 5,
        stagedItems: 2,
        databaseBytes: 4096,
        historyShortened: false,
        missingAfterRestartMs: null,
      },
    });
  });
});

describe("requests the shell refuses", () => {
  test("not JSON, a bad shape, the seq rule: recorded without content, answered invalid when an id is known", async () => {
    const side = openHub({ clients: clients() });
    const { ws, ik } = await session(side, anna.key);
    const connected = await side.waitFor("clientConnected");
    const t = ik.transport;
    const raw = (bytes: Uint8Array) => {
      const sealed = t?.encrypt(bytes);
      if (sealed?.ok === true) ws.send(sealed.value);
    };
    raw(new TextEncoder().encode("{not json"));
    raw(Uint8Array.of(0xff, 0xfe));
    ws.send(ik.seal({ t: "req", id: 3, op: "nope", body: {} }));
    ws.send(
      ik.seal({
        t: "req",
        id: 4,
        op: "site.wifi",
        seq: 5,
        body: { name: "home", password: "hunter2-secret", extra: 1 },
      }),
    );
    ws.send(ik.seal({ t: "req", id: 5, op: "snapshot", seq: 3, body: {} }));
    ws.send(ik.seal({ t: "req", id: 6, op: "mode.switch", body: { mode: 1 } }));
    const replies = [];
    for (let i = 0; i < 4; i++) replies.push(ik.open((await ws.next()) ?? new Uint8Array(0)));
    expect(replies).toEqual([
      {
        t: "res",
        id: 3,
        ok: false,
        error: { code: "invalid", detail: { field: "op", reason: "format" } },
      },
      {
        t: "res",
        id: 4,
        ok: false,
        error: { code: "invalid", detail: { field: "", reason: "format" } },
      },
      {
        t: "res",
        id: 5,
        ok: false,
        error: { code: "invalid", detail: { field: "seq", reason: "format" } },
      },
      {
        t: "res",
        id: 6,
        ok: false,
        error: { code: "invalid", detail: { field: "seq", reason: "format" } },
      },
    ]);
    const rejected = side.of("inputRejected").map((e) => e.rejection);
    expect(rejected.map((r) => (r.source === "app" ? [r.conn, r.reason] : []))).toEqual([
      [connected.conn, "notJson"],
      [connected.conn, "notJson"],
      [connected.conn, "badShape"],
      [connected.conn, "badShape"],
      [connected.conn, "seqRule"],
      [connected.conn, "seqRule"],
    ]);
    expect(JSON.stringify(rejected)).not.toContain("hunter2");
    expect(side.of("clientRequest").map((e) => e.request.op.op)).toEqual([]);
  });

  test("fileChunk on the home network's listener is consoleOnly", async () => {
    const side = openHub({ clients: clients() });
    const { ws, ik } = await session(side, anna.key);
    ws.send(ik.seal({ t: "req", id: 2, op: "fileChunk", body: { job: 1, n: 0, data: "" } }));
    expect(ik.open((await ws.next()) ?? new Uint8Array(0))).toEqual({
      t: "res",
      id: 2,
      ok: false,
      error: { code: "consoleOnly", detail: {} },
    });
    expect(side.of("clientRequest").map((e) => e.request.op.op)).toEqual([]);
  });
});

describe("a fuzzed handshake", () => {
  function bare(limits = {}) {
    const events: unknown[] = [];
    const channel = new AppChannel({
      staticKey: staticKey(1).key,
      identity: new Uint8Array(16),
      hubVersion: "0",
      clientKeys: new MemoryClientKeys(clients()),
      linkSecrets: new MemoryLinkSecrets(),
      core: { hello: () => ({ boot: 1, rev: 0, person: 2 }), rev: () => 0 },
      emit: (event) => events.push(event),
      connIds: new ConnIds(),
      hubStatus: () => ({
        lastCommitMs: null,
        stagedItems: 0,
        databaseBytes: null,
        historyShortened: false,
        missingAfterRestartMs: null,
      }),
      limits: {
        handshakesPerSecondPerAddress: 1e6,
        handshakesPerSecond: 1e6,
        maxOpenHandshakes: 1e6,
        ...limits,
      },
    });
    return { channel, events };
  }

  function socket() {
    const state = { sent: [] as Uint8Array[], closed: undefined as number | undefined };
    return {
      state,
      socket: {
        send: (bytes: Uint8Array) => {
          state.sent.push(bytes);
          return { ok: true };
        },
        close: (code: number) => {
          state.closed = code;
        },
      },
    };
  }

  test("random messages 1 and altered real ones never draw message 2 nor reach the core", async () => {
    const { channel, events } = bare();
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const ik = await new IkClient(openHub({ clients: clients() }), anna.key).message1();
    const sockets = [];
    for (let i = 0; i < 400; i++) {
      const length = next() % 300;
      const bytes = i % 2 === 0 ? Uint8Array.from({ length }, () => next() % 256) : ik.slice();
      if (i % 2 === 1) {
        const at = next() % bytes.length;
        bytes[at] = (bytes[at] ?? 0) ^ (1 << (next() % 8));
      }
      const ticket = channel.admit("10.0.0.1");
      expect(ticket.refused).toBe(false);
      if (ticket.refused) continue;
      const s = socket();
      const conn = channel.open(ticket, s.socket, "lan");
      channel.receive(conn, bytes);
      sockets.push(s.state);
    }
    await sleep(200);
    expect(sockets.every((s) => s.sent.length === 0 && s.closed === CLOSE.policy)).toBe(true);
    expect(events).toEqual([]);
    expect(channel.handshakes).toBe(0);
    channel.stop();
  });

  test("messages past the few queued while message 1 is read close the handshake before message 2", async () => {
    const side = openHub({ clients: clients() });
    const m1 = await new IkClient(side, anna.key).message1();
    const channel = new AppChannel({
      staticKey: side.hub.key,
      identity: side.hub.identity,
      hubVersion: "0",
      clientKeys: new MemoryClientKeys(clients()),
      linkSecrets: new MemoryLinkSecrets(),
      core: { hello: () => ({ boot: 1, rev: 0, person: 2 }), rev: () => 0 },
      emit: () => undefined,
      connIds: new ConnIds(),
      hubStatus: () => ({
        lastCommitMs: null,
        stagedItems: 0,
        databaseBytes: null,
        historyShortened: false,
        missingAfterRestartMs: null,
      }),
      limits: { maxQueued: 4 },
    });
    const ticket = channel.admit("10.0.0.3");
    if (ticket.refused) return;
    const s = socket();
    const conn = channel.open(ticket, s.socket, "lan");
    channel.receive(conn, m1);
    for (let i = 0; i < 10; i++) channel.receive(conn, new Uint8Array(64).fill(i));
    await sleep(50);
    expect(s.state.closed).toBe(CLOSE.policy);
    expect(s.state.sent).toEqual([]);
    channel.stop();
  });

  test("a message 3 out of place, or many messages at once, closes the handshake", async () => {
    const { channel } = bare();
    const ticket = channel.admit("10.0.0.2");
    if (ticket.refused) return;
    const s = socket();
    const conn = channel.open(ticket, s.socket, "lan");
    for (let i = 0; i < 6; i++) channel.receive(conn, new Uint8Array(96).fill(i));
    await sleep(50);
    expect(s.state.closed).toBe(CLOSE.policy);
    expect(channel.handshakes).toBe(0);
    channel.stop();
  });
});

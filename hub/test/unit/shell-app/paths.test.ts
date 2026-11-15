/**
 * Which handshake a connection carries, and what a refused one tells the core (m2-design.md
 * section 11, "Step 1, wave 2: questions settled"): `/app` for a session (IK), `/app/link` and
 * `/app/restore` for the two XXpsk3 handshakes, each first message read only as its path's
 * handshake; `first` acted on only once the session is proven; and `clientRefused`, at most one
 * per address per minute with its count, the addresses past 64 ‡ as one `"many"`.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { clientId, tokenId } from "../../../src/core/model/ids.ts";
import { ClientKind } from "../../../src/core/model/rows.ts";
import { CLOSE, HANDSHAKE_PATHS, handshakeOfPath } from "../../../src/shell/app/channel.ts";
import {
  type ClientRefused,
  MANY_ADDRESSES,
  RefusalReporter,
} from "../../../src/shell/app/refusals.ts";
import { expectNoKeyLeaks, noteKey } from "../setup/support/leak-guard.ts";
import {
  clientRow,
  IkClient,
  LinkClient,
  ManualTimers,
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

const anna = staticKey(40);
const hubConsole = staticKey(41);
const phone = staticKey(42);
const FAST = { refusalWindowMs: 100 };

function clients() {
  return [
    clientRow(7, anna.key.publicKey),
    clientRow(9, hubConsole.key.publicKey, ClientKind.Console),
  ];
}

function secret(seed: number): Uint8Array {
  const bytes = new Uint8Array(16).fill(seed);
  noteKey(bytes);
  return bytes;
}

type Kind = "session" | "link" | "restore";

/** A real first message of each kind, its token given to the hub where it needs one. */
async function firstMessage(side: ReturnType<typeof openHub>, kind: Kind): Promise<Uint8Array> {
  if (kind === "session") return new IkClient(side, anna.key).message1();
  const client = new LinkClient(kind, secret(kind === "link" ? 1 : 2), phone.key);
  noteKey(client.psk);
  side.channel.perform({
    kind: "linkSecret",
    token: kind === "link" ? tokenId(4) : tokenId(2 ** 31),
    purpose: kind,
    askName: false,
    lookup: client.lookup,
    psk: client.psk,
  });
  return client.write({ proto: [1, 1], find: client.lookup });
}

describe("the path says the handshake", () => {
  test("three paths, each its own handshake; any other path is no channel", () => {
    expect(HANDSHAKE_PATHS).toEqual({
      session: "/app",
      link: "/app/link",
      restore: "/app/restore",
    });
    expect(handshakeOfPath("/app")).toBe("session");
    expect(handshakeOfPath("/app/link")).toBe("link");
    expect(handshakeOfPath("/app/restore")).toBe("restore");
    for (const other of ["/app/", "/app/link/", "/app/LINK", "/appx", "/"])
      expect(handshakeOfPath(other)).toBeUndefined();
  });

  test.each(["session", "link", "restore"] as const)(
    "on its own path, a %s's first message draws message 2",
    async (kind) => {
      const side = openHub({ clients: clients() });
      const m1 = await firstMessage(side, kind);
      const ws = await WsClient.open(side, "lan", undefined, kind);
      ws.send(m1);
      expect(await ws.next()).toBeDefined();
    },
  );

  const wrong = (["session", "link", "restore"] as const).flatMap((kind) =>
    (["session", "link", "restore"] as const)
      .filter((path) => path !== kind)
      .map((path) => [kind, path] as const),
  );
  test.each(wrong)(
    "a %s's first message on the %s path fails as that path's handshake fails",
    async (kind, path) => {
      const side = openHub({ clients: clients(), limits: FAST });
      const m1 = await firstMessage(side, kind);
      const ws = await WsClient.open(side, "lan", undefined, path);
      ws.send(m1);
      expect(await ws.next()).toBeUndefined();
      expect(ws.closedWith?.code).toBe(CLOSE.policy);
      expect(side.events).toEqual([]);
      await sleep(200);
      expect(side.refusals).toEqual([
        { kind: "clientRefused", address: "127.0.0.1", reason: "malformed", count: 1 },
      ]);
    },
  );

  test("an upgrade to a path that is no handshake is not the channel", async () => {
    const side = openHub({ clients: clients() });
    const host = `127.0.0.1:${side.consolePort}`;
    const answer = await rawRequest(side.consolePort, false, [
      ...upgradeLines(host, `http://${host}`).map((l) => l.replace("GET /app ", "GET /app/other ")),
    ]);
    expect(answer.status).not.toBe(101);
  });
});

describe("first", () => {
  test("a replayed message 1 with a first causes nothing in the core", async () => {
    const side = openHub({ clients: clients(), limits: { handshakeTimeoutMs: 150, ...FAST } });
    const ik = new IkClient(side, anna.key);
    const m1 = await ik.message1({
      proto: [1, 1],
      app: "1.0.0",
      first: { t: "req", id: 1, seq: 9, op: "disarm", body: { target: "mine" } },
    });
    for (let i = 0; i < 3; i++) {
      const replay = await WsClient.open(side, "lan");
      replay.send(m1);
      expect(await replay.next()).toBeDefined();
      expect((await replay.waitClosed(2000))?.code).toBe(CLOSE.policy);
    }
    await sleep(200);
    expect(side.events).toEqual([]);
    expect(new Set(side.refusals.map((r) => r.reason))).toEqual(new Set(["timeout"]));
    expect(side.refusals.reduce((n, r) => n + r.count, 0)).toBe(3);
  });
});

describe("clientRefused", () => {
  test("each reason the channel gives", async () => {
    const side = openHub({
      clients: clients(),
      limits: { ...FAST, handshakeTimeoutMs: 150, handshakesPerSecondPerAddress: 100 },
    });
    const reasons: string[] = [];
    const take = async (): Promise<void> => {
      await sleep(200);
      reasons.push(...side.refusals.splice(0).map((r) => r.reason));
    };
    // unknownKey
    let ws = await WsClient.open(side, "lan");
    ws.send(await new IkClient(side, staticKey(43).key).message1());
    await ws.waitClosed();
    await take();
    // removedKey
    side.keys.applyCommitted([
      {
        table: "clients",
        op: "upsert",
        row: { ...clientRow(7, anna.key.publicKey), removedMs: 3 },
      },
    ]);
    ws = await WsClient.open(side, "lan");
    ws.send(await new IkClient(side, anna.key).message1());
    await ws.waitClosed();
    await take();
    // consoleOnLan
    ws = await WsClient.open(side, "lan");
    ws.send(await new IkClient(side, hubConsole.key).message1());
    await ws.waitClosed();
    await take();
    // noVersion
    ws = await WsClient.open(side, "console");
    ws.send(await new IkClient(side, hubConsole.key).message1({ proto: [3, 4], app: "x" }));
    await ws.waitClosed();
    await take();
    // timeout
    ws = await WsClient.open(side, "console");
    await ws.waitClosed();
    await take();
    // malformed
    ws = await WsClient.open(side, "console");
    ws.send(new Uint8Array(10));
    await ws.waitClosed();
    await take();
    expect(reasons).toEqual([
      "unknownKey",
      "removedKey",
      "consoleOnLan",
      "noVersion",
      "timeout",
      "malformed",
    ]);
    expect(side.events).toEqual([]);
  });

  test("a refused upgrade is rateLimited", async () => {
    const side = openHub({
      clients: clients(),
      limits: { ...FAST, handshakesPerSecondPerAddress: 1 },
    });
    const host = `127.0.0.1:${side.consolePort}`;
    await rawRequest(side.consolePort, false, upgradeLines(host, `http://${host}`));
    for (let i = 0; i < 3; i++) {
      expect(
        (await rawRequest(side.consolePort, false, upgradeLines(host, `http://${host}`))).status,
      ).toBe(503);
    }
    await sleep(200);
    expect(side.refusals.filter((r) => r.reason === "rateLimited")).toEqual([
      { kind: "clientRefused", address: "127.0.0.1", reason: "rateLimited", count: 3 },
    ]);
  });

  test("a session that is admitted is no refusal", async () => {
    const side = openHub({ clients: clients(), limits: FAST });
    await session(side, anna.key);
    await side.waitFor("clientConnected", (e) => e.client === clientId(7));
    await sleep(200);
    expect(side.refusals).toEqual([]);
  });

  test("one per address per minute, counting the rest; past 64 addresses ‡ one for many", () => {
    const timers = new ManualTimers();
    const sent: ClientRefused[] = [];
    const reporter = new RefusalReporter(
      (r) => sent.push(r),
      (ms, run) => timers.after(ms, run),
    );
    reporter.refused("10.0.0.1", "unknownKey");
    reporter.refused("10.0.0.1", "timeout");
    reporter.refused("10.0.0.1", "unknownKey");
    for (let i = 0; i < 70; i++) reporter.refused(`10.1.0.${i}`, "malformed");
    timers.advance(59_999);
    expect(sent).toEqual([]);
    timers.advance(1);
    expect(sent).toHaveLength(65);
    expect(sent[0]).toEqual({
      kind: "clientRefused",
      address: "10.0.0.1",
      reason: "unknownKey",
      count: 3,
    });
    expect(sent.filter((r) => r.address !== MANY_ADDRESSES)).toHaveLength(64);
    expect(sent.at(-1)).toEqual({
      kind: "clientRefused",
      address: MANY_ADDRESSES,
      reason: "malformed",
      count: 7,
    });
    // A new minute starts with the next refusal.
    reporter.refused("10.0.0.1", "noVersion");
    timers.advance(60_000);
    expect(sent.at(-1)).toEqual({
      kind: "clientRefused",
      address: "10.0.0.1",
      reason: "noVersion",
      count: 1,
    });
    expect(sent).toHaveLength(66);
  });

  test("what is held is sent when the hub stops", () => {
    const timers = new ManualTimers();
    const sent: ClientRefused[] = [];
    const reporter = new RefusalReporter(
      (r) => sent.push(r),
      (ms, run) => timers.after(ms, run),
    );
    reporter.refused("10.0.0.9", "timeout");
    reporter.flush();
    expect(sent).toEqual([
      { kind: "clientRefused", address: "10.0.0.9", reason: "timeout", count: 1 },
    ]);
    timers.advance(60_000);
    expect(sent).toHaveLength(1);
  });
});

describe("unknownToken", () => {
  test("a find that names no live token is counted per address, and is no token's try", async () => {
    const side = openHub({ clients: clients(), limits: FAST });
    const client = new LinkClient("link", secret(9), phone.key);
    const ws = await WsClient.open(side, "lan", undefined, "link");
    ws.send(await client.write({ proto: [1, 1], find: client.lookup }));
    expect(await ws.next()).toBeUndefined();
    await sleep(200);
    expect(side.events).toEqual([]);
    expect(side.refusals).toEqual([
      { kind: "clientRefused", address: "127.0.0.1", reason: "unknownToken", count: 1 },
    ]);
  });
});

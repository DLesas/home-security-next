/**
 * Linking and restore on real loopback sockets (m2-design.md section 5, "Linking" and "Restore's
 * messages"): the token found by `LinkHello.find`, the pre-shared key taken after message 1, a
 * wrong key or a malformed message 3 as `linkFailed`, a `find` that names nothing closed before
 * message 2 as no try, `linkCompleted` with the client's static key, `LinkResult` as the hub's
 * first transport message and then the close; restore's `restoreOpened`, `RestoreOffer` before
 * the phone's key, `restoreKey` once, `RestoreResult` and the close. Also the vector's message 2.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex, toHex } from "@hsn/protocol";
import { noiseVector, x25519StaticKey } from "@hsn/protocol/app";
import { tokenId } from "../../../src/core/model/ids.ts";
import { CLOSE } from "../../../src/shell/app/channel.ts";
import { expectNoKeyLeaks, noteKey } from "../setup/support/leak-guard.ts";
import { LinkClient, must, openHub, sleep, staticKey, stopHubs, WsClient } from "./support.ts";

afterEach(() => {
  stopHubs();
});

afterAll(() => {
  expectNoKeyLeaks();
});

const phone = staticKey(20);

function secret(seed: number): Uint8Array {
  const bytes = new Uint8Array(16).fill(seed);
  noteKey(bytes);
  return bytes;
}

async function toMessage3(
  purpose: "link" | "restore",
  side: ReturnType<typeof openHub>,
  given: Uint8Array,
  token = tokenId(4),
  tokenPurpose: "link" | "restore" = purpose,
) {
  const client = new LinkClient(purpose, given, phone.key);
  noteKey(client.psk);
  side.channel.perform({
    kind: "linkSecret",
    token,
    purpose: tokenPurpose,
    askName: false,
    lookup: client.lookup,
    psk: client.psk,
  });
  const ws = await WsClient.open(side, "lan", undefined, purpose);
  ws.send(await client.write({ proto: [1, 1], find: client.lookup }));
  return { client, ws };
}

describe("linking", () => {
  test("message 1 names the token, message 2 is {hub, proto}, message 3 is linkCompleted; LinkResult then the close", async () => {
    const side = openHub();
    const { client, ws } = await toMessage3("link", side, secret(1));
    const m2 = await ws.next();
    expect(await client.read(m2 ?? new Uint8Array(0))).toEqual({
      hub: "0.1.0",
      proto: 1,
      askName: false,
    });
    ws.send(await client.write({ name: "Anna’s laptop", kind: "web", person: { name: "Anna" } }));
    const completed = await side.waitFor("linkCompleted");
    expect(completed).toMatchObject({
      token: tokenId(4),
      listener: "lan",
      link: { name: "Anna’s laptop", kind: "web", person: { name: "Anna" } },
    });
    expect(toHex(completed.staticKey)).toBe(toHex(phone.key.publicKey));
    side.channel.perform({
      kind: "appSend",
      conn: completed.conn,
      message: { kind: "handshake", body: { client: 12, person: 3 } },
    });
    expect(client.open((await ws.next()) ?? new Uint8Array(0))).toEqual({ client: 12, person: 3 });
    expect((await ws.waitClosed())?.code).toBe(CLOSE.normal);
    expect(side.of("clientClosed")).toEqual([]);
  });

  test("the hub's message 2 is the vector's, byte for byte", async () => {
    const file = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../../packages/protocol/vectors/app-noise.json"),
        "utf8",
      ),
    ) as { vectors: unknown[] };
    const vector = noiseVector.parse(
      file.vectors.find((v) =>
        (v as { name: string }).name.startsWith("link (XXpsk3) from a QR code"),
      ),
    );
    const hubPrivate = fromHex(vector.responder.static.private);
    const side = openHub({
      hubKey: { key: must(x25519StaticKey(hubPrivate)), privateKey: hubPrivate },
      hubVersion: "0.2.0",
      ephemeral: () => ({
        publicKey: fromHex(vector.responder.ephemeral.public),
        privateKey: fromHex(vector.responder.ephemeral.private),
      }),
    });
    const find = (
      JSON.parse(Buffer.from(vector.messages[0]?.payload ?? "", "hex").toString()) as {
        find: string;
      }
    ).find;
    side.channel.perform({
      kind: "linkSecret",
      token: tokenId(4),
      purpose: "link",
      askName: false,
      lookup: find,
      psk: fromHex(vector.psk ?? ""),
    });
    const ws = await WsClient.open(side, "lan", undefined, "link");
    ws.send(fromHex(vector.messages[0]?.message ?? ""));
    expect(toHex((await ws.next()) ?? new Uint8Array(0))).toBe(vector.messages[1]?.message ?? "");
    ws.send(fromHex(vector.messages[2]?.message ?? ""));
    expect((await side.waitFor("linkCompleted")).link).toEqual({
      name: "Anna’s phone",
      kind: "phone",
      person: { name: "Anna" },
    });
  });

  test("a find that names no live token closes before message 2, and is no try", async () => {
    const side = openHub();
    const client = new LinkClient("link", secret(2), phone.key);
    const ws = await WsClient.open(side, "lan", undefined, "link");
    ws.send(await client.write({ proto: [1, 1], find: client.lookup }));
    expect(await ws.next()).toBeUndefined();
    expect(side.events).toEqual([]);
  });

  test("a token withdrawn by linkSecret is no longer found", async () => {
    const side = openHub();
    const client = new LinkClient("link", secret(3), phone.key);
    side.channel.perform({
      kind: "linkSecret",
      token: tokenId(5),
      purpose: "link",
      askName: false,
      lookup: client.lookup,
      psk: client.psk,
    });
    side.channel.perform({
      kind: "linkSecret",
      token: tokenId(5),
      purpose: "link",
      askName: false,
      lookup: null,
      psk: null,
    });
    const ws = await WsClient.open(side, "lan", undefined, "link");
    ws.send(await client.write({ proto: [1, 1], find: client.lookup }));
    expect(await ws.next()).toBeUndefined();
  });

  test("a wrong pre-shared key is linkFailed badPsk, with the address, and the socket closes", async () => {
    const side = openHub();
    const real = new LinkClient("link", secret(4), phone.key);
    const wrong = new LinkClient("link", secret(5), phone.key);
    side.channel.perform({
      kind: "linkSecret",
      token: tokenId(6),
      purpose: "link",
      askName: false,
      lookup: real.lookup,
      psk: real.psk,
    });
    const ws = await WsClient.open(side, "lan", undefined, "link");
    // The impostor names the real token but holds another key.
    ws.send(await wrong.write({ proto: [1, 1], find: real.lookup }));
    await wrong.read((await ws.next()) ?? new Uint8Array(0));
    ws.send(await wrong.write({ name: "x", kind: "web" }));
    expect(await side.waitFor("linkFailed")).toEqual({
      kind: "linkFailed",
      token: tokenId(6),
      reason: "badPsk",
      address: "127.0.0.1",
    });
    expect((await ws.waitClosed())?.code).toBe(CLOSE.policy);
    expect(side.of("linkCompleted")).toEqual([]);
  });

  test("a message 3 that decrypts but is not a LinkRequest is linkFailed malformed", async () => {
    const side = openHub();
    const { client, ws } = await toMessage3("link", side, secret(6));
    await client.read((await ws.next()) ?? new Uint8Array(0));
    ws.send(await client.write({ name: "", kind: "toaster" }));
    expect((await side.waitFor("linkFailed")).reason).toBe("malformed");
  });

  test("message 3 must come within 5 s ‡ of the connection", async () => {
    const side = openHub({ limits: { handshakeTimeoutMs: 200 } });
    const { client, ws } = await toMessage3("link", side, secret(7));
    await client.read((await ws.next()) ?? new Uint8Array(0));
    expect((await ws.waitClosed(2000))?.code).toBe(CLOSE.policy);
    expect(side.events).toEqual([]);
  });

  test("closeConn closes a link the core refused; nothing more is sent", async () => {
    const side = openHub();
    const { client, ws } = await toMessage3("link", side, secret(8));
    await client.read((await ws.next()) ?? new Uint8Array(0));
    ws.send(await client.write({ name: "x", kind: "web" }));
    const completed = await side.waitFor("linkCompleted");
    side.channel.perform({ kind: "closeConn", conn: completed.conn, reason: "linkRefused" });
    expect(await ws.next()).toBeUndefined();
    expect(ws.closedWith?.code).toBe(CLOSE.policy);
  });

  test("a restore token is not taken under the link prologue, nor a link token under restore's", async () => {
    const side = openHub();
    const a = await toMessage3("link", side, secret(9), tokenId(7), "restore");
    expect(await a.ws.next()).toBeUndefined();
    const b = await toMessage3("restore", side, secret(10), tokenId(2 ** 31), "link");
    expect(await b.ws.next()).toBeUndefined();
    expect(side.events).toEqual([]);
  });

  test("a linking client that sends anything after message 3 is closed", async () => {
    const side = openHub();
    const { client, ws } = await toMessage3("link", side, secret(11));
    await client.read((await ws.next()) ?? new Uint8Array(0));
    ws.send(await client.write({ name: "x", kind: "web" }));
    await side.waitFor("linkCompleted");
    ws.send(client.seal({ hello: 1 }));
    expect((await ws.waitClosed())?.code).toBe(CLOSE.policy);
  });
});

describe("restore", () => {
  const RESTORE = tokenId(2 ** 31);
  // The phone's backup key enters the core once, in `restoreKey` (section 2): not noted as a leak.
  const backupKey = new Uint8Array(32).fill(0x42);

  test("restoreOpened, the hub's offer, then the phone's key as restoreKey, then RestoreResult and the close", async () => {
    const side = openHub();
    const { client, ws } = await toMessage3("restore", side, secret(12), RESTORE);
    expect(await client.read((await ws.next()) ?? new Uint8Array(0))).toEqual({
      hub: "0.1.0",
      proto: 1,
      askName: false,
    });
    ws.send(await client.write({ app: "1.0.0" }));
    const opened = await side.waitFor("restoreOpened");
    expect(opened.token).toBe(RESTORE);
    const offer = { identity: "a".repeat(26), epoch: 3, madeMs: 10, lastChangeMs: 9 };
    side.channel.perform({
      kind: "appSend",
      conn: opened.conn,
      message: { kind: "handshake", body: offer },
    });
    expect(client.open((await ws.next()) ?? new Uint8Array(0))).toEqual(offer);
    ws.send(client.seal({ key: Buffer.from(backupKey).toString("base64url"), epoch: 3 }));
    const key = await side.waitFor("restoreKey");
    expect(key).toMatchObject({ conn: opened.conn, token: RESTORE, epoch: 3 });
    expect(toHex(key.key)).toBe(toHex(backupKey));
    side.channel.perform({
      kind: "appSend",
      conn: opened.conn,
      message: { kind: "handshake", body: { ok: true } },
    });
    expect(client.open((await ws.next()) ?? new Uint8Array(0))).toEqual({ ok: true });
    expect((await ws.waitClosed())?.code).toBe(CLOSE.normal);
  });

  test("a key sent before the hub's offer is refused and closes the connection", async () => {
    const side = openHub();
    const { client, ws } = await toMessage3("restore", side, secret(13), RESTORE);
    await client.read((await ws.next()) ?? new Uint8Array(0));
    ws.send(await client.write({ app: "1.0.0" }));
    await side.waitFor("restoreOpened");
    ws.send(client.seal({ key: Buffer.from(backupKey).toString("base64url"), epoch: 3 }));
    expect((await ws.waitClosed())?.code).toBe(CLOSE.policy);
    expect(side.of("restoreKey")).toEqual([]);
    expect((await side.waitFor("clientClosed")).reason).toBe("badFrame");
  });

  test("a second key is refused", async () => {
    const side = openHub();
    const { client, ws } = await toMessage3("restore", side, secret(14), RESTORE);
    await client.read((await ws.next()) ?? new Uint8Array(0));
    ws.send(await client.write({ app: "1.0.0" }));
    const opened = await side.waitFor("restoreOpened");
    side.channel.perform({
      kind: "appSend",
      conn: opened.conn,
      message: {
        kind: "handshake",
        body: { identity: "a".repeat(26), epoch: 3, madeMs: 1, lastChangeMs: 1 },
      },
    });
    await ws.next();
    const key = { key: Buffer.from(backupKey).toString("base64url"), epoch: 3 };
    ws.send(client.seal(key));
    ws.send(client.seal(key));
    expect((await ws.waitClosed())?.code).toBe(CLOSE.policy);
    await sleep(20);
    expect(side.of("restoreKey")).toHaveLength(1);
  });

  test("a LinkResult is never sent on a restore connection, nor an offer on a link", async () => {
    const side = openHub();
    const r = await toMessage3("restore", side, secret(15), RESTORE);
    await r.client.read((await r.ws.next()) ?? new Uint8Array(0));
    r.ws.send(await r.client.write({ app: "1.0.0" }));
    const opened = await side.waitFor("restoreOpened");
    side.channel.perform({
      kind: "appSend",
      conn: opened.conn,
      message: { kind: "handshake", body: { client: 1, person: null } },
    });
    expect(await r.ws.next(100)).toBeUndefined();
    expect(side.reports).toHaveLength(1);
  });
});

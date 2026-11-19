/**
 * Channel version 2 in the session layer (docs/m4-design.md section 9; docs/m3-m4-plan.md): the
 * hub speaks 1 and 2, a session agrees the highest both speak, and every request is read as its
 * session's version reads it. A version 1 web client and a version 2 client side by side: the
 * first served exactly as before, never sent anything only version 2 names; the second reaching
 * the core with version 2's operations.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { HUB_PROTO, versionGate } from "../../../src/shell/app/channel.ts";
import { clientId } from "../../../src/core/model/ids.ts";
import { ClientKind } from "../../../src/core/model/rows.ts";
import {
  clientRow,
  IkClient,
  openHub,
  staticKey,
  stopHubs,
  WsClient,
  type HubSide,
} from "./support.ts";

afterEach(() => {
  stopHubs();
});

const web = staticKey(51);
const phone = staticKey(52);

function clients() {
  return [clientRow(7, web.key.publicKey), clientRow(8, phone.key.publicKey, ClientKind.Phone)];
}

/** A session of `proto` on the home listener, admitted by a first `pong`. */
async function sessionOf(
  side: HubSide,
  key: typeof web.key,
  proto: [number, number],
  first?: unknown,
): Promise<{ ws: WsClient; ik: IkClient; hello: unknown }> {
  const ws = await WsClient.open(side, "lan");
  const ik = new IkClient(side, key);
  ws.send(await ik.message1({ proto, app: "1.0.0", ...(first === undefined ? {} : { first }) }));
  const m2 = await ws.next();
  expect(m2).toBeDefined();
  const hello = await ik.message2(m2 ?? new Uint8Array(0));
  ws.send(ik.seal({ t: "req", id: 1000, op: "pong", body: {} }));
  return { ws, ik, hello };
}

const PUSH_REGISTER = {
  platform: "fcm",
  environment: "production",
  token: "fcm-token-1",
  keyId: "0102030405060708",
  key: "A".repeat(43),
};

describe("the version gate", () => {
  test("the hub speaks 1 and 2", () => {
    expect(HUB_PROTO).toEqual([1, 2]);
  });

  test("version 1 and version 2 side by side: each agrees its own, the core told which", async () => {
    const side = openHub({ clients: clients() });
    const one = await sessionOf(side, web.key, [1, 1]);
    const two = await sessionOf(side, phone.key, [1, 2]);
    expect(one.hello).toMatchObject({ proto: 1 });
    expect(two.hello).toMatchObject({ proto: 2 });
    await side.waitFor("clientConnected", (e) => e.client === clientId(8));
    expect(side.of("clientConnected").map((e) => [e.client, e.proto])).toEqual([
      [clientId(7), 1],
      [clientId(8), 2],
    ]);
  });

  test("a version 2 operation from a version 1 session: protoUnsupported, notInVersion, not to the core", async () => {
    const side = openHub({ clients: clients() });
    const one = await sessionOf(side, web.key, [1, 1]);
    one.ws.send(one.ik.seal({ t: "req", id: 4, seq: 1, op: "push.register", body: PUSH_REGISTER }));
    expect(one.ik.open((await one.ws.next()) ?? new Uint8Array(0))).toEqual({
      t: "res",
      id: 4,
      ok: false,
      error: { code: "protoUnsupported", detail: { speaks: [1, 2] } },
    });
    const rejected = await side.waitFor("inputRejected");
    expect(rejected.rejection).toMatchObject({ source: "app", reason: "notInVersion" });
    expect(side.of("clientRequest")).toEqual([]);
  });

  test("the same from a version 2 session reaches the core as version 2's operation", async () => {
    const side = openHub({ clients: clients() });
    const two = await sessionOf(side, phone.key, [2, 2]);
    two.ws.send(two.ik.seal({ t: "req", id: 4, seq: 1, op: "push.register", body: PUSH_REGISTER }));
    const request = await side.waitFor("clientRequest");
    expect(JSON.parse(JSON.stringify(request.request)) as unknown).toEqual({
      id: 4,
      seq: 1,
      op: { op: "push.register", body: PUSH_REGISTER },
    });
    // Version 2's rules hold too: a change without `seq`, a body of the wrong shape.
    two.ws.send(two.ik.seal({ t: "req", id: 5, op: "push.test", body: {} }));
    two.ws.send(
      two.ik.seal({ t: "req", id: 6, seq: 2, op: "push.register", body: { platform: "x" } }),
    );
    two.ws.send(two.ik.seal({ t: "req", id: 7, op: "no.such", body: {} }));
    const replies = [];
    for (let i = 0; i < 3; i++)
      replies.push(two.ik.open((await two.ws.next()) ?? new Uint8Array(0)));
    expect(replies).toEqual([
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
        error: { code: "invalid", detail: { field: "platform", reason: "format" } },
      },
      {
        t: "res",
        id: 7,
        ok: false,
        error: { code: "invalid", detail: { field: "op", reason: "format" } },
      },
    ]);
    await side.waitFor("inputRejected", () => side.of("inputRejected").length === 3);
    expect(
      side.of("inputRejected").map((e) => e.rejection.source === "app" && e.rejection.reason),
    ).toEqual(["seqRule", "badShape", "badShape"]);
  });

  test("a version 1 operation on either version reads the same", async () => {
    const side = openHub({ clients: clients() });
    const one = await sessionOf(side, web.key, [1, 1]);
    const two = await sessionOf(side, phone.key, [1, 2]);
    one.ws.send(one.ik.seal({ t: "req", id: 2, op: "snapshot", body: {} }));
    two.ws.send(two.ik.seal({ t: "req", id: 2, op: "snapshot", body: {} }));
    await side.waitFor("clientRequest", () => side.of("clientRequest").length === 2);
    expect(side.of("clientRequest").map((e) => e.request)).toEqual([
      { id: 2, seq: undefined, op: { op: "snapshot", body: {} } },
      { id: 2, seq: undefined, op: { op: "snapshot", body: {} } },
    ]);
  });

  test("an event only version 2 names reaches the version 2 session only; the next one reaches both", async () => {
    const side = openHub({ clients: clients() });
    const one = await sessionOf(side, web.key, [1, 1]);
    const two = await sessionOf(side, phone.key, [1, 2]);
    await side.waitFor("clientConnected", () => side.of("clientConnected").length === 2);
    const [c1, c2] = side.of("clientConnected").map((e) => e.conn);
    const deviceUpdate = {
      t: "evt",
      rev: 50,
      ev: "deviceUpdate",
      body: {
        device: 3,
        image: "0102030405060708",
        state: "offered",
        held: null,
        method: "radio",
        bytes: 0,
        of: 10,
      },
    } as never;
    const door = {
      t: "evt",
      rev: 51,
      ev: "door",
      body: { sensor: 3, open: true, atMs: 1 },
    } as const;
    for (const conn of [c1, c2]) {
      if (conn === undefined) continue;
      side.channel.perform({ kind: "appSend", conn, message: deviceUpdate });
      side.channel.perform({ kind: "appSend", conn, message: door });
    }
    // Version 1: only the door, and its stream's nonces still follow (it decrypts).
    expect(one.ik.open((await one.ws.next()) ?? new Uint8Array(0))).toMatchObject({
      ev: "door",
      rev: 51,
    });
    expect(two.ik.open((await two.ws.next()) ?? new Uint8Array(0))).toMatchObject({
      ev: "deviceUpdate",
    });
    expect(two.ik.open((await two.ws.next()) ?? new Uint8Array(0))).toMatchObject({ ev: "door" });
    expect(await one.ws.next(100)).toBeUndefined();
  });

  test("a refusal only version 2 can say goes to a version 1 session as protoUnsupported", async () => {
    const side = openHub({ clients: clients() });
    const one = await sessionOf(side, web.key, [1, 1]);
    const two = await sessionOf(side, phone.key, [2, 2]);
    await side.waitFor("clientConnected", () => side.of("clientConnected").length === 2);
    const [c1, c2] = side.of("clientConnected").map((e) => e.conn);
    const refusal = {
      t: "res",
      id: 9,
      ok: false,
      error: { code: "invalid", detail: { field: "url", reason: "notLocal" } },
    } as never;
    for (const conn of [c1, c2])
      if (conn !== undefined) side.channel.perform({ kind: "appSend", conn, message: refusal });
    expect(one.ik.open((await one.ws.next()) ?? new Uint8Array(0))).toEqual({
      t: "res",
      id: 9,
      ok: false,
      error: { code: "protoUnsupported", detail: { speaks: [1, 2] } },
    });
    expect(two.ik.open((await two.ws.next()) ?? new Uint8Array(0))).toEqual({
      t: "res",
      id: 9,
      ok: false,
      error: { code: "invalid", detail: { field: "url", reason: "notLocal" } },
    });
  });

  test("first, read as the session's version: a version 2 change is taken, refused on version 1", async () => {
    const side = openHub({ clients: clients() });
    const first = { t: "req", id: 1, seq: 3, op: "push.test", body: {} };
    await sessionOf(side, phone.key, [2, 2], first);
    const request = await side.waitFor("clientRequest");
    expect(request.request.op).toEqual({ op: "push.test", body: {} });
    const ws = await WsClient.open(side, "lan");
    ws.send(await new IkClient(side, web.key).message1({ proto: [1, 1], app: "1", first }));
    expect(await ws.next(300)).toBeUndefined();
  });
});

describe("versionGate", () => {
  test("version 2 sees everything as it is", () => {
    const evt = { t: "evt", rev: 1, ev: "deviceUpdate", body: {} };
    const res = {
      t: "res",
      id: 1,
      ok: false,
      error: { code: "busy", detail: { because: "rollout" } },
    };
    expect(versionGate(2, evt)).toBe(evt);
    expect(versionGate(2, res)).toBe(res);
  });

  test("version 1: an event it does not name is dropped, a version 2 error made protoUnsupported", () => {
    expect(versionGate(1, { t: "evt", rev: 1, ev: "deviceUpdate", body: {} })).toBeUndefined();
    const ping = { t: "evt", rev: 1, ev: "ping", body: {} };
    expect(versionGate(1, ping)).toBe(ping);
    expect(
      versionGate(1, {
        t: "res",
        id: 1,
        ok: false,
        error: { code: "busy", detail: { because: "rollout" } },
      }),
    ).toEqual({
      t: "res",
      id: 1,
      ok: false,
      error: { code: "protoUnsupported", detail: { speaks: [1, 2] } },
    });
    const v1 = {
      t: "res",
      id: 1,
      ok: false,
      error: { code: "busy", detail: { because: "upload" } },
    };
    expect(versionGate(1, v1)).toEqual(v1);
    const ok = { t: "res", id: 1, ok: true, body: {} };
    expect(versionGate(1, ok)).toBe(ok);
    // A handshake's payload has no `t`: as it is.
    const link = { client: 1, person: 2 };
    expect(versionGate(1, link)).toBe(link);
  });
});

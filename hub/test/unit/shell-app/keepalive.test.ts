/**
 * The keepalive is the shell's (m2-design.md section 5, the wave 2 ruling): the channel sends an
 * encrypted `ping` to a session quiet for 20 s ‡, carrying the last `rev` that session was sent,
 * and takes `pong` itself; the core gets no input for it and the client no answer, and learns of
 * a dead session only from `clientClosed {reason: "liveness"}` 60 s ‡ after the last
 * authenticated message. A `pong` that answers no `ping`, or comes again, is the same as any; a
 * replayed one fails to decrypt; a flood of them costs the core nothing.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { clientId } from "../../../src/core/model/ids.ts";
import { CLOSE } from "../../../src/shell/app/channel.ts";
import { expectNoKeyLeaks } from "../setup/support/leak-guard.ts";
import {
  clientRow,
  ManualTimers,
  openHub,
  session,
  sleep,
  staticKey,
  stopHubs,
} from "./support.ts";

afterEach(() => {
  stopHubs();
});

afterAll(() => {
  expectNoKeyLeaks();
});

const anna = staticKey(70);
const pong = (id: number) => ({ t: "req", id, op: "pong", body: {} });

async function opened(limits = {}, timers?: ManualTimers) {
  const side = openHub({
    clients: [clientRow(7, anna.key.publicKey)],
    limits,
    ...(timers === undefined ? {} : { timers, now: () => timers.now }),
  });
  const s = await session(side, anna.key);
  await side.waitFor("clientConnected", (e) => e.client === clientId(7));
  return { side, ...s };
}

describe("pong", () => {
  test("is taken by the shell: no input for the core, no answer to the client", async () => {
    const { side, ws, ik } = await opened();
    const before = side.events.length;
    for (let id = 2; id < 6; id++) ws.send(ik.seal(pong(id)));
    ws.send(ik.seal({ t: "req", id: 9, op: "snapshot", body: {} }));
    await side.waitFor("clientRequest", (e) => e.request.id === 9);
    // Only the snapshot reached the core; the session's own proof was a pong, and went nowhere.
    expect(side.events.slice(before).map((e) => e.kind)).toEqual(["clientRequest"]);
    expect(side.of("clientRequest").map((e) => e.request.op.op)).toEqual(["snapshot"]);
    expect(await ws.next(150)).toBeUndefined();
  });

  test("one that answers no ping, or comes again, changes nothing but counting as heard", async () => {
    const timers = new ManualTimers();
    const { side, ws, ik } = await opened({ pingAfterQuietMs: 20_000, livenessMs: 60_000 }, timers);
    const before = side.events.length;
    ws.send(ik.seal(pong(2)));
    ws.send(ik.seal(pong(2)));
    await sleep(50);
    timers.advance(19_999);
    expect(await ws.next(50)).toBeUndefined();
    expect(side.events.length).toBe(before);
  });

  test("a recorded pong sent again fails to decrypt and closes the session, rather than keeping it", async () => {
    const { side, ws, ik } = await opened();
    const recorded = ik.seal(pong(2));
    ws.send(recorded);
    ws.send(recorded);
    expect((await ws.waitClosed())?.code).toBe(CLOSE.decryptFailed);
    expect((await side.waitFor("clientClosed")).reason).toBe("decryptFailed");
  });

  test("a flood of them costs the core nothing", async () => {
    const { side, ws, ik } = await opened();
    const before = side.events.length;
    for (let id = 2; id < 2002; id++) ws.send(ik.seal(pong(id)));
    ws.send(ik.seal({ t: "req", id: 3000, op: "snapshot", body: {} }));
    await side.waitFor("clientRequest", (e) => e.request.id === 3000, 10_000);
    expect(side.events.length - before).toBe(1);
  });
});

describe("liveness, on the monotonic clock", () => {
  test("a ping after 20 s ‡ quiet, carrying the session's last rev; closed 60 s ‡ after the last thing heard", async () => {
    const timers = new ManualTimers();
    const { side, ws, ik } = await opened({}, timers);
    const conn = (await side.waitFor("clientConnected")).conn;
    side.channel.perform({
      kind: "appSend",
      conn,
      message: { t: "evt", rev: 57, ev: "forget", body: { device: 3 } },
    });
    expect(ik.open((await ws.next()) ?? new Uint8Array(0))).toMatchObject({ rev: 57 });
    timers.advance(19_999);
    expect(await ws.next(50)).toBeUndefined();
    timers.advance(1);
    expect(ik.open((await ws.next()) ?? new Uint8Array(0))).toEqual({
      t: "evt",
      rev: 57,
      ev: "ping",
      body: {},
    });
    // The client stops answering: closed at 60 s from the last thing heard, not before.
    timers.advance(39_999);
    await sleep(20);
    expect(ws.closedWith).toBeUndefined();
    timers.advance(1);
    expect((await ws.waitClosed())?.code).toBe(CLOSE.liveness);
    expect(side.of("clientClosed")).toEqual([{ kind: "clientClosed", conn, reason: "liveness" }]);
  });

  test("a pong moves the close 60 s on from it", async () => {
    const timers = new ManualTimers();
    const { side, ws, ik } = await opened({}, timers);
    timers.advance(50_000);
    ws.send(ik.seal(pong(2)));
    await sleep(50);
    timers.advance(59_999);
    await sleep(20);
    expect(ws.closedWith).toBeUndefined();
    timers.advance(1);
    expect((await ws.waitClosed())?.code).toBe(CLOSE.liveness);
    expect(side.of("clientClosed").map((e) => e.reason)).toEqual(["liveness"]);
  });
});

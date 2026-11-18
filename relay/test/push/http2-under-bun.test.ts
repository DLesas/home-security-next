/**
 * The one-day check (docs/spikes/B3-http2-under-bun.md), kept as tests: Bun 1.4.2's `node:http2`
 * client, through `safe/http2.ts` and the APNs sender, against the APNs stand-in. Multiplexed
 * streams within the server's limit, one connection reused, GOAWAY and a new connection, a stream
 * refused unprocessed and sent again, a connection lost mid-request, a stalled server, a failing
 * one, one that is gone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import { ApnsClient } from "../../src/push/apns.ts";
import { readApnsKey } from "../../src/push/credentials.ts";
import { ApnsProviderToken } from "../../src/push/jwt.ts";
import { Http2Connection } from "../../src/push/safe/http2.ts";
import type { ApnsReceived, ApnsScript } from "../../../tools/push-standins/src/index.ts";
import { apnsToken, memoryLog, REPO, sealedH, type StandIns, standIns, TOPIC } from "./helpers.ts";

let open: StandIns | undefined;
const clients: ApnsClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await open?.close();
  open = undefined;
});

async function setUp(
  options: {
    script?: (n: number, request: ApnsReceived) => ApnsScript | undefined;
    maxConcurrentStreams?: number;
  } = {},
) {
  const s = await standIns({
    ...(options.script === undefined ? {} : { apns: options.script }),
    ...(options.maxConcurrentStreams === undefined
      ? {}
      : { maxConcurrentStreams: options.maxConcurrentStreams }),
  });
  open = s;
  const signer = readApnsKey(s.apnsKeyPath, s.apnsKey.keyId, s.apnsKey.teamId, {
    programFolder: REPO,
    uid: process.getuid?.(),
  })._unsafeUnwrap();
  const log = memoryLog();
  const client = new ApnsClient({
    tokens: new ApnsProviderToken(signer),
    topic: TOPIC,
    origins: { production: s.apns.origin, development: s.apns.origin },
    ca: s.tls.cert,
    now: () => Date.now(),
    log,
    requestTimeoutMs: 300,
  });
  clients.push(client);
  const send = (n: number) =>
    client.send({ env: "production", token: apnsToken(n), h: sealedH(n) });
  return { s, client, send, log };
}

describe("node:http2 under Bun, against the APNs stand-in", () => {
  test("200 pushes at once share one connection, within the server's stream limit", async () => {
    let inFlight = 0;
    let most = 0;
    const { s, send, client } = await setUp({
      maxConcurrentStreams: 10,
      // Each answer comes 5 ms late, so streams pile up to whatever the client allows itself.
      script: () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        setTimeout(() => (inFlight -= 1), 5);
        return { kind: "status", status: 200, delayMs: 5 };
      },
    });
    const outcomes = await Promise.all(Array.from({ length: 200 }, (_, n) => send(n)));
    expect(new Set(outcomes.map((o) => o.kind))).toEqual(new Set(["delivered"]));
    expect(s.apns.connections).toBe(1);
    expect(s.apns.received).toHaveLength(200);
    expect(most).toBe(10);
    // Kept within the limit by the client: the server refused nothing.
    expect(client.refusedStreams).toBe(0);
  });

  test("a client that does not wait for SETTINGS has streams over the limit refused: what the sender avoids", async () => {
    const { s } = await setUp({ maxConcurrentStreams: 2 });
    const session = http2.connect(s.apns.origin, { ca: s.tls.cert });
    session.on("error", () => undefined);
    const codes = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<number | string>((resolve) => {
            const stream = session.request({ ":method": "POST", ":path": "/3/device/x" });
            stream.on("response", (h) => {
              resolve(Number(h[":status"]));
              stream.resume();
            });
            stream.on("error", () => {
              resolve(`rst ${stream.rstCode}`);
            });
            stream.on("close", () => {
              resolve(`rst ${stream.rstCode}`);
            });
            stream.end("{}");
          }),
      ),
    );
    session.close();
    expect(codes).toContain(`rst ${http2.constants.NGHTTP2_REFUSED_STREAM}`);
  });

  test("the wrapper waits for SETTINGS, reports the limit, and classes an unprocessed stream as refused", async () => {
    const { s } = await setUp({ maxConcurrentStreams: 3 });
    const connection = Http2Connection.open(s.apns.origin, {
      ca: s.tls.cert,
      connectTimeoutMs: 1000,
    });
    expect((await connection.ready()).isOk()).toBe(true);
    expect(connection.streamLimit).toBe(3);
    connection.close();
    expect(connection.usable).toBe(false);
    const after = await connection.request({ ":method": "POST", ":path": "/" }, "", 100, 100);
    expect(after._unsafeUnwrapErr()).toEqual({ kind: "refused" });
  });

  test("sequential pushes reuse the connection", async () => {
    const { s, send } = await setUp();
    for (let n = 0; n < 30; n += 1) expect((await send(n)).kind).toBe("delivered");
    expect(s.apns.connections).toBe(1);
  });

  test("after a GOAWAY the next push opens a new connection", async () => {
    const { s, send } = await setUp();
    expect((await send(1)).kind).toBe("delivered");
    s.apns.goaway();
    await Bun.sleep(20);
    expect((await send(2)).kind).toBe("delivered");
    expect(s.apns.connections).toBe(2);
  });

  test("streams above a GOAWAY's last stream are refused, sent again on a new connection, and delivered", async () => {
    // On the first connection every push stalls; on the next they are answered.
    const { s, send, client } = await setUp({
      script: (_n, request) => (request.connection === 1 ? { kind: "stall" } : undefined),
    });
    const pending = [send(1), send(2), send(3)];
    for (let i = 0; i < 50 && s.apns.received.length < 3; i += 1) await Bun.sleep(10);
    const streams = s.apns.received.map((r) => r.stream).sort((a, b) => a - b);
    // The server says it processed only the first: the other two were not, so they are refused.
    s.apns.goaway(streams[0]);
    const outcomes = await Promise.all(pending);
    expect(outcomes.filter((o) => o.kind === "delivered")).toHaveLength(2);
    expect(outcomes.filter((o) => o.kind === "retryLater")).toEqual([
      { kind: "retryLater", why: "timeout" },
    ]);
    expect(s.apns.connections).toBe(2);
    expect(s.apns.received.filter((r) => r.connection === 2)).toHaveLength(2);
    expect(client.refusedStreams).toBe(2);
  });

  test("a connection lost mid-request is retryLater, and the next push reconnects", async () => {
    const { s, send } = await setUp({ script: (n) => (n === 1 ? { kind: "drop" } : undefined) });
    expect(await send(1)).toEqual({ kind: "retryLater", why: "connection" });
    expect((await send(2)).kind).toBe("delivered");
    expect(s.apns.connections).toBe(2);
  });

  test("a stalled answer times out without losing the connection", async () => {
    const { s, send } = await setUp({ script: (n) => (n === 1 ? { kind: "stall" } : undefined) });
    const started = Date.now();
    expect(await send(1)).toEqual({ kind: "retryLater", why: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await send(2)).kind).toBe("delivered");
    expect(s.apns.connections).toBe(1);
  });

  test("a reset stream is retryLater", async () => {
    const { send } = await setUp({ script: (n) => (n === 1 ? { kind: "reset" } : undefined) });
    expect((await send(1)).kind).toBe("retryLater");
    expect((await send(2)).kind).toBe("delivered");
  });

  test("a server that is gone: retryLater at once, and no new attempt until the back-off passes", async () => {
    const { s, send, log } = await setUp();
    expect((await send(1)).kind).toBe("delivered");
    await s.apns.close();
    expect(await send(2)).toEqual({ kind: "retryLater", why: "connection" });
    const attempts = log.lines.filter((l) => l.includes("serviceUnreachable")).length;
    expect(attempts).toBe(1);
    // Within the first back-off step (1 s ‡), pushes fail at once without a new connection.
    expect(await send(3)).toEqual({ kind: "retryLater", why: "connection" });
    expect(log.lines.filter((l) => l.includes("serviceUnreachable")).length).toBe(1);
  });

  test("a connection that never answers SETTINGS times out", async () => {
    const quiet = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } });
    const connection = Http2Connection.open(`https://127.0.0.1:${quiet.port}`, {
      connectTimeoutMs: 200,
    });
    expect((await connection.ready())._unsafeUnwrapErr().kind).toBe("timeout");
    quiet.stop(true);
  });
});

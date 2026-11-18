/**
 * What the relay's side of a relay link does after each close (`relayCloseReconnect`, B1's): on
 * 4403 it stops and says so once; on 4001, 4426 and 4429 it waits (4429: the last `limit`'s
 * `retryAfterMs`, else ten minutes); on anything else it backs off. Against a push service of the
 * test's own that completes the real XN, says `joined`, and then closes as told.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { Handshake } from "@hsn/protocol/app";
import {
  encodeRelayWelcome,
  provedIdentity,
  RELAY_BINARY_KIND,
  RELAY_CLOSE,
  RELAY_LIMITS,
  relayBinaryCodec,
  startRelayResponder,
} from "@hsn/protocol/relay";
import type { UpstreamAnswer } from "../../src/releases/upstream.ts";
import { PushLink } from "../../src/push/push-link.ts";
import { cleanup, ManualClock, memoryLog, must, relayKey, tempFolder } from "./helpers.ts";

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function until(condition: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await Bun.sleep(10);
  }
  return condition();
}

interface Data {
  handshake?: Handshake;
  step: number;
}

/** A push service that joins every relay and then closes its link with `code`, after `before`. */
function closingService(code: number | undefined, before: readonly (string | Uint8Array)[] = []) {
  const folder = tempFolder();
  stops.push(() => {
    cleanup(folder);
  });
  const socketPath = join(folder, "push.sock");
  let connections = 0;
  const closedWith: number[] = [];
  const server = Bun.serve<Data>({
    unix: socketPath,
    fetch(request, srv) {
      return srv.upgrade(request, { data: { step: 0 } })
        ? undefined
        : new Response(null, { status: 400 });
    },
    websocket: {
      open() {
        connections += 1;
      },
      async message(ws: ServerWebSocket<Data>, message) {
        if (typeof message === "string") return;
        if (ws.data.step === 0) {
          const handshake = must(startRelayResponder("relay"));
          ws.data.handshake = handshake;
          must(await handshake.readMessage(new Uint8Array(message)));
          const welcome = must(
            encodeRelayWelcome({
              proto: 1,
              relay: "0.1.0",
              roles: ["push"],
              limits: {
                maxRosterBytes: 1,
                maxPushItemsPerFrame: 32,
                maxReleasePieceBytes: 1,
                maxRestartWithinMs: 0,
              },
            }),
          );
          ws.send(must(await handshake.writeMessage(welcome)));
          ws.data.step = 1;
          return;
        }
        const handshake = ws.data.handshake;
        if (handshake === undefined) return;
        must(await handshake.readMessage(new Uint8Array(message)));
        ws.send(JSON.stringify({ t: "joined", identity: provedIdentity(handshake) }));
        for (const frame of before) ws.send(frame);
        if (code !== undefined) ws.close(code);
      },
      close(_ws: ServerWebSocket<Data>, closeCode: number) {
        closedWith.push(closeCode);
      },
    },
  });
  stops.push(() => server.stop(true));
  return {
    url: `ws+unix://${socketPath}:/v1/relay`,
    connections: () => connections,
    closedWith: () => closedWith,
  };
}

async function linkTo(code: number, before: readonly string[] = []) {
  const service = closingService(code, before);
  const clock = new ManualClock(Date.now());
  const log = memoryLog();
  const pushLink = new PushLink({
    url: service.url,
    staticKey: relayKey(),
    version: "0.1.0",
    clock,
    log,
    random: () => 0.5,
  });
  stops.push(() => {
    pushLink.stop();
  });
  pushLink.start();
  expect(await until(() => log.text().includes('"relayLinkDown"') || pushLink.refused)).toBe(true);
  expect(service.connections()).toBe(1);
  /** Moves the clock by `ms` and says how many connections the service has had once things settle. */
  const after = async (ms: number) => {
    clock.advance(ms);
    await Bun.sleep(150);
    return service.connections();
  };
  return { pushLink, log, after };
}

describe("after a close, the relay's side follows relayCloseReconnect", () => {
  test("4403: never again, reported once as an error", async () => {
    const { pushLink, log, after } = await linkTo(RELAY_CLOSE.refused);
    expect(pushLink.refused).toBe(true);
    expect(await after(24 * 3600_000)).toBe(1);
    expect(log.lines.filter((l) => l.includes('"relayLinkRefused"'))).toHaveLength(1);
    expect(log.text()).toContain('"level":"error"');
    expect(log.text()).not.toContain('"relayLinkDown"');
  });

  test("4001: waits ten minutes (identity in use), not a millisecond less", async () => {
    const { pushLink, after } = await linkTo(RELAY_CLOSE.replaced);
    expect(pushLink.refused).toBe(false);
    expect(await after(RELAY_LIMITS.identityInUseWaitMs - 1)).toBe(1);
    expect(await after(1)).toBe(2);
  });

  test("4426: waits ten minutes", async () => {
    const { after } = await linkTo(RELAY_CLOSE.noSharedVersion);
    expect(await after(RELAY_LIMITS.limitWaitMs - 1)).toBe(1);
    expect(await after(1)).toBe(2);
  });

  test("4429 without a limit frame: waits ten minutes", async () => {
    const { after } = await linkTo(RELAY_CLOSE.overLimit);
    expect(await after(RELAY_LIMITS.limitWaitMs - 1)).toBe(1);
    expect(await after(1)).toBe(2);
  });

  test("4429 after a limit frame: waits its retryAfterMs", async () => {
    const { after } = await linkTo(RELAY_CLOSE.overLimit, [
      JSON.stringify({ t: "limit", what: "pushes", retryAfterMs: 5000 }),
    ]);
    expect(await after(4999)).toBe(1);
    expect(await after(1)).toBe(2);
  });

  for (const code of [RELAY_CLOSE.badFrame, RELAY_CLOSE.handshakeTimeout, RELAY_CLOSE.stopping]) {
    test(`${code}: backs off, 1 s then 2 s`, async () => {
      const { after } = await linkTo(code);
      expect(await after(999)).toBe(1);
      expect(await after(1)).toBe(2);
      expect(await after(1999)).toBe(2);
      expect(await after(1)).toBe(3);
    });
  }
});

describe("release answers on the relay's side", () => {
  const piece = (id: number, bytes: number) =>
    must(
      relayBinaryCodec.encode({
        kind: RELAY_BINARY_KIND.releasePiece,
        id,
        bytes: new Uint8Array(bytes),
      }),
    );

  function joinedWith(frames: readonly (string | Uint8Array)[]) {
    const service = closingService(undefined, frames);
    const answers: UpstreamAnswer[] = [];
    let downs = 0;
    let fills = 0;
    const pushLink = new PushLink({
      url: service.url,
      staticKey: relayKey(),
      version: "0.1.0",
      clock: new ManualClock(Date.now()),
      log: memoryLog(),
      random: () => 0.5,
    });
    pushLink.attachReleases({
      answer: (a) => {
        answers.push(a);
      },
      linkDown: () => {
        downs += 1;
      },
      fill: () => {
        fills += 1;
        return Promise.resolve(0);
      },
    });
    stops.push(() => {
      pushLink.stop();
    });
    pushLink.start();
    return { service, pushLink, answers, downs: () => downs, fills: () => fills };
  }

  test("pieces and release frames reach the cache; it fills when the link joins", async () => {
    const offer = JSON.stringify({ t: "release.offer", releases: [] });
    const error = JSON.stringify({ t: "release.error", id: 2, reason: "limit", retryAfterMs: 50 });
    const { answers, fills, pushLink } = joinedWith([
      offer,
      piece(1, RELAY_LIMITS.maxReleasePieceBytes),
      error,
    ]);
    expect(await until(() => answers.length === 3)).toBe(true);
    expect(pushLink.up).toBe(true);
    expect(fills()).toBe(1);
    expect(answers.map((a) => a.kind)).toEqual(["offer", "piece", "error"]);
    const p = answers[1];
    expect(p?.kind === "piece" ? p.bytes.length : 0).toBe(RELAY_LIMITS.maxReleasePieceBytes);
    expect(answers[2]).toEqual({ kind: "error", id: 2, reason: "limit", retryAfterMs: 50 });
  });

  test("a release piece one byte over the largest closes the link 4400", async () => {
    const frame = new Uint8Array(5 + RELAY_LIMITS.maxReleasePieceBytes + 1);
    frame[0] = RELAY_BINARY_KIND.releasePiece;
    const { service, answers } = joinedWith([frame]);
    expect(await until(() => service.closedWith().length === 1)).toBe(true);
    expect(service.closedWith()).toEqual([RELAY_CLOSE.badFrame]);
    expect(answers).toHaveLength(0);
  });

  test("a binary frame that is not a release piece closes the link 4400; the cache hears it is down", async () => {
    const streamData = must(
      relayBinaryCodec.encode({
        kind: RELAY_BINARY_KIND.streamData,
        stream: 1,
        message: new Uint8Array(4),
      }),
    );
    const { service, answers, downs } = joinedWith([streamData]);
    expect(await until(() => service.closedWith().length === 1)).toBe(true);
    expect(service.closedWith()).toEqual([RELAY_CLOSE.badFrame]);
    expect(answers).toHaveLength(0);
    expect(await until(() => downs() === 1)).toBe(true);
  });

  test("the cache's channel sends only while the link is joined", async () => {
    const { pushLink } = joinedWith([]);
    const frame = { t: "release.check", platform: "linux-arm64", running: "0.0.0" } as const;
    expect(await until(() => pushLink.up)).toBe(true);
    expect(pushLink.releaseChannel.send(frame)).toBe(true);
    pushLink.stop();
    expect(pushLink.releaseChannel.send(frame)).toBe(false);
  });
});

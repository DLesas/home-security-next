/**
 * `PushSender` over a real relay link: the push role's listeners (`server.ts`) on a local socket
 * and on TLS, and `PushLink` as the operated or a self-hosted relay opens it. Batches and their
 * split at 32 items, the `limit` frame, a result's timeout, the link lost and found again with the
 * back-off, the ping and its pong, a refused key (4403), and the checks before an upgrade.
 *
 * These run on `@hsn/protocol`'s own XN (B1's), as the push role's process does: not on the double.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { appIdentityBytes, formatIdentity, type StaticKey } from "@hsn/protocol/app";
import type { RelayPushItem } from "@hsn/protocol/relay";
import { SYSTEM_CLOCK, type LinkClock } from "../../src/push/clock.ts";
import { PUSH_SERVICE_LIMITS, PushLimiter } from "../../src/push/limits.ts";
import type { ServiceOutcome } from "../../src/push/outcomes.ts";
import type { PushLog } from "../../src/push/log.ts";
import { PushLink } from "../../src/push/push-link.ts";
import { type PushDispatch, PushService } from "../../src/push/push-service.ts";
import { sha256 } from "../../src/push/safe/crypto.ts";
import { listen, type PushListeners } from "../../src/push/server.ts";
import { loopbackTls } from "../../../tools/push-standins/src/index.ts";
import {
  apnsToken,
  cleanup,
  hubIdentity,
  ManualClock,
  memoryLog,
  must,
  relayKey,
  sealedH,
  tempFolder,
} from "./helpers.ts";

class Dispatch implements PushDispatch {
  readonly sent: RelayPushItem[] = [];
  hold = false;
  send(item: RelayPushItem): Promise<ServiceOutcome> {
    this.sent.push(item);
    return this.hold ? new Promise(() => undefined) : Promise.resolve({ kind: "delivered" });
  }
}

const items = (n: number, from = 1): RelayPushItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: from + i,
    hub: hubIdentity(from + i),
    platform: "apns",
    env: "production",
    token: apnsToken(from + i),
    h: sealedH(from + i),
  }));

async function until(condition: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await Bun.sleep(10);
  }
  return condition();
}

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

interface Served {
  readonly folder: string;
  readonly socketPath: string;
  readonly service: PushService;
  readonly dispatch: Dispatch;
  readonly listeners: PushListeners;
  readonly ca: string;
  readonly log: ReturnType<typeof memoryLog>;
}

function serve(
  options: { refused?: ReadonlySet<string>; limiter?: PushLimiter; folder?: string } = {},
): Served {
  const folder = options.folder ?? tempFolder();
  if (options.folder === undefined)
    stops.push(() => {
      cleanup(folder);
    });
  const socketPath = join(folder, "push.sock");
  const dispatch = new Dispatch();
  const log = memoryLog();
  const tls = must(loopbackTls(Date.now()));
  const service = new PushService({
    dispatch,
    version: "0.1.0",
    clock: SYSTEM_CLOCK,
    log,
    ...(options.refused === undefined ? {} : { refused: options.refused }),
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
  });
  const listeners = listen(service, {
    socketPath,
    tcp: { hostname: "127.0.0.1", port: 0, tls },
  })._unsafeUnwrap();
  stops.push(() => listeners.stop());
  return { folder, socketPath, service, dispatch, listeners, ca: tls.cert, log };
}

function link(
  url: string,
  options: {
    key?: StaticKey;
    ca?: string;
    clock?: LinkClock;
    resultTimeoutMs?: number;
    log?: PushLog;
  } = {},
): PushLink {
  const pushLink = new PushLink({
    url,
    staticKey: options.key ?? relayKey(),
    version: "0.1.0",
    clock: options.clock ?? SYSTEM_CLOCK,
    log: options.log ?? memoryLog(),
    random: () => 0.5,
    ...(options.ca === undefined ? {} : { ca: options.ca }),
    ...(options.resultTimeoutMs === undefined ? {} : { resultTimeoutMs: options.resultTimeoutMs }),
  });
  stops.push(() => {
    pushLink.stop();
  });
  return pushLink;
}

const local = (s: Served) => `ws+unix://${s.socketPath}:/v1/relay`;
const remote = (s: Served) => `wss://127.0.0.1:${s.listeners.port ?? 0}/v1/relay`;

describe("a relay link over real sockets (the real XN)", () => {
  // Windows socket access is controlled by NTFS ACLs, without POSIX mode bits.
  test.skipIf(process.platform === "win32")("the local socket is 0600", () => {
    const s = serve();
    expect(statSync(s.socketPath).mode & 0o777).toBe(0o600);
  });

  test("over the local socket: up, 40 items in two frames, every result back", async () => {
    const s = serve();
    const pushLink = link(local(s));
    pushLink.start();
    expect(await until(() => pushLink.up)).toBe(true);
    const results = (await pushLink.send(items(40)))._unsafeUnwrap();
    expect(results.map((r) => r.id).sort((a, b) => a - b)).toEqual(items(40).map((i) => i.id));
    expect(results.every((r) => r.outcome === "accepted")).toBe(true);
    expect(s.dispatch.sent).toHaveLength(40);
    expect(s.log.lines.filter((l) => l.includes('"pushFrame"'))).toHaveLength(2);
  });

  test("over TLS with the push service's certificate: up; without it: never up", async () => {
    const s = serve();
    const trusted = link(remote(s), { ca: s.ca });
    trusted.start();
    expect(await until(() => trusted.up)).toBe(true);
    expect((await trusted.send(items(1)))._unsafeUnwrap()).toEqual([
      { id: 1, outcome: "accepted" },
    ]);
    const untrusted = link(remote(s));
    untrusted.start();
    expect(await until(() => untrusted.up, 500)).toBe(false);
  });

  test("before it is up: linkDown", async () => {
    const s = serve();
    const pushLink = link(local(s));
    expect((await pushLink.send(items(1)))._unsafeUnwrapErr()).toEqual({ kind: "linkDown" });
  });

  test("a limit frame: later sends are limited until it passes, without asking", async () => {
    const s = serve({
      limiter: new PushLimiter({
        ...PUSH_SERVICE_LIMITS,
        perRelayKeyPerDay: 1,
        operatorRelayKeyPerDay: 1,
      }),
    });
    const pushLink = link(local(s));
    pushLink.start();
    await until(() => pushLink.up);
    expect((await pushLink.send(items(2)))._unsafeUnwrap()).toEqual([
      { id: 1, outcome: "accepted" },
      { id: 2, outcome: "limited" },
    ]);
    const third = (await pushLink.send(items(1, 3)))._unsafeUnwrapErr();
    expect(third.kind).toBe("limited");
    expect(third.kind === "limited" && third.retryAfterMs > 0).toBe(true);
    expect(s.dispatch.sent).toHaveLength(1);
  });

  test("no pushResult in time: timeout", async () => {
    const s = serve();
    s.dispatch.hold = true;
    const pushLink = link(local(s), { resultTimeoutMs: 200 });
    pushLink.start();
    await until(() => pushLink.up);
    expect((await pushLink.send(items(1)))._unsafeUnwrapErr()).toEqual({ kind: "timeout" });
  });

  test("the link lost mid-batch: linkDown; the push role back: up again after the back-off", async () => {
    const folder = tempFolder();
    stops.push(() => {
      cleanup(folder);
    });
    const first = serve({ folder });
    first.dispatch.hold = true;
    const pushLink = link(local(first));
    pushLink.start();
    await until(() => pushLink.up);
    const pending = pushLink.send(items(1));
    await until(() => first.dispatch.sent.length === 1);
    await first.listeners.stop();
    expect((await pending)._unsafeUnwrapErr()).toEqual({ kind: "linkDown" });
    expect(pushLink.up).toBe(false);
    const second = serve({ folder });
    expect(await until(() => pushLink.up, 3000)).toBe(true);
    expect((await pushLink.send(items(1, 2)))._unsafeUnwrap()).toEqual([
      { id: 2, outcome: "accepted" },
    ]);
    expect(second.dispatch.sent).toHaveLength(1);
  });

  test("a refused key: closed 4403 after message 3; the relay stops, says so once, tries no more", async () => {
    const key = relayKey();
    const identity = formatIdentity(appIdentityBytes(sha256, key.publicKey));
    const s = serve({ refused: new Set([identity]) });
    const clock = new ManualClock(Date.now());
    const log = memoryLog();
    const pushLink = link(local(s), { key, clock, log });
    pushLink.start();
    expect(await until(() => pushLink.refused)).toBe(true);
    clock.advance(24 * 3600_000);
    await Bun.sleep(100);
    expect(pushLink.up).toBe(false);
    expect(s.log.lines.filter((l) => l.includes('"linkRefused"'))).toHaveLength(1);
    expect(log.lines.filter((l) => l.includes('"relayLinkRefused"'))).toHaveLength(1);
    expect(log.text()).not.toContain('"relayLinkDown"');
    // Started again (a new key or configuration): it tries once more.
    s.service.setRefused(new Set());
    pushLink.start();
    expect(await until(() => pushLink.up)).toBe(true);
  });

  test("a ping every 30 s; no pong within 15 s closes the link, and it comes back", async () => {
    const s = serve();
    const clock = new ManualClock(Date.now());
    const pushLink = link(local(s), { clock });
    pushLink.start();
    expect(await until(() => pushLink.up)).toBe(true);
    clock.advance(30_000);
    await Bun.sleep(50);
    clock.advance(15_000);
    await Bun.sleep(100);
    expect(pushLink.up).toBe(true);
    // The next ping's pong cannot arrive before the clock passes 15 s more at once.
    clock.advance(15_000);
    clock.advance(15_000);
    expect(await until(() => !pushLink.up, 1000)).toBe(true);
    clock.advance(1000);
    expect(await until(() => pushLink.up)).toBe(true);
  });

  test("before any state: a path other than /v1/relay is 404; a 5th unauthenticated link from one address is 429", async () => {
    const s = serve();
    const origin = `https://127.0.0.1:${s.listeners.port ?? 0}`;
    expect((await fetch(`${origin}/v1/hub`, { tls: { ca: s.ca } })).status).toBe(404);
    const sockets = Array.from(
      { length: 4 },
      () => new WebSocket(`${origin.replace("https", "wss")}/v1/relay`, { tls: { ca: s.ca } }),
    );
    stops.push(() => {
      for (const socket of sockets) socket.close();
    });
    expect(sockets).toHaveLength(4);
    expect(await until(() => sockets.every((socket) => socket.readyState === WebSocket.OPEN))).toBe(
      true,
    );
    const fifth = await fetch(`${origin}/v1/relay`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
      tls: { ca: s.ca },
    });
    expect(fifth.status).toBe(429);
    expect(s.log.text()).toContain('"upgradeRefused"');
  });
});

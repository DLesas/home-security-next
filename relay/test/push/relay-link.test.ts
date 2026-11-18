/**
 * The push service's side of `/v1/relay` (D142), on a socket the test holds and a clock it
 * drives: the XN handshake and what it answers, every close code, the refused relay key, newest
 * wins, the caps on joined links, the queue during a handshake, the frames after it, and the push
 * limits through a link, including that one relay's flood does not spend another's share of the
 * same hub. All on `@hsn/protocol`'s own XN (B1's): it covers every case here, so no double.
 */
import { describe, expect, test } from "bun:test";
import {
  appIdentityBytes,
  formatIdentity,
  startHandshake,
  NOISE_PATTERNS,
  type Handshake,
  type StartHandshake,
  type StaticKey,
} from "@hsn/protocol/app";
import {
  type PushToRelayFrame,
  RELAY_BINARY_KIND,
  RELAY_LIMITS,
  relayBinaryCodec,
  relayPrologue,
  type RelayPushItem,
  relayWelcome,
} from "@hsn/protocol/relay";
import { LinkGuard, PUSH_LINK_LIMITS } from "../../src/push/link-guard.ts";
import { PUSH_SERVICE_LIMITS, PushLimiter } from "../../src/push/limits.ts";
import type { ServiceOutcome } from "../../src/push/outcomes.ts";
import { type PushDispatch, PushService } from "../../src/push/push-service.ts";
import type { LinkPeer, LinkSocket, RelayLinkServer } from "../../src/push/relay-link.ts";
import type { OpenReleaseRoute, ReleasePeerOf } from "../../src/push/releases-route.ts";
import { sha256 } from "../../src/push/safe/crypto.ts";
import {
  apnsToken,
  hubIdentity,
  ManualClock,
  memoryLog,
  must,
  relayKey,
  sealedH,
} from "./helpers.ts";

const NOON = Date.UTC(2026, 10, 18, 12);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeSocket implements LinkSocket {
  readonly texts: string[] = [];
  readonly binaries: Uint8Array[] = [];
  closedWith: number | undefined;
  accepts = true;
  sendText(text: string): boolean {
    if (this.accepts) this.texts.push(text);
    return this.accepts;
  }
  sendBinary(bytes: Uint8Array): boolean {
    if (this.accepts) this.binaries.push(bytes);
    return this.accepts;
  }
  close(code: number): void {
    this.closedWith ??= code;
  }
  frames(): PushToRelayFrame[] {
    return this.texts.map((t) => JSON.parse(t) as PushToRelayFrame);
  }
}

/** A dispatch that answers by token and remembers what it was given. */
class FakeDispatch implements PushDispatch {
  readonly sent: RelayPushItem[] = [];
  hold = false;
  private readonly held: (() => void)[] = [];
  constructor(
    private readonly answer: (item: RelayPushItem) => ServiceOutcome = () => ({
      kind: "delivered",
    }),
  ) {}
  send(item: RelayPushItem): Promise<ServiceOutcome> {
    this.sent.push(item);
    if (!this.hold) return Promise.resolve(this.answer(item));
    return new Promise((resolve) =>
      this.held.push(() => {
        resolve(this.answer(item));
      }),
    );
  }
  release(): void {
    for (const run of this.held.splice(0)) run();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Bun.sleep(0);
}

interface World {
  readonly service: PushService;
  readonly clock: ManualClock;
  readonly dispatch: FakeDispatch;
  readonly log: ReturnType<typeof memoryLog>;
}

function world(
  options: {
    refused?: ReadonlySet<string>;
    guard?: LinkGuard;
    limiter?: PushLimiter;
    dispatch?: FakeDispatch;
    openReleases?: OpenReleaseRoute;
  } = {},
): World {
  const clock = new ManualClock(NOON);
  const dispatch = options.dispatch ?? new FakeDispatch();
  const log = memoryLog();
  const service = new PushService({
    dispatch,
    version: "0.1.0",
    clock,
    log,
    ...(options.refused === undefined ? {} : { refused: options.refused }),
    ...(options.guard === undefined ? {} : { guard: options.guard }),
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    ...(options.openReleases === undefined ? {} : { openReleases: options.openReleases }),
  });
  return { service, clock, dispatch, log };
}

interface Relay {
  readonly socket: FakeSocket;
  readonly link: RelayLinkServer;
  readonly key: StaticKey;
  readonly initiator: Handshake;
  readonly identity: string;
}

/** Opens a link as the server would after an upgrade, and runs the relay's side of XN. */
async function connect(
  w: World,
  start: StartHandshake,
  options: {
    key?: StaticKey;
    peer?: LinkPeer;
    proto?: readonly [number, number];
    prologue?: Uint8Array;
    stopAfter?: 1 | 2;
  } = {},
): Promise<Relay> {
  const key = options.key ?? relayKey();
  const peer = options.peer ?? { address: "203.0.113.5", local: false };
  expect(w.service.upgrade(peer.address)).toBe("ok");
  const socket = new FakeSocket();
  const link = w.service.open(socket, peer);
  const started = must(
    start({
      pattern: NOISE_PATTERNS.relay,
      initiator: true,
      prologue: options.prologue ?? relayPrologue("peer"),
      staticKey: key,
    }),
  );
  const initiator = started;
  const identity = formatIdentity(appIdentityBytes(sha256, key.publicKey));
  const m1 = must(
    await initiator.writeMessage(
      encoder.encode(JSON.stringify({ proto: options.proto ?? [1, 1], relay: "0.1.0" })),
    ),
  );
  link.receive(m1);
  await settle();
  if (options.stopAfter === 1 || socket.closedWith !== undefined)
    return { socket, link, key, initiator, identity };
  const m2 = socket.binaries[0];
  if (m2 === undefined) return { socket, link, key, initiator, identity };
  const welcome = await initiator.readMessage(m2);
  if (!welcome.ok || options.stopAfter === 2) return { socket, link, key, initiator, identity };
  const m3 = must(await initiator.writeMessage(encoder.encode("{}")));
  link.receive(m3);
  await settle();
  return { socket, link, key, initiator, identity };
}

const item = (id: number, hub = hubIdentity(1)): RelayPushItem => ({
  id,
  hub,
  platform: "apns",
  env: "production",
  token: apnsToken(id),
  h: sealedH(id),
});

const push = (relay: Relay, items: readonly RelayPushItem[]) => {
  relay.link.receive(JSON.stringify({ t: "push", items }));
};

{
  const start = startHandshake;
  describe("on the real XN", () => {
    test("the handshake: one message 2, then joined with the identity of the relay's proved key", async () => {
      const w = world();
      const relay = await connect(w, start);
      expect(relay.socket.closedWith).toBeUndefined();
      expect(relay.link.joined).toBe(true);
      expect(relay.socket.frames()).toEqual([{ t: "joined", identity: relay.identity }]);
      expect(relay.socket.binaries).toHaveLength(1);
      expect(w.log.text()).toContain('"linkJoined"');
    });

    test("message 2's payload is a RelayWelcome for the push role", async () => {
      const w = world();
      const key = relayKey();
      const socket = new FakeSocket();
      w.service.upgrade("203.0.113.5");
      const link = w.service.open(socket, { address: "203.0.113.5", local: false });
      const started = must(
        start({
          pattern: NOISE_PATTERNS.relay,
          initiator: true,
          prologue: relayPrologue("peer"),
          staticKey: key,
        }),
      );
      const m1 = must(
        await started.writeMessage(
          encoder.encode(JSON.stringify({ proto: [1, 3], relay: "0.1.0" })),
        ),
      );
      link.receive(m1);
      await settle();
      const m2 = must(await started.readMessage(socket.binaries[0] ?? new Uint8Array(0)));
      const welcome = relayWelcome.parse(JSON.parse(decoder.decode(m2)));
      expect(welcome).toEqual({
        proto: 1,
        relay: "0.1.0",
        roles: ["push"],
        limits: {
          maxRosterBytes: 131_072,
          maxPushItemsPerFrame: 32,
          maxReleasePieceBytes: 262_144,
          maxRestartWithinMs: 600_000,
        },
      });
    });

    test("no shared version: 4426", async () => {
      const w = world();
      const relay = await connect(w, start, { proto: [2, 3] });
      expect(relay.socket.closedWith).toBe(4426);
      expect(relay.socket.binaries).toHaveLength(0);
    });

    test("a wrong prologue never joins", async () => {
      const w = world();
      const relay = await connect(w, start, { prologue: relayPrologue("hub") });
      expect(relay.link.joined).toBe(false);
      expect(relay.socket.texts).toHaveLength(0);
    });

    test("a text frame before the handshake ends: 4400, and nothing is sent", async () => {
      const w = world();
      w.service.upgrade("203.0.113.5");
      const socket = new FakeSocket();
      const link = w.service.open(socket, { address: "203.0.113.5", local: false });
      link.receive(JSON.stringify({ t: "push", items: [item(1)] }));
      await settle();
      expect(socket.closedWith).toBe(4400);
      expect(w.dispatch.sent).toHaveLength(0);
    });

    test("message 3 within 10 s: at 9,999 ms open, at 10,000 closed 4408", async () => {
      const w = world();
      const relay = await connect(w, start, { stopAfter: 2 });
      w.clock.advance(10_000 - 1);
      expect(relay.socket.closedWith).toBeUndefined();
      w.clock.advance(1);
      expect(relay.socket.closedWith).toBe(4408);
      expect(w.service.linkCount).toBe(0);
    });

    test("a second message queued during a handshake step: 4429", async () => {
      const w = world();
      w.service.upgrade("203.0.113.5");
      const socket = new FakeSocket();
      const link = w.service.open(socket, { address: "203.0.113.5", local: false });
      const started = must(
        start({
          pattern: NOISE_PATTERNS.relay,
          initiator: true,
          prologue: relayPrologue("peer"),
          staticKey: relayKey(),
        }),
      );
      const m1 = must(
        await started.writeMessage(
          encoder.encode(JSON.stringify({ proto: [1, 1], relay: "0.1.0" })),
        ),
      );
      link.receive(m1);
      link.receive(new Uint8Array(40));
      expect(socket.closedWith).toBeUndefined();
      link.receive(new Uint8Array(40));
      expect(socket.closedWith).toBe(4429);
    });

    test("a joined link: ping, pong; a binary frame, a frame no schema takes, malformed JSON: 4400", async () => {
      for (const bad of [
        new Uint8Array([1, 0, 0, 0, 0]),
        JSON.stringify({ t: "roster", rev: 1, targets: [] }),
        "{not json",
        JSON.stringify({ t: "push", items: [{ ...item(1), token: "zz" }] }),
      ]) {
        const w = world();
        const relay = await connect(w, start);
        relay.link.receive(JSON.stringify({ t: "ping", n: 7 }));
        expect(relay.socket.frames().at(-1)).toEqual({ t: "pong", n: 7 });
        relay.link.receive(bad);
        expect(relay.socket.closedWith).toBe(4400);
      }
    });

    test("a joined link silent for 75 s is closed; any frame starts the clock again", async () => {
      const w = world();
      const relay = await connect(w, start);
      w.clock.advance(75_000 - 1);
      relay.link.receive(JSON.stringify({ t: "ping", n: 1 }));
      w.clock.advance(75_000 - 1);
      expect(relay.socket.closedWith).toBeUndefined();
      w.clock.advance(1);
      expect(relay.socket.closedWith).toBe(4408);
    });

    test("with no way to the releases role: an empty offer, and unavailable", async () => {
      const w = world();
      const relay = await connect(w, start);
      relay.link.receive(
        JSON.stringify({ t: "release.check", platform: "linux-arm64", running: "1.0.0" }),
      );
      relay.link.receive(
        JSON.stringify({
          t: "release.get",
          id: 4,
          file: "hsn-hub-1.0.1-linux-arm64.hsnr",
          offset: 0,
          length: 10,
        }),
      );
      expect(relay.socket.frames().slice(1)).toEqual([
        { t: "release.offer", releases: [] },
        { t: "release.error", id: 4, reason: "unavailable" },
      ]);
    });

    test("a refused relay key is turned away after message 3: 4403, no joined, nothing sent", async () => {
      const key = relayKey();
      const identity = formatIdentity(appIdentityBytes(sha256, key.publicKey));
      const w = world({ refused: new Set([identity]) });
      const relay = await connect(w, start, { key });
      expect(relay.socket.closedWith).toBe(4403);
      expect(relay.socket.texts).toHaveLength(0);
      expect(w.log.text()).toContain('"linkRefused"');
      // Another key is let in.
      expect((await connect(w, start)).link.joined).toBe(true);
    });

    test("refusing a joined relay's key closes its link at once", async () => {
      const w = world();
      const relay = await connect(w, start);
      const other = await connect(w, start);
      w.service.setRefused(new Set([relay.identity]));
      expect(relay.socket.closedWith).toBe(4403);
      expect(other.socket.closedWith).toBeUndefined();
    });

    test("one link per relay key: the newest wins, the older is closed 4001", async () => {
      const w = world();
      const key = relayKey();
      const first = await connect(w, start, { key });
      const second = await connect(w, start, { key });
      expect(first.socket.closedWith).toBe(4001);
      expect(second.link.joined).toBe(true);
      expect(second.socket.closedWith).toBeUndefined();
    });

    test("joined links per address: the 8th joins, the 9th is closed 4429", async () => {
      const w = world({
        guard: new LinkGuard({ ...PUSH_LINK_LIMITS, upgradesPerMinutePerAddress: 100 }),
      });
      for (let i = 0; i < 8; i += 1) expect((await connect(w, start)).link.joined).toBe(true);
      const ninth = await connect(w, start);
      expect(ninth.socket.closedWith).toBe(4429);
      expect(
        (await connect(w, start, { peer: { address: "198.51.100.1", local: false } })).link.joined,
      ).toBe(true);
    });

    test("a push frame is answered item by item, each with its outcome", async () => {
      const outcomes: Record<number, ServiceOutcome> = {
        1: { kind: "delivered" },
        2: { kind: "tokenInvalid" },
        3: { kind: "retryLater", why: "rateLimited" },
        4: { kind: "retryLater", why: "unavailable" },
        5: { kind: "dropped", why: "badRequest" },
      };
      const dispatch = new FakeDispatch((i) => outcomes[i.id] ?? { kind: "delivered" });
      const w = world({ dispatch });
      const relay = await connect(w, start);
      push(
        relay,
        [1, 2, 3, 4, 5].map((id) => item(id)),
      );
      await settle();
      expect(relay.socket.frames().at(-1)).toEqual({
        t: "pushResult",
        results: [
          { id: 1, outcome: "accepted" },
          { id: 2, outcome: "badToken" },
          { id: 3, outcome: "limited" },
          { id: 4, outcome: "failed" },
          { id: 5, outcome: "failed" },
        ],
      });
      expect(dispatch.sent.map((i) => i.token)).toEqual([1, 2, 3, 4, 5].map(apnsToken));
      expect(w.log.text()).toContain('"pushDropped"');
    });

    test("per relay key and hub: the 60th in 10 minutes goes, the 61st is limited; another relay for the same hub is untouched", async () => {
      const w = world();
      const flooding = await connect(w, start);
      const own = await connect(w, start, { peer: { address: "198.51.100.7", local: false } });
      const hub = hubIdentity(9);
      for (let batch = 0; batch < 2; batch += 1) {
        push(
          flooding,
          Array.from({ length: 30 }, (_, i) => item(batch * 30 + i + 1, hub)),
        );
        await settle();
      }
      push(flooding, [item(61, hub), item(62, hubIdentity(10))]);
      await settle();
      expect(flooding.socket.frames().at(-1)).toEqual({
        t: "pushResult",
        results: [
          { id: 61, outcome: "limited" },
          { id: 62, outcome: "accepted" },
        ],
      });
      // A pair limit is the item's, not the link's: no `limit` frame.
      expect(flooding.socket.frames().some((f) => f.t === "limit")).toBe(false);
      push(own, [item(1, hub)]);
      await settle();
      expect(own.socket.frames().at(-1)).toEqual({
        t: "pushResult",
        results: [{ id: 1, outcome: "accepted" }],
      });
      expect(w.dispatch.sent).toHaveLength(62);
    });

    test("per relay key: past its day, every item is limited and a limit frame says until midnight", async () => {
      const limiter = new PushLimiter({ ...PUSH_SERVICE_LIMITS, perRelayKeyPerDay: 3 });
      const w = world({ limiter });
      const relay = await connect(w, start);
      push(relay, [
        item(1, hubIdentity(1)),
        item(2, hubIdentity(2)),
        item(3, hubIdentity(3)),
        item(4, hubIdentity(4)),
      ]);
      await settle();
      const frames = relay.socket.frames();
      expect(frames.at(-2)).toEqual({
        t: "limit",
        what: "pushes",
        retryAfterMs: Date.UTC(2026, 10, 19) - NOON,
      });
      expect(frames.at(-1)).toEqual({
        t: "pushResult",
        results: [
          { id: 1, outcome: "accepted" },
          { id: 2, outcome: "accepted" },
          { id: 3, outcome: "accepted" },
          { id: 4, outcome: "limited" },
        ],
      });
      expect(w.log.text()).toContain('"what":"relayKey"');
    });

    test("frames in hand: the 4th waits for its answer, the 5th is limited at once", async () => {
      const dispatch = new FakeDispatch();
      dispatch.hold = true;
      const w = world({ dispatch });
      const relay = await connect(w, start);
      for (let f = 0; f < 4; f += 1) push(relay, [item(f + 1, hubIdentity(f))]);
      push(relay, [item(5, hubIdentity(5))]);
      await settle();
      expect(relay.socket.frames().slice(1)).toEqual([
        { t: "limit", what: "pushes", retryAfterMs: 1000 },
        { t: "pushResult", results: [{ id: 5, outcome: "limited" }] },
      ]);
      dispatch.release();
      await settle();
      expect(relay.socket.frames().filter((f) => f.t === "pushResult")).toHaveLength(5);
    });

    test("a socket that cannot take a frame is closed 4429", async () => {
      const w = world();
      const relay = await connect(w, start);
      relay.socket.accepts = false;
      relay.link.receive(JSON.stringify({ t: "ping", n: 1 }));
      expect(relay.socket.closedWith).toBe(4429);
    });

    test("the operator's local link has its own larger share", async () => {
      const limiter = new PushLimiter({
        ...PUSH_SERVICE_LIMITS,
        perRelayKeyPerDay: 1,
        operatorRelayKeyPerDay: 2,
      });
      const w = world({ limiter });
      const local = await connect(w, start, { peer: { address: null, local: true } });
      push(local, [item(1, hubIdentity(1)), item(2, hubIdentity(2)), item(3, hubIdentity(3))]);
      await settle();
      expect(local.socket.frames().at(-1)).toEqual({
        t: "pushResult",
        results: [
          { id: 1, outcome: "accepted" },
          { id: 2, outcome: "accepted" },
          { id: 3, outcome: "limited" },
        ],
      });
    });

    test("stopping closes every link with 1001", async () => {
      const w = world();
      const a = await connect(w, start);
      const b = await connect(w, start, { stopAfter: 1 });
      w.service.stop();
      expect([a.socket.closedWith, b.socket.closedWith]).toEqual([1001, 1001]);
      expect(w.service.linkCount).toBe(0);
    });
  });
}

/** A way to the releases role the test answers by hand. */
class FakeRoute {
  readonly forwarded: string[] = [];
  peer: ReleasePeerOf | undefined;
  closes = 0;
  forwards = true;
  answer: (answer: string | Uint8Array) => void = () => undefined;
  gone: () => void = () => undefined;
  readonly open: OpenReleaseRoute = (peer, onAnswer, onGone) => {
    this.peer = peer;
    this.answer = onAnswer;
    this.gone = onGone;
    return {
      forward: (text) => {
        if (this.forwards) this.forwarded.push(text);
        return Promise.resolve(this.forwards);
      },
      close: () => {
        this.closes += 1;
      },
    };
  };
}

const get = (id: number) =>
  JSON.stringify({
    t: "release.get",
    id,
    file: "hsn-hub-1.0.1-linux-arm64.hsnr",
    offset: 0,
    length: 10,
  });
/** A kind 2 frame one byte over the largest, made by hand: the codec would not make it. */
const oversized = (id: number) => {
  const frame = new Uint8Array(5 + RELAY_LIMITS.maxReleasePieceBytes + 1);
  frame[0] = RELAY_BINARY_KIND.releasePiece;
  new DataView(frame.buffer).setUint32(1, id, true);
  return frame;
};
const piece = (id: number, bytes = 10) => {
  const encoded = relayBinaryCodec.encode({
    kind: RELAY_BINARY_KIND.releasePiece,
    id,
    bytes: new Uint8Array(bytes),
  });
  return encoded.ok ? encoded.value : new Uint8Array(0);
};

describe("release frames through a way to the releases role", () => {
  const start = startHandshake;

  async function joined(route: FakeRoute) {
    const w = world({ openReleases: route.open });
    const relay = await connect(w, start, { peer: { address: "203.0.113.5", local: false } });
    return { w, relay };
  }

  test("opened at join for the proved identity and address; frames forwarded and answered unchanged", async () => {
    const route = new FakeRoute();
    const { relay } = await joined(route);
    expect(route.peer).toEqual({ identity: relay.identity, address: "203.0.113.5" });
    const check = JSON.stringify({ t: "release.check", platform: "linux-arm64", running: "1.0.0" });
    relay.link.receive(check);
    relay.link.receive(get(4));
    await settle();
    expect(route.forwarded).toEqual([check, get(4)]);
    const offer = JSON.stringify({ t: "release.offer", releases: [] });
    route.answer(offer);
    const bytes = piece(4);
    route.answer(bytes);
    expect(relay.socket.texts.at(-1)).toBe(offer);
    expect(relay.socket.binaries.at(-1)).toBe(bytes);
  });

  test("four pieces in hand at once; a fifth is limit; an answer frees a place; an id twice is unavailable", async () => {
    const route = new FakeRoute();
    const { relay } = await joined(route);
    for (let id = 1; id <= 5; id += 1) relay.link.receive(get(id));
    await settle();
    expect(route.forwarded).toHaveLength(RELAY_LIMITS.maxReleasePiecesInFlight);
    expect(relay.socket.frames().at(-1)).toEqual({
      t: "release.error",
      id: 5,
      reason: "limit",
      retryAfterMs: 1000,
    });
    route.answer(JSON.stringify({ t: "release.error", id: 1, reason: "notFound" }));
    relay.link.receive(get(6));
    await settle();
    expect(route.forwarded).toHaveLength(5);
    relay.link.receive(get(6));
    expect(relay.socket.frames().at(-1)).toEqual({
      t: "release.error",
      id: 6,
      reason: "unavailable",
    });
  });

  test("a piece for an id not in hand, larger than the largest binary frame, or not a piece closes the way; the link stays", async () => {
    for (const bad of [piece(77), oversized(1), new Uint8Array([1, 1, 0, 0, 0, 1])]) {
      const route = new FakeRoute();
      const { relay } = await joined(route);
      relay.link.receive(get(1));
      await settle();
      const binaries = relay.socket.binaries.length;
      route.answer(bad);
      expect(relay.socket.binaries).toHaveLength(binaries);
      expect(route.closes).toBe(1);
      expect(relay.socket.closedWith).toBeUndefined();
      expect(relay.socket.frames().at(-1)).toEqual({
        t: "release.error",
        id: 1,
        reason: "unavailable",
      });
      relay.link.receive(get(2));
      expect(relay.socket.frames().at(-1)).toEqual({
        t: "release.error",
        id: 2,
        reason: "unavailable",
      });
    }
  });

  test("an answer that is not a release frame closes the way", async () => {
    const route = new FakeRoute();
    const { relay } = await joined(route);
    route.answer(JSON.stringify({ t: "pong", n: 1 }));
    expect(route.closes).toBe(1);
    expect(relay.socket.texts.some((t) => t.includes("pong"))).toBe(false);
  });

  test("the way gone: pieces in hand unavailable; a frame that could not be forwarded: unavailable, or an empty offer", async () => {
    const route = new FakeRoute();
    const { relay } = await joined(route);
    relay.link.receive(get(1));
    relay.link.receive(get(2));
    await settle();
    route.gone();
    expect(relay.socket.frames().slice(-2)).toEqual([
      { t: "release.error", id: 1, reason: "unavailable" },
      { t: "release.error", id: 2, reason: "unavailable" },
    ]);
    const refusing = new FakeRoute();
    refusing.forwards = false;
    const other = await joined(refusing);
    other.relay.link.receive(get(3));
    other.relay.link.receive(
      JSON.stringify({ t: "release.check", platform: "linux-arm64", running: "1.0.0" }),
    );
    await settle();
    expect(other.relay.socket.frames().slice(-2)).toEqual([
      { t: "release.error", id: 3, reason: "unavailable" },
      { t: "release.offer", releases: [] },
    ]);
  });

  test("a reader too slow for a piece is closed 4429, and the way with it", async () => {
    const route = new FakeRoute();
    const { relay } = await joined(route);
    relay.link.receive(get(1));
    await settle();
    relay.socket.accepts = false;
    route.answer(piece(1));
    expect(relay.socket.closedWith).toBe(4429);
    expect(route.closes).toBe(1);
  });

  test("closed with the link, once; never opened for a link that did not join", async () => {
    const route = new FakeRoute();
    const { w, relay } = await joined(route);
    relay.link.close(1001);
    relay.link.close(1001);
    expect(route.closes).toBe(1);
    expect(w.service.linkCount).toBe(0);
    const refused = new FakeRoute();
    const key = relayKey();
    const w2 = world({
      openReleases: refused.open,
      refused: new Set([formatIdentity(appIdentityBytes(sha256, key.publicKey))]),
    });
    await connect(w2, start, { key });
    expect(refused.peer).toBeUndefined();
  });
});

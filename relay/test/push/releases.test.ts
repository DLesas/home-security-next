/**
 * Release frames on relay links, end to end (docs/m4-design.md sections 3 and 6): a self-hosted
 * relay's cache (B2's `UpstreamCache`) over its real relay link (`PushLink`, TLS) through the push
 * service (`relay-link.ts`, `releases-route.ts`) and B2's forwarding socket to B2's releases
 * service. Filled in pieces; cut and resumed at the partial file's length; refused over budget
 * with the releases role's own error; no releases socket configured; the link's own cap on pieces
 * in hand; and no forwarding socket left open once its link has closed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hubReleaseFileName,
  HUB_RELEASE,
  RELEASE_PLATFORMS,
  type ReleasePlatform,
} from "@hsn/protocol/release";
import { RELAY_LIMITS, relayIdentity } from "@hsn/protocol/relay";
import type { Result } from "neverthrow";
import { ReleaseBudget } from "../../src/core/release-budget.ts";
import { FolderReleaseIndex } from "../../src/releases/folder-index.ts";
import { type ForwardingListener, listenForwarding } from "../../src/releases/forwarding.ts";
import { type PieceAnswer, type PieceRequest, ReleaseService } from "../../src/releases/service.ts";
import { type UpstreamAnswer, UpstreamCache } from "../../src/releases/upstream.ts";
import { SILENT_LOG } from "../../src/shell/log.ts";
import { SYSTEM_CLOCK } from "../../src/push/clock.ts";
import type { ServiceOutcome } from "../../src/push/outcomes.ts";
import { PushLink } from "../../src/push/push-link.ts";
import { PushService } from "../../src/push/push-service.ts";
import { forwardedRoutes } from "../../src/push/releases-route.ts";
import { listen, type PushListeners } from "../../src/push/server.ts";
import type { ReleasePeer } from "../../src/core/release-budget.ts";
import { loopbackTls } from "../../../tools/push-standins/src/index.ts";
import { cleanup, memoryLog, must, relayKey, tempFolder } from "./helpers.ts";

const PIECE = RELAY_LIMITS.maxReleasePieceBytes;

/** A neverthrow result's value; the test fails on its error. */
function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isErr()) expect(JSON.stringify(result.error)).toBe("no error");
  return result._unsafeUnwrap();
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A hub release of the published layout (B2's tests' layout): fixed bytes, manifest, a zero signature, payload. */
function writeHubRelease(
  folder: string,
  version: string,
  payloadBytes: number,
  platform: ReleasePlatform,
): string {
  const payload = new Uint8Array(randomBytes(payloadBytes));
  const manifest = {
    version,
    platform,
    madeMs: Date.UTC(2026, 10, 18),
    payloadBytes,
    payloadSha256: sha(payload),
    files: [{ path: "hub", bytes: payloadBytes, sha256: sha(payload), executable: true }],
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const out = new Uint8Array(
    HUB_RELEASE.fixedBytes + json.length + HUB_RELEASE.signatureBytes + payloadBytes,
  );
  out.set(new TextEncoder().encode(HUB_RELEASE.magic), 0);
  out[4] = HUB_RELEASE.format;
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, HUB_RELEASE.fixedBytes);
  out.set(payload, HUB_RELEASE.fixedBytes + json.length + HUB_RELEASE.signatureBytes);
  const file = hubReleaseFileName(version, platform);
  writeFileSync(join(folder, file), out);
  return file;
}

async function until(condition: () => boolean, ms = 5000): Promise<boolean> {
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

const noPush = { send: (): Promise<ServiceOutcome> => Promise.resolve({ kind: "delivered" }) };

interface Seen {
  readonly peer: ReleasePeer;
  readonly request: PieceRequest;
}

interface World {
  readonly operated: string;
  readonly self: string;
  readonly big: string;
  readonly small: string;
  readonly seen: Seen[];
  readonly answers: UpstreamAnswer[];
  readonly link: PushLink;
  readonly cache: UpstreamCache;
  readonly selfIndex: FolderReleaseIndex;
  readonly live: () => number;
  /** Stops the push service's listeners, cutting the relay link. */
  cut(): Promise<void>;
  /** Starts them again on the same socket and port. */
  restore(): void;
  /** Stops just the releases listener, leaving the push role and relay link up. */
  cutReleases(): Promise<void>;
  /** Restarts the releases listener on the same socket. */
  restoreReleases(): void;
  readonly identity: string;
  /** The push service's relay link URL and certificate, for more relays. */
  readonly url: string;
  readonly ca: string;
}

async function world(
  options: {
    releases?: boolean;
    budget?: ReleaseBudget;
    /** Called for each `release.get` before it is answered; return a promise to hold it. */
    hold?: (seen: Seen) => Promise<void> | undefined;
  } = {},
): Promise<World> {
  const root = tempFolder();
  stops.push(() => {
    cleanup(root);
  });
  const operated = join(root, "operated");
  const self = join(root, "self");
  mkdirSync(operated);
  mkdirSync(self);
  const big = writeHubRelease(operated, "1.4.0", 2 * PIECE + 9, "linux-x64");
  const small = writeHubRelease(operated, "1.4.0", 1234, "darwin-arm64");
  const index = new FolderReleaseIndex(operated, SILENT_LOG);
  (await index.refresh())._unsafeUnwrap();
  const service = new ReleaseService(
    index,
    options.budget ?? new ReleaseBudget(),
    SYSTEM_CLOCK,
    SILENT_LOG,
  );
  const seen: Seen[] = [];
  const releasesSocket = join(root, "releases.sock");
  /** Listens with the same release files and budgets on each start. */
  const serveReleases = (): ForwardingListener =>
    unwrap(
      listenForwarding(
        {
          check: (peer, check) => service.check(peer, check),
          async get(peer, request): Promise<PieceAnswer> {
            const entry = { peer, request };
            seen.push(entry);
            await options.hold?.(entry);
            return service.get(peer, request);
          },
        },
        releasesSocket,
        SILENT_LOG,
      ),
    );
  let forwarding: ForwardingListener | undefined = serveReleases();
  stops.push(() => forwarding?.stop());

  const tls = must(loopbackTls(Date.now()));
  const routes = forwardedRoutes(releasesSocket, memoryLog());
  const pushSocket = join(root, "push.sock");
  let port = 0;
  let listeners: PushListeners | undefined;
  const serve = () => {
    const push = new PushService({
      dispatch: noPush,
      version: "0.1.0",
      clock: SYSTEM_CLOCK,
      log: memoryLog(),
      ...(options.releases === false ? {} : { openReleases: routes.open }),
    });
    listeners = unwrap(
      listen(push, { socketPath: pushSocket, tcp: { hostname: "127.0.0.1", port, tls } }),
    );
    port = listeners.port ?? 0;
  };
  serve();
  stops.push(() => listeners?.stop());

  const key = relayKey();
  const link = new PushLink({
    url: `wss://127.0.0.1:${port}/v1/relay`,
    staticKey: key,
    version: "0.1.0",
    clock: SYSTEM_CLOCK,
    log: memoryLog(),
    ca: tls.cert,
    random: () => 0.5,
  });
  stops.push(() => {
    link.stop();
  });
  const selfIndex = new FolderReleaseIndex(self, SILENT_LOG);
  (await selfIndex.refresh())._unsafeUnwrap();
  const cache = new UpstreamCache({
    index: selfIndex,
    clock: SYSTEM_CLOCK,
    log: SILENT_LOG,
    channel: link.releaseChannel,
  });
  stops.push(() => {
    cache.stop();
  });
  const answers: UpstreamAnswer[] = [];
  link.attachReleases({
    answer(answer) {
      answers.push(answer);
      cache.answer(answer);
    },
    linkDown: () => {
      cache.linkDown();
    },
    fill: () => cache.fill(),
  });
  return {
    operated,
    self,
    big,
    small,
    seen,
    answers,
    link,
    cache,
    selfIndex,
    live: routes.live,
    identity: relayIdentity(key.publicKey) ?? "",
    url: `wss://127.0.0.1:${port}/v1/relay`,
    ca: tls.cert,
    async cut() {
      await listeners?.stop();
    },
    restore: serve,
    async cutReleases() {
      await forwarding?.stop();
      forwarding = undefined;
    },
    restoreReleases() {
      forwarding = serveReleases();
    },
  };
}

const same = (w: World, file: string) =>
  existsSync(join(w.self, file)) &&
  readFileSync(join(w.self, file)).equals(readFileSync(join(w.operated, file)));

describe("a self-hosted relay's release cache over its relay link", () => {
  test("fills with every offered file, in pieces, counted against the relay key and the link's address", async () => {
    const w = await world();
    w.link.start();
    expect(await until(() => same(w, w.big) && same(w, w.small))).toBe(true);
    const bigPieces = w.seen.filter((s) => s.request.file === w.big).map((s) => s.request.offset);
    expect(bigPieces).toEqual([0, PIECE, 2 * PIECE]);
    expect(w.seen).toHaveLength(4);
    expect(w.seen.every((s) => s.request.length <= PIECE)).toBe(true);
    expect(w.seen[0]?.peer).toEqual({ kind: "relay", identity: w.identity, address: "127.0.0.1" });
    expect(w.answers.filter((a) => a.kind === "piece")).toHaveLength(4);
  });

  test("a fetch cut by the link dropping resumes at the partial file's length when the link is back", async () => {
    const cutting: { world?: World; done: boolean } = { done: false };
    const w = await world({
      hold: (seen) => {
        const target = cutting.world;
        if (cutting.done || seen.request.file !== target?.big || seen.request.offset !== PIECE) {
          return undefined;
        }
        cutting.done = true;
        // The second piece is asked for: the link goes before it is answered.
        return target.cut();
      },
    });
    cutting.world = w;
    w.link.start();
    expect(await until(() => cutting.done && !w.link.up)).toBe(true);
    const partial = join(w.self, `.partial-${w.big}`);
    expect(await until(() => existsSync(partial))).toBe(true);
    expect(readFileSync(partial).length).toBe(PIECE);
    w.restore();
    expect(await until(() => same(w, w.big), 8000)).toBe(true);
    const bigPieces = w.seen.filter((s) => s.request.file === w.big).map((s) => s.request.offset);
    // Offset 0 once; the piece at PIECE asked again after the cut, not from the start.
    expect(bigPieces.filter((o) => o === 0)).toHaveLength(1);
    expect(bigPieces.filter((o) => o === PIECE)).toHaveLength(2);
    expect(existsSync(partial)).toBe(false);
  });

  test("over the releases role's budget: release.error limit, with when to retry, and the fill stops", async () => {
    // A daily egress budget a little over one piece, for the whole service.
    const w = await world({ budget: new ReleaseBudget(undefined, PIECE + 10_000) });
    w.link.start();
    expect(await until(() => w.answers.some((a) => a.kind === "error"))).toBe(true);
    const error = w.answers.find((a) => a.kind === "error");
    expect(error?.kind === "error" ? error.reason : "").toBe("limit");
    expect(error?.kind === "error" ? (error.retryAfterMs ?? 0) : 0).toBeGreaterThan(0);
    await Bun.sleep(200);
    expect(same(w, w.big)).toBe(false);
  });

  test("with no releases socket configured: an empty offer, and unavailable for a piece", async () => {
    const w = await world({ releases: false });
    w.link.start();
    expect(await until(() => w.link.up)).toBe(true);
    expect(await until(() => w.answers.length >= RELEASE_PLATFORMS.length, 1000)).toBe(true);
    expect(w.answers).toEqual(RELEASE_PLATFORMS.map(() => ({ kind: "offer", releases: [] })));
    expect(
      w.link.releaseChannel.send({ t: "release.get", id: 9, file: w.big, offset: 0, length: 10 }),
    ).toBe(true);
    expect(await until(() => w.answers.some((a) => a.kind === "error"))).toBe(true);
    expect(w.answers.find((a) => a.kind === "error")).toEqual({
      kind: "error",
      id: 9,
      reason: "unavailable",
    });
    expect(w.seen).toHaveLength(0);
    expect(w.live()).toBe(0);
  });

  test("a releases socket can restart while the relay link stays joined", async () => {
    const w = await world();
    w.link.start();
    expect(await until(() => same(w, w.big) && same(w, w.small))).toBe(true);
    w.answers.length = 0;
    await w.cutReleases();
    expect(await until(() => w.live() === 0)).toBe(true);
    expect(w.link.up).toBe(true);
    const check = { t: "release.check", platform: "linux-x64", running: "0.0.0" } as const;
    expect(w.link.releaseChannel.send(check)).toBe(true);
    expect(await until(() => w.answers.length === 1)).toBe(true);
    expect(w.answers[0]).toEqual({ kind: "offer", releases: [] });
    w.restoreReleases();
    expect(w.link.releaseChannel.send(check)).toBe(true);
    expect(await until(() => w.answers.length === 2)).toBe(true);
    const offer = w.answers[1];
    expect(offer?.kind === "offer" ? offer.releases.map((entry) => entry.file) : []).toEqual([
      w.big,
    ]);
    expect(
      w.link.releaseChannel.send({ t: "release.get", id: 999, file: w.big, offset: 0, length: 10 }),
    ).toBe(true);
    expect(await until(() => w.answers.length === 3)).toBe(true);
    const piece = w.answers[2];
    expect(piece?.kind === "piece" ? [piece.id, piece.bytes.length] : []).toEqual([999, 10]);
    expect(w.link.up).toBe(true);
  });

  test("the link's own cap: a fifth piece in hand is limit, from the push service itself", async () => {
    const released: (() => void)[] = [];
    const w = await world({
      hold: () =>
        new Promise<void>((resolve) => {
          released.push(resolve);
        }),
    });
    w.link.start();
    expect(await until(() => w.link.up)).toBe(true);
    // Wait for the cache's own first piece to be in hand, then ask for four more.
    expect(await until(() => w.seen.length === 1)).toBe(true);
    for (let id = 900; id < 904; id += 1) {
      expect(
        w.link.releaseChannel.send({ t: "release.get", id, file: w.small, offset: 0, length: 10 }),
      ).toBe(true);
    }
    expect(await until(() => w.answers.some((a) => a.kind === "error"))).toBe(true);
    expect(w.answers.filter((a) => a.kind === "error")).toEqual([
      { kind: "error", id: 903, reason: "limit", retryAfterMs: 1000 },
    ]);
    expect(w.seen).toHaveLength(4);
    for (const release of released) release();
  });

  test("a forwarding socket per joined link, each closed with its link: none left open", async () => {
    const w = await world();
    const links: PushLink[] = [];
    for (let i = 0; i < 5; i += 1) {
      const other = new PushLink({
        url: w.url,
        staticKey: relayKey(),
        version: "0.1.0",
        clock: SYSTEM_CLOCK,
        log: memoryLog(),
        ca: w.ca,
        random: () => 0.5,
      });
      stops.push(() => {
        other.stop();
      });
      other.start();
      links.push(other);
    }
    expect(links).toHaveLength(5);
    expect(await until(() => links.every((l) => l.up))).toBe(true);
    expect(await until(() => w.live() === 5)).toBe(true);
    for (const l of links.slice(0, 3)) l.stop();
    expect(await until(() => w.live() === 2)).toBe(true);
    await w.cut();
    expect(await until(() => w.live() === 0)).toBe(true);
  });
});

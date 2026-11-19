/**
 * The releases role (docs/m4-design.md section 6; D142's "Releases" row): the folder's signed
 * files of both kinds indexed by their manifests; `release.check` and `release.get` on joined hub
 * links only, in pieces, resumable, within the budgets; and a self-hosted relay filling its cache
 * from the operated releases role through the forwarding socket the push process uses, resuming a
 * cut fetch. Release files are made here with the published layout; the relay checks no
 * signature, so theirs are zeros.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  FIRMWARE_RELEASE,
  firmwareReleaseFileName,
  HUB_RELEASE,
  RELEASE_PLATFORMS,
  hubReleaseFileName,
  type ReleasePlatform,
} from "@hsn/protocol/release";
import { encodeTextFrame, RELAY_CLOSE, RELAY_LIMITS, releaseOffer } from "@hsn/protocol/relay";
import { ReleaseBudget } from "../src/core/release-budget.ts";
import { PROTECTION_LIMITS } from "../src/core/rules.ts";
import { untilNextUtcDay } from "../src/core/time.ts";
import { FolderReleaseIndex } from "../src/releases/folder-index.ts";
import {
  listenForwarding,
  type ForwardingListener,
  ReleaseForwarder,
} from "../src/releases/forwarding.ts";
import type { PieceAnswer, ReleaseAnswers } from "../src/releases/service.ts";
import { ReleaseService } from "../src/releases/service.ts";
import {
  readUpstreamAnswer,
  socketChannel,
  UpstreamCache,
  type UpstreamChannel,
  type UpstreamRequest,
} from "../src/releases/upstream.ts";
import {
  Client,
  cleanup,
  ManualClock,
  memoryLog,
  must,
  settle,
  StandInHub,
  startRelay,
  tempFolder,
  type TestRelay,
  until,
} from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 18, 12);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A release file of the published layout: fixed bytes, manifest, a zero signature, the payload. */
function releaseBytes(
  kind: "hub" | "firmware",
  version: string,
  payloadBytes: number,
  options: { platform?: ReleasePlatform; target?: string; manifestVersion?: string } = {},
): Uint8Array {
  const payload = new Uint8Array(randomBytes(payloadBytes));
  const manifest =
    kind === "hub"
      ? {
          version: options.manifestVersion ?? version,
          platform: options.platform ?? "linux-arm64",
          madeMs: T0,
          payloadBytes,
          payloadSha256: sha(payload),
          files: [{ path: "hub", bytes: payloadBytes, sha256: sha(payload), executable: true }],
        }
      : {
          kind: "firmware",
          version: options.manifestVersion ?? version,
          target: options.target ?? FIRMWARE_RELEASE.target,
          roles: [1, 2],
          payloadBytes,
          payloadSha256: sha(payload),
          madeMs: T0,
        };
  const layout = kind === "hub" ? HUB_RELEASE : FIRMWARE_RELEASE;
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const out = new Uint8Array(
    layout.fixedBytes + json.length + layout.signatureBytes + payloadBytes,
  );
  out.set(new TextEncoder().encode(layout.magic), 0);
  out[4] = layout.format;
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, layout.fixedBytes);
  out.set(payload, layout.fixedBytes + json.length + layout.signatureBytes);
  return out;
}

function writeRelease(
  folder: string,
  kind: "hub" | "firmware",
  version: string,
  payloadBytes: number,
  platform: ReleasePlatform = "linux-arm64",
): { file: string; bytes: Uint8Array } {
  const file =
    kind === "hub" ? hubReleaseFileName(version, platform) : firmwareReleaseFileName(version);
  const bytes = releaseBytes(kind, version, payloadBytes, { platform });
  writeFileSync(join(folder, file), bytes);
  return { file, bytes };
}

describe("the index", () => {
  let folder: string;
  beforeEach(() => {
    folder = tempFolder();
  });
  afterEach(() => {
    cleanup(folder);
  });

  test("offers the newest hub release above `running` for the platform, and the newest firmware above the hub's", async () => {
    writeRelease(folder, "hub", "1.2.0", 100);
    const newest = writeRelease(folder, "hub", "1.10.0", 200);
    writeRelease(folder, "hub", "2.0.0", 50, "darwin-arm64");
    writeRelease(folder, "firmware", "0.9.0", 64);
    const firmware = writeRelease(folder, "firmware", "1.0.1", 80);
    const index = new FolderReleaseIndex(folder, memoryLog());
    must(await index.refresh());
    const offers = index.offer({ platform: "linux-arm64", running: "1.2.0" });
    expect(offers).toEqual([
      {
        kind: "hub",
        version: "1.10.0",
        platform: "linux-arm64",
        file: newest.file,
        bytes: newest.bytes.length,
        sha256: sha(newest.bytes),
      },
      {
        kind: "firmware",
        version: "1.0.1",
        target: "esp32s3",
        roles: [1, 2],
        file: firmware.file,
        bytes: firmware.bytes.length,
        sha256: sha(firmware.bytes),
      },
    ]);
    for (const offer of offers) expect(releaseOffer.safeParse(offer).success).toBe(true);
    // Up to date: nothing above what it runs and holds.
    expect(index.offer({ platform: "linux-arm64", running: "1.10.0", firmware: "1.0.1" })).toEqual(
      [],
    );
    // Version compared as numbers, not text: 1.9.0 is below 1.10.0.
    expect(
      index
        .offer({ platform: "linux-arm64", running: "1.9.0", firmware: "1.0.0" })
        .map((o) => o.version),
    ).toEqual(["1.10.0", "1.0.1"]);
    expect(index.offer({ platform: "windows-x64", running: "0.0.0", firmware: "9.0.0" })).toEqual(
      [],
    );
  });

  test("leaves out files it must not offer, and follows the folder", async () => {
    writeFileSync(join(folder, "hsn-hub-1.0.0-linux-arm64.hsnr"), new Uint8Array(100)); // no magic
    writeFileSync(
      join(folder, "hsn-hub-1.1.0-linux-arm64.hsnr"),
      releaseBytes("hub", "1.1.0", 10, { manifestVersion: "1.2.0" }),
    ); // name and manifest differ
    writeFileSync(
      join(folder, "hsn-firmware-1.0.0.hsnf"),
      releaseBytes("firmware", "1.0.0", 10, { target: "esp32c6" }),
    ); // a board the offer cannot name
    writeFileSync(join(folder, "notes.txt"), "not a release");
    const log = memoryLog();
    const index = new FolderReleaseIndex(folder, log);
    must(await index.refresh());
    expect(index.entries()).toEqual([]);
    expect(log.text()).toContain('"refused":3');
    const added = writeRelease(folder, "hub", "1.3.0", 10);
    must(await index.refresh());
    expect(index.entries().map((e) => e.file)).toEqual([added.file]);
    rmSync(join(folder, added.file));
    must(await index.refresh());
    expect(index.entries()).toEqual([]);
  });

  test(`a file over its kind's cap is not offered (firmware: ${RELAY_LIMITS.maxFirmwareReleaseBytes} bytes)`, async () => {
    // A payload length of as many digits as the cap's, so the manifest is as long.
    const overhead = releaseBytes("firmware", "1.0.0", 1_000_000).length - 1_000_000;
    writeFileSync(
      join(folder, firmwareReleaseFileName("1.0.0")),
      releaseBytes("firmware", "1.0.0", RELAY_LIMITS.maxFirmwareReleaseBytes - overhead),
    );
    writeFileSync(
      join(folder, firmwareReleaseFileName("1.0.1")),
      releaseBytes("firmware", "1.0.1", RELAY_LIMITS.maxFirmwareReleaseBytes - overhead + 1),
    );
    const index = new FolderReleaseIndex(folder, memoryLog());
    must(await index.refresh());
    expect(index.entries().map((e) => e.version)).toEqual(["1.0.0"]);
  });

  test("a large file is hashed in pieces: the relay's thread keeps turning while it is indexed", async () => {
    const payload = 48 * 1024 * 1024;
    writeRelease(folder, "hub", "3.0.0", payload);
    const index = new FolderReleaseIndex(folder, memoryLog());
    const state = { done: false };
    const refreshed = index.refresh().map(() => {
      state.done = true;
    });
    let turns = 0;
    let longest = 0;
    let last = performance.now();
    while (!state.done) {
      await new Promise((resolve) => setImmediate(resolve));
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      turns += 1;
    }
    must(await refreshed);
    expect(index.entries()).toHaveLength(1);
    // One turn at least per piece read; none held anywhere near the 0.3 s of a whole file.
    expect(turns).toBeGreaterThan(payload / RELAY_LIMITS.maxReleasePieceBytes / 2);
    expect(longest).toBeLessThan(50);
  });

  test("reads exactly the range asked, or says why not", async () => {
    const release = writeRelease(folder, "firmware", "1.0.0", 1000);
    const index = new FolderReleaseIndex(folder, memoryLog());
    must(await index.refresh());
    expect(must(await index.read(release.file, 5, 10))).toEqual(release.bytes.slice(5, 15));
    const n = release.bytes.length;
    expect(must(await index.read(release.file, n - 1, 1))).toEqual(release.bytes.slice(n - 1));
    expect((await index.read(release.file, n - 1, 2))._unsafeUnwrapErr()).toEqual({
      kind: "range",
    });
    expect((await index.read("hsn-firmware-9.9.9.hsnf", 0, 1))._unsafeUnwrapErr()).toEqual({
      kind: "notFound",
    });
  });
});

describe("through a hub link", () => {
  let folder: string;
  let releasesFolder: string;
  let t: TestRelay;
  let budget: ReleaseBudget;

  async function start(answers?: ReleaseAnswers) {
    const clock = new ManualClock(T0);
    const index = new FolderReleaseIndex(releasesFolder, memoryLog());
    must(await index.refresh());
    budget = new ReleaseBudget();
    t = startRelay(folder, {
      clock,
      releases: answers ?? new ReleaseService(index, budget, clock, memoryLog()),
    });
  }

  beforeEach(() => {
    folder = tempFolder();
    releasesFolder = join(folder, "releases");
    mkdirSync(releasesFolder);
  });
  afterEach(async () => {
    await t.stop();
    cleanup(folder);
  });

  /** Fetches `file` from `from` in pieces of the largest size, `inFlight` at once, starting at `offset`. */
  async function fetchFile(
    hub: StandInHub,
    file: string,
    bytes: number,
    offset = 0,
    stopAt = bytes,
  ): Promise<Uint8Array> {
    const out = new Uint8Array(stopAt - offset);
    let id = 1000 + offset;
    for (let at = offset; at < stopAt; at += RELAY_LIMITS.maxReleasePieceBytes) {
      const length = Math.min(RELAY_LIMITS.maxReleasePieceBytes, stopAt - at);
      const request = id++;
      hub.send({ t: "release.get", id: request, file, offset: at, length });
      await until(() => hub.pieces().has(request), "a piece");
      const piece = hub.pieces().get(request) ?? new Uint8Array();
      expect(piece.length).toBe(length);
      out.set(piece, at - offset);
    }
    return out;
  }

  test("a release is offered and fetched in pieces, its bytes and SHA-256 the file's", async () => {
    const release = writeRelease(
      releasesFolder,
      "hub",
      "1.1.0",
      3 * RELAY_LIMITS.maxReleasePieceBytes + 17,
    );
    await start();
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    hub.send({ t: "release.check", platform: "linux-arm64", running: "1.0.0" });
    const offer = await hub.next("release.offer");
    expect(offer.releases).toHaveLength(1);
    const listed = offer.releases[0];
    const fetched = await fetchFile(hub, release.file, release.bytes.length);
    expect(fetched).toEqual(release.bytes);
    expect(sha(fetched)).toBe(listed?.sha256 ?? "");
  });

  test("a fetch cut half-way resumes on a new link at its offset", async () => {
    const release = writeRelease(
      releasesFolder,
      "firmware",
      "1.0.0",
      2 * RELAY_LIMITS.maxReleasePieceBytes + 5,
    );
    await start();
    const first = await StandInHub.connect(t.url);
    await first.next("joined");
    const half = RELAY_LIMITS.maxReleasePieceBytes;
    const head = await fetchFile(first, release.file, release.bytes.length, 0, half);
    first.client.close();
    await until(() => t.relay.counts.joined === 0, "the link to close");
    const second = await StandInHub.connect(t.url, {
      key: { key: first.key, identity: first.identity },
    });
    await second.next("joined");
    const tail = await fetchFile(second, release.file, release.bytes.length, half);
    const whole = new Uint8Array(release.bytes.length);
    whole.set(head, 0);
    whole.set(tail, half);
    expect(sha(whole)).toBe(sha(release.bytes));
  });

  test("each refusal is answered in order: notFound, range, then limit until midnight UTC", async () => {
    const release = writeRelease(releasesFolder, "firmware", "1.0.0", 1000);
    await start();
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const n = release.bytes.length;
    hub.send({ t: "release.get", id: 1, file: "hsn-firmware-9.0.0.hsnf", offset: 0, length: 1 });
    expect(await hub.next("release.error")).toEqual({
      t: "release.error",
      id: 1,
      reason: "notFound",
    });
    hub.send({ t: "release.get", id: 2, file: release.file, offset: n - 10, length: 11 });
    expect(await hub.next("release.error")).toEqual({ t: "release.error", id: 2, reason: "range" });
    // Three whole downloads per file per identity per day: the fourth is refused.
    for (let i = 0; i < PROTECTION_LIMITS.releases.downloadsPerFilePerIdentityPerDay; i++) {
      await fetchFile(hub, release.file, n);
    }
    hub.send({ t: "release.get", id: 3, file: release.file, offset: 0, length: 1 });
    expect(await hub.next("release.error")).toEqual({
      t: "release.error",
      id: 3,
      reason: "limit",
      retryAfterMs: untilNextUtcDay(T0),
    });
    expect(hub.pieces().has(3)).toBe(false);
    // Midnight UTC: allowed again (on a new link: the old one fell silent meanwhile).
    t.clock.to(T0 + untilNextUtcDay(T0));
    const next = await StandInHub.connect(t.url, { key: { key: hub.key, identity: hub.identity } });
    await next.next("joined");
    next.send({ t: "release.get", id: 4, file: release.file, offset: 0, length: 1 });
    await until(() => next.pieces().has(4), "a piece after midnight");
  });

  test("never on an unauthenticated connection", async () => {
    const release = writeRelease(releasesFolder, "firmware", "1.0.0", 100);
    await start();
    const get = must(
      encodeTextFrame("hubToRelay", {
        t: "release.get",
        id: 1,
        file: release.file,
        offset: 0,
        length: 10,
      }),
    );
    const check = must(
      encodeTextFrame("hubToRelay", {
        t: "release.check",
        platform: "linux-arm64",
        running: "0.0.0",
      }),
    );
    for (const frame of [get, check]) {
      const raw = new Client(`${t.url}/v1/hub`);
      await raw.open();
      raw.send(frame);
      expect(await raw.closed()).toBe(RELAY_CLOSE.badFrame);
      expect(raw.binaries).toEqual([]);
      expect(raw.texts).toEqual([]);
    }
    // A phone's stream cannot ask either: it carries binary only, to the hub.
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const phone = new Client(`${t.url}/v1/phone/${hub.identity}/session`);
    await phone.open();
    phone.send(get);
    expect(await phone.closed()).toBe(1003);
    expect(phone.binaries).toEqual([]);
    expect(budget.egressToday(T0)).toBe(0);
  });

  test(`at most ${RELAY_LIMITS.maxReleasePiecesInFlight} pieces in hand per link; the next is answered limit`, async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answers: ReleaseAnswers = {
      check: () => [],
      get: async (): Promise<PieceAnswer> => {
        await held;
        return { ok: true, bytes: new Uint8Array([7]) };
      },
    };
    await start(answers);
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    for (let i = 1; i <= RELAY_LIMITS.maxReleasePiecesInFlight + 1; i++) {
      hub.send({ t: "release.get", id: i, file: "hsn-firmware-1.0.0.hsnf", offset: 0, length: 1 });
    }
    expect(await hub.next("release.error")).toEqual({
      t: "release.error",
      id: RELAY_LIMITS.maxReleasePiecesInFlight + 1,
      reason: "limit",
    });
    release();
    await until(() => hub.pieces().size === RELAY_LIMITS.maxReleasePiecesInFlight, "the pieces");
  });

  test("without the releases role: nothing offered, every piece unavailable", async () => {
    t = startRelay(folder, { roles: ["relay"] });
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    expect(hub.welcome?.roles).toEqual(["relay"]);
    hub.send({ t: "release.check", platform: "linux-arm64", running: "0.0.0" });
    expect(await hub.next("release.offer")).toEqual({ t: "release.offer", releases: [] });
    hub.send({ t: "release.get", id: 9, file: "hsn-firmware-1.0.0.hsnf", offset: 0, length: 1 });
    expect(await hub.next("release.error")).toEqual({
      t: "release.error",
      id: 9,
      reason: "unavailable",
    });
  });
});

describe("relay links, through the forwarding socket", () => {
  let operated: string;
  let selfHosted: string;
  let socketPath: string;
  let forwarding: ForwardingListener;
  let service: ReleaseService;
  const clock = new ManualClock(T0);
  const relayIdentity = "relayrelayrelayrelayrelay2";

  beforeEach(async () => {
    const root = tempFolder();
    operated = join(root, "operated");
    selfHosted = join(root, "self");
    mkdirSync(operated);
    mkdirSync(selfHosted);
    socketPath = join(root, "r.sock");
    const index = new FolderReleaseIndex(operated, memoryLog());
    writeRelease(operated, "hub", "1.4.0", 2 * RELAY_LIMITS.maxReleasePieceBytes + 9, "linux-x64");
    writeRelease(operated, "hub", "1.4.0", 1234, "darwin-arm64");
    writeRelease(operated, "firmware", "2.0.0", RELAY_LIMITS.maxReleasePieceBytes + 1);
    must(await index.refresh());
    service = new ReleaseService(index, new ReleaseBudget(), clock, memoryLog());
    forwarding = must(listenForwarding(service, socketPath, memoryLog()));
  });

  afterEach(async () => {
    await forwarding.stop();
    cleanup(join(operated, ".."));
  });

  // Windows does not expose Unix-domain socket permissions as POSIX mode bits.
  test.skipIf(process.platform === "win32")(
    "the socket is the operator's account's alone (0600)",
    () => {
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    },
  );

  test("a self-hosted relay's cache fills with every offered file, whole and checked", async () => {
    const index = new FolderReleaseIndex(selfHosted, memoryLog());
    must(await index.refresh());
    const channel = must(socketChannel(socketPath, relayIdentity));
    const cache = new UpstreamCache({ index, clock, log: memoryLog(), channel });
    channel.attach(cache);
    expect(await cache.fill()).toBe(3);
    const files = readdirNames(operated);
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(readFileSync(join(selfHosted, file))).toEqual(readFileSync(join(operated, file)));
    }
    expect(index.entries()).toHaveLength(3);
    // Filled already: nothing more is fetched.
    expect(await cache.fill()).toBe(0);
    channel.close();
  });

  test("a reset direct socket channel opens another connection for the next fill", async () => {
    const index = new FolderReleaseIndex(selfHosted, memoryLog());
    const channel = must(socketChannel(socketPath, relayIdentity));
    const cache = new UpstreamCache({ index, clock, log: memoryLog(), channel });
    channel.attach(cache);
    channel.reset();
    expect(await cache.fill()).toBe(3);
    expect(index.entries()).toHaveLength(3);
    cache.stop();
    channel.close();
  });

  test("a late offer from a timed-out direct socket cannot answer the replacement fill", async () => {
    const replies: (() => void)[] = [];
    const open = ReleaseForwarder.open.bind(ReleaseForwarder);
    using forwarder = spyOn(ReleaseForwarder, "open").mockImplementation(
      (path, peer, answer, closed) =>
        open(
          path,
          peer,
          (data) => {
            // Hold delivery past the timeout without depending on WebSocket close timing.
            replies.push(() => {
              answer(data);
            });
          },
          closed,
        ),
    );
    const timer = new ManualClock(T0);
    const index = new FolderReleaseIndex(selfHosted, memoryLog());
    const channel = must(socketChannel(socketPath, relayIdentity));
    const cache = new UpstreamCache({ index, clock: timer, log: memoryLog(), channel });
    channel.attach(cache);

    const expired = cache.fill();
    await until(() => replies.length === 1, "the first socket's offer");
    timer.advance(RELAY_LIMITS.silentLinkMs);
    expect(await expired).toBe(0);
    const replacement = cache.fill();
    await until(() => replies.length === 2, "the replacement socket's offer");
    expect(forwarder).toHaveBeenCalledTimes(2);

    using answer = spyOn(cache, "answer");
    const [late, current] = replies;
    late?.();
    const afterLate = answer.mock.calls.length;
    current?.();
    const afterCurrent = answer.mock.calls.length;
    cache.stop();
    channel.close();
    expect(await replacement).toBe(0);
    expect(afterLate).toBe(0);
    expect(afterCurrent).toBe(1);
  });

  test.each(["release.check", "release.get"] as const)(
    "a silent %s times out at the silent-link bound and a fresh fill can finish",
    async (silent) => {
      const index = new FolderReleaseIndex(selfHosted, memoryLog());
      const timer = new ManualClock(T0);
      const asked: UpstreamRequest[] = [];
      let resets = 0;
      const cache = new UpstreamCache({
        index,
        clock: timer,
        log: memoryLog(),
        channel: {
          send(frame) {
            asked.push(frame);
            return true;
          },
          reset() {
            resets += 1;
          },
        },
      });
      const fill = cache.fill();
      if (silent === "release.get") {
        for (const platform of RELEASE_PLATFORMS) {
          expect(asked.at(-1)).toMatchObject({ t: "release.check", platform });
          const releases = service.check(
            { kind: "relay", identity: relayIdentity, address: null },
            { platform, running: "0.0.0" },
          );
          cache.answer({ kind: "offer", releases });
          await Promise.resolve();
        }
      }
      expect(asked.at(-1)?.t).toBe(silent);
      expect(timer.pending).toBe(1);
      timer.advance(RELAY_LIMITS.silentLinkMs - 1);
      expect(resets).toBe(0);
      expect(timer.pending).toBe(1);
      timer.advance(1);
      expect(await fill).toBe(0);
      expect(resets).toBe(1);
      expect(timer.pending).toBe(0);

      const again = cache.fill();
      for (const platform of RELEASE_PLATFORMS) {
        expect(asked.at(-1)).toMatchObject({ t: "release.check", platform });
        cache.answer({ kind: "offer", releases: [] });
        await Promise.resolve();
      }
      expect(await again).toBe(0);
      expect(timer.pending).toBe(0);
      cache.stop();
    },
  );

  test("a fill cut half-way resumes at the partial file's length", async () => {
    const index = new FolderReleaseIndex(selfHosted, memoryLog());
    must(await index.refresh());
    const asked: UpstreamRequest[] = [];
    const inner = must(socketChannel(socketPath, relayIdentity));
    let cutAfter = 2;
    const channel: UpstreamChannel = {
      reset() {
        inner.reset();
      },
      send(frame) {
        if (frame.t === "release.get") {
          if (cutAfter === 0) return false;
          cutAfter -= 1;
        }
        asked.push(frame);
        return inner.send(frame);
      },
    };
    const cache = new UpstreamCache({ index, clock, log: memoryLog(), channel });
    inner.attach(cache);
    // The small file whole, then the first piece of the next, then the link is cut.
    expect(await cache.fill()).toBe(1);
    const partials = readdirNames(selfHosted, true).filter((n) => n.startsWith(".partial-"));
    expect(partials).toHaveLength(1);
    const partialFile = partials[0] ?? "";
    const offsetAtCut = readFileSync(join(selfHosted, partialFile)).length;
    expect(offsetAtCut).toBeGreaterThan(0);
    // The link is back: the fetch goes on from where it stopped.
    cutAfter = Number.POSITIVE_INFINITY;
    asked.length = 0;
    expect(await cache.fill()).toBe(2);
    expect(index.entries()).toHaveLength(3);
    const resumed = asked.find(
      (f) => f.t === "release.get" && `.partial-${f.file}` === partialFile,
    );
    expect(resumed?.t === "release.get" ? resumed.offset : -1).toBe(offsetAtCut);
    expect(existsSync(join(selfHosted, partialFile))).toBe(false);
    inner.close();
  });

  test("a relay key's budget is counted: the fourth download of a file is limit", async () => {
    const answers: (string | Uint8Array)[] = [];
    const forwarder = must(
      ReleaseForwarder.open(
        socketPath,
        { identity: relayIdentity, address: "198.51.100.7" },
        (a) => {
          answers.push(a);
        },
      ),
    );
    const file = hubReleaseFileName("1.4.0", "darwin-arm64");
    const entry = service.index.find(file);
    const bytes = entry?.bytes ?? 0;
    for (let i = 1; i <= 4; i++) {
      const text = must(
        encodeTextFrame("relayToPush", { t: "release.get", id: i, file, offset: 0, length: bytes }),
      );
      expect(await forwarder.forward(text)).toBe(true);
      await until(() => answers.length === i, "an answer");
    }
    const read = answers.map((a) => readUpstreamAnswer(a));
    expect(read.slice(0, 3).map((a) => a?.kind)).toEqual(["piece", "piece", "piece"]);
    expect(read[3]).toEqual({
      kind: "error",
      id: 4,
      reason: "limit",
      retryAfterMs: untilNextUtcDay(T0),
    });
    // Anything but a release frame closes the forwarded link.
    const push = must(encodeTextFrame("relayToPush", { t: "ping", n: 1 }));
    await forwarder.forward(push);
    await settle(50);
    expect(await forwarder.forward(push)).toBe(false);
    forwarder.close();
  });

  test("a path that names no relay key is not upgraded", async () => {
    const answers: unknown[] = [];
    let closed = false;
    const forwarder = must(
      ReleaseForwarder.open(
        socketPath,
        { identity: "NOT-AN-IDENTITY", address: null },
        (a) => answers.push(a),
        () => {
          closed = true;
        },
      ),
    );
    expect(await forwarder.forward("{}")).toBe(false);
    await until(() => closed, "the refusal");
  });
});

/** Lists a folder, optionally including dot files. */
function readdirNames(folder: string, all = false): string[] {
  const names = readdirSync(folder);
  return all ? names : names.filter((n) => !n.startsWith("."));
}

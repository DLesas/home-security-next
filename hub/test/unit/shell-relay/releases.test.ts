/**
 * Releases over the relay link (docs/m4-design.md section 6; D84, D129), from B2's real relay and
 * its releases role reading a folder: offered when the link comes up; a hub release signed with
 * `TEST_PUBLISHER_KEY` fetched in pieces into the upload store, then staged by M2's own staging, as
 * an upload is; a fetch cut half-way and resumed at the first byte it did not hold; refused over
 * the relay's budget; over its kind's cap before a byte is asked for; a changed file refused; and
 * a firmware release handed to `stageFirmware`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIRMWARE_RELEASE,
  firmwareReleaseFileName,
  hubReleaseFileName,
} from "@hsn/protocol/release";
import { RELAY_BINARY_KIND, relayBinaryCodec, RELAY_LIMITS } from "@hsn/protocol/relay";
import type { FileWork } from "../../../src/core/model/effects.ts";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { jobId, type JobId } from "../../../src/core/model/ids.ts";
import { emptyState } from "../../../src/core/step.ts";
import type { JobPieces, JobStarted } from "../../../src/shell/loop.ts";
import { hubReleaseWanted } from "../../../src/shell/relay/releases.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import { Staging } from "../../../src/shell/update/stage.ts";
import { installPaths } from "../../../launcher/src/layout.ts";
import { releaseOfFiles } from "../../../packaging/shared/make-release.ts";
import { ReleaseBudget } from "../../../../relay/src/core/release-budget.ts";
import { FolderReleaseIndex } from "../../../../relay/src/releases/folder-index.ts";
import {
  type PieceAnswer,
  type PieceRequest,
  type ReleaseAnswers,
  ReleaseService,
} from "../../../../relay/src/releases/service.ts";
import { ManualClock, memoryLog } from "../../../../relay/test/helpers.ts";
import {
  type ClientSide,
  makeClient,
  type RelayRun,
  ScriptedRelay,
  settle,
  type ScriptedLink,
  startRelayRun,
  staticKeyOf,
  stopAll,
  until,
} from "./support.ts";

const SEED = new Uint8Array(32).fill(7);
const PAYLOAD_BYTES = 3_000_000;
let root: string;
let releases: string;
let hubFile: string;
let hubBytes: Uint8Array;
let firmwareFile: string;
let firmwareBytes: Uint8Array;

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hsn-relay-releases-"));
  releases = join(root, "releases");
  mkdirSync(releases);
  // Bytes that do not compress, so the release is several pieces long.
  const made = releaseOfFiles(
    [
      { path: "bin/hsn-hub", data: new Uint8Array(randomBytes(PAYLOAD_BYTES)), executable: true },
      {
        path: "drizzle/0000.sql",
        data: new TextEncoder().encode("CREATE TABLE x (a);"),
        executable: false,
      },
    ],
    "9.0.0",
    "darwin-arm64",
    SEED,
    0,
  );
  if (made.isErr()) expect(made.error).toBe("a release");
  hubBytes = made.unwrapOr(new Uint8Array());
  hubFile = hubReleaseFileName("9.0.0", "darwin-arm64");
  writeFileSync(join(releases, hubFile), hubBytes);
  firmwareBytes = firmwareRelease("1.2.3", 400_000);
  firmwareFile = firmwareReleaseFileName("1.2.3");
  writeFileSync(join(releases, firmwareFile), firmwareBytes);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  await stopAll();
});

/** A firmware release of the published layout; the relay checks no signature, so its is zeros. */
function firmwareRelease(version: string, payloadBytes: number): Uint8Array {
  const payload = new Uint8Array(randomBytes(payloadBytes));
  const json = new TextEncoder().encode(
    JSON.stringify({
      kind: "firmware",
      version,
      target: FIRMWARE_RELEASE.target,
      roles: [1, 2],
      payloadBytes,
      payloadSha256: sha(payload).toString("hex"),
      madeMs: 0,
    }),
  );
  const out = new Uint8Array(
    FIRMWARE_RELEASE.fixedBytes + json.length + FIRMWARE_RELEASE.signatureBytes + payloadBytes,
  );
  out.set(new TextEncoder().encode(FIRMWARE_RELEASE.magic), 0);
  out[4] = FIRMWARE_RELEASE.format;
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, FIRMWARE_RELEASE.fixedBytes);
  out.set(payload, FIRMWARE_RELEASE.fixedBytes + json.length + FIRMWARE_RELEASE.signatureBytes);
  return out;
}

/** The install's prefix, as the launcher lays it out, for staging into. */
function prefix(): string {
  const p = mkdtempSync(join(root, "prefix-"));
  mkdirSync(join(p, "staged", "0.1.0", "bin"), { recursive: true });
  mkdirSync(join(p, "state"), { recursive: true });
  writeFileSync(
    installPaths(p).launcherFile,
    JSON.stringify({ current: "0.1.0", previous: null, trial: null, rolledBack: null }),
  );
  return p;
}

/** The releases role's answers, every request it was asked recorded. */
async function service(
  budget = new ReleaseBudget(),
): Promise<{ answers: ReleaseAnswers; asked: PieceRequest[]; clock: ManualClock }> {
  const clock = new ManualClock(Date.UTC(2026, 10, 18, 12));
  const index = new FolderReleaseIndex(releases, memoryLog());
  expect((await index.refresh()).isOk()).toBe(true);
  const real = new ReleaseService(index, budget, clock, memoryLog());
  const asked: PieceRequest[] = [];
  return {
    asked,
    clock,
    answers: {
      check: (peer, check) => real.check(peer, check),
      get: (peer, request): Promise<PieceAnswer> => {
        asked.push(request);
        return real.get(peer, request);
      },
    },
  };
}

/** The staging a fetched hub release gets: M2's, into `p`, signed with the test key. */
function stagingInto(p: string, stages: FileWork[]) {
  return (_job: JobId, work: FileWork): JobStarted => {
    stages.push(work);
    if (work.kind !== "stageUpdate")
      return { kind: "ready", outcome: { kind: "failed", reason: "io", message: work.kind } };
    const path = side?.uploads.finished(work.upload)?.path;
    if (path === undefined)
      return { kind: "ready", outcome: { kind: "failed", reason: "noUpload", message: "none" } };
    const staging = new Staging({
      path,
      prefix: p,
      runningVersion: "0.1.0",
      platform: "darwin-arm64",
      keys: [TEST_PUBLISHER_KEY],
      wanted: () => true,
    });
    return {
      kind: "pieces",
      pieces: {
        next: () => {
          const outcome = staging.next();
          return outcome === undefined ? { done: false } : { done: true, outcome };
        },
        abort: () => {
          staging.abort("stopped");
        },
      },
    };
  };
}

let side: ClientSide | undefined;
let seed = 60;

async function joinedTo(
  run: RelayRun,
  stage?: ReturnType<typeof stagingInto>,
): Promise<ClientSide> {
  side = makeClient({
    key: staticKeyOf(seed++),
    platform: "darwin-arm64",
    firmware: () => "1.0.0",
    ...(stage === undefined ? {} : { stage }),
  });
  side.client.perform({ kind: "relayConnect", url: run.url });
  await until(() => side?.client.state.kind === "up", "the link up");
  return side;
}

function hubWork(overrides: Partial<Extract<FileWork, { kind: "fetchRelease" }>> = {}) {
  return {
    kind: "fetchRelease",
    release: "hub",
    file: hubFile,
    bytes: hubBytes.length,
    sha256: new Uint8Array(sha(hubBytes)),
    ...overrides,
  } as const;
}

/** Delivers one release piece with the request id it answers. */
function sendPiece(link: ScriptedLink, id: number, bytes: Uint8Array): void {
  const frame = relayBinaryCodec.encode({ kind: RELAY_BINARY_KIND.releasePiece, id, bytes });
  expect(frame.ok).toBe(true);
  if (frame.ok) link.sendBinary(frame.value);
}

/** Runs pieces as the loop does: one `next` a turn, no turn while the job waits. */
async function drive(
  pieces: JobPieces,
  each: (turn: number) => Promise<void> | void = () => undefined,
): Promise<{ outcome: FileOutcome; turns: number }> {
  for (let turn = 0; ; turn++) {
    if (pieces.waiting?.() === true) {
      await settle(2);
      continue;
    }
    const step = pieces.next();
    if (step.done) return { outcome: step.outcome, turns: turn };
    await each(turn);
  }
}

describe("offers", () => {
  test("when the link comes up: release.check with platform, running and firmware; the offer to the core", async () => {
    const s = await service();
    const run = startRelayRun({ releases: s.answers });
    const client = await joinedTo(run);
    await until(() => client.of("releaseOffered").length === 1, "the offer");
    expect(client.of("releaseOffered")[0]?.releases).toEqual([
      {
        kind: "hub",
        version: "9.0.0",
        platform: "darwin-arm64",
        file: hubFile,
        bytes: hubBytes.length,
        sha256: sha(hubBytes).toString("hex"),
      },
      expect.objectContaining({ kind: "firmware", version: "1.2.3", file: firmwareFile }),
    ]);
    // And again every 24 hours while the link stays up.
    client.timers.advance(RELAY_LIMITS.releaseCheckEveryMs - 1);
    await settle();
    expect(client.of("releaseOffered")).toHaveLength(1);
  });

  test("again 24 hours on, on a link still up", async () => {
    const relay = new ScriptedRelay();
    const client = makeClient({
      key: staticKeyOf(70),
      connect: relay.connect,
      firmware: () => undefined,
    });
    client.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => client.client.state.kind === "up", "up");
    const link = relay.last;
    expect(link?.sent("release.check")).toEqual([
      { t: "release.check", platform: "linux-arm64", running: "0.1.0" },
    ]);
    for (let i = 0; i < 24 * 120 - 1; i++) client.timers.advance(30_000);
    expect(link?.sent("release.check")).toHaveLength(1);
    client.timers.advance(30_000);
    expect(link?.sent("release.check")).toHaveLength(2);
  });
});

describe("fetching", () => {
  test("a cancelled fetch frees its file and an immediate retry gets only its own answers", async () => {
    const relay = new ScriptedRelay();
    const first = jobId(31);
    const retry = jobId(32);
    let wanted = first;
    const client = makeClient({
      key: staticKeyOf(74),
      connect: relay.connect,
      wanted: (job, release) => release === "firmware" || job === wanted,
    });
    client.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => client.client.state.kind === "up", "up");
    const old = client.client.fetch(first, hubWork());
    const link = relay.last;
    if (old.kind !== "pieces" || link === undefined) {
      expect(old.kind === "pieces" && link !== undefined).toBe(true);
      return;
    }
    const gets = link.sent("release.get");
    expect(gets).toHaveLength(4);
    wanted = retry;
    const other = client.client.fetch(
      jobId(33),
      hubWork({ release: "firmware", file: firmwareFile }),
    );
    const fresh = client.client.fetch(retry, hubWork());
    expect(other.kind).toBe("pieces");
    expect(fresh.kind).toBe("pieces");
    expect(old.pieces.next()).toMatchObject({ done: true, outcome: { kind: "failed" } });
    expect(client.uploads.held).toBe(2);
    expect(client.client.releases.fetching).toBe(2);
    expect(link.sent("release.get")).toHaveLength(4);
    if (fresh.kind !== "pieces" || other.kind !== "pieces") return;
    expect(fresh.pieces.waiting?.()).toBe(true);
    const wakes = client.wakes.count;
    for (const get of gets)
      sendPiece(link, get.id, hubBytes.slice(get.offset, get.offset + get.length));
    expect(client.wakes.count).toBeGreaterThan(wakes);
    expect(other.pieces.next()).toEqual({ done: false });
    expect(
      link
        .sent("release.get")
        .slice(4)
        .map(({ file, offset }) => ({ file, offset })),
    ).toEqual(
      Array.from({ length: 4 }, (_, i) => ({
        file: firmwareFile,
        offset: i * RELAY_LIMITS.maxReleasePieceBytes,
      })),
    );
    const otherPiece = link.sent("release.get")[4];
    expect(otherPiece).toBeDefined();
    if (otherPiece === undefined) return;
    sendPiece(link, otherPiece.id, hubBytes.slice(0, otherPiece.length));
    expect(fresh.pieces.next()).toEqual({ done: false });
    expect(link.sent("release.get").at(-1)).toMatchObject({ file: hubFile, offset: 0 });
    expect(client.client.state.kind).toBe("up");
  });

  test.each([false, true])(
    "a cancel after the last piece prevents staging work (staging started: %s)",
    async (startedStaging) => {
      const relay = new ScriptedRelay();
      const job = jobId(34);
      let wanted = true;
      let stages = 0;
      let aborted = 0;
      /** Whether the core still wanted the release each time the staging was asked for a piece. */
      const asked: boolean[] = [];
      const client = makeClient({
        key: staticKeyOf(75),
        connect: relay.connect,
        wanted: () => wanted,
        stage: () => {
          stages += 1;
          return {
            kind: "pieces",
            pieces: {
              // The staging is asked only after the cancel, which a real one sees in its own next()
              // and ends without the loop waiting (`shell/update/stage-job.ts`); what it gives then
              // is not the fetch's outcome.
              next: () => {
                asked.push(wanted);
                return { done: true, outcome: { kind: "updateStaged", version: "9.0.0" } };
              },
              abort: () => {
                aborted += 1;
              },
            },
          };
        },
      });
      client.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
      await until(() => client.client.state.kind === "up", "up");
      const bytes = hubBytes.slice(0, 32);
      const fetch = client.client.fetch(job, hubWork({ bytes: bytes.length, sha256: sha(bytes) }));
      const link = relay.last;
      const get = link?.sent("release.get")[0];
      if (fetch.kind !== "pieces" || link === undefined || get === undefined) {
        expect(fetch.kind === "pieces" && get !== undefined).toBe(true);
        return;
      }
      sendPiece(link, get.id, bytes);
      if (startedStaging) expect(fetch.pieces.next()).toEqual({ done: false });
      wanted = false;
      expect(fetch.pieces.next()).toMatchObject({ done: true, outcome: { kind: "failed" } });
      expect(stages).toBe(Number(startedStaging));
      expect(asked).toEqual(startedStaging ? [false] : []);
      // Never aborted: an abort is a stop's, which waits for the staging's worker.
      expect(aborted).toBe(0);
      expect(client.uploads.held).toBe(0);
      expect(link.sent("release.get")).toHaveLength(1);
    },
  );

  test("a newer hub offer makes the current fetch unwanted even while waiting to reconnect", async () => {
    const relay = new ScriptedRelay();
    const job = jobId(35);
    const base = emptyState();
    const staging = { source: "fetch", job, version: "9.0.0" } as const;
    const offer = {
      kind: "hub",
      version: "9.0.0",
      platform: "darwin-arm64",
      file: hubFile,
      bytes: hubBytes.length,
      sha256: sha(hubBytes).toString("hex"),
    } as const;
    let state = {
      ...base,
      upkeep: { ...base.upkeep, staging, offer: { ...offer, version: "9.0.0" } },
    };
    expect(hubReleaseWanted(state, jobId(36))).toBe(false);
    expect(
      hubReleaseWanted({ ...state, upkeep: { ...state.upkeep, staging: undefined } }, job),
    ).toBe(false);
    const client = makeClient({
      key: staticKeyOf(76),
      connect: relay.connect,
      wanted: (id) => hubReleaseWanted(state, id),
    });
    const fetch = client.client.fetch(job, hubWork());
    expect(fetch.kind).toBe("pieces");
    if (fetch.kind !== "pieces") return;
    expect(fetch.pieces.waiting?.()).toBe(true);
    state = { ...state, upkeep: { ...state.upkeep, offer: { ...offer, version: "10.0.0" } } };
    expect(fetch.pieces.waiting?.()).toBe(false);
    client.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => client.client.state.kind === "up", "up");
    expect(relay.last?.sent("release.get")).toEqual([]);
    expect(fetch.pieces.next()).toMatchObject({ done: true, outcome: { kind: "failed" } });
    expect(client.uploads.held).toBe(0);
  });

  test("a hub release in pieces of 256 KiB, at most 4 in flight, then staged as an upload is", async () => {
    const s = await service();
    const run = startRelayRun({ releases: s.answers });
    const stages: FileWork[] = [];
    const p = prefix();
    const client = await joinedTo(run, stagingInto(p, stages));
    const started = client.client.fetch(jobId(7), hubWork());
    expect(started.kind).toBe("pieces");
    if (started.kind !== "pieces") return;
    const { outcome } = await drive(started.pieces);
    expect(outcome).toEqual({ kind: "updateStaged", version: "9.0.0" });
    expect(s.asked.every((r) => r.length <= RELAY_LIMITS.maxReleasePieceBytes)).toBe(true);
    expect(s.asked.map((r) => r.offset)).toEqual(
      Array.from({ length: Math.ceil(hubBytes.length / 262_144) }, (_, i) => i * 262_144),
    );
    expect(stages.map((w) => (w.kind === "stageUpdate" ? w.upload.job : -1))).toEqual([7]);
    expect(
      Buffer.from(readFileSync(join(p, "staged", "9.0.0", "drizzle", "0000.sql"))).toString(),
    ).toBe("CREATE TABLE x (a);");
    // The fetched file is freed once the job is over.
    expect(client.uploads.held).toBe(0);
    expect(client.client.releases.fetching).toBe(0);
  });

  test("the pieces in flight never pass 4, and the job waits (no turn) while nothing has come", async () => {
    const relay = new ScriptedRelay();
    const client = makeClient({ key: staticKeyOf(71), connect: relay.connect });
    client.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => client.client.state.kind === "up", "up");
    const started = client.client.fetch(jobId(3), hubWork());
    if (started.kind !== "pieces") return;
    const gets = relay.last?.sent("release.get") ?? [];
    expect(gets.map((g) => [g.offset, g.length])).toEqual([
      [0, 262_144],
      [262_144, 262_144],
      [524_288, 262_144],
      [786_432, 262_144],
    ]);
    expect(started.pieces.waiting?.()).toBe(true);
    const wakes = client.wakes.count;
    // The second piece first: still waiting for the first, but woken.
    const second = hubBytes.slice(262_144, 524_288);
    const frame = new Uint8Array(5 + second.length);
    frame[0] = 2;
    new DataView(frame.buffer).setUint32(1, gets[1]?.id ?? 0, true);
    frame.set(second, 5);
    relay.last?.sendBinary(frame);
    expect(client.wakes.count).toBe(wakes + 1);
    expect(started.pieces.waiting?.()).toBe(true);
    expect(started.pieces.next()).toEqual({ done: false });
    expect(relay.last?.sent("release.get")).toHaveLength(4);
  });

  test("cut half-way and resumed: asked again from the first byte it did not hold", async () => {
    const s = await service();
    const run = startRelayRun({ releases: s.answers });
    const stages: FileWork[] = [];
    const client = await joinedTo(run, stagingInto(prefix(), stages));
    const started = client.client.fetch(jobId(8), hubWork());
    if (started.kind !== "pieces") return;
    let cutAt = -1;
    let askedBefore = 0;
    const fetch = started.pieces as unknown as { readonly written: number };
    const { outcome } = await drive(started.pieces, async () => {
      if (cutAt >= 0 || fetch.written < 2 * 262_144) return;
      // The relay goes, with pieces in flight, and comes back on its port.
      cutAt = fetch.written;
      askedBefore = s.asked.length;
      await run.stop();
      await until(() => client.client.state.kind === "waiting", "the link lost");
      run.start();
      client.timers.advance(1000);
      await until(() => client.client.state.kind === "up", "the link back");
    });
    expect(outcome).toEqual({ kind: "updateStaged", version: "9.0.0" });
    expect(cutAt).toBeGreaterThan(0);
    const after = s.asked.slice(askedBefore);
    // After the cut, nothing the hub held (written, or come and not yet written) is asked again:
    // only what was in flight when the link dropped, and what was never asked.
    const before = s.asked.slice(0, askedBefore).map((r) => r.offset);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.offset >= cutAt)).toBe(true);
    expect(after[0]?.offset).toBeLessThanOrEqual(Math.max(...before) + 262_144);
    const all = new Set([...before, ...after.map((r) => r.offset)]);
    expect(all.size).toBe(Math.ceil(hubBytes.length / 262_144));
    const refetched = after.filter((r) =>
      s.asked.slice(0, askedBefore).some((b) => b.offset === r.offset),
    );
    expect(refetched.length).toBeLessThanOrEqual(RELAY_LIMITS.maxReleasePiecesInFlight);
  });

  test("the link not back within 10 minutes: unreachable, and the file freed", async () => {
    const s = await service();
    const run = startRelayRun({ releases: s.answers });
    const client = await joinedTo(run);
    const started = client.client.fetch(jobId(9), hubWork());
    if (started.kind !== "pieces") return;
    await until(() => s.asked.length > 0, "a request");
    await run.stop();
    await until(() => client.client.state.kind === "waiting", "the link lost");
    // What came before the cut is written; then the fetch waits.
    while (started.pieces.waiting?.() !== true) expect(started.pieces.next().done).toBe(false);
    // Back-off attempts fail meanwhile; the fetch's own wait ends at 10 minutes.
    for (let ms = 0; ms < RELAY_LIMITS.fetchResumeWaitMs - 1000; ms += 1000)
      client.timers.advance(1000);
    const waits = started.pieces as Required<JobPieces>;
    client.timers.advance(999);
    expect(waits.waiting()).toBe(true);
    client.timers.advance(1);
    expect(waits.waiting()).toBe(false);
    expect(started.pieces.next()).toEqual({
      done: true,
      outcome: {
        kind: "failed",
        reason: "unreachable",
        message: "the relay link did not come back within 10 minutes",
      },
    });
    expect(client.uploads.held).toBe(0);
  });

  test("refused over the relay's budget: unreachable, saying when to retry", async () => {
    // A daily egress for the whole service of less than the file: the first pieces pass, then not.
    const s = await service(new ReleaseBudget(undefined, 600_000));
    const run = startRelayRun({ releases: s.answers });
    const client = await joinedTo(run);
    const started = client.client.fetch(jobId(10), hubWork());
    if (started.kind !== "pieces") return;
    const { outcome } = await drive(started.pieces);
    expect(outcome).toMatchObject({ kind: "failed", reason: "unreachable" });
    expect(outcome.kind === "failed" ? outcome.message : "").toMatch(
      /^over the relay's release budget, retry after \d+ ms$/u,
    );
    expect(client.uploads.held).toBe(0);
  });

  test("over its kind's cap: refused before any byte is asked for", async () => {
    const relay = new ScriptedRelay();
    const client = makeClient({ key: staticKeyOf(72), connect: relay.connect });
    client.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => client.client.state.kind === "up", "up");
    const hub = client.client.fetch(
      jobId(1),
      hubWork({ bytes: RELAY_LIMITS.maxHubReleaseBytes + 1 }),
    );
    expect(hub).toMatchObject({ kind: "ready", outcome: { kind: "failed", reason: "tooLarge" } });
    const atCap = client.client.fetch(
      jobId(2),
      hubWork({ bytes: RELAY_LIMITS.maxHubReleaseBytes }),
    );
    expect(atCap.kind).toBe("pieces");
    if (atCap.kind === "pieces") atCap.pieces.abort();
    const firmware = client.client.fetch(jobId(3), {
      kind: "fetchRelease",
      release: "firmware",
      file: firmwareFile,
      bytes: RELAY_LIMITS.maxFirmwareReleaseBytes + 1,
      sha256: new Uint8Array(32),
    });
    expect(firmware).toMatchObject({
      kind: "ready",
      outcome: { kind: "failed", reason: "tooLarge" },
    });
    expect(relay.last?.sent("release.get").map((g) => g.file)).toEqual(Array(4).fill(hubFile));
    expect(client.uploads.held).toBe(0);
  });

  test("a file not the one offered (a changed byte) is refused badFile, never staged", async () => {
    const s = await service();
    const run = startRelayRun({ releases: s.answers });
    const stages: FileWork[] = [];
    const client = await joinedTo(run, stagingInto(prefix(), stages));
    const wrong = new Uint8Array(sha(hubBytes));
    wrong[0] = (wrong[0] ?? 0) ^ 1;
    const started = client.client.fetch(jobId(11), hubWork({ sha256: wrong }));
    if (started.kind !== "pieces") return;
    const { outcome } = await drive(started.pieces);
    expect(outcome).toEqual({
      kind: "failed",
      reason: "badFile",
      message: "the fetched file is not the one offered",
    });
    expect(stages).toEqual([]);
    expect(client.uploads.held).toBe(0);
  });

  test("a piece of the wrong length is refused badFile", async () => {
    const relay = new ScriptedRelay();
    const client = makeClient({ key: staticKeyOf(73), connect: relay.connect });
    client.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => client.client.state.kind === "up", "up");
    const started = client.client.fetch(jobId(4), hubWork());
    if (started.kind !== "pieces") return;
    const first = relay.last?.sent("release.get")[0];
    const frame = new Uint8Array(5 + 10);
    frame[0] = 2;
    new DataView(frame.buffer).setUint32(1, first?.id ?? 0, true);
    relay.last?.sendBinary(frame);
    expect(started.pieces.next()).toEqual({
      done: true,
      outcome: {
        kind: "failed",
        reason: "badFile",
        message: "the relay sent 10 bytes for a piece of 262144",
      },
    });
  });

  test("the relay's other refusals: notFound and unavailable unreachable, range badFile", async () => {
    for (const [reason, expected] of [
      ["notFound", "unreachable"],
      ["unavailable", "unreachable"],
      ["range", "badFile"],
    ] as const) {
      const relay = new ScriptedRelay();
      const client = makeClient({ key: staticKeyOf(74), connect: relay.connect });
      client.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
      await until(() => client.client.state.kind === "up", "up");
      const started = client.client.fetch(jobId(5), hubWork());
      if (started.kind !== "pieces") return;
      const first = relay.last?.sent("release.get")[0];
      relay.last?.send({ t: "release.error", id: first?.id ?? 0, reason });
      const step = started.pieces.next();
      expect(step.done && step.outcome.kind === "failed" ? step.outcome.reason : "").toBe(expected);
      client.client.stop();
    }
  });

  test("a firmware release: fetched whole, then given to stageFirmware as an upload", async () => {
    const s = await service();
    const run = startRelayRun({ releases: s.answers });
    const stages: FileWork[] = [];
    let fetched: Uint8Array | undefined;
    const client = await joinedTo(run, (_job, work) => {
      stages.push(work);
      if (work.kind === "stageFirmware") {
        const path = side?.uploads.finished(work.upload)?.path;
        fetched = path === undefined ? undefined : new Uint8Array(readFileSync(path));
      }
      return { kind: "ready", outcome: { kind: "failed", reason: "wrongTarget", message: "test" } };
    });
    const started = client.client.fetch(jobId(12), {
      kind: "fetchRelease",
      release: "firmware",
      file: firmwareFile,
      bytes: firmwareBytes.length,
      sha256: new Uint8Array(sha(firmwareBytes)),
    });
    if (started.kind !== "pieces") return;
    const { outcome } = await drive(started.pieces);
    expect(outcome).toEqual({ kind: "failed", reason: "wrongTarget", message: "test" });
    expect(stages.map((w) => (w.kind === "stageFirmware" ? [w.upload.job, w.own] : []))).toEqual([
      [12, null],
    ]);
    expect(fetched !== undefined && Buffer.from(fetched).equals(Buffer.from(firmwareBytes))).toBe(
      true,
    );
    expect(client.uploads.held).toBe(0);
  });

  test("a stop aborts the fetch: its file is freed and later pieces are dropped", async () => {
    const s = await service();
    const run = startRelayRun({ releases: s.answers });
    const client = await joinedTo(run);
    const started = client.client.fetch(jobId(13), hubWork());
    if (started.kind !== "pieces") return;
    expect(client.uploads.held).toBe(1);
    started.pieces.abort();
    expect(client.uploads.held).toBe(0);
    await settle(50);
    expect(client.client.releases.fetching).toBe(0);
  });

  test("stopping the relay client frees every fetch, including a job waiting for its first link", () => {
    const client = makeClient({ key: staticKeyOf(77) });
    const fetch = client.client.fetch(jobId(37), hubWork());
    expect(fetch.kind).toBe("pieces");
    expect(client.uploads.held).toBe(1);
    client.client.stop();
    expect(client.client.releases.fetching).toBe(0);
    expect(client.uploads.held).toBe(0);
    expect(client.timers.pending).toBe(0);
  });
});

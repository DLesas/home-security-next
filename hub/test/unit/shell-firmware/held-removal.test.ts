/**
 * A removal held back by a failing commit (`shell/loop.ts` holds a turn's file jobs until a commit
 * succeeds) runs when the commit recovers, by which time the index may have changed: the real loop,
 * a real database whose commits fail on demand, and the real firmware jobs. A removal never
 * deletes a file an image in the index then names (the same image staged again has the same file,
 * named by its hash), and the store's check at the next start then finds nothing wrong; with no
 * such image, the held removal deletes the file. And the mirror: a staging held behind a removal
 * of the same image stages it after the removal has run.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeSha256 } from "@hsn/protocol";
import { err, ok } from "neverthrow";
import type { Effect, FileWork } from "../../../src/core/model/effects.ts";
import type { HubEvent, Input } from "../../../src/core/model/events.ts";
import { connId, imageId, jobId } from "../../../src/core/model/ids.ts";
import { type FirmwareImageRow, ImageKind } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import type { Core } from "../../../src/core/step.ts";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { firmwareJob, isFirmwareWork } from "../../../src/shell/firmware/jobs.ts";
import {
  checkStore,
  imageFileName,
  indexedImages,
  storeFolder,
} from "../../../src/shell/firmware/store.ts";
import { HubLoop, type JobStarted, type LoopWriter } from "../../../src/shell/loop.ts";
import { openStore, type OpenedStore } from "../../../src/shell/storage/store.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { espImage, release, sha256, type TempFolder, tempFolder, testHubKeys } from "./support.ts";

const folders: TempFolder[] = [];
let keys: Awaited<ReturnType<typeof testHubKeys>>;

beforeAll(async () => {
  keys = await testHubKeys();
});

afterEach(() => {
  for (const folder of folders.splice(0)) folder.remove();
});

class FixedClock {
  now(): Now {
    return { mono: mono(1), wall: Date.UTC(2026, 10, 18), wallTrusted: true };
  }
}

const payload = espImage({ size: 600_000, seed: 8 });
const sha = sha256(payload);
const FILE = imageFileName(sha);

function row(id: number, removedMs: number | null): FirmwareImageRow {
  return {
    id: imageId(id),
    imageId: sha.slice(0, 8),
    sha256: sha,
    version: 65_536 + 4 * 256,
    kind: ImageKind.Official,
    roles: 14,
    bytes: payload.length,
    header: new Uint8Array(128),
    manifest: null,
    file: FILE,
    addedMs: 1,
    addedBy: "test",
    removedMs,
  };
}

function writeRow(r: FirmwareImageRow): Effect {
  return {
    kind: "write",
    durability: "now",
    op: { table: "firmware_images", op: "upsert", row: r },
  };
}

interface Rig {
  readonly dataDir: string;
  readonly store: OpenedStore;
  readonly loop: HubLoop;
  /** What the stand-in core does on the next tick. */
  next: readonly Effect[];
  failing: boolean;
  readonly ready: HubEvent[];
}

/**
 * A hub whose image (row 1) is stored and indexed, its key in `hub_keys`, and a loop whose core
 * does on each tick what the test says and records each `fileReady`.
 */
function rig(): Rig {
  const folder = tempFolder("held");
  folders.push(folder);
  const dataDir = join(folder.path, "data");
  const store = openStore({
    dataDir,
    migrationsFolder: join(import.meta.dir, "..", "..", "..", "drizzle"),
    clock: new FixedClock(),
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
  store.writer.stage([
    {
      kind: "write",
      durability: "now",
      op: {
        table: "hub_keys",
        op: "upsert",
        row: {
          signingPrivate: keys.pkcs8,
          signingPublic: keys.publicKey,
          identity: keys.identity,
          appStaticPrivate: null,
          appStaticPublic: null,
          tlsPrivate: null,
          tlsCertificate: null,
        },
      },
    },
    writeRow(row(1, null)) as Extract<Effect, { kind: "write" }>,
  ]);
  expect(store.writer.flush("now").isOk()).toBe(true);
  mkdirSync(storeFolder(dataDir), { recursive: true });
  writeFileSync(join(storeFolder(dataDir), FILE), payload);
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  writeFileSync(join(dataDir, "uploads", "1"), release({ payload }));

  const state = { clock: { boot: { id: 1 } } } as unknown as HubState;
  const holder = { rig: undefined as Rig | undefined };
  const core: Core = {
    emptyState: () => state,
    nextDeadline: () => undefined,
    step: (current: HubState, input: Input) => {
      const r = holder.rig;
      if (r === undefined) return ok({ state: current, effects: [], wake: undefined });
      if (input.event.kind === "fileReady") r.ready.push(input.event);
      const effects = input.event.kind === "tick" ? r.next : [];
      if (input.event.kind === "tick") r.next = [];
      return ok({ state: current, effects, wake: undefined });
    },
  };
  // The real writer, whose commits fail while `failing`, as a full disk's would.
  const real = store.writer;
  const writer = {
    stage: (items) => {
      real.stage(items);
    },
    setCadence: (everyMs) => {
      real.setCadence(everyMs);
    },
    durable: (device) => real.durable(device),
    due: (now) => real.due(now),
    flushIfDue: (now) =>
      holder.rig?.failing === true
        ? err({ kind: "storage", origin: "test", message: "disk full" })
        : real.flushIfDue(now),
    flush: (reason) => real.flush(reason),
    takeOutcome: () => real.takeOutcome(),
    maintain: () => real.maintain(),
  } as LoopWriter;
  const deps = {
    db: store.db,
    dataDir,
    rules: DEFAULT_RULES,
    uploads: { pathOf: () => join(dataDir, "uploads", "1") },
    exports: { send: () => ok(undefined) },
    publisherKeys: [TEST_PUBLISHER_KEY],
  };
  const loop = new HubLoop(
    core,
    {
      cipher: new VectorCipher([]),
      rules: DEFAULT_RULES,
      calendar: UNBUILT_CALENDAR,
      sha256: nodeSha256,
    },
    {
      clock: new FixedClock(),
      random: { bytes: (n) => ok(new Uint8Array(n)) },
      links: { listen: () => undefined, send: () => ok(undefined), close: () => ok(undefined) },
      control: { respond: () => undefined, publish: () => undefined },
      writer,
      advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
      wakeAt: () => undefined,
      soon: () => undefined,
      report: () => undefined,
      fatal: () => undefined,
      files: {
        perform: (job, work: FileWork): JobStarted => {
          if (!isFirmwareWork(work))
            return {
              kind: "ready",
              outcome: { kind: "failed", reason: "io", message: "not firmware" },
            };
          const started = firmwareJob(job, work, deps);
          if (started.kind !== "pieces") return started;
          const pieces = started.pieces;
          return {
            kind: "pieces",
            pieces: {
              next: () => {
                const outcome = pieces.next();
                return outcome === undefined ? { done: false } : { done: true, outcome };
              },
              abort: () => {
                pieces.abort("stop");
              },
            },
          };
        },
      },
    },
  );
  const made: Rig = { dataDir, store, loop, next: [], failing: false, ready: [] };
  holder.rig = made;
  return made;
}

/** One tick of the core with these effects, then the loop's turns until no job is open. */
function tick(r: Rig, effects: readonly Effect[]): void {
  r.next = effects;
  r.loop.enqueue({ kind: "tick" });
  r.loop.turn();
  for (let i = 0; i < 1000 && (r.loop.openJobs > 0 || r.loop.waiting > 0); i++) r.loop.turn();
}

function remove(id: number): Effect {
  return {
    kind: "fileJob",
    job: jobId(2 ** 31 + id),
    work: { kind: "removeFirmware", image: imageId(id), file: FILE },
  };
}

/** The store's check as the next start makes it, from the index as committed. */
function nextStart(r: Rig) {
  return checkStore(r.dataDir, indexedImages(r.store.db)._unsafeUnwrap())._unsafeUnwrap();
}

describe("a removal held back by a failing commit", () => {
  test("the same image staged again meanwhile: the held removal leaves its file, and the next start finds nothing", () => {
    const r = rig();
    r.failing = true;
    // `firmware.remove`: the row marked removed (written now) and its file's removal: both held.
    tick(r, [writeRow(row(1, 5)), remove(1)]);
    expect(r.ready).toEqual([]);
    // The same image added again: a new row naming the same file, still not committed.
    tick(r, [writeRow(row(2, null))]);
    expect(existsSync(join(storeFolder(r.dataDir), FILE))).toBe(true);
    // The disk recovers: one commit holds both rows, then the held removal runs.
    r.failing = false;
    tick(r, []);
    expect(r.ready).toEqual([
      {
        kind: "fileReady",
        job: jobId(2 ** 31 + 1),
        outcome: { kind: "firmwareRemoved", image: imageId(1) },
      },
    ]);
    expect(existsSync(join(storeFolder(r.dataDir), FILE))).toBe(true);
    expect(
      indexedImages(r.store.db)
        ._unsafeUnwrap()
        .map((i) => i.id),
    ).toEqual([imageId(2)]);
    expect(nextStart(r)).toEqual({ damaged: [], removed: [] });
    r.store.db.close(true);
  });

  test("no image staged again: the held removal deletes the file", () => {
    const r = rig();
    r.failing = true;
    tick(r, [writeRow(row(1, 5)), remove(1)]);
    expect(existsSync(join(storeFolder(r.dataDir), FILE))).toBe(true);
    r.failing = false;
    tick(r, []);
    expect(r.ready.map((e) => (e.kind === "fileReady" ? e.outcome.kind : ""))).toEqual([
      "firmwareRemoved",
    ]);
    expect(existsSync(join(storeFolder(r.dataDir), FILE))).toBe(false);
    expect(nextStart(r)).toEqual({ damaged: [], removed: [] });
    r.store.db.close(true);
  });

  test("not held at all: the removal deletes the file at once", () => {
    const r = rig();
    tick(r, [writeRow(row(1, 5)), remove(1)]);
    expect(existsSync(join(storeFolder(r.dataDir), FILE))).toBe(false);
    r.store.db.close(true);
  });

  test("the mirror: a staging held behind a removal of the same image stages it after the removal", () => {
    const r = rig();
    r.failing = true;
    tick(r, [writeRow(row(1, 5)), remove(1)]);
    tick(r, [
      {
        kind: "fileJob",
        job: jobId(2 ** 31 + 9),
        work: { kind: "stageFirmware", upload: { conn: connId(1), job: 1 }, own: null },
      },
    ]);
    r.failing = false;
    tick(r, []);
    // The removal ran first (no image named the file then), then the staging put it back.
    expect(r.ready.map((e) => (e.kind === "fileReady" ? e.outcome.kind : ""))).toEqual([
      "firmwareRemoved",
      "firmwareStaged",
    ]);
    expect(existsSync(join(storeFolder(r.dataDir), FILE))).toBe(true);
    // The core indexes it from `firmwareStaged`; the next start then finds it whole.
    tick(r, [writeRow(row(2, null))]);
    expect(nextStart(r)).toEqual({ damaged: [], removed: [] });
    r.store.db.close(true);
  });
});

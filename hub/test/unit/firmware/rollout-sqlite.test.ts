import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateAction, UpdateReason, UpdateStage } from "@hsn/protocol";
import { linkId } from "../../../src/core/model/ids.ts";
import { DeviceUpdateState, RolloutStage } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import {
  checkStore,
  imageFileName,
  indexedImages,
  storeFolder,
} from "../../../src/shell/firmware/store.ts";
import { type OpenedStore, openStore } from "../../../src/shell/storage/store.ts";
import type { StagedEffect } from "../../../src/ports/writer.ts";
import { tempFolder } from "../shell-firmware/support.ts";
import {
  bootedView,
  DEFAULT_RULES,
  decisions,
  effectsOf,
  fileBytes,
  imageRow,
  OLD_VERSION,
  ON_TRIAL,
  offerTo,
  openRow,
  type Ran,
  rowOf,
  Runner,
  S1,
  siteSnapshot,
  UpdateHolding,
  WALL0,
  wifi,
} from "./support.ts";

const stores = new Set<OpenedStore>();
const folders: ReturnType<typeof tempFolder>[] = [];

afterEach(() => {
  for (const store of stores) store.db.close(true);
  stores.clear();
  for (const folder of folders.splice(0)) folder.remove();
});

/** Opens the real writer and reader over the checked-in migrations. */
function open(dataDir: string): OpenedStore {
  const store = openStore({
    dataDir,
    migrationsFolder: join(import.meta.dir, "..", "..", "..", "drizzle"),
    clock: { now: () => ({ mono: mono(0), wall: WALL0, wallTrusted: true }) },
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
  stores.add(store);
  return store;
}

/** Commits one batch of effects through the real writer and fails with its storage error. */
function commit(store: OpenedStore, out: Ran["out"]): void {
  store.writer.stage(
    out.filter((item): item is StagedEffect => item.kind === "write" || item.kind === "record"),
  );
  const committed = store.writer.flush("now");
  expect(committed.isErr() ? committed.error.message : undefined).toBeUndefined();
}

/** Boots fresh module state using only the snapshot reconstructed from SQLite. */
function boot(store: OpenedStore) {
  const snapshot = store.reader.snapshot()._unsafeUnwrap();
  const runner = new Runner(bootedView(snapshot));
  const result = runner.boot(snapshot);
  return { runner, result };
}

/** Loads the site into SQLite, then indexes a stored file via the firmware module. */
function setup(version?: number) {
  const folder = tempFolder("rollout-sqlite");
  folders.push(folder);
  const dataDir = folder.path;
  const store = open(dataDir);
  const site = siteSnapshot();
  const device = site.devices.find(({ id }) => id === S1) ?? expect.unreachable("missing sensor");
  const config =
    site.sensorConfig.find(({ deviceId }) => deviceId === S1) ??
    expect.unreachable("missing sensor config");
  commit(store, [
    { kind: "write", durability: "now", op: { table: "devices", op: "upsert", row: device } },
    { kind: "write", durability: "now", op: { table: "sensor_config", op: "upsert", row: config } },
  ]);
  const { runner } = boot(store);
  const payload = new Uint8Array(131_072).fill(42);
  const sha256 = new Uint8Array(createHash("sha256").update(payload).digest());
  const file = imageFileName(sha256);
  const image = imageRow(1, version, {
    bytes: payload.length,
    file,
    sha256,
    imageId: sha256.slice(0, 8),
  });
  mkdirSync(storeFolder(dataDir), { recursive: true });
  writeFileSync(join(storeFolder(dataDir), file), payload);
  const upload = runner.op({ op: "firmware.upload", body: { job: 1 } });
  const job = effectsOf(upload, "fileJob")[0]?.job ?? expect.unreachable("missing staging job");
  const staged = runner.fileReady(job, {
    kind: "firmwareStaged",
    image: {
      imageId: image.imageId,
      sha256: image.sha256,
      version: image.version,
      kind: image.kind,
      roles: image.roles,
      bytes: image.bytes,
      file: image.file,
      header: image.header,
      manifest: image.manifest,
    },
  });
  commit(store, staged.out);
  expect(store.reader.snapshot()._unsafeUnwrap().m3m4?.firmwareImages).toEqual([image]);
  return { store, dataDir, runner, image };
}

/** Closes and reopens the database before rebuilding the hub state. */
function restart(store: OpenedStore, dataDir: string) {
  store.db.close(true);
  stores.delete(store);
  const next = open(dataDir);
  return { store: next, ...boot(next) };
}

/** Checks the three firmware tables against migration 3, including the joins SQLite omits. */
function checkRows(store: OpenedStore): void {
  expect(store.db.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
  expect(
    store.db
      .query(
        `
    SELECT r.id FROM rollouts r
    LEFT JOIN firmware_images f ON f.id = r.image
    WHERE f.id IS NULL
  `,
      )
      .all(),
  ).toEqual([]);
  expect(
    store.db
      .query(
        `
    SELECT u.device_id FROM device_updates u
    LEFT JOIN rollouts r ON r.id = u.rollout_id
    LEFT JOIN devices d ON d.id = u.device_id
    WHERE (u.rollout_id IS NOT NULL AND r.id IS NULL) OR d.id IS NULL
  `,
      )
      .all(),
  ).toEqual([]);
}

const stages = [
  ["offered", DeviceUpdateState.Offered],
  ["transferring", DeviceUpdateState.Fetching],
  ["waiting to start", DeviceUpdateState.Installing],
  ["waiting for confirmation", DeviceUpdateState.OnTrial],
  ["waiting to retry a broken transfer", DeviceUpdateState.Fetching],
  ["paused after the retry limit", DeviceUpdateState.Refused],
] as const;

test.each(stages)(
  "SQLite restart while %s continues from the committed stage",
  (stage, expected) => {
    const { store, dataDir, runner, image } = setup();
    const started = runner.op({ op: "rollout.start", body: { image: image.id, devices: [S1] } });
    expect(started.answer?.ok).toBe(true);
    commit(store, started.out);
    const offer = runner.query(S1, {}, wifi(501));
    expect(effectsOf(offer, "transferGrant").map(({ link }) => link)).toEqual([linkId(501)]);
    commit(store, offer.out);
    const checkpoint = 65_536;
    if (expected !== DeviceUpdateState.Offered) {
      commit(
        store,
        runner.send({
          kind: "transferProgress",
          link: linkId(501),
          image: image.imageId,
          bytes: checkpoint,
        }).out,
      );
    }
    if (expected === DeviceUpdateState.Installing || expected === DeviceUpdateState.OnTrial) {
      commit(
        store,
        runner.status(S1, image.imageId, UpdateStage.Verified, 0, fileBytes(image)).out,
      );
      if (expected === DeviceUpdateState.OnTrial) {
        commit(store, runner.started(S1, image.version, ON_TRIAL).out);
      }
    }
    if (stage === "waiting to retry a broken transfer" || expected === DeviceUpdateState.Refused) {
      const attempts =
        runner.rules.firmware.brokenTries - (expected === DeviceUpdateState.Refused ? 0 : 1);
      for (let i = 1; i <= attempts; i++) {
        commit(
          store,
          runner.status(S1, image.imageId, UpdateStage.Refused, UpdateReason.LinkLost, checkpoint)
            .out,
        );
        expect(rowOf(runner, S1)?.attempts).toBe(i);
      }
    }
    checkRows(store);
    const durable = store.reader.snapshot()._unsafeUnwrap().m3m4?.deviceUpdates;
    expect(durable).toHaveLength(1);
    expect(durable?.[0]).toMatchObject({ deviceId: S1, rolloutId: 1, state: expected });

    const next = restart(store, dataDir);
    const after = next.runner;
    expect(rowOf(after, S1)).toEqual(durable?.[0]);
    expect(after.slice.grants.size).toBe(0);
    expect(effectsOf(next.result, "transferGrant")).toEqual([]);
    if (expected === DeviceUpdateState.Refused) {
      expect(openRow(after)).toMatchObject({
        stage: RolloutStage.Paused,
        pausedDevice: S1,
        pausedReason: UpdateReason.LinkLost,
      });
      const whilePaused = after.query(S1, {}, wifi(502));
      expect(offerTo(whilePaused, S1)?.offer.action).toBe(UpdateAction.Nothing);
      expect(effectsOf(whilePaused, "transferGrant")).toEqual([]);
      expect(after.op({ op: "rollout.resume", body: { rollout: 1 } }).answer?.ok).toBe(true);
      expect(rowOf(after, S1)).toMatchObject({ state: DeviceUpdateState.Planned, attempts: 0 });
    }

    if (expected !== DeviceUpdateState.Installing && expected !== DeviceUpdateState.OnTrial) {
      const held =
        expected === DeviceUpdateState.Fetching
          ? { image: image.imageId, held: UpdateHolding.Part, bytes: checkpoint }
          : {};
      const fetch = after.query(S1, held, wifi(502));
      expect(offerTo(fetch, S1)?.offer).toMatchObject({
        action: UpdateAction.Fetch,
        imageId: image.imageId,
      });
      expect(effectsOf(fetch, "transferGrant").map(({ link }) => link)).toEqual([linkId(502)]);
      if (expected === DeviceUpdateState.Fetching) expect(rowOf(after, S1)?.bytes).toBe(checkpoint);
      expect(effectsOf(after.query(S1, held, wifi(502)), "transferGrant")).toEqual([]);
      expect(after.slice.grants.size).toBe(1);
      const verified = after.status(S1, image.imageId, UpdateStage.Verified, 0, fileBytes(image));
      expect(offerTo(verified, S1)?.offer.action).toBe(UpdateAction.InstallNow);
      expect(rowOf(after, S1)?.state).toBe(DeviceUpdateState.Installing);
    } else {
      const waiting = after.query(S1, {}, wifi(502));
      expect(offerTo(waiting, S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
      expect(effectsOf(waiting, "transferGrant")).toEqual([]);
      expect(rowOf(after, S1)?.state).toBe(expected);
    }

    if (expected !== DeviceUpdateState.OnTrial) after.started(S1, image.version, ON_TRIAL);
    expect(rowOf(after, S1)?.state).toBe(DeviceUpdateState.OnTrial);
    const confirmed = after.status(S1, image.imageId, UpdateStage.Confirmed);
    expect(decisions(confirmed).map(({ kind }) => kind)).toEqual([
      "firmware_confirmed",
      "rollout_done",
    ]);
    expect(after.slice.grants.size).toBe(0);
    expect(openRow(after)).toBeUndefined();
    commit(next.store, after.all);
    checkRows(next.store);
    const snapshot = next.store.reader.snapshot()._unsafeUnwrap().m3m4;
    expect(snapshot?.rollouts).toMatchObject([
      { id: 1, image: image.id, stage: RolloutStage.Done, endedMs: after.now.wall },
    ]);
    expect(snapshot?.deviceUpdates).toMatchObject([
      { deviceId: S1, rolloutId: 1, state: DeviceUpdateState.Confirmed },
    ]);
  },
);

test("a same-version trial started before restart still needs matching confirmation after it", () => {
  const { store, dataDir, runner, image } = setup(OLD_VERSION);
  expect(
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [S1] } }).answer?.ok,
  ).toBe(true);
  runner.query(S1, {}, wifi(501));
  runner.status(S1, image.imageId, UpdateStage.Verified, 0, fileBytes(image));
  expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Installing);
  runner.started(S1, OLD_VERSION, ON_TRIAL);
  const waiting = rowOf(runner, S1);
  expect(waiting?.state).not.toBe(DeviceUpdateState.Confirmed);
  commit(store, runner.all);

  const next = restart(store, dataDir);
  expect(rowOf(next.runner, S1)).toMatchObject({ sameVersion: true });
  expect(rowOf(next.runner, S1)).toEqual(waiting);
  expect(decisions(next.runner.started(S1, OLD_VERSION, undefined))).toEqual([]);
  expect(
    decisions(next.runner.status(S1, imageRow(3, OLD_VERSION).imageId, UpdateStage.Confirmed)),
  ).toEqual([]);
  expect(openRow(next.runner)?.stage).toBe(RolloutStage.Pilots);
  expect(
    decisions(next.runner.status(S1, image.imageId, UpdateStage.Confirmed)).map(({ kind }) => kind),
  ).toEqual(["firmware_confirmed", "rollout_done"]);
  commit(next.store, next.runner.all);
  expect(next.store.reader.snapshot()._unsafeUnwrap().m3m4?.deviceUpdates).toMatchObject([
    { deviceId: S1, sameVersion: true, state: DeviceUpdateState.Confirmed },
  ]);
});

test("start-up reports the file missing with a rollout in progress and removes it from the live index", () => {
  const { store, dataDir, runner, image } = setup();
  expect(
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [S1] } }).answer?.ok,
  ).toBe(true);
  runner.query(S1, {}, wifi(501));
  commit(store, runner.all);
  rmSync(storeFolder(dataDir), { recursive: true });

  const next = restart(store, dataDir);
  const checked = checkStore(dataDir, indexedImages(next.store.db)._unsafeUnwrap())._unsafeUnwrap();
  expect(checked).toEqual({ damaged: [{ image: image.id, problem: "missing" }], removed: [] });
  const damage = checked.damaged[0] ?? expect.unreachable("missing store damage");
  const changed = next.runner.send({ kind: "firmwareStoreDamaged", ...damage });
  commit(next.store, changed.out);
  expect(indexedImages(next.store.db)._unsafeUnwrap()).toEqual([]);
  const snapshot = next.store.reader.snapshot()._unsafeUnwrap().m3m4;
  expect(snapshot?.firmwareImages).toMatchObject([
    { id: image.id, removedMs: next.runner.now.wall },
  ]);
  expect(snapshot?.rollouts).toMatchObject([{ image: image.id, stage: RolloutStage.Paused }]);
  expect(effectsOf(next.runner.query(S1, {}, wifi(502)), "transferGrant")).toEqual([]);
  checkRows(next.store);
});

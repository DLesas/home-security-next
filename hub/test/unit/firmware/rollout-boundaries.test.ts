import { expect, test } from "bun:test";
import { UpdateAction, UpdateReason, UpdateStage } from "@hsn/protocol";
import { linkId } from "../../../src/core/model/ids.ts";
import { DeviceState, DeviceUpdateState, RolloutStage } from "../../../src/core/model/rows.ts";
import {
  CONFIRMED_IMAGE,
  DEFAULT_RULES,
  decisions,
  effectsOf,
  fileBytes,
  HOUR_US,
  imageRow,
  OLD_VERSION,
  ON_TRIAL,
  offerTo,
  openRow,
  rowOf,
  S1,
  S2,
  siteRunner,
  wifi,
  writes,
} from "./support.ts";

test("two sensors on a same-version rebuild need a matching confirmation of their own", () => {
  const old = imageRow(1, OLD_VERSION);
  const target = imageRow(2, OLD_VERSION);
  const { runner } = siteRunner(DEFAULT_RULES, { firmwareImages: [old, target] });
  expect(
    runner.op({
      op: "rollout.start",
      body: { image: target.id, devices: [S1, S2], pilots: [S1] },
    }).answer?.ok,
  ).toBe(true);

  runner.query(S1);
  runner.query(S1, {}, wifi(501));
  runner.status(S1, target.imageId, UpdateStage.Verified, 0, fileBytes(target));
  expect(rowOf(runner, S1)).toMatchObject({
    state: DeviceUpdateState.Installing,
    sameVersion: true,
  });
  expect(rowOf(runner, S2)).toMatchObject({ state: DeviceUpdateState.Planned, sameVersion: true });
  expect(decisions(runner.status(S1, old.imageId, UpdateStage.Confirmed))).toEqual([]);
  expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Installing);
  runner.status(S1, target.imageId, UpdateStage.Confirmed);
  expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Confirmed);
  expect(openRow(runner)?.stage).toBe(RolloutStage.Soak);
  runner.run(HOUR_US);

  runner.query(S2);
  runner.query(S2, {}, wifi(502));
  runner.status(S2, target.imageId, UpdateStage.Verified, 0, fileBytes(target));
  expect(rowOf(runner, S2)?.state).toBe(DeviceUpdateState.Installing);
  const started = runner.started(S2, OLD_VERSION, ON_TRIAL);
  expect(decisions(started).map(({ kind }) => kind)).not.toContain("firmware_confirmed");
  const waiting = rowOf(runner, S2);
  expect(waiting?.state).not.toBe(DeviceUpdateState.Confirmed);
  expect(decisions(runner.status(S1, target.imageId, UpdateStage.Confirmed))).toEqual([]);
  expect(rowOf(runner, S2)).toEqual(waiting);
  expect(openRow(runner)?.stage).toBe(RolloutStage.Rest);
});

test("a matching confirmation from a paired sensor outside the rollout changes no rollout rows", () => {
  const { runner, image } = siteRunner();
  expect(
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [S1] } }).answer?.ok,
  ).toBe(true);
  const original = rowOf(runner, S1);
  const rollout = openRow(runner);
  const report = runner.status(S2, image.imageId, UpdateStage.Confirmed);
  expect(writes(report)).toEqual([]);
  expect(decisions(report)).toEqual([]);
  expect(rowOf(runner, S2)).toBeUndefined();
  expect(rowOf(runner, S1)).toEqual(original);
  expect(openRow(runner)).toEqual(rollout);
});

test("removing a sensor mid-transfer revokes its grant and a late confirmation changes no rows", () => {
  const { runner, image } = siteRunner();
  expect(
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [S1, S2], pilots: [S1] } })
      .answer?.ok,
  ).toBe(true);
  runner.query(S1);
  runner.query(S1, {}, wifi(501));
  runner.send({ kind: "transferProgress", link: linkId(501), image: image.imageId, bytes: 65_536 });
  expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Fetching);

  const registry = runner.view.registry;
  const devices = new Map(registry.devices);
  const removed = devices.get(S1) ?? expect.unreachable("sensor fixture is missing");
  devices.set(S1, { ...removed, state: DeviceState.Removed, removedMs: runner.now.wall });
  runner.view = { ...runner.view, registry: { ...registry, devices } };
  const result = runner.send({ kind: "deviceRemoved", device: S1 });
  expect(effectsOf(result, "transferRevoke").map(({ link }) => link)).toEqual([linkId(501)]);
  expect(runner.slice.grants.size).toBe(0);
  const update = rowOf(runner, S1);
  const rollout = openRow(runner);
  const late = runner.status(
    S1,
    image.imageId,
    UpdateStage.Confirmed,
    0,
    fileBytes(image),
    wifi(501),
  );
  expect(writes(late)).toEqual([]);
  expect(decisions(late)).toEqual([]);
  expect(effectsOf(late, "transferGrant")).toEqual([]);
  expect(rowOf(runner, S1)).toEqual(update);
  expect(openRow(runner)).toEqual(rollout);
});

test("when the only board fails, the rollout stays paused and records no completion", () => {
  const { runner, image } = siteRunner();
  expect(
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [S1] } }).answer?.ok,
  ).toBe(true);
  runner.query(S1);
  const failed = runner.status(S1, image.imageId, UpdateStage.Refused, UpdateReason.BadHeader);
  expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Refused);
  expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.Nothing);
  expect(openRow(runner)).toMatchObject({
    stage: RolloutStage.Paused,
    pausedDevice: S1,
    endedMs: null,
  });
  expect(decisions(failed).map(({ kind }) => kind)).not.toContain("rollout_done");
});

test("a finished rollout does not carry confirmation into the next image for the same role", () => {
  const first = imageRow(1);
  const second = imageRow(2);
  const { runner } = siteRunner(DEFAULT_RULES, { firmwareImages: [first, second] });
  expect(
    runner.op({ op: "rollout.start", body: { image: first.id, devices: [S1] } }).answer?.ok,
  ).toBe(true);
  runner.query(S1);
  runner.query(S1, {}, wifi(501));
  runner.status(S1, first.imageId, UpdateStage.Verified, 0, fileBytes(first));
  runner.started(S1, first.version, CONFIRMED_IMAGE);
  expect(openRow(runner)).toBeUndefined();
  expect(
    runner.op({ op: "rollout.start", body: { image: second.id, devices: [S1] } }).answer?.ok,
  ).toBe(true);
  expect(rowOf(runner, S1)).toMatchObject({ rolloutId: 2, attempts: 0, bytes: 0 });
  const stale = runner.status(S1, first.imageId, UpdateStage.Confirmed);
  expect(decisions(stale).map(({ kind }) => kind)).not.toContain("firmware_confirmed");
  expect(offerTo(stale, S1)?.offer.imageId).toEqual(second.imageId);
  expect(openRow(runner)).toMatchObject({ id: 2, image: second.id, endedMs: null });
});

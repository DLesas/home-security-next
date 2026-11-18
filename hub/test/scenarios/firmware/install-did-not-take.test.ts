/**
 * An install that did not take (found by the firmware's engineers): the hub gives the go-ahead; a
 * power cut tears the device's confirmation of the new image; the device boots its old image, not
 * on trial and with no rollback flag; it sends a Started for the old version, then an update query
 * saying "verified" for the new image, which it kept. Not a rollback and not "no contact": the hub
 * gives the go-ahead again when the conditions hold, counting each such return against
 * `brokenTries` ‡; at the last it refuses the device `imageCheck` and pauses the rollout naming it.
 *
 * Run on the firmware module with the other modules' state as a booted site (the unit tests'
 * runner): the device side of the exchange is scripted as the packets `intake` would accept, since
 * the sensors module's sending of offers (U8) is not built yet.
 */
import { describe, expect, test } from "bun:test";
import { UpdateAction, UpdateHolding, UpdateReason, UpdateStage } from "@hsn/protocol";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { DeviceUpdateState, RolloutStage } from "../../../src/core/model/rows.ts";
import {
  CONFIRMED_IMAGE,
  decisions,
  fileBytes,
  G1,
  HOUR_US,
  linkAll,
  NEW_VERSION,
  OLD_VERSION,
  ON_TRIAL,
  offerTo,
  okBody,
  openRow,
  R1,
  rowOf,
  type Runner,
  S1,
  S2,
  sensorThrough,
  siteRunner,
  wifi,
} from "../../unit/firmware/support.ts";

type Image = ReturnType<typeof siteRunner>["image"];

/** The device's old image booted, not on trial, no rollback flag: the torn confirmation's sequence. */
function didNotTake(runner: Runner, device: typeof S1, image: Image) {
  const started = runner.started(device, OLD_VERSION, CONFIRMED_IMAGE);
  const query = runner.query(device, { image: image.imageId, held: UpdateHolding.Verified });
  return { started, query };
}

/** The go-ahead given to `device`, which had verified the image. */
function goAhead(runner: Runner, device: typeof S1, image: Image, link: number): void {
  runner.query(device);
  runner.query(device, {}, wifi(link));
  const verified = runner.status(device, image.imageId, UpdateStage.Verified);
  expect(offerTo(verified, device)?.offer.action).toBe(UpdateAction.InstallNow);
  expect(rowOf(runner, device)?.state).toBe(DeviceUpdateState.Installing);
}

function expectRetried(
  runner: Runner,
  device: typeof S1,
  ran: ReturnType<typeof didNotTake>,
  attempts: number,
) {
  const all = [...decisions(ran.started), ...decisions(ran.query)].map((d) => d.kind);
  expect(all).not.toContain("firmware_rolled_back");
  expect(all).not.toContain("firmware_refused");
  expect(all).not.toContain("rollout_paused");
  expect(rowOf(runner, device)?.attempts).toBe(attempts);
  // The go-ahead again, in answer to the query, recorded as a go-ahead.
  expect(offerTo(ran.query, device)?.offer.action).toBe(UpdateAction.InstallNow);
  expect(all).toContain("firmware_installing");
  expect(rowOf(runner, device)?.state).toBe(DeviceUpdateState.Installing);
}

function expectExhausted(runner: Runner, device: typeof S1, ran: ReturnType<typeof didNotTake>) {
  const refused = decisions(ran.started).find((d) => d.kind === "firmware_refused");
  expect(refused).toMatchObject({ device, value: UpdateReason.ImageCheck, durability: "now" });
  expect(rowOf(runner, device)?.state).toBe(DeviceUpdateState.Refused);
  expect(rowOf(runner, device)?.lastReason).toBe(UpdateReason.ImageCheck);
  expect(openRow(runner)).toMatchObject({
    stage: RolloutStage.Paused,
    pausedReason: UpdateReason.ImageCheck,
    pausedDevice: device,
  });
  // What the person sees: the device refused "imageCheck", the rollout paused naming it.
  const status = okBody(runner.op({ op: "rollout.status", body: {} }).answer) as {
    rollout: { paused: unknown };
    devices: { device: number; state: string; lastReason: string | null }[];
  };
  expect(status.rollout.paused).toEqual({ reason: "imageCheck", device });
  expect(status.devices.find((d) => d.device === device)).toMatchObject({
    state: "refused",
    lastReason: "imageCheck",
  });
  // The device's query is answered "nothing": the hub no longer gives it the go-ahead.
  expect(offerTo(ran.query, device)?.offer.action).toBe(UpdateAction.Nothing);
}

describe("an install that did not take", () => {
  test("a sensor in the rest: the go-ahead again, counted; at the limit, refused imageCheck and paused", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id } });
    linkAll(runner);
    sensorThrough(runner, S1, image, 501);
    runner.status(R1, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(600));
    runner.started(R1, NEW_VERSION, CONFIRMED_IMAGE, {}, wifi(600));
    runner.status(G1, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(700));
    runner.started(G1, NEW_VERSION, CONFIRMED_IMAGE, {}, wifi(700));
    runner.run(HOUR_US);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Rest);

    goAhead(runner, S2, image, 502);
    const tries = DEFAULT_RULES.firmware.brokenTries;
    for (let attempt = 1; attempt < tries; attempt++) {
      expectRetried(runner, S2, didNotTake(runner, S2, image), attempt);
    }
    expectExhausted(runner, S2, didNotTake(runner, S2, image));
  });

  test("the sensor pilot: retried as the current pilot, the siren pilot not started meanwhile; at the limit, paused", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id } });
    linkAll(runner);
    goAhead(runner, S1, image, 501);
    const tries = DEFAULT_RULES.firmware.brokenTries;
    for (let attempt = 1; attempt < tries; attempt++) {
      const ran = didNotTake(runner, S1, image);
      expectRetried(runner, S1, ran, attempt);
      expect(offerTo(ran.started, R1)).toBeUndefined();
      expect(offerTo(ran.query, R1)).toBeUndefined();
      expect(rowOf(runner, R1)?.state).toBe(DeviceUpdateState.Planned);
    }
    expectExhausted(runner, S1, didNotTake(runner, S1, image));
    expect(rowOf(runner, R1)?.state).toBe(DeviceUpdateState.Planned);
  });

  test("the same after a Started on trial first (the new image ran, its confirmation torn)", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [S1] } });
    goAhead(runner, S1, image, 501);
    runner.started(S1, NEW_VERSION, ON_TRIAL);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.OnTrial);
    expectRetried(runner, S1, didNotTake(runner, S1, image), 1);
  });

  test("a confirmed go-ahead after a retry: confirmed, the count no longer matters", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [S1] } });
    goAhead(runner, S1, image, 501);
    didNotTake(runner, S1, image);
    runner.started(S1, NEW_VERSION, CONFIRMED_IMAGE);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Confirmed);
    expect(openRow(runner)).toBeUndefined();
  });
});

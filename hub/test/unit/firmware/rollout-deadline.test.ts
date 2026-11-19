import { expect, test } from "bun:test";
import { UpdateAction, UpdateReason, UpdateStage } from "@hsn/protocol";
import { firmwareDeadlines } from "../../../src/core/firmware/deadlines.ts";
import { linkId } from "../../../src/core/model/ids.ts";
import {
  ArmState,
  DeviceUpdateState,
  NO_CONTACT_REASON,
  RolloutStage,
  UpdateHeld,
} from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import {
  DAY_US,
  decisions,
  fileBytes,
  G1,
  offerTo,
  openRow,
  rowOf,
  type Runner,
  S1,
  S2,
  SECOND_US,
  sensorThrough,
  siteRunner,
  updateEvents,
  wifi,
} from "./support.ts";

type DeadlineKind = ReturnType<typeof firmwareDeadlines>[number]["key"]["kind"];

/** Delivers one due timer at the current clock, including a jump across a suspended day. */
function expire(runner: Runner, kind: DeadlineKind, late: number) {
  const timers = firmwareDeadlines(runner.slice);
  expect(timers.map(({ key }) => key.kind)).toEqual([kind]);
  const due = timers[0] ?? expect.unreachable("the firmware did not arm the expected timer");
  const remaining = due.at - runner.now.mono;
  expect(remaining).toBeGreaterThanOrEqual(1000);
  expect(runner.run(remaining - 1000).out).toEqual([]);
  expect(firmwareDeadlines(runner.slice)).toEqual([due]);

  runner.advance(1000 + late);
  const result = runner.send({ kind: "timer", key: due.key, at: due.at });
  expect(firmwareDeadlines(runner.slice).filter(({ at }) => at <= runner.now.mono)).toEqual([]);
  return result;
}

/** Approves a rollout over the named devices and identifies its sensor's transfer link. */
function sensorRollout(devices = [S1]) {
  const made = siteRunner();
  const { runner, image } = made;
  expect(
    runner.op({ op: "rollout.start", body: { image: image.id, devices, pilots: [S1] } }).answer?.ok,
  ).toBe(true);
  return made;
}

const arrivals = [
  ["on time", 0],
  ["a day late", DAY_US],
] as const;

test.each(arrivals)("soak expiry %s starts the rest exactly once", (_name, late) => {
  const { runner, image } = sensorRollout([S1, S2]);
  sensorThrough(runner, S1, image, 501);
  expect(openRow(runner)?.stage).toBe(RolloutStage.Soak);
  expire(runner, "soakEnd", late);
  expect(openRow(runner)?.stage).toBe(RolloutStage.Rest);
  expect(offerTo(runner.query(S2), S2)?.offer.action).toBe(UpdateAction.JoinWifiAndFetch);
  expect(firmwareDeadlines(runner.slice)).toEqual([]);
});

test.each(arrivals)("trial watch %s records no contact and pauses", (_name, late) => {
  const { runner, image } = sensorRollout();
  runner.query(S1);
  runner.query(S1, {}, wifi(501));
  runner.status(S1, image.imageId, UpdateStage.Verified, 0, fileBytes(image));
  expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Installing);
  const due = expire(runner, "trialWatch", late);
  expect(decisions(due).filter(({ kind }) => kind === "firmware_refused")).toMatchObject([
    { device: S1, value: NO_CONTACT_REASON, durability: "now" },
  ]);
  expect(rowOf(runner, S1)).toMatchObject({
    state: DeviceUpdateState.Refused,
    lastReason: NO_CONTACT_REASON,
  });
  expect(openRow(runner)?.stage).toBe(RolloutStage.Paused);
  expect(firmwareDeadlines(runner.slice)).toEqual([]);
});

test.each(arrivals)(
  "Bluetooth expiry %s clears the session and replans the device",
  (_name, late) => {
    const { runner } = sensorRollout();
    runner.op({ op: "firmware.bluetooth", body: { device: S1 } });
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.OpenBluetooth);
    expect(rowOf(runner, S1)?.bleExpiresMs).toBeGreaterThan(runner.now.wall);
    expire(runner, "sessionExpiry", late);
    expect(rowOf(runner, S1)).toMatchObject({
      state: DeviceUpdateState.Planned,
      bleNonce: null,
      bleExpiresMs: null,
    });
    expect(firmwareDeadlines(runner.slice)).toEqual([]);
  },
);

test.each(arrivals)(
  "an armed reminder %s is recorded once and rearmed for tomorrow",
  (_name, late) => {
    const { runner } = sensorRollout();
    runner.arm(S1);
    runner.send({ kind: "armedChanged", sensor: S1, arm: ArmState.Armed, cause: undefined });
    const due = expire(runner, "armedReminder", late);
    expect(decisions(due).filter(({ kind }) => kind === "firmware_reminder")).toMatchObject([
      { device: S1 },
    ]);
    expect(rowOf(runner, S1)?.remindedMs).toBe(runner.now.wall);
    expect(firmwareDeadlines(runner.slice).map(({ at }) => at)).toEqual([
      mono(runner.now.mono + runner.rules.firmware.armedReminderEveryMs * 1000),
    ]);
  },
);

test.each(arrivals)("a gateway retry %s clears the hold and offers one fetch", (_name, late) => {
  const { runner, image } = siteRunner();
  expect(
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [G1] } }).answer?.ok,
  ).toBe(true);
  runner.gatewaySession(G1, linkId(700));
  runner.send({ kind: "gatewayUp", gateway: G1, link: linkId(700) });
  runner.status(G1, image.imageId, UpdateStage.Refused, UpdateReason.RadioBusy, 0, wifi(700));
  expect(rowOf(runner, G1)?.held).toBe(UpdateHeld.GatewayBusy);
  const due = expire(runner, "gatewayBusyRetry", late);
  expect(offerTo(due, G1)?.offer.action).toBe(UpdateAction.Fetch);
  expect(rowOf(runner, G1)?.held).toBe(UpdateHeld.No);
  expect(firmwareDeadlines(runner.slice)).toEqual([]);
});

test.each(arrivals)("a progress deadline %s publishes the latest bytes once", (_name, late) => {
  const { runner, image } = sensorRollout();
  runner.query(S1);
  runner.query(S1, {}, wifi(501));
  runner.send({ kind: "transferProgress", link: linkId(501), image: image.imageId, bytes: 65_536 });
  runner.advance(SECOND_US);
  const latest = runner.send({
    kind: "transferProgress",
    link: linkId(501),
    image: image.imageId,
    bytes: 131_072,
  });
  expect(updateEvents(latest, S1)).toEqual([]);
  const due = expire(runner, "progressEvent", late);
  expect(updateEvents(due, S1)).toMatchObject([{ state: "fetching", bytes: 131_072 }]);
  expect(firmwareDeadlines(runner.slice)).toEqual([]);
});

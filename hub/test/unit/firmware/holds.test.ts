/**
 * Holds, starting and ending (docs/m3-updates-design.md section 4, "Before any offer", "Before the
 * go-ahead"): presence at its edge; armed (D91) with its reminder at its edges; the battery floor
 * at its edge and USB power; a countdown, an alarm or a site move (D115), with every grant revoked
 * while a countdown or alarm runs and given again after (R12); a key change not finished (D141);
 * a provisioning or hub switch and a sounding siren before the go-ahead.
 */
import { describe, expect, test } from "bun:test";
import { UpdateAction, UpdateHolding, UpdateStage } from "@hsn/protocol";
import { batteryPercent } from "../../../src/core/health/view.ts";
import { deviceId, linkId } from "../../../src/core/model/ids.ts";
import { mono } from "../../../src/core/model/time.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  ArmState,
  DeviceUpdateState,
  MoveStage,
  UpdateHeld,
} from "../../../src/core/model/rows.ts";
import { offerWaiting } from "../../../src/core/firmware/view.ts";
import {
  DAY_US,
  decisions,
  effectsOf,
  fileBytes,
  INTERVAL_MS,
  offerTo,
  R1,
  rowOf,
  type Runner,
  S1,
  SECOND_US,
  sensorThrough,
  siteRunner,
  updateRows,
  wifi,
} from "./support.ts";

function started(): ReturnType<typeof siteRunner> {
  const made = siteRunner();
  made.runner.op({ op: "rollout.start", body: { image: made.image.id, pilots: [S1] } });
  return made;
}

/** The sensor pilot downloaded and verified, waiting for the go-ahead (paused by a hold). */
function verifiedWaiting(
  runner: Runner,
  image: ReturnType<typeof siteRunner>["image"],
  hold: () => void,
) {
  runner.query(S1);
  runner.query(S1, {}, wifi(501));
  hold();
  const ran = runner.status(S1, image.imageId, UpdateStage.Verified);
  expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Verified);
  return ran;
}

describe("presence", () => {
  test("a sensor heard within two of its intervals is offered; one heard a moment before that is not", () => {
    const { runner } = started();
    const window = DEFAULT_RULES.firmware.heardWithinHeartbeats * INTERVAL_MS * 1000;
    runner.advance(window);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);
    runner.advance(1);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(false);
  });
});

describe("armed (D91)", () => {
  test("an armed sensor is held armed before any offer; disarmed, the offer waits", () => {
    const { runner } = started();
    runner.arm(S1);
    runner.send({ kind: "armedChanged", sensor: S1, arm: ArmState.Armed, cause: undefined });
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.Armed);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(false);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    runner.arm(S1, ArmState.Disarmed);
    runner.send({ kind: "armedChanged", sensor: S1, arm: ArmState.Disarmed, cause: undefined });
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.No);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);
  });

  test("both waiting states count as armed", () => {
    const { runner } = started();
    runner.arm(S1, ArmState.WaitsForCloseAfterAlarm);
    runner.send({
      kind: "armedChanged",
      sensor: S1,
      arm: ArmState.WaitsForCloseAfterAlarm,
      cause: undefined,
    });
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.Armed);
  });

  test("arming during a download: it goes on, and the install waits until disarmed", () => {
    const { runner, image } = started();
    runner.query(S1);
    const fetch = runner.query(S1, {}, wifi(501));
    expect(offerTo(fetch, S1)?.offer.action).toBe(UpdateAction.Fetch);
    runner.arm(S1);
    runner.send({ kind: "armedChanged", sensor: S1, arm: ArmState.Armed, cause: undefined });
    // The download goes on: a status on the link is answered "fetch".
    const going = runner.status(S1, image.imageId, UpdateStage.Fetching, 0, 262_144, wifi(501));
    expect(offerTo(going, S1)?.offer.action).toBe(UpdateAction.Fetch);
    const verified = runner.status(S1, image.imageId, UpdateStage.Verified);
    expect(offerTo(verified, S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.Armed);
    runner.arm(S1, ArmState.Disarmed);
    runner.send({ kind: "armedChanged", sensor: S1, arm: ArmState.Disarmed, cause: undefined });
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);
    const go = runner.query(S1, { image: image.imageId, held: UpdateHolding.Verified });
    expect(offerTo(go, S1)?.offer.action).toBe(UpdateAction.InstallNow);
  });

  test("the reminder: after 24 hours armed, not a moment before, then daily, and none once disarmed", () => {
    const { runner } = started();
    runner.arm(S1);
    runner.send({ kind: "armedChanged", sensor: S1, arm: ArmState.Armed, cause: undefined });
    const after = DEFAULT_RULES.firmware.armedReminderAfterMs * 1000;
    expect(decisions(runner.run(after - 1)).filter((d) => d.kind === "firmware_reminder")).toEqual(
      [],
    );
    const first = runner.run(1);
    const reminder = decisions(first).find((d) => d.kind === "firmware_reminder");
    expect(reminder?.device).toBe(S1);
    expect(reminder?.value).toBe(1);
    expect(rowOf(runner, S1)?.remindedMs).toBe(runner.now.wall);
    expect(updateRows(first).at(-1)?.durability).toBe("now");
    const every = DEFAULT_RULES.firmware.armedReminderEveryMs * 1000;
    expect(decisions(runner.run(every - 1)).filter((d) => d.kind === "firmware_reminder")).toEqual(
      [],
    );
    expect(decisions(runner.run(1)).find((d) => d.kind === "firmware_reminder")?.value).toBe(2);
    runner.arm(S1, ArmState.Disarmed);
    runner.send({ kind: "armedChanged", sensor: S1, arm: ArmState.Disarmed, cause: undefined });
    expect(decisions(runner.run(2 * DAY_US)).filter((d) => d.kind === "firmware_reminder")).toEqual(
      [],
    );
  });
});

describe("battery (UP7, P9)", () => {
  test("at the floor it is offered; one percent below it is held; on USB power it is not", () => {
    const { runner } = started();
    runner.battery(S1, 3_703);
    expect(batteryPercent(runner.view, runner.rules, S1)).toBe(
      DEFAULT_RULES.firmware.batteryFloorPercent,
    );
    runner.decision("battery_ok", S1);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.No);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);

    runner.battery(S1, 3_702);
    expect(batteryPercent(runner.view, runner.rules, S1)).toBe(
      DEFAULT_RULES.firmware.batteryFloorPercent - 1,
    );
    runner.decision("battery_low", S1);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.Battery);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.KeepAndWait);

    const powered = runner.query(S1, { power: true });
    expect(offerTo(powered, S1)?.offer.action).toBe(UpdateAction.JoinWifiAndFetch);
  });

  test("a siren's battery never holds it: sirens and gateways are on mains", () => {
    const { runner } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: 1, devices: [R1] } });
    runner.battery(R1, 3_000);
    const ran = runner.heartbeat(R1, wifi(600));
    expect(offerTo(ran, R1)?.offer.action).toBe(UpdateAction.Fetch);
  });
});

describe("a countdown, an alarm or a site move (D115, R12)", () => {
  test("a countdown starting mid-download revokes the grant; it is given again when the countdown ends", () => {
    const { runner } = started();
    runner.query(S1);
    runner.query(S1, {}, wifi(501));
    runner.countdown(S1);
    const revoked = runner.heartbeat(S1);
    expect(effectsOf(revoked, "transferRevoke")).toEqual([
      { kind: "transferRevoke", link: linkId(501), reason: "paused" },
    ]);
    // Asked again on its link meanwhile, it is told to wait.
    expect(
      offerTo(runner.query(S1, { held: UpdateHolding.Part }, wifi(501)), S1)?.offer.action,
    ).toBe(UpdateAction.KeepAndWait);
    runner.countdown(false);
    const again = runner.heartbeat(S1);
    expect(effectsOf(again, "transferGrant").map((e) => e.link)).toEqual([linkId(501)]);
  });

  test("a countdown starting before the go-ahead: none is given until it ends", () => {
    const { runner, image } = started();
    const ran = verifiedWaiting(runner, image, () => {
      runner.countdown(S1);
    });
    expect(offerTo(ran, S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.CountdownAlarmOrSiteMove);
    runner.countdown(false);
    runner.heartbeat(S1);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.No);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);
  });

  test("an alarm holds the go-ahead; a site move holds it but revokes no grant", () => {
    const { runner, image } = started();
    verifiedWaiting(runner, image, () => {
      runner.alarm(true);
    });
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.CountdownAlarmOrSiteMove);
    runner.alarm(false);
    runner.siteMove(MoveStage.Announcing);
    const moving = runner.heartbeat(S1);
    expect(effectsOf(moving, "transferRevoke")).toEqual([]);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.CountdownAlarmOrSiteMove);
    runner.siteMove(MoveStage.Done);
    runner.heartbeat(S1);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.No);
  });
});

describe("before the go-ahead", () => {
  test("a hub version switch under way holds it; once over, it goes", () => {
    const { runner, image } = started();
    const ran = verifiedWaiting(runner, image, () => {
      runner.hubSwitching(true);
    });
    expect(offerTo(ran, S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    runner.hubSwitching(false);
    expect(
      offerTo(runner.query(S1, { image: image.imageId, held: UpdateHolding.Verified }), S1)?.offer
        .action,
    ).toBe(UpdateAction.InstallNow);
  });

  test("a provisioning under way holds it; once over, it goes", () => {
    const { runner, image } = started();
    const board = {
      link: linkId(42),
      label: "/dev/cu.usb",
      identity: undefined,
      exchange: {
        kind: "provision" as const,
        asker: { kind: "automatic" as const },
        device: deviceId(77),
        deadline: undefined,
        mayHoldKey: false,
      },
    };
    const ran = verifiedWaiting(runner, image, () => {
      runner.view = {
        ...runner.view,
        setup: { ...runner.view.setup, boards: new Map([[board.link, board]]) },
      };
    });
    expect(offerTo(ran, S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.WaitingTurn);
    runner.view = { ...runner.view, setup: { ...runner.view.setup, boards: new Map() } };
    expect(
      offerTo(runner.query(S1, { image: image.imageId, held: UpdateHolding.Verified }), S1)?.offer
        .action,
    ).toBe(UpdateAction.InstallNow);
  });

  test("a siren installs only when off: not while it tests", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [R1] } });
    runner.heartbeat(R1, wifi(600));
    runner.view = {
      ...runner.view,
      alarm: {
        ...runner.view.alarm,
        tests: new Map([[R1, mono(runner.now.mono + 60 * SECOND_US)]]),
      },
    };
    const ran = runner.status(
      R1,
      image.imageId,
      UpdateStage.Verified,
      0,
      fileBytes(image),
      wifi(600),
    );
    expect(offerTo(ran, R1)).toBeUndefined();
    expect(rowOf(runner, R1)?.held).toBe(UpdateHeld.WaitingTurn);
    runner.advance(61 * SECOND_US);
    const off = runner.heartbeat(R1, wifi(600));
    expect(offerTo(off, R1)?.offer.action).toBe(UpdateAction.InstallNow);
  });
});

describe("a key change after a restore (D141)", () => {
  test("held while the device is not heard under its new key; offered once it is", () => {
    const { runner } = siteRunner(DEFAULT_RULES, { rekey: [S1] });
    runner.op({ op: "rollout.start", body: { image: 1, pilots: [S1] } });
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.KeyChange);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    runner.decision("key_changed", S1);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.No);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);
  });
});

export { sensorThrough };

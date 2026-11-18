/**
 * A device failing at each stage, and what each of its reports changes (docs/m3-updates-design.md
 * section 4, "How a failed update is reported"; section 5, the device messages): refusals that
 * hold, breaks counted to their edge, refusals that pause, a busy gateway with its retry at its
 * edge and its bound, a rollback, a restart without trying, no contact at the trial watch's edge;
 * the shell's progress and the `deviceUpdate` bound; and what a device with nothing planned is told.
 */
import { describe, expect, test } from "bun:test";
import { UpdateAction, UpdateHolding, UpdateReason, UpdateStage } from "@hsn/protocol";
import { linkId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  ArmState,
  DeviceUpdateState,
  NO_CONTACT_REASON,
  ROLLED_BACK_REASON,
  RolloutStage,
  UpdateHeld,
} from "../../../src/core/model/rows.ts";
import { offerWaiting } from "../../../src/core/firmware/view.ts";
import {
  CONFIRMED_IMAGE,
  G2,
  decisions,
  effectsOf,
  fileBytes,
  G1,
  HOUR_US,
  MINUTE_US,
  NEW_VERSION,
  OLD_VERSION,
  ON_TRIAL,
  offerTo,
  okBody,
  openRow,
  R1,
  rolledBack,
  rowOf,
  type Runner,
  S1,
  S2,
  SECOND_US,
  siteRunner,
  updateEvents,
  wifi,
} from "./support.ts";

type Image = ReturnType<typeof siteRunner>["image"];

/** The sensor pilot, offered and fetching on link 501. */
function fetching(): { runner: Runner; image: Image } {
  const made = siteRunner();
  made.runner.op({ op: "rollout.start", body: { image: made.image.id, pilots: [S1] } });
  made.runner.query(S1);
  made.runner.query(S1, {}, wifi(501));
  return made;
}

describe("refusals that only hold the device", () => {
  test.each([
    ["noWifi", UpdateReason.NoWifi],
    ["hubNotFound", UpdateReason.HubNotFound],
  ])("%s: needs a phone, no pause, and Wi-Fi not tried again in this rollout", (_name, reason) => {
    const { runner, image } = fetching();
    const ran = runner.status(S1, image.imageId, UpdateStage.Refused, reason);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.NeedsPhone);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Planned);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Pilots);
    expect(decisions(ran).map((d) => d.kind)).not.toContain("firmware_refused");
    expect(offerTo(ran, S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(false);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
  });

  test("a sensor without Wi-Fi details is held needing a phone from its first query", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id, pilots: [S1] } });
    const ran = runner.query(S1, { wifi: false });
    expect(offerTo(ran, S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(rowOf(runner, S1)?.held).toBe(UpdateHeld.NeedsPhone);
  });

  test.each([
    ["battery", UpdateReason.Battery, UpdateHeld.Battery],
    ["armed", UpdateReason.Armed, UpdateHeld.Armed],
  ])("%s: held so, no pause", (_name, reason, held) => {
    const { runner, image } = fetching();
    runner.status(S1, image.imageId, UpdateStage.Refused, reason);
    expect(rowOf(runner, S1)?.held).toBe(held);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Pilots);
  });
});

describe("a hold the device reported stays until the hub learns something new", () => {
  test("armed: not offered again until its arming changes", () => {
    const { runner, image } = fetching();
    runner.status(S1, image.imageId, UpdateStage.Refused, UpdateReason.Armed);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(false);
    runner.send({ kind: "armedChanged", sensor: S1, arm: ArmState.Disarmed, cause: undefined });
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.JoinWifiAndFetch);
  });

  test("battery: not offered again until a new reading", () => {
    const { runner, image } = fetching();
    runner.battery(S1, 3_800);
    runner.status(S1, image.imageId, UpdateStage.Refused, UpdateReason.Battery);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    runner.battery(S1, 3_900);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.JoinWifiAndFetch);
  });
});

describe("a download broken", () => {
  test.each([
    ["linkLost", UpdateReason.LinkLost],
    ["flash", UpdateReason.Flash],
    ["hashMismatch", UpdateReason.HashMismatch],
  ])(
    "%s: offered again twice; the third break is refused and pauses the rollout",
    (_name, reason) => {
      const { runner, image } = fetching();
      const tries = DEFAULT_RULES.firmware.brokenTries;
      for (let i = 1; i < tries; i++) {
        const ran = runner.status(S1, image.imageId, UpdateStage.Refused, reason);
        expect(rowOf(runner, S1)?.attempts).toBe(i);
        expect(rowOf(runner, S1)?.state).not.toBe(DeviceUpdateState.Refused);
        expect(offerTo(ran, S1)?.offer.action).toBe(UpdateAction.JoinWifiAndFetch);
      }
      const last = runner.status(S1, image.imageId, UpdateStage.Refused, reason);
      expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Refused);
      const refused = decisions(last).find((d) => d.kind === "firmware_refused");
      expect(refused).toMatchObject({ device: S1, value: reason, durability: "now" });
      expect(openRow(runner)?.stage).toBe(RolloutStage.Paused);
      expect(openRow(runner)?.pausedReason).toBe(reason);
      expect(offerTo(last, S1)?.offer.action).toBe(UpdateAction.Nothing);
    },
  );
});

describe("refused before writing, or at the install: the image or the store is wrong", () => {
  test.each([
    ["badHeader", UpdateReason.BadHeader],
    ["wrongHub", UpdateReason.WrongHub],
    ["wrongRole", UpdateReason.WrongRole],
    ["tooLarge", UpdateReason.TooLarge],
    ["badSignature", UpdateReason.BadSignature],
  ])("%s: refused at once, its grant revoked, the rollout paused naming it", (_name, reason) => {
    const { runner, image } = fetching();
    const ran = runner.status(S1, image.imageId, UpdateStage.Refused, reason);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Refused);
    expect(rowOf(runner, S1)?.lastReason).toBe(reason);
    expect(effectsOf(ran, "transferRevoke").map((e) => e.link)).toEqual([linkId(501)]);
    expect(openRow(runner)).toMatchObject({
      stage: RolloutStage.Paused,
      pausedReason: reason,
      pausedDevice: S1,
    });
    const status = okBody(runner.op({ op: "rollout.status", body: {} }).answer) as {
      rollout: { paused: unknown };
      devices: { device: number; state: string; lastReason: string | null }[];
    };
    expect(status.rollout.paused).toEqual({ reason: _name, device: S1 });
    expect(status.devices.find((d) => d.device === S1)).toMatchObject({
      state: "refused",
      lastReason: _name,
    });
  });

  test("imageCheck at the install: refused and paused", () => {
    const { runner, image } = fetching();
    runner.status(S1, image.imageId, UpdateStage.Verified);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Installing);
    runner.status(S1, image.imageId, UpdateStage.Refused, UpdateReason.ImageCheck);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Refused);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Paused);
  });
});

describe("after the go-ahead", () => {
  test("a rollback: rolled back with the failed version, notified as a warning, the rollout paused", () => {
    const { runner, image } = fetching();
    runner.status(S1, image.imageId, UpdateStage.Verified);
    runner.started(S1, NEW_VERSION, ON_TRIAL);
    const ran = runner.started(S1, OLD_VERSION, rolledBack(NEW_VERSION));
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.RolledBack);
    expect(decisions(ran).find((d) => d.kind === "firmware_rolled_back")).toMatchObject({
      device: S1,
      value: NEW_VERSION,
      durability: "now",
    });
    expect(openRow(runner)?.stage).toBe(RolloutStage.Paused);
    expect(openRow(runner)?.pausedDevice).toBe(S1);
    expect(openRow(runner)?.pausedReason).toBe(ROLLED_BACK_REASON);
    const status = okBody(runner.op({ op: "rollout.status", body: {} }).answer) as {
      rollout: { paused: unknown };
    };
    expect(status.rollout.paused).toEqual({ reason: "rolledBack", device: S1 });
  });

  test("a rollback of another version is not this rollout's", () => {
    const { runner, image } = fetching();
    runner.status(S1, image.imageId, UpdateStage.Verified);
    runner.started(S1, OLD_VERSION, rolledBack(0x010001));
    expect(rowOf(runner, S1)?.state).not.toBe(DeviceUpdateState.RolledBack);
  });

  test("restarted on its old image without trying: verified again, and the go-ahead given again", () => {
    const { runner, image } = fetching();
    runner.status(S1, image.imageId, UpdateStage.Verified);
    runner.started(S1, OLD_VERSION, CONFIRMED_IMAGE);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Verified);
    const again = runner.query(S1, { image: image.imageId, held: UpdateHolding.Verified });
    expect(offerTo(again, S1)?.offer.action).toBe(UpdateAction.InstallNow);
  });

  test("no Started within the trial deadline and its grace: noContact, at the edge, and paused", () => {
    const { runner, image } = fetching();
    runner.status(S1, image.imageId, UpdateStage.Verified);
    const watch =
      (DEFAULT_RULES.firmware.trialDeadlineMs.sensor + DEFAULT_RULES.firmware.noContactGraceMs) *
      1000;
    runner.run(watch - 1);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Installing);
    const due = runner.run(1);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Refused);
    expect(rowOf(runner, S1)?.lastReason).toBe(NO_CONTACT_REASON);
    expect(decisions(due).find((d) => d.kind === "firmware_refused")?.value).toBe(
      NO_CONTACT_REASON,
    );
    expect(openRow(runner)?.pausedReason).toBe(NO_CONTACT_REASON);
  });

  test("a siren's watch is its own deadline: 5 minutes and the grace", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [R1] } });
    runner.heartbeat(R1, wifi(600));
    runner.status(R1, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(600));
    expect(rowOf(runner, R1)?.state).toBe(DeviceUpdateState.Installing);
    const watch =
      (DEFAULT_RULES.firmware.trialDeadlineMs.siren + DEFAULT_RULES.firmware.noContactGraceMs) *
      1000;
    runner.run(watch - 1);
    expect(rowOf(runner, R1)?.state).toBe(DeviceUpdateState.Installing);
    runner.run(1);
    expect(rowOf(runner, R1)?.state).toBe(DeviceUpdateState.Refused);
  });

  test("confirmed in time: no noContact later", () => {
    const { runner, image } = fetching();
    runner.status(S1, image.imageId, UpdateStage.Verified);
    runner.started(S1, NEW_VERSION, ON_TRIAL);
    runner.status(S1, image.imageId, UpdateStage.Confirmed);
    const later = runner.run(HOUR_US);
    expect(decisions(later).map((d) => d.kind)).not.toContain("firmware_refused");
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Confirmed);
  });
});

describe("a gateway always busy (section 5)", () => {
  function gatewayFetching() {
    const made = siteRunner();
    made.runner.op({ op: "rollout.start", body: { image: made.image.id, devices: [G1] } });
    made.runner.gatewaySession(G1, linkId(700));
    made.runner.send({ kind: "gatewayUp", gateway: G1, link: linkId(700) });
    expect(rowOf(made.runner, G1)?.state).toBe(DeviceUpdateState.Offered);
    return made;
  }

  test("held, offered again after an hour at its edge; after the third hold it waits for a person", () => {
    const { runner, image } = gatewayFetching();
    for (let hold = 1; hold < DEFAULT_RULES.firmware.gatewayBusyMaxHolds; hold++) {
      const busy = runner.status(
        G1,
        image.imageId,
        UpdateStage.Refused,
        UpdateReason.RadioBusy,
        0,
        wifi(700),
      );
      expect(rowOf(runner, G1)?.held).toBe(UpdateHeld.GatewayBusy);
      expect(decisions(busy).find((d) => d.kind === "firmware_held")?.value).toBe(
        UpdateHeld.GatewayBusy,
      );
      expect(openRow(runner)?.stage).not.toBe(RolloutStage.Paused);
      expect(
        offerTo(runner.run(DEFAULT_RULES.firmware.gatewayBusyRetryMs * 1000 - 1), G1),
      ).toBeUndefined();
      const retry = runner.run(1);
      expect(offerTo(retry, G1)?.offer.action).toBe(UpdateAction.Fetch);
    }
    runner.status(G1, image.imageId, UpdateStage.Refused, UpdateReason.RadioBusy, 0, wifi(700));
    expect(offerTo(runner.run(10 * HOUR_US), G1)).toBeUndefined();
    expect(rowOf(runner, G1)?.held).toBe(UpdateHeld.GatewayBusy);
    // "Update now anyway".
    const forced = runner.op({
      op: "rollout.resume",
      body: { rollout: 1, device: G1, force: true },
    });
    okBody(forced.answer);
    expect(offerTo(forced, G1)?.offer.action).toBe(UpdateAction.ForcedFetch);
    expect(effectsOf(forced, "transferGrant").map((g) => g.link)).toEqual([linkId(700)]);
    expect(rowOf(runner, G1)?.held).toBe(UpdateHeld.No);
  });

  /** G1 held busy three times, then forced; G2 planned beside it. */
  function forcedGateway() {
    const made = siteRunner();
    made.runner.op({ op: "rollout.start", body: { image: made.image.id, devices: [G1, G2] } });
    made.runner.gatewaySession(G1, linkId(700));
    made.runner.send({ kind: "gatewayUp", gateway: G1, link: linkId(700) });
    for (let hold = 0; hold < DEFAULT_RULES.firmware.gatewayBusyMaxHolds; hold++) {
      made.runner.status(
        G1,
        made.image.imageId,
        UpdateStage.Refused,
        UpdateReason.RadioBusy,
        0,
        wifi(700),
      );
      if (hold + 1 < DEFAULT_RULES.firmware.gatewayBusyMaxHolds) {
        made.runner.run(DEFAULT_RULES.firmware.gatewayBusyRetryMs * 1000);
      }
    }
    made.runner.op({ op: "rollout.resume", body: { rollout: 1, device: G1, force: true } });
    expect(rowOf(made.runner, G1)?.state).toBe(DeviceUpdateState.Offered);
    return made;
  }

  test("forced: action 6 on its link when asked again, never during a countdown or alarm", () => {
    const { runner } = forcedGateway();
    expect(
      offerTo(runner.query(G1, { held: UpdateHolding.Part }, wifi(700)), G1)?.offer.action,
    ).toBe(UpdateAction.ForcedFetch);
    runner.countdown(S1);
    const counting = runner.heartbeat(S1);
    expect(effectsOf(counting, "transferRevoke")).toEqual([
      { kind: "transferRevoke", link: linkId(700), reason: "paused" },
    ]);
    expect(
      offerTo(runner.query(G1, { held: UpdateHolding.Part }, wifi(700)), G1)?.offer.action,
    ).toBe(UpdateAction.KeepAndWait);
    runner.countdown(false);
    runner.alarm(true);
    expect(
      offerTo(runner.query(G1, { held: UpdateHolding.Part }, wifi(700)), G1)?.offer.action,
    ).toBe(UpdateAction.KeepAndWait);
    runner.alarm(false);
    expect(
      offerTo(runner.query(G1, { held: UpdateHolding.Part }, wifi(700)), G1)?.offer.action,
    ).toBe(UpdateAction.ForcedFetch);
  });

  test("forced: only that gateway; the other, at its turn, is offered an ordinary fetch", () => {
    const { runner, image } = forcedGateway();
    runner.gatewaySession(G2, linkId(701));
    runner.send({ kind: "gatewayUp", gateway: G2, link: linkId(701) });
    runner.status(G1, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(700));
    runner.started(G1, NEW_VERSION, CONFIRMED_IMAGE, {}, wifi(700));
    const rest = runner.run(DEFAULT_RULES.firmware.soakMs * 1000);
    expect(offerTo(rest, G2)?.offer.action).toBe(UpdateAction.Fetch);
  });

  test("forced, then paused: told to wait, its grant taken back; resumed, forced again; cancelled, told to discard", () => {
    const { runner } = forcedGateway();
    const paused = runner.op({ op: "rollout.pause", body: { rollout: 1 } });
    expect(offerTo(paused, G1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(effectsOf(paused, "transferRevoke")).toEqual([
      { kind: "transferRevoke", link: linkId(700), reason: "paused" },
    ]);
    expect(
      offerTo(runner.query(G1, { held: UpdateHolding.Part }, wifi(700)), G1)?.offer.action,
    ).toBe(UpdateAction.KeepAndWait);
    const resumed = runner.op({ op: "rollout.resume", body: { rollout: 1 } });
    expect(offerTo(resumed, G1)?.offer.action).toBe(UpdateAction.ForcedFetch);
    const cancelled = runner.op({ op: "rollout.cancel", body: { rollout: 1 } });
    expect(offerTo(cancelled, G1)?.offer.action).toBe(UpdateAction.Nothing);
  });

  test("a new rollout starts with no gateway forced", () => {
    const { runner } = forcedGateway();
    runner.op({ op: "rollout.cancel", body: { rollout: 1 } });
    const offered = runner.op({ op: "rollout.start", body: { image: 1, devices: [G1] } });
    expect(offerTo(offered, G1)?.offer.action).toBe(UpdateAction.Fetch);
  });
});

describe("progress and the deviceUpdate bound", () => {
  test("progress is routine and sent to app at most every 2 s, the latest at the bound", () => {
    const { runner, image } = fetching();
    const progress = (bytes: number) =>
      runner.send({ kind: "transferProgress", link: linkId(501), image: image.imageId, bytes });
    // The transition to fetching is sent at once.
    expect(updateEvents(progress(65_536), S1)).toMatchObject([
      { state: "fetching", bytes: 65_536 },
    ]);
    runner.advance(SECOND_US);
    // Progress within the bound is not.
    expect(updateEvents(progress(131_072), S1)).toEqual([]);
    const every = DEFAULT_RULES.firmware.progressEventEveryMs * 1000;
    expect(updateEvents(runner.run(every - SECOND_US - 1), S1)).toEqual([]);
    const due = updateEvents(runner.run(1), S1);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ bytes: 131_072, of: fileBytes(image) });
    // After the bound, the next progress is sent at once; a timer with nothing new sends nothing.
    runner.advance(every);
    expect(updateEvents(progress(196_608), S1)).toMatchObject([{ bytes: 196_608 }]);
    expect(updateEvents(runner.run(10 * every), S1)).toEqual([]);
  });

  test("progress on a link no grant covers, or for another image, changes nothing", () => {
    const { runner, image } = fetching();
    runner.send({ kind: "transferProgress", link: linkId(999), image: image.imageId, bytes: 10 });
    runner.send({
      kind: "transferProgress",
      link: linkId(501),
      image: new Uint8Array(8),
      bytes: 10,
    });
    expect(rowOf(runner, S1)?.bytes).toBe(0);
  });
});

describe("a device with nothing to do", () => {
  test("a sensor outside the rollout is answered nothing, with no image", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id, devices: [S1] } });
    const ran = runner.query(S2);
    expect(offerTo(ran, S2)?.offer).toMatchObject({
      action: UpdateAction.Nothing,
      fileBytes: fileBytes(image),
    });
  });

  test("with no rollout at all, a query is answered nothing and no row is written", () => {
    const { runner } = siteRunner();
    const ran = runner.query(S1);
    expect(offerTo(ran, S1)?.offer).toMatchObject({ action: UpdateAction.Nothing, fileBytes: 0 });
    expect(ran.effects).toEqual([]);
  });

  test("a status for another image is not this rollout's", () => {
    const { runner } = fetching();
    runner.status(S1, new Uint8Array(8).fill(9), UpdateStage.Verified);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Offered);
  });

  test("a confirmed device is never offered again", () => {
    const { runner, image } = fetching();
    runner.status(S1, image.imageId, UpdateStage.Verified);
    runner.started(S1, NEW_VERSION, CONFIRMED_IMAGE);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(false);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.Nothing);
  });
});

export { MINUTE_US };

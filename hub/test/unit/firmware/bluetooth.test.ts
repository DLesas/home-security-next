/**
 * `firmware.bluetooth` (docs/m3-updates-design.md section 5, "Over Bluetooth from the phone", D138):
 * every refusal as `refusals-v2.ts` maps it; the nonce from the input's entropy, committed before
 * the shell replies; one session per device, asked again given again; the expiry at its edge; the offer a sensor gets at its
 * next reply and a siren at once; the session's end by the device's word.
 */
import { describe, expect, test } from "bun:test";
import { UpdateAction, UpdateReason, UpdateStage } from "@hsn/protocol";
import { FIRMWARE_BLUETOOTH_REFUSALS } from "@hsn/protocol/app";
import { requestId, rolloutId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  DeviceState,
  DeviceUpdateState,
  MoveStage,
  RolloutStage,
  UpdateHeld,
  UpdateMethod,
} from "../../../src/core/model/rows.ts";
import { sessionGranted } from "../../../src/core/firmware/codes.ts";
import { offerWaiting } from "../../../src/core/firmware/view.ts";
import {
  bootedView,
  decisions,
  effectsOf,
  entropyFor,
  fileBytes,
  imageRow,
  NEW_VERSION,
  ON_TRIAL,
  offerTo,
  okBody,
  R1,
  refusal,
  rowOf,
  Runner,
  S1,
  S2,
  siteRunner,
  siteSnapshot,
  updateRows,
  WALL0,
  wifi,
} from "./support.ts";

function inRollout(devices = [S1, S2, R1]) {
  const made = siteRunner();
  const pilots = [S1, R1].filter((d) => devices.includes(d));
  made.runner.op({ op: "rollout.start", body: { image: 1, devices, pilots } });
  return made;
}

const ask = (runner: Runner, device: number) =>
  runner.op({ op: "firmware.bluetooth", body: { device } });

describe("refusals", () => {
  test("notPaired: unknown, or not paired with this hub", () => {
    const snapshot = siteSnapshot({ firmwareImages: [imageRow()] });
    const unpaired = {
      ...snapshot,
      devices: snapshot.devices.map((d) =>
        d.id === S2 ? { ...d, state: DeviceState.ResetByOwner } : d,
      ),
    };
    const runner = new Runner(bootedView(unpaired));
    runner.boot(unpaired);
    expect(refusal(ask(runner, 99).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.notPaired);
    expect(refusal(ask(runner, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.notPaired);
  });

  test("noImage: no rollout, or none naming the device, or one already verified for it", () => {
    const { runner, image } = siteRunner();
    expect(refusal(ask(runner, S1).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.noImage);
    runner.op({ op: "rollout.start", body: { image: 1, devices: [S1] } });
    expect(refusal(ask(runner, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.noImage);
    runner.query(S1);
    runner.arm(S1);
    runner.status(S1, image.imageId, UpdateStage.Verified);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Verified);
    expect(refusal(ask(runner, S1).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.noImage);
  });

  test("onTrial: its running image is on trial", () => {
    const { runner } = inRollout();
    runner.started(S1, 0x010000, ON_TRIAL);
    expect(refusal(ask(runner, S1).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.onTrial);
  });

  test("a live session is no refusal: asked again, the same session; a new one once it has expired", () => {
    const { runner } = inRollout();
    const first = effectsOf(ask(runner, S2), "bluetoothSession")[0];
    const again = ask(runner, S2);
    expect(okBody(again.answer)).toMatchObject({ session: "granted", device: S2 });
    expect(effectsOf(again, "bluetoothSession")[0]?.nonce).toEqual(first?.nonce);
    runner.run(DEFAULT_RULES.firmware.bluetoothSessionMs * 1000);
    const after = effectsOf(ask(runner, S2), "bluetoothSession")[0];
    expect(after?.nonce).toHaveLength(8);
    expect(after?.nonce).not.toEqual(first?.nonce);
  });

  test("the holds: armed, battery, countdown, alarm, site move, key change", () => {
    const armed = inRollout().runner;
    armed.arm(S2);
    expect(refusal(ask(armed, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.armed);

    const low = inRollout().runner;
    low.battery(S2, 3_300);
    expect(refusal(ask(low, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.battery);

    const counting = inRollout().runner;
    counting.countdown(S1);
    expect(refusal(ask(counting, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.countdown);

    const alarm = inRollout().runner;
    alarm.alarm(true);
    expect(refusal(ask(alarm, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.alarm);

    const moving = inRollout().runner;
    moving.siteMove(MoveStage.Switched);
    expect(refusal(ask(moving, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.siteMove);

    const { runner: rekey } = siteRunner(DEFAULT_RULES, { rekey: [S2] });
    rekey.op({ op: "rollout.start", body: { image: 1, devices: [S2] } });
    expect(refusal(ask(rekey, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.keyChange);
  });

  test("a refused request writes nothing and draws no entropy", () => {
    const { runner } = inRollout();
    runner.arm(S2);
    const ran = ask(runner, S2);
    expect(ran.effects).toEqual([]);
  });
});

describe("a session", () => {
  test("the nonce is the input's first 8 bytes of entropy, committed now, and the shell replies with the rest", () => {
    const { runner, image } = inRollout();
    const ran = ask(runner, S2);
    const nonce = entropyFor(runner.stepCount).slice(0, 8);
    // Answered as a change with the marker, which holds neither the key nor the nonce.
    expect(okBody(ran.answer)).toEqual(
      sessionGranted(S2, runner.now.wall + DEFAULT_RULES.firmware.bluetoothSessionMs),
    );
    const session = effectsOf(ran, "bluetoothSession")[0];
    expect(session).toMatchObject({
      to: { kind: "control", request: requestId(1 + 1) },
      device: S2,
      address: 0x0100_0000 + S2,
      nonce,
      reply: {
        device: S2,
        address: 0x0100_0000 + S2,
        imageId: "4141414141414141",
        version: "1.1.0",
        fileBytes: fileBytes(image),
        sha256: "41".repeat(32),
        windowS: DEFAULT_RULES.firmware.bluetoothWindowTens * 10,
        expiresInMs: DEFAULT_RULES.firmware.bluetoothSessionMs,
        needsWake: true,
      },
    });
    const row = updateRows(ran).find((r) => r.row.deviceId === S2);
    expect(row?.durability).toBe("now");
    expect(row?.row.bleNonce).toEqual(nonce);
    expect(row?.row.bleExpiresMs).toBe(runner.now.wall + DEFAULT_RULES.firmware.bluetoothSessionMs);
    expect(decisions(ran).find((d) => d.kind === "firmware_session_opened")?.device).toBe(S2);
    // The write comes before the effect the shell replies by.
    const kinds = ran.effects.map((e) => e.kind);
    expect(kinds.indexOf("write")).toBeLessThan(kinds.indexOf("bluetoothSession"));
  });

  test("the sensor's next reply says an update waits; its query is answered 'open Bluetooth' with the nonce and window", () => {
    const { runner } = inRollout();
    const ran = ask(runner, S2);
    const nonce = effectsOf(ran, "bluetoothSession")[0]?.nonce;
    expect(offerWaiting(runner.view, runner.rules, runner.now, S2)).toBe(true);
    const query = runner.query(S2);
    expect(offerTo(query, S2)?.offer).toMatchObject({
      action: UpdateAction.OpenBluetooth,
      bluetoothNonce: nonce,
      bluetoothWindowUnits: DEFAULT_RULES.firmware.bluetoothWindowTens,
    });
    expect(rowOf(runner, S2)?.method).toBe(UpdateMethod.Bluetooth);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S2)).toBe(false);
  });

  test("a siren is told at once on its link; it needs no wake", () => {
    const { runner } = inRollout([R1]);
    runner.heartbeat(R1, wifi(600));
    const ran = ask(runner, R1);
    expect(effectsOf(ran, "bluetoothSession")[0]?.reply.needsWake).toBe(false);
    expect(offerTo(ran, R1)?.offer.action).toBe(UpdateAction.OpenBluetooth);
  });

  test("the session's life ends at its edge: its nonce goes, now", () => {
    const { runner } = inRollout();
    ask(runner, S2);
    runner.query(S2);
    const life = DEFAULT_RULES.firmware.bluetoothSessionMs * 1000;
    runner.run(life - 1);
    expect(rowOf(runner, S2)?.bleNonce).not.toBeNull();
    const ended = runner.run(1);
    expect(rowOf(runner, S2)?.bleNonce).toBeNull();
    expect(rowOf(runner, S2)?.state).toBe(DeviceUpdateState.Planned);
    expect(updateRows(ended).at(-1)?.durability).toBe("now");
  });

  test("verified over Bluetooth: the session ends there; the go-ahead follows as for any device", () => {
    const { runner, image } = inRollout();
    ask(runner, S1);
    runner.query(S1);
    const verified = runner.status(S1, image.imageId, UpdateStage.Verified);
    expect(rowOf(runner, S1)?.bleNonce).toBeNull();
    expect(offerTo(verified, S1)?.offer.action).toBe(UpdateAction.InstallNow);
    runner.started(S1, NEW_VERSION, ON_TRIAL);
  });

  test("the window ended, or five wrong tags: the session is over, the device back to planned, no pause", () => {
    for (const reason of [UpdateReason.WindowEnded, UpdateReason.SessionRefused]) {
      const { runner, image } = inRollout();
      ask(runner, S2);
      runner.query(S2);
      runner.status(S2, image.imageId, UpdateStage.Refused, reason);
      expect(rowOf(runner, S2)?.bleNonce).toBeNull();
      expect(rowOf(runner, S2)?.state).toBe(DeviceUpdateState.Planned);
      expect(effectsOf(ask(runner, S2), "bluetoothSession")).toHaveLength(1);
    }
  });
});

describe("a session's expiry at its exact moment: live one millisecond before, over at it", () => {
  const life = DEFAULT_RULES.firmware.bluetoothSessionMs;

  test("the offer: open Bluetooth a millisecond before the expiry; not at it", () => {
    const before = inRollout().runner;
    ask(before, S2);
    before.advance((life - 1) * 1000);
    expect(offerTo(before.query(S2), S2)?.offer.action).toBe(UpdateAction.OpenBluetooth);

    const at = inRollout().runner;
    ask(at, S2);
    at.advance(life * 1000);
    // Over: S2 is no pilot, so without its session it waits its turn.
    expect(offerTo(at.query(S2), S2)?.offer.action).toBe(UpdateAction.KeepAndWait);
  });

  test("asked again: the same session with 1 ms left a millisecond before the expiry; a new one at it", () => {
    const before = inRollout().runner;
    const first = effectsOf(ask(before, S2), "bluetoothSession")[0];
    before.advance((life - 1) * 1000);
    const again = effectsOf(ask(before, S2), "bluetoothSession")[0];
    expect(again?.nonce).toEqual(first?.nonce);
    expect(again?.reply.expiresInMs).toBe(1);

    const at = inRollout().runner;
    const opened = effectsOf(ask(at, S2), "bluetoothSession")[0];
    at.advance(life * 1000);
    const fresh = effectsOf(ask(at, S2), "bluetoothSession")[0];
    expect(fresh?.reply.expiresInMs).toBe(life);
    expect(fresh?.nonce).not.toEqual(opened?.nonce);
  });

  test("after a restart: a session expiring a millisecond later is kept; one expiring now is over", () => {
    const row = (expiresIn: number) => ({
      deviceId: S2,
      rolloutId: rolloutId(1),
      state: DeviceUpdateState.Planned,
      method: UpdateMethod.Bluetooth,
      held: UpdateHeld.No,
      bytes: 0,
      attempts: 0,
      sameVersion: false,
      lastReason: null,
      sinceMs: 0,
      bleNonce: new Uint8Array(8).fill(3),
      bleExpiresMs: WALL0 + expiresIn,
      remindedMs: null,
    });
    const rollout = {
      id: rolloutId(1),
      image: imageRow().id,
      devices: new Uint8Array([S2, 0, 0, 0]),
      pilots: new Uint8Array([S2, 0, 0, 0]),
      stage: RolloutStage.Pilots,
      approvedBy: "dimitri",
      approvedMs: WALL0,
      soakUntilMs: null,
      pausedReason: null,
      pausedDevice: null,
      endedMs: null,
    };
    for (const [expiresIn, live] of [
      [1, true],
      [0, false],
    ] as const) {
      const snapshot = siteSnapshot({
        firmwareImages: [imageRow()],
        rollouts: [rollout],
        deviceUpdates: [row(expiresIn)],
      });
      const runner = new Runner(bootedView(snapshot));
      const booted = runner.boot(snapshot);
      expect(rowOf(runner, S2)?.bleNonce === null).toBe(!live);
      expect(runner.slice.timers.some((t) => t.key.kind === "sessionExpiry")).toBe(live);
      expect(updateRows(booted).some((r) => r.row.deviceId === S2)).toBe(!live);
    }
  });
});

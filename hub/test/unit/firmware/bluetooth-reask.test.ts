/**
 * `firmware.bluetooth` asked again while the device's session lives (docs/m3-updates-design.md
 * section 5, step 1): the same session, its nonce and the time left of its life, and nothing done
 * again: no nonce drawn, no timer, no write, no decision, no offer. Which refusals still apply to
 * it: those that leave the session nothing to serve (not paired, no image planned, on trial) and a
 * key change, under which the key derived again may not be the one given; not the holds (armed,
 * battery, countdown, alarm, site move), which a live session goes ahead of (`decide.ts`). And what
 * "no image planned" covers for any ask: an image dropped as damaged, a row from another rollout.
 */
import { describe, expect, test } from "bun:test";
import { UpdateAction } from "@hsn/protocol";
import { FIRMWARE_BLUETOOTH_REFUSALS } from "@hsn/protocol/app";
import { type DeviceId, imageId, rolloutId } from "../../../src/core/model/ids.ts";
import {
  DeviceUpdateState,
  type DeviceUpdateRow,
  MoveStage,
  RolloutStage,
  UpdateHeld,
  UpdateMethod,
} from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { sessionGranted } from "../../../src/core/firmware/codes.ts";
import {
  bootedView,
  decisions,
  effectsOf,
  imageRow,
  offerTo,
  okBody,
  ON_TRIAL,
  OLD_VERSION,
  R1,
  refusal,
  rowOf,
  Runner,
  S1,
  S2,
  siteRunner,
  siteSnapshot,
  WALL0,
  wifi,
} from "./support.ts";

const LIFE_MS = DEFAULT_RULES.firmware.bluetoothSessionMs;

function inRollout(devices = [S1, S2, R1]) {
  const made = siteRunner();
  const pilots = [S1, R1].filter((d) => devices.includes(d));
  made.runner.op({ op: "rollout.start", body: { image: 1, devices, pilots } });
  return made;
}

const ask = (runner: Runner, device: number, to: "control" | "app" = "control") =>
  runner.op({ op: "firmware.bluetooth", body: { device } }, undefined, to);

/** A session granted for S2, then a minute on. */
function liveFor(device: DeviceId = S2) {
  const made = inRollout();
  const first = ask(made.runner, device);
  const session = effectsOf(first, "bluetoothSession")[0];
  made.runner.advance(60_000_000);
  return { ...made, session, timers: made.runner.slice.timers };
}

describe("asked again while the session lives", () => {
  test("the same nonce and the time left; nothing drawn, armed, written, recorded or offered", () => {
    const { runner, session, timers } = liveFor();
    const again = ask(runner, S2);
    const given = effectsOf(again, "bluetoothSession");
    expect(given).toHaveLength(1);
    expect(given[0]?.nonce).toEqual(session?.nonce);
    expect(given[0]?.reply.expiresInMs).toBe(LIFE_MS - 60_000);
    expect({ ...given[0]?.reply, expiresInMs: 0 }).toEqual({ ...session?.reply, expiresInMs: 0 });
    // The session's reply and its marker are all: no write, decision, event or offer; the timer
    // as it was.
    expect(again.out.map((o) => o.kind)).toEqual(["bluetoothSession", "opAnswer"]);
    expect(runner.slice.timers).toEqual(timers);
    expect(decisions(again).filter((d) => d.kind === "firmware_session_opened")).toEqual([]);
  });

  test("from an app: answered with the marker, which holds the device and the expiry, not the nonce", () => {
    const { runner, session } = liveFor();
    const again = ask(runner, S2, "app");
    const expires = rowOf(runner, S2)?.bleExpiresMs ?? 0;
    expect(okBody(again.answer)).toEqual(sessionGranted(S2, expires));
    expect(expires).toBe(WALL0 + LIFE_MS);
    expect(JSON.stringify(again.answer)).not.toContain(
      Buffer.from(session?.nonce ?? []).toString("hex"),
    );
    // A new session from an app is answered with the same marker, for its own expiry.
    const fresh = inRollout().runner;
    const granted = ask(fresh, S2, "app");
    expect(okBody(granted.answer)).toEqual(sessionGranted(S2, fresh.now.wall + LIFE_MS));
  });

  test("a siren told at its grant is not offered again", () => {
    const { runner } = inRollout([R1]);
    runner.heartbeat(R1, wifi(600));
    const first = ask(runner, R1);
    expect(offerTo(first, R1)?.offer.action).toBe(UpdateAction.OpenBluetooth);
    const again = ask(runner, R1);
    expect(effectsOf(again, "bluetoothSession")[0]?.nonce).toEqual(
      effectsOf(first, "bluetoothSession")[0]?.nonce,
    );
    expect(offerTo(again, R1)).toBeUndefined();
  });

  test("the holds do not refuse it: armed, battery, countdown, alarm, site move", () => {
    const holds: readonly ((runner: Runner) => void)[] = [
      (r) => {
        r.arm(S2);
      },
      (r) => {
        r.battery(S2, 3_300);
      },
      (r) => {
        r.countdown(S1);
      },
      (r) => {
        r.alarm(true);
      },
      (r) => {
        r.siteMove(MoveStage.Switched);
      },
    ];
    for (const hold of holds) {
      const { runner, session } = liveFor();
      hold(runner);
      // A new session would be refused (bluetooth.test.ts, "the holds"); the live one is given.
      const again = ask(runner, S2);
      expect(okBody(again.answer)).toMatchObject({ session: "granted", device: S2 });
      expect(effectsOf(again, "bluetoothSession")[0]?.nonce).toEqual(session?.nonce);
    }
  });

  test("an image dropped as damaged meanwhile: noImage", () => {
    const { runner } = liveFor();
    runner.send({ kind: "firmwareStoreDamaged", image: imageId(1), problem: "wrongHash" });
    expect(refusal(ask(runner, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.noImage);
  });

  test("its running image found on trial meanwhile: onTrial", () => {
    const { runner } = liveFor();
    runner.started(S2, OLD_VERSION, ON_TRIAL);
    expect(refusal(ask(runner, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.onTrial);
  });

  test("a key change under way: keyChange, as the key derived again may not be the one given", () => {
    const row: DeviceUpdateRow = {
      deviceId: S2,
      rolloutId: rolloutId(1),
      state: DeviceUpdateState.Offered,
      method: UpdateMethod.Bluetooth,
      held: UpdateHeld.No,
      bytes: 0,
      attempts: 0,
      sameVersion: false,
      lastReason: null,
      sinceMs: WALL0,
      bleNonce: new Uint8Array(8).fill(3),
      bleExpiresMs: WALL0 + LIFE_MS,
      remindedMs: null,
    };
    const snapshot = siteSnapshot({
      firmwareImages: [imageRow()],
      rollouts: [openRollout(1, [S2])],
      deviceUpdates: [row],
      rekey: [S2],
    });
    const runner = new Runner(bootedView(snapshot));
    runner.boot(snapshot);
    expect(rowOf(runner, S2)?.bleNonce).not.toBeNull();
    expect(refusal(ask(runner, S2).answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.keyChange);
  });
});

/** An open rollout of image 1 for `devices`, with `id`. */
function openRollout(id: number, devices: readonly DeviceId[]) {
  return {
    id: rolloutId(id),
    image: imageRow().id,
    devices: new Uint8Array(devices.flatMap((d) => [d, 0, 0, 0])),
    pilots: new Uint8Array(devices.slice(0, 1).flatMap((d) => [d, 0, 0, 0])),
    stage: RolloutStage.Pilots,
    approvedBy: "dimitri",
    approvedMs: WALL0,
    soakUntilMs: null,
    pausedReason: null,
    pausedDevice: null,
    endedMs: null,
  };
}

describe("no image planned, for any ask", () => {
  test("an image dropped as damaged is no image: no session is granted for it", () => {
    const { runner } = inRollout();
    runner.send({ kind: "firmwareStoreDamaged", image: imageId(1), problem: "missing" });
    const asked = ask(runner, S2);
    expect(refusal(asked.answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.noImage);
    expect(effectsOf(asked, "bluetoothSession")).toEqual([]);
    expect(rowOf(runner, S2)?.bleNonce).toBeNull();
  });

  test("a device's update left from an earlier rollout is no image planned in the open one", () => {
    // S2's row names rollout 1, which ended; rollout 2, open, does not name S2.
    const stale: DeviceUpdateRow = {
      deviceId: S2,
      rolloutId: rolloutId(1),
      state: DeviceUpdateState.Planned,
      method: UpdateMethod.JoinWifi,
      held: UpdateHeld.No,
      bytes: 0,
      attempts: 0,
      sameVersion: false,
      lastReason: null,
      sinceMs: WALL0,
      bleNonce: null,
      bleExpiresMs: null,
      remindedMs: null,
    };
    const ended = { ...openRollout(1, [S2]), stage: RolloutStage.Done, endedMs: WALL0 - 1 };
    const snapshot = siteSnapshot({
      firmwareImages: [imageRow()],
      rollouts: [ended, openRollout(2, [S1])],
      deviceUpdates: [stale],
    });
    const runner = new Runner(bootedView(snapshot));
    runner.boot(snapshot);
    runner.hearAll();
    const asked = ask(runner, S2);
    expect(refusal(asked.answer)).toEqual(FIRMWARE_BLUETOOTH_REFUSALS.noImage);
    expect(effectsOf(asked, "bluetoothSession")).toEqual([]);
  });
});

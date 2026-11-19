/**
 * A Bluetooth session across a restart (docs/m3-updates-design.md section 4, "After a hub
 * restart", and section 5, step 1): a session whose life ended while the hub was off is over
 * exactly as when its expiry timer runs live (`devices.ts`, `sessionEnded`, the one rule for both):
 * an update offered or fetching over Bluetooth goes back to planned, one fetching over Wi-Fi or its
 * own link goes on. A session still live at the restart keeps its nonce, and its expiry is armed for
 * exactly the time left, bounded by the session's life. Found by review: before, a restart only
 * cleared the nonce, and a device left offered over Bluetooth skipped its holds and its turn.
 */
import { describe, expect, test } from "bun:test";
import { UpdateAction } from "@hsn/protocol";
import { type DeviceId, rolloutId } from "../../../src/core/model/ids.ts";
import {
  DeviceUpdateState,
  type DeviceUpdateRow,
  RolloutStage,
  UpdateHeld,
  UpdateMethod,
} from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { monoAfterMs } from "../../../src/core/model/time.ts";
import { offerWaiting } from "../../../src/core/firmware/view.ts";
import {
  bootedView,
  imageRow,
  offerTo,
  R1,
  rowOf,
  Runner,
  S1,
  S2,
  siteRunner,
  siteSnapshot,
  updateRows,
  WALL0,
} from "./support.ts";

const LIFE_MS = DEFAULT_RULES.firmware.bluetoothSessionMs;
const NONCE = new Uint8Array(8).fill(3);

/** The open rollout: S1 its pilot, S2 and the siren R1 waiting their turn. */
const ROLLOUT = {
  id: rolloutId(1),
  image: imageRow().id,
  devices: new Uint8Array([S1, 0, 0, 0, S2, 0, 0, 0, R1, 0, 0, 0]),
  pilots: new Uint8Array([S1, 0, 0, 0]),
  stage: RolloutStage.Pilots,
  approvedBy: "dimitri",
  approvedMs: WALL0,
  soakUntilMs: null,
  pausedReason: null,
  pausedDevice: null,
  endedMs: null,
};

/** A device's update row with a session ending `expiresIn` ms after the boot's wall time. */
function sessionRow(
  device: DeviceId,
  state: DeviceUpdateState,
  method: UpdateMethod,
  expiresIn: number,
): DeviceUpdateRow {
  return {
    deviceId: device,
    rolloutId: rolloutId(1),
    state,
    method,
    held: UpdateHeld.No,
    bytes: state === DeviceUpdateState.Fetching ? 4096 : 0,
    attempts: 0,
    sameVersion: false,
    lastReason: null,
    sinceMs: WALL0 - 60_000,
    bleNonce: NONCE,
    bleExpiresMs: WALL0 + expiresIn,
    remindedMs: null,
  };
}

/** A hub started from `row` in the open rollout. */
function booted(row: DeviceUpdateRow) {
  const snapshot = siteSnapshot({
    firmwareImages: [imageRow()],
    rollouts: [ROLLOUT],
    deviceUpdates: [row],
  });
  const runner = new Runner(bootedView(snapshot));
  const ran = runner.boot(snapshot);
  return { runner, ran };
}

/** What a session's end leaves of the row: what the two paths must agree on. */
function settled(row: DeviceUpdateRow | undefined) {
  return row === undefined
    ? undefined
    : {
        state: row.state,
        method: row.method,
        held: row.held,
        bytes: row.bytes,
        bleNonce: row.bleNonce,
        bleExpiresMs: row.bleExpiresMs,
      };
}

/** Each state the live expiry handles, and the state it leaves. */
const CASES: readonly (readonly [
  string,
  DeviceId,
  DeviceUpdateState,
  UpdateMethod,
  DeviceUpdateState,
])[] = [
  [
    "a sensor offered over Bluetooth goes back to planned",
    S2,
    DeviceUpdateState.Offered,
    UpdateMethod.Bluetooth,
    DeviceUpdateState.Planned,
  ],
  [
    "a sensor fetching over Bluetooth goes back to planned",
    S2,
    DeviceUpdateState.Fetching,
    UpdateMethod.Bluetooth,
    DeviceUpdateState.Planned,
  ],
  [
    "a sensor planned for Bluetooth stays planned",
    S2,
    DeviceUpdateState.Planned,
    UpdateMethod.Bluetooth,
    DeviceUpdateState.Planned,
  ],
  [
    "a sensor fetching over Wi-Fi goes on fetching",
    S2,
    DeviceUpdateState.Fetching,
    UpdateMethod.JoinWifi,
    DeviceUpdateState.Fetching,
  ],
  [
    "a sensor offered Wi-Fi stays offered",
    S2,
    DeviceUpdateState.Offered,
    UpdateMethod.JoinWifi,
    DeviceUpdateState.Offered,
  ],
  [
    "a siren fetching on its own link goes on fetching",
    R1,
    DeviceUpdateState.Fetching,
    UpdateMethod.OwnLink,
    DeviceUpdateState.Fetching,
  ],
  [
    "a siren offered over Bluetooth goes back to planned",
    R1,
    DeviceUpdateState.Offered,
    UpdateMethod.Bluetooth,
    DeviceUpdateState.Planned,
  ],
];

describe("a session whose life ended while the hub was off is over as the live expiry has it", () => {
  for (const [name, device, state, method, after] of CASES) {
    test(name, () => {
      // Off: its life ended at the boot's own wall time.
      const off = booted(sessionRow(device, state, method, 0));
      if (device !== R1) {
        // Live: one millisecond left at the boot, then its timer runs. (A siren is told of a live
        // session at once on the boot's look at every device, so its row has moved by its expiry
        // for another reason: the siren's cases check the restart's outcome alone.)
        const live = booted(sessionRow(device, state, method, 1));
        expect(rowOf(live.runner, device)?.bleNonce).toEqual(NONCE);
        live.runner.run(1000);
        expect(settled(rowOf(off.runner, device))).toEqual(settled(rowOf(live.runner, device)));
      }
      expect(rowOf(off.runner, device)?.state).toBe(after);
      expect(rowOf(off.runner, device)?.method).toBe(method);
      expect(rowOf(off.runner, device)?.bleNonce).toBeNull();
      expect(rowOf(off.runner, device)?.bleExpiresMs).toBeNull();
      // The end is written now, at the boot, and no expiry is left armed.
      const written = updateRows(off.ran).filter((r) => r.row.deviceId === device);
      expect(written.at(-1)?.durability).toBe("now");
      expect(written.at(-1)?.row.bleNonce).toBeNull();
      expect(off.runner.slice.timers.some((t) => t.key.kind === "sessionExpiry")).toBe(false);
    });
  }

  test("a sensor left offered over Bluetooth waits its turn again, not its old session's offer", () => {
    // S2 was offered "open Bluetooth" and nobody connected. Back to planned, and no pilot, it
    // waits its turn (bluetooth.test.ts, "the offer: ... not at it"); left offered, it would count
    // as started and skip its holds, the pause and its turn (decide.ts).
    const { runner } = booted(
      sessionRow(S2, DeviceUpdateState.Offered, UpdateMethod.Bluetooth, -60_000),
    );
    expect(rowOf(runner, S2)?.state).toBe(DeviceUpdateState.Planned);
    expect(offerTo(runner.query(S2), S2)?.offer.action).toBe(UpdateAction.KeepAndWait);
  });

  test("armed while off: back to planned, it is held armed, not offered", () => {
    const { runner } = booted(sessionRow(S2, DeviceUpdateState.Offered, UpdateMethod.Bluetooth, 0));
    runner.arm(S2);
    const query = runner.query(S2);
    expect(offerTo(query, S2)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(rowOf(runner, S2)?.state).toBe(DeviceUpdateState.Planned);
  });
});

describe("a session still live at the restart", () => {
  for (const [name, left, armed] of [
    ["1 ms left: its expiry is armed 1 ms on", 1, 1],
    ["its whole life left: armed its whole life on", LIFE_MS, LIFE_MS],
    [
      "more than its life left (the wall clock went back): armed its life on, no more",
      LIFE_MS + 60_000,
      LIFE_MS,
    ],
  ] as const) {
    test(name, () => {
      const { runner, ran } = booted(
        sessionRow(S2, DeviceUpdateState.Offered, UpdateMethod.Bluetooth, left),
      );
      expect(rowOf(runner, S2)?.bleNonce).toEqual(NONCE);
      expect(updateRows(ran).some((r) => r.row.deviceId === S2)).toBe(false);
      const timers = runner.slice.timers.filter((t) => t.key.kind === "sessionExpiry");
      expect(timers).toHaveLength(1);
      expect(timers[0]?.at).toBe(monoAfterMs(runner.now.mono, armed));
      // It ends exactly then: live the microsecond before, over at it.
      runner.run(armed * 1000 - 1);
      expect(rowOf(runner, S2)?.bleNonce).toEqual(NONCE);
      runner.run(1);
      expect(rowOf(runner, S2)?.bleNonce).toBeNull();
      expect(rowOf(runner, S2)?.state).toBe(DeviceUpdateState.Planned);
    });
  }
});

describe("after a session's end the device is told the new plan, not the old session", () => {
  test("live: a pilot told to open Bluetooth is flagged and answered 'join Wi-Fi' at its next contact", () => {
    const { runner } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: 1, devices: [S1, S2], pilots: [S1] } });
    runner.op({ op: "firmware.bluetooth", body: { device: S1 } });
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.OpenBluetooth);
    runner.run(LIFE_MS * 1000);
    runner.hear(S1);
    // Its next reply says an update waits: the hub does not take "open Bluetooth" as told.
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.JoinWifiAndFetch);
  });

  test("after a restart: the same", () => {
    const { runner } = booted(sessionRow(S1, DeviceUpdateState.Offered, UpdateMethod.Bluetooth, 0));
    runner.hear(S1);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.JoinWifiAndFetch);
  });
});

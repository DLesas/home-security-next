/**
 * A restart of the hub at every point of a whole rollout (docs/m3-updates-design.md section 4,
 * "After a hub restart"; section 6, "The hub loses power at any stage"): the rollout is rebuilt
 * from the rows committed so far, as a power cut leaves them (every "now" write, and the routine
 * ones staged before the last of them), and carries on to done. Nothing committed is lost, every
 * timer a state needs is set again, and no device is given a transition twice: never offered
 * again once confirmed, never a second go-ahead recorded.
 */
import { describe, expect, test } from "bun:test";
import { UpdateAction, UpdateHolding, UpdateStage } from "@hsn/protocol";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { M3M4Snapshot } from "../../../src/core/model/events.ts";
import { deviceId, linkId, rolloutId } from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { mono } from "../../../src/core/model/time.ts";
import {
  ArmState,
  type DeviceUpdateRow,
  DeviceUpdateState,
  type FirmwareImageRow,
  type RolloutRow,
  RolloutStage,
} from "../../../src/core/model/rows.ts";
import { EMPTY_FIRMWARE_SLICE } from "../../../src/core/firmware/state.ts";
import {
  CONFIRMED_IMAGE,
  decisions,
  fileBytes,
  G1,
  G2,
  GATEWAYS,
  HOUR_US,
  imageRow,
  linkAll,
  LORA,
  NEW_VERSION,
  OLD_VERSION,
  ON_TRIAL,
  offerTo,
  openRow,
  rowOf,
  R1,
  R2,
  Runner,
  S1,
  SENSORS,
  SIRENS,
  siteSnapshot,
  bootedView,
  wifi,
} from "./support.ts";

const image = imageRow();

type Step = (runner: Runner) => void;

function sensorSteps(
  sensor: (typeof SENSORS)[number],
  link: number,
  trial: boolean,
): readonly Step[] {
  return [
    (r) => r.query(sensor),
    (r) => r.query(sensor, {}, wifi(link)),
    (r) =>
      r.send({ kind: "transferProgress", link: linkId(link), image: image.imageId, bytes: 65_536 }),
    (r) => r.status(sensor, image.imageId, UpdateStage.Verified),
    ...(trial
      ? [
          (r: Runner) => r.started(sensor, NEW_VERSION, ON_TRIAL),
          (r: Runner) => r.status(sensor, image.imageId, UpdateStage.Confirmed),
        ]
      : [(r: Runner) => r.started(sensor, NEW_VERSION, CONFIRMED_IMAGE)]),
  ];
}

function linkedSteps(device: typeof R1, link: number): readonly Step[] {
  return [
    (r) => r.heartbeat(device, wifi(link)),
    (r) => r.status(device, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(link)),
    (r) => r.started(device, NEW_VERSION, CONFIRMED_IMAGE, {}, wifi(link)),
  ];
}

/** The whole rollout over the site, as the devices and the people would drive it. */
const SCRIPT: readonly Step[] = [
  (r) => r.op({ op: "rollout.start", body: { image: image.id } }),
  (r) => {
    linkAll(r);
  },
  ...sensorSteps(S1, 501, true),
  ...linkedSteps(R1, 600),
  ...linkedSteps(G1, 700),
  (r) => r.run(HOUR_US / 2),
  (r) => r.run(HOUR_US / 2),
  ...linkedSteps(R2, 601),
  ...SENSORS.slice(1).flatMap((s, i) => sensorSteps(s, 510 + i, i % 2 === 0)),
  (r) => {
    r.gatewaySession(G2, linkId(701));
    r.send({ kind: "gatewayUp", gateway: G2, link: linkId(701) });
  },
  ...linkedSteps(G2, 701),
];

interface Committed {
  readonly images: Map<number, FirmwareImageRow>;
  readonly rollouts: Map<number, RolloutRow>;
  readonly updates: Map<number, DeviceUpdateRow>;
}

/** What a power cut now leaves on disk: every write up to the last "now" one. */
function committed(all: readonly (Internal | Effect)[], initial = image): Committed {
  const writes = all.filter((e): e is Extract<Effect, { kind: "write" }> => e.kind === "write");
  const last = writes.map((w) => w.durability).lastIndexOf("now");
  const rows: Committed = {
    images: new Map([[initial.id, initial]]),
    rollouts: new Map(),
    updates: new Map(),
  };
  for (const write of writes.slice(0, last + 1)) {
    const op = write.op;
    if (op.op !== "upsert") continue;
    if (op.table === "firmware_images") rows.images.set(op.row.id, op.row);
    if (op.table === "rollouts") rows.rollouts.set(op.row.id, op.row);
    if (op.table === "device_updates") rows.updates.set(op.row.deviceId, op.row);
  }
  return rows;
}

function snapshotOf(rows: Committed): Partial<M3M4Snapshot> {
  return {
    firmwareImages: [...rows.images.values()],
    rollouts: [...rows.rollouts.values()],
    deviceUpdates: [...rows.updates.values()],
  };
}

/** The decisions of transitions, by device and kind, over a run. */
function transitions(all: readonly (Internal | Effect)[]): readonly string[] {
  const once = new Set([
    "firmware_device_offered",
    "firmware_verified",
    "firmware_installing",
    "firmware_on_trial",
    "firmware_confirmed",
  ]);
  return all.flatMap((m) =>
    m.kind === "auditRecord" && m.record.kind === "decision" && once.has(m.record.row.kind)
      ? [`${m.record.row.kind}:${m.record.row.deviceId}`]
      : [],
  );
}

function fresh(): Runner {
  const snapshot = siteSnapshot({ firmwareImages: [image] });
  const runner = new Runner(bootedView(snapshot));
  runner.boot(snapshot);
  runner.hearAll();
  return runner;
}

describe("a restart at every point of a rollout", () => {
  test.each(["query", "status"])(
    "a restored go-ahead waits for a fresh verified LoRa %s",
    (kind) => {
      const before = fresh();
      before.op({ op: "rollout.start", body: { image: image.id, pilots: [S1] } });
      before.query(S1);
      const verified = before.status(S1, image.imageId, UpdateStage.Verified);
      expect(offerTo(verified, S1)?.offer.action).toBe(UpdateAction.InstallNow);
      const after = new Runner({ ...before.view, firmware: EMPTY_FIRMWARE_SLICE });
      after.now = before.now;
      after.boot(siteSnapshot(snapshotOf(committed(before.all))));
      /** The sensor still holds the file and asks again over LoRa. */
      const report = (bytes: number) => {
        const arrival = { ...LORA, endedAt: after.now.mono };
        return kind === "query"
          ? after.query(S1, { image: image.imageId, held: UpdateHolding.Verified, bytes }, arrival)
          : after.status(S1, image.imageId, UpdateStage.Verified, 0, bytes, arrival);
      };
      const listenUs = Math.max(...after.rules.replies.eventListenMs) * 1000;
      after.run(listenUs);
      expect(offerTo(report(fileBytes(image)), S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
      after.run(1);
      expect(offerTo(report(fileBytes(image) - 1), S1)?.offer.action).toBe(
        UpdateAction.KeepAndWait,
      );
      expect(after.slice.updates.get(S1)?.row.state).toBe(DeviceUpdateState.Installing);
      expect(offerTo(report(fileBytes(image)), S1)?.offer.action).toBe(UpdateAction.InstallNow);
      expect(after.slice.updates.get(S1)?.row.state).toBe(DeviceUpdateState.Installing);
      expect(offerTo(report(fileBytes(image)), S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    },
  );

  test.each([-1, 0, 1])("a soak booted %i ms from expiry settles only if due", (offset) => {
    const before = fresh();
    for (const step of SCRIPT) {
      step(before);
      if (openRow(before)?.stage === RolloutStage.Soak) break;
    }
    expect(openRow(before)?.stage).toBe(RolloutStage.Soak);
    const after = new Runner({ ...before.view, firmware: EMPTY_FIRMWARE_SLICE });
    after.now = before.now;
    after.advance(HOUR_US + offset * 1000);
    after.boot(siteSnapshot(snapshotOf(committed(before.all))));
    expect(openRow(after)?.stage).toBe(offset < 0 ? RolloutStage.Soak : RolloutStage.Rest);
    const soak = after.slice.timers.find(({ key }) => key.kind === "soakEnd");
    expect(soak?.at).toBe(offset < 0 ? mono(after.now.mono + 1000) : undefined);
    expect(after.slice.timers.every(({ at }) => at > after.now.mono)).toBe(true);
  });

  test("an armed reminder due at restart is recorded in the boot step and rearmed for tomorrow", () => {
    const before = fresh();
    before.arm(S1);
    before.op({ op: "rollout.start", body: { image: image.id, pilots: [S1] } });
    before.send({ kind: "armedChanged", sensor: S1, arm: ArmState.Armed, cause: undefined });
    before.run(before.rules.firmware.armedReminderAfterMs * 1000);
    const after = new Runner({ ...before.view, firmware: EMPTY_FIRMWARE_SLICE });
    after.now = before.now;
    const daily = after.rules.firmware.armedReminderEveryMs * 1000;
    after.advance(daily);
    const restored = after.boot(siteSnapshot(snapshotOf(committed(before.all))));
    expect(decisions(restored).filter(({ kind }) => kind === "firmware_reminder")).toHaveLength(1);
    expect(after.slice.timers.find(({ key }) => key.kind === "armedReminder")?.at).toBe(
      mono(after.now.mono + daily),
    );
  });

  test("after a hub restart, only matching status confirms a same-version rollout", () => {
    const rebuild = imageRow(1, OLD_VERSION);
    const snapshot = siteSnapshot({ firmwareImages: [rebuild] });
    const before = new Runner(bootedView(snapshot));
    before.boot(snapshot);
    before.hearAll();
    before.op({ op: "rollout.start", body: { image: rebuild.id, devices: [S1] } });
    before.query(S1);
    before.query(S1, {}, wifi(501));
    before.status(S1, rebuild.imageId, UpdateStage.Verified);
    expect(rowOf(before, S1)?.state).toBe(DeviceUpdateState.Installing);
    const stored = committed(before.all, rebuild);
    expect(stored.updates.get(S1)).toMatchObject({ sameVersion: true, attempts: 0 });
    const after = new Runner({ ...before.view, firmware: EMPTY_FIRMWARE_SLICE });
    after.now = before.now;
    after.boot(siteSnapshot(snapshotOf(stored)));
    expect(rowOf(after, S1)).toMatchObject({ sameVersion: true, attempts: 0 });
    after.started(S1, OLD_VERSION, CONFIRMED_IMAGE);
    expect(rowOf(after, S1)?.state).toBe(DeviceUpdateState.Installing);
    after.status(S1, rebuild.imageId, UpdateStage.Confirmed);
    expect(rowOf(after, S1)?.state).toBe(DeviceUpdateState.Confirmed);
  });

  test("without one, the script takes the rollout to done", () => {
    const runner = fresh();
    for (const step of SCRIPT) step(runner);
    expect(openRow(runner)).toBeUndefined();
    expect([...runner.slice.rollouts.values()][0]?.row.stage).toBe(RolloutStage.Done);
    expect(new Set(transitions(runner.all)).size).toBe(transitions(runner.all).length);
  });

  test.each(SCRIPT.map((_, k) => [k]))(
    "restarted after step %i: nothing lost, nothing given twice, done",
    (k) => {
      const before = fresh();
      for (const step of SCRIPT.slice(0, k + 1)) step(before);
      const rows = committed(before.all);

      const after = new Runner({ ...before.view, firmware: EMPTY_FIRMWARE_SLICE });
      after.now = before.now;
      const booted = after.boot(siteSnapshot(snapshotOf(rows)));

      // Nothing committed is lost: the rebuilt rows are the committed ones (but a session over).
      for (const [device, row] of rows.updates) {
        const rebuilt = after.slice.updates.get(deviceId(device))?.row;
        expect(rebuilt?.state).toBe(row.state);
        expect(rebuilt?.rolloutId).toBe(row.rolloutId);
        expect(rebuilt?.attempts).toBe(row.attempts);
      }
      for (const [id, row] of rows.rollouts) {
        expect(after.slice.rollouts.get(rolloutId(id))?.row.stage).toBe(row.stage);
      }
      // Every state that waits on time has its timer again.
      for (const entry of after.slice.updates.values()) {
        const state = entry.row.state;
        if (state === DeviceUpdateState.Installing || state === DeviceUpdateState.OnTrial) {
          expect(
            after.slice.timers.some(
              (t) => t.key.kind === "trialWatch" && t.key.device === entry.row.deviceId,
            ),
          ).toBe(true);
        }
      }
      if (openRow(after)?.stage === RolloutStage.Soak) {
        expect(after.slice.timers.some((t) => t.key.kind === "soakEnd")).toBe(true);
      }
      // No go-ahead or confirmation is made again at the restart itself.
      expect(
        transitions(booted.out).filter((t) => !t.startsWith("firmware_device_offered")),
      ).toEqual([]);

      for (const step of SCRIPT.slice(k + 1)) step(after);
      expect(openRow(after)).toBeUndefined();
      const ended = [...after.slice.rollouts.values()][0]?.row;
      expect(ended?.stage).toBe(RolloutStage.Done);
      for (const device of [...SENSORS, ...SIRENS, ...GATEWAYS]) {
        expect(after.slice.updates.get(device)?.row.state).toBe(DeviceUpdateState.Confirmed);
      }
      // Each transition at most once over both runs, counting only what the first run committed.
      const kept = transitions(before.all).filter((t) => {
        const [kind, device] = t.split(":");
        const row = rows.updates.get(Number(device));
        if (row === undefined) return false;
        const reached: Record<string, DeviceUpdateState> = {
          firmware_device_offered: DeviceUpdateState.Offered,
          firmware_verified: DeviceUpdateState.Verified,
          firmware_installing: DeviceUpdateState.Installing,
          firmware_on_trial: DeviceUpdateState.OnTrial,
          firmware_confirmed: DeviceUpdateState.Confirmed,
        };
        return (
          row.state >= (reached[kind ?? ""] ?? 99) || row.state === DeviceUpdateState.Confirmed
        );
      });
      const both = [...kept, ...transitions(after.all)];
      const installs = both.filter((t) => t.startsWith("firmware_installing"));
      expect(new Set(installs).size).toBe(installs.length);
      const confirms = both.filter((t) => t.startsWith("firmware_confirmed"));
      expect(new Set(confirms).size).toBe(confirms.length);
    },
  );
});

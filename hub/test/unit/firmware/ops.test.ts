/**
 * Every operation's permission and refusals (docs/m3-updates-design.md section 4, "App operations
 * and events"; `ops-v2.ts`, `refusals-v2.ts`), and what pause, resume and cancel do to a rollout.
 */
import { describe, expect, test } from "bun:test";
import { UpdateAction, UpdateReason, UpdateStage } from "@hsn/protocol";
import { OFFER_AND_ROLLOUT_REFUSALS, type AppOpV2 } from "@hsn/protocol/app";
import { linkId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { DeviceUpdateState, RolloutStage } from "../../../src/core/model/rows.ts";
import { offerWaiting } from "../../../src/core/firmware/view.ts";
import {
  ANNA,
  BEN,
  CONFIRMED_IMAGE,
  CONSOLE,
  decisions,
  effectsOf,
  fileBytes,
  G1,
  HOUR_US,
  imageRow,
  linkAll,
  NEW_VERSION,
  offerTo,
  offers,
  okBody,
  openRow,
  R1,
  refusal,
  rolloutRows,
  rowOf,
  S1,
  S2,
  SECOND_US,
  sensorThrough,
  siteRunner,
  wifi,
} from "./support.ts";

const EVERY_OP: readonly AppOpV2[] = [
  { op: "firmware.list", body: {} },
  { op: "firmware.offers", body: {} },
  { op: "firmware.fetch", body: { version: "1.2.0" } },
  { op: "firmware.upload", body: { job: 1 } },
  { op: "firmware.remove", body: { image: 1 } },
  { op: "firmware.download", body: { image: 1 } },
  { op: "firmware.bluetooth", body: { device: 10 } },
  { op: "rollout.start", body: { image: 1 } },
  { op: "rollout.pause", body: { rollout: 1 } },
  { op: "rollout.resume", body: { rollout: 1 } },
  { op: "rollout.cancel", body: { rollout: 1 } },
  { op: "rollout.status", body: {} },
];

describe("permissions", () => {
  test.each(EVERY_OP.map((op) => [op.op, op] as const))(
    "%s: refused unauthorized without manage system, and nothing done",
    (_name, op) => {
      const { runner } = siteRunner();
      const ran = runner.op(op, BEN, "app");
      expect(refusal(ran.answer)).toEqual({
        code: "unauthorized",
        detail: { permission: "manageSystem" },
      });
      expect(ran.effects).toEqual([]);
      expect(ran.messages.filter((m) => m.kind !== "opAnswer")).toEqual([]);
    },
  );

  test.each(EVERY_OP.filter((op) => op.op !== "firmware.upload").map((op) => [op.op, op] as const))(
    "%s: a person with manage system passes the permission check",
    (_name, op) => {
      const { runner } = siteRunner();
      const answer = runner.op(op, ANNA, "app").answer;
      if (answer?.ok === false) expect(answer.error.code).not.toBe("unauthorized");
    },
  );

  test("firmware.upload is console only: the console and hsn may, a person on an app may not", () => {
    const { runner } = siteRunner();
    expect(
      refusal(runner.op({ op: "firmware.upload", body: { job: 1 } }, ANNA, "app").answer),
    ).toEqual({
      code: "consoleOnly",
      detail: {},
    });
    expect(
      effectsOf(runner.op({ op: "firmware.upload", body: { job: 1 } }, CONSOLE, "app"), "fileJob"),
    ).toHaveLength(1);
    expect(
      effectsOf(runner.op({ op: "firmware.upload", body: { job: 1 } }), "fileJob"),
    ).toHaveLength(1);
  });
});

describe("rollout.start's refusals", () => {
  test("an image not in the store, or removed: notFound", () => {
    const removed = imageRow(2, NEW_VERSION, { removedMs: 1 });
    const { runner } = siteRunner(DEFAULT_RULES, { firmwareImages: [imageRow(), removed] });
    expect(refusal(runner.op({ op: "rollout.start", body: { image: 9 } }).answer)).toEqual({
      code: "notFound",
      detail: { what: "image", id: 9 },
    });
    expect(refusal(runner.op({ op: "rollout.start", body: { image: 2 } }).answer)).toEqual({
      code: "notFound",
      detail: { what: "image", id: 2 },
    });
  });

  test("one rollout at a time: busy while one is open; allowed again once it has ended", () => {
    const { runner } = siteRunner();
    okBody(runner.op({ op: "rollout.start", body: { image: 1 } }).answer);
    expect(refusal(runner.op({ op: "rollout.start", body: { image: 1 } }).answer)).toEqual(
      OFFER_AND_ROLLOUT_REFUSALS.rolloutOpen,
    );
    runner.op({ op: "rollout.cancel", body: { rollout: 1 } });
    const again = okBody(runner.op({ op: "rollout.start", body: { image: 1 } }).answer) as {
      id: number;
    };
    expect(again.id).toBe(2);
  });

  test("devices: an unknown one notFound; one of a role the image is not for wrongRole; none at all range", () => {
    const sensorsOnly = imageRow(2, NEW_VERSION, { roles: 0b0010 });
    const { runner } = siteRunner(DEFAULT_RULES, { firmwareImages: [imageRow(), sensorsOnly] });
    expect(
      refusal(runner.op({ op: "rollout.start", body: { image: 1, devices: [99] } }).answer),
    ).toEqual({
      code: "notFound",
      detail: { what: "device", id: 99 },
    });
    expect(
      refusal(runner.op({ op: "rollout.start", body: { image: 2, devices: [S1, R1] } }).answer),
    ).toEqual({
      code: "invalid",
      detail: { field: "devices", reason: "wrongRole", refs: [R1] },
    });
    const noRoles = imageRow(3, NEW_VERSION, { roles: 0 });
    const empty = siteRunner(DEFAULT_RULES, { firmwareImages: [noRoles] }).runner;
    expect(refusal(empty.op({ op: "rollout.start", body: { image: 3 } }).answer)).toEqual({
      code: "invalid",
      detail: { field: "devices", reason: "range" },
    });
  });

  test("pilots: one outside the devices, or two of one role, is refused", () => {
    const { runner } = siteRunner();
    expect(
      refusal(
        runner.op({ op: "rollout.start", body: { image: 1, devices: [S1], pilots: [S2] } }).answer,
      ),
    ).toEqual({
      code: "invalid",
      detail: { field: "pilots", reason: "range", refs: [S2] },
    });
    expect(
      refusal(runner.op({ op: "rollout.start", body: { image: 1, pilots: [S1, S2] } }).answer),
    ).toEqual({
      code: "invalid",
      detail: { field: "pilots", reason: "range" },
    });
    expect(openRow(runner)).toBeUndefined();
  });
});

describe("rollout.pause, resume and cancel", () => {
  test("a rollout that does not exist is notFound; one ended is refused", () => {
    const { runner } = siteRunner();
    for (const op of ["rollout.pause", "rollout.resume", "rollout.cancel"] as const) {
      expect(refusal(runner.op({ op, body: { rollout: 5 } }).answer)).toEqual({
        code: "notFound",
        detail: { what: "rollout", id: 5 },
      });
    }
    runner.op({ op: "rollout.start", body: { image: 1 } });
    runner.op({ op: "rollout.cancel", body: { rollout: 1 } });
    for (const op of ["rollout.pause", "rollout.resume", "rollout.cancel"] as const) {
      expect(refusal(runner.op({ op, body: { rollout: 1 } }).answer)).toEqual({
        code: "invalid",
        detail: { field: "rollout", reason: "range" },
      });
    }
  });

  test("resume: a device not in the rollout, or force for one that is no gateway, is refused", () => {
    const { runner } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: 1, devices: [S1, G1] } });
    expect(
      refusal(runner.op({ op: "rollout.resume", body: { rollout: 1, device: S2 } }).answer),
    ).toEqual({
      code: "invalid",
      detail: { field: "device", reason: "unknownReference" },
    });
    expect(
      refusal(
        runner.op({ op: "rollout.resume", body: { rollout: 1, device: S1, force: true } }).answer,
      ),
    ).toEqual({ code: "invalid", detail: { field: "force", reason: "range" } });
  });

  test("a person's pause: no new offer while paused; a download already going goes on; resume carries on", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: 1, pilots: [S1] } });
    runner.query(S1);
    runner.query(S1, {}, wifi(501));
    const paused = runner.op({ op: "rollout.pause", body: { rollout: 1 } });
    expect(okBody(paused.answer)).toMatchObject({ stage: "paused", paused: null });
    expect(decisions(paused).find((d) => d.kind === "rollout_paused")?.durability).toBe("now");
    // The download goes on...
    const going = runner.status(S1, image.imageId, UpdateStage.Fetching, 0, 10, wifi(501));
    expect(offerTo(going, S1)?.offer.action).toBe(UpdateAction.Fetch);
    // ...but no go-ahead is given while paused.
    const verified = runner.status(S1, image.imageId, UpdateStage.Verified);
    expect(offerTo(verified, S1)?.offer.action).toBe(UpdateAction.KeepAndWait);
    const resumed = runner.op({ op: "rollout.resume", body: { rollout: 1 } });
    expect(okBody(resumed.answer)).toMatchObject({ stage: "pilots", paused: null });
    expect(decisions(resumed).map((d) => d.kind)).toContain("rollout_resumed");
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);
  });

  test("resume after a refusal: the device that caused the pause is offered again", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: 1, pilots: [S1] } });
    runner.query(S1);
    runner.status(S1, image.imageId, UpdateStage.Refused, UpdateReason.BadSignature);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Paused);
    runner.op({ op: "rollout.resume", body: { rollout: 1 } });
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Planned);
    expect(rowOf(runner, S1)?.attempts).toBe(0);
    expect(offerTo(runner.query(S1), S1)?.offer.action).toBe(UpdateAction.JoinWifiAndFetch);
  });

  test("paused in the soak: resumed, the soak runs only what was left of its hour", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: 1 } });
    linkAll(runner);
    sensorThrough(runner, S1, image, 501);
    runner.status(R1, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(600));
    runner.started(R1, NEW_VERSION, CONFIRMED_IMAGE, {}, wifi(600));
    runner.status(G1, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(700));
    runner.started(G1, NEW_VERSION, CONFIRMED_IMAGE, {}, wifi(700));
    expect(openRow(runner)?.stage).toBe(RolloutStage.Soak);
    runner.run(HOUR_US / 4);
    runner.op({ op: "rollout.pause", body: { rollout: 1 } });
    runner.run(HOUR_US / 4);
    runner.op({ op: "rollout.resume", body: { rollout: 1 } });
    expect(openRow(runner)?.stage).toBe(RolloutStage.Soak);
    runner.run(HOUR_US / 2 - SECOND_US);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Soak);
    runner.run(SECOND_US);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Rest);
  });

  test("cancel: what can be stopped is cancelled, grants revoked, a holder told to discard; one installing is left", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: 1, pilots: [S1, R1] } });
    runner.heartbeat(R1, wifi(600));
    // S1 is installing; R1 waits its turn with nothing yet.
    runner.query(S1);
    runner.query(S1, {}, wifi(501));
    runner.status(S1, image.imageId, UpdateStage.Verified);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Installing);
    const cancelled = runner.op({ op: "rollout.cancel", body: { rollout: 1 } });
    expect(okBody(cancelled.answer)).toMatchObject({ stage: "cancelled" });
    expect(rolloutRows(cancelled).at(-1)?.endedMs).toBe(runner.now.wall);
    expect(decisions(cancelled).map((d) => d.kind)).toContain("rollout_cancelled");
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Installing);
    expect(rowOf(runner, R1)?.state).toBe(DeviceUpdateState.Cancelled);
    expect(rowOf(runner, S2)?.state).toBe(DeviceUpdateState.Cancelled);
  });

  test("cancel while fetching: the grant goes, a siren is told to discard at once, a sensor at its next reply", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: 1, devices: [S1, R1] } });
    runner.heartbeat(R1, wifi(600));
    runner.query(S1);
    runner.query(S1, {}, wifi(501));
    sensorConfirmedOnly(runner, image);
    expect(rowOf(runner, R1)?.state).toBe(DeviceUpdateState.Offered);
    const cancelled = runner.op({ op: "rollout.cancel", body: { rollout: 1 } });
    expect(effectsOf(cancelled, "transferRevoke").map((e) => e.link)).toEqual([linkId(600)]);
    expect(offers(cancelled).map((o) => [o.device, o.offer.action])).toEqual([
      [R1, UpdateAction.Nothing],
    ]);
  });
});

function sensorConfirmedOnly(
  runner: ReturnType<typeof siteRunner>["runner"],
  image: ReturnType<typeof siteRunner>["image"],
): void {
  runner.status(S1, image.imageId, UpdateStage.Verified);
  runner.started(S1, NEW_VERSION, CONFIRMED_IMAGE);
}

describe("rollout.status", () => {
  test("with no rollout: none, and no devices", () => {
    const { runner } = siteRunner();
    expect(okBody(runner.op({ op: "rollout.status", body: {} }).answer)).toEqual({
      rollout: null,
      devices: [],
    });
  });

  test("every planned device's state, hold, method, bytes and last reason; the ended rollout after it ends", () => {
    const { runner } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: 1, devices: [S1, S2] } });
    const status = okBody(runner.op({ op: "rollout.status", body: {} }).answer) as {
      rollout: { id: number; stage: string };
      devices: unknown[];
    };
    expect(status.rollout).toMatchObject({ id: 1, stage: "pilots" });
    expect(status.devices).toEqual([
      {
        device: S1,
        state: "planned",
        held: null,
        method: "joinWifi",
        bytes: 0,
        of: fileBytes(imageRow()),
        lastReason: null,
      },
      {
        device: S2,
        state: "planned",
        held: "waitingTurn",
        method: "joinWifi",
        bytes: 0,
        of: fileBytes(imageRow()),
        lastReason: null,
      },
    ]);
    runner.op({ op: "rollout.cancel", body: { rollout: 1 } });
    const after = okBody(runner.op({ op: "rollout.status", body: {} }).answer) as {
      rollout: { stage: string };
    };
    expect(after.rollout.stage).toBe("cancelled");
  });
});

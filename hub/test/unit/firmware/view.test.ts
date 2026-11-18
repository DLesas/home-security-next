/**
 * firmware's view for the other modules (docs/m3-updates-design.md section 4, "Where it sits in
 * the core and the shell"): the device object's `update`, the `deviceUpdate` bodies app sends when
 * their identity changes, and whether any device is installing (upkeep's switch waits).
 */
import { describe, expect, test } from "bun:test";
import { UpdateStage } from "@hsn/protocol";
import { deviceUpdateOf, devicesInstalling } from "../../../src/core/firmware/view.ts";
import { CONFIRMED_IMAGE, NEW_VERSION, S1, S2, siteRunner, updateEvents, wifi } from "./support.ts";

describe("the view", () => {
  test("a device's update: null with none; its state, hold and method once planned", () => {
    const { runner } = siteRunner();
    expect(deviceUpdateOf(runner.view, S1)).toBeNull();
    runner.op({ op: "rollout.start", body: { image: 1, devices: [S1, S2], pilots: [S1] } });
    expect(deviceUpdateOf(runner.view, S1)).toEqual({
      state: "planned",
      held: null,
      method: "joinWifi",
    });
    expect(deviceUpdateOf(runner.view, S2)).toEqual({
      state: "planned",
      held: "waitingTurn",
      method: "joinWifi",
    });
  });

  test("deviceUpdate: one event per transition, to app, with its body exactly; none for a device unmoved", () => {
    const { runner, image } = siteRunner();
    const started = runner.op({
      op: "rollout.start",
      body: { image: 1, devices: [S1, S2], pilots: [S1] },
    });
    expect(updateEvents(started, S1)).toEqual([
      {
        device: S1,
        image: 1,
        state: "planned",
        held: null,
        method: "joinWifi",
        bytes: 0,
        of: image.bytes + 128,
      },
    ]);
    const offered = runner.query(S1);
    expect(updateEvents(offered).map((b) => [b.device, b.state])).toEqual([[S1, "offered"]]);
    const refused = runner.status(S1, image.imageId, 3 /* refused */, 6 /* badHeader */);
    expect(updateEvents(refused, S1)).toMatchObject([{ state: "refused", reason: "badHeader" }]);
    // No device's update moved: nothing is sent.
    expect(updateEvents(runner.heartbeat(S2))).toEqual([]);
  });

  test("devicesInstalling: from the go-ahead until confirmed", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: 1, devices: [S1] } });
    expect(devicesInstalling(runner.view)).toBe(false);
    runner.query(S1);
    runner.query(S1, {}, wifi(501));
    runner.status(S1, image.imageId, UpdateStage.Verified);
    expect(devicesInstalling(runner.view)).toBe(true);
    runner.started(S1, NEW_VERSION, CONFIRMED_IMAGE);
    expect(devicesInstalling(runner.view)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  checkReplayWindow,
  checkStrictlyHigher,
  decodeReplayWindow,
  EMPTY_REPLAY_WINDOW,
  encodeReplayWindow,
  fromHex,
  MAX_U32,
  newSendCounter,
  REPLAY_WINDOW_BYTES,
  type ReplayWindow,
  RESTORE_COUNTER_JUMP,
  restoreSendCounter,
  ResumeStep,
  resumeSendCounter,
  type SendCounter,
  takeSendCounter,
  toHex,
} from "../src/index.ts";

/** A simulated device: a counter in RAM and a resume point in flash. */
class SimulatedSender {
  state: SendCounter;
  flash: number;
  readonly sent: number[] = [];

  constructor(readonly step: ResumeStep) {
    this.state = newSendCounter(step);
    this.flash = this.state.resumePoint;
  }

  send(): void {
    const taken = takeSendCounter(this.state);
    if (!taken.ok) throw new Error(taken.error.code);
    if (taken.value.saveResumePoint !== undefined) this.flash = taken.value.saveResumePoint;
    this.sent.push(taken.value.counter);
    this.state = taken.value.state;
  }

  powerLoss(): void {
    this.state = resumeSendCounter(this.step, this.flash);
  }
}

describe("sending counters and resume points", () => {
  test("start at 1 and count up", () => {
    const sender = new SimulatedSender(ResumeStep.Sensor);
    for (let i = 0; i < 5; i++) sender.send();
    expect(sender.sent).toEqual([1, 2, 3, 4, 5]);
  });

  test("save counter + step before using each multiple of the step", () => {
    for (const step of [ResumeStep.Sensor, ResumeStep.SirenOrGateway]) {
      const sender = new SimulatedSender(step);
      const saves: number[] = [];
      for (let i = 0; i < 3 * step + 1; i++) {
        const taken = takeSendCounter(sender.state);
        if (!taken.ok) throw new Error("exhausted");
        if (taken.value.saveResumePoint !== undefined) {
          expect(taken.value.counter % step).toBe(0);
          saves.push(taken.value.saveResumePoint);
        }
        sender.state = taken.value.state;
      }
      expect(saves).toEqual([2 * step, 3 * step, 4 * step]);
    }
  });

  test("a power loss at any point skips counters but never repeats one", () => {
    for (const step of [ResumeStep.Sensor, ResumeStep.SirenOrGateway]) {
      for (const lossAfter of [0, 1, step - 2, step - 1, step, step + 1, 2 * step - 1, 2 * step]) {
        const sender = new SimulatedSender(step);
        for (let i = 0; i < lossAfter; i++) sender.send();
        sender.powerLoss();
        sender.powerLoss();
        for (let i = 0; i < step + 2; i++) sender.send();
        sender.powerLoss();
        sender.send();
        expect(new Set(sender.sent).size).toBe(sender.sent.length);
        expect(sender.sent).toEqual([...sender.sent].sort((a, b) => a - b));
      }
    }
  });

  test("a sensor that loses power after 30 packets resumes at 64", () => {
    const sender = new SimulatedSender(ResumeStep.Sensor);
    for (let i = 0; i < 30; i++) sender.send();
    sender.powerLoss();
    sender.send();
    expect(sender.sent.at(-1)).toBe(64);
    expect(sender.flash).toBe(128);
  });

  test("refuses to wrap past 2³² − 1", () => {
    const lastSensorBlock = 0xffffffc0;
    expect(
      takeSendCounter({ step: 64, next: lastSensorBlock - 1, resumePoint: lastSensorBlock }).ok,
    ).toBe(true);
    expect(
      takeSendCounter({ step: 64, next: lastSensorBlock, resumePoint: lastSensorBlock }),
    ).toEqual({
      ok: false,
      error: { code: "counterExhausted" },
    });
    expect(takeSendCounter({ step: 1024, next: 0xfffffc00, resumePoint: 0xfffffc00 }).ok).toBe(
      false,
    );
    expect(takeSendCounter({ step: 64, next: MAX_U32 + 1, resumePoint: MAX_U32 + 1 }).ok).toBe(
      false,
    );
  });

  test("resume points must be valid counters", () => {
    expect(() => resumeSendCounter(64, 0)).toThrow(RangeError);
    expect(() => resumeSendCounter(64, 2 ** 32)).toThrow(RangeError);
  });

  test("restoring a backup moves the hub's counter forward by 2²⁴", () => {
    expect(RESTORE_COUNTER_JUMP).toBe(16_777_216);
    const restored = restoreSendCounter(ResumeStep.Hub, 5120);
    expect(restored).toEqual({
      ok: true,
      value: { step: 1024, next: 5120 + 2 ** 24, resumePoint: 5120 + 2 ** 24 },
    });
    const taken = restored.ok ? takeSendCounter(restored.value) : undefined;
    expect(taken?.ok && taken.value.saveResumePoint).toBe(5120 + 2 ** 24 + 1024);
    expect(restoreSendCounter(ResumeStep.Hub, MAX_U32 - RESTORE_COUNTER_JUMP).ok).toBe(true);
    expect(restoreSendCounter(ResumeStep.Hub, MAX_U32 - RESTORE_COUNTER_JUMP + 1)).toEqual({
      ok: false,
      error: { code: "counterExhausted" },
    });
  });
});

describe("hub receive window", () => {
  function play(counters: readonly number[], start: ReplayWindow = EMPTY_REPLAY_WINDOW) {
    let window = start;
    const outcomes = counters.map((counter) => {
      const check = checkReplayWindow(window, counter);
      if (!check.accepted) return check.reason;
      window = check.state;
      return "accepted";
    });
    return { outcomes, window };
  }

  test("accepts higher counters and refuses duplicates", () => {
    expect(play([1, 2, 2, 3, 1]).outcomes).toEqual([
      "accepted",
      "accepted",
      "duplicate",
      "accepted",
      "duplicate",
    ]);
  });

  test("accepts each of the 64 below the highest once; 65 below is too old", () => {
    const { outcomes } = play([100, 36, 36, 35, 99, 99]);
    expect(outcomes).toEqual([
      "accepted",
      "accepted",
      "duplicate",
      "tooOld",
      "accepted",
      "duplicate",
    ]);
  });

  test("every counter in the window, in reverse, is accepted exactly once", () => {
    const below = Array.from({ length: 64 }, (_, i) => 1000 - 1 - i);
    const first = play([1000, ...below]);
    expect(first.outcomes.every((o) => o === "accepted")).toBe(true);
    expect(first.window.seenBelow).toBe((1n << 64n) - 1n);
    expect(play([...below, 1000, 936], first.window).outcomes.every((o) => o !== "accepted")).toBe(
      true,
    );
  });

  test("a jump of exactly 64 keeps the old highest; 65 drops it", () => {
    expect(play([1000, 1064, 1000]).outcomes).toEqual(["accepted", "accepted", "duplicate"]);
    expect(play([1000, 1065, 1000, 1001]).outcomes).toEqual([
      "accepted",
      "accepted",
      "tooOld",
      "accepted",
    ]);
  });

  test("large jumps clear the window", () => {
    const { outcomes, window } = play([5, 6, 7, 0x80000000, 7, 0x80000000 - 1]);
    expect(outcomes).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "tooOld",
      "accepted",
    ]);
    expect(window.seenBelow).toBe(1n);
  });

  test("works up to 2³² − 1", () => {
    const { outcomes } = play([
      MAX_U32 - 64,
      MAX_U32,
      MAX_U32 - 64,
      MAX_U32 - 63,
      MAX_U32 - 65,
      MAX_U32,
    ]);
    expect(outcomes).toEqual([
      "accepted",
      "accepted",
      "duplicate",
      "accepted",
      "tooOld",
      "duplicate",
    ]);
  });

  test("only accepted counters are marked as seen", () => {
    expect(play([3]).window).toEqual({ highest: 3, seenBelow: 0n });
    expect(play([3, 60]).window).toEqual({ highest: 60, seenBelow: 1n << 56n });
    expect(play([3, 70]).window).toEqual({ highest: 70, seenBelow: 0n });
  });

  test("received counters are always valid", () => {
    expect(() => checkReplayWindow(EMPTY_REPLAY_WINDOW, 0)).toThrow(RangeError);
    expect(() => checkReplayWindow(EMPTY_REPLAY_WINDOW, 2 ** 32)).toThrow(RangeError);
  });

  test("state serialises to 12 bytes and back", () => {
    const { window } = play([1, 3, 64, 65, 0xfedcba98]);
    const bytes = encodeReplayWindow({ highest: 0x01020304, seenBelow: 0x8000000000000001n });
    expect(toHex(bytes)).toBe("04030201" + "01000000" + "00000080");
    expect(bytes.length).toBe(REPLAY_WINDOW_BYTES);
    expect(decodeReplayWindow(encodeReplayWindow(window))).toEqual({ ok: true, value: window });
    expect(decodeReplayWindow(fromHex("00".repeat(11)))).toEqual({
      ok: false,
      error: { code: "truncated" },
    });
    expect(decodeReplayWindow(fromHex("00".repeat(13)))).toEqual({
      ok: false,
      error: { code: "tooLong" },
    });
  });
});

describe("strictly higher", () => {
  test("accepts only a counter above the last accepted", () => {
    expect(checkStrictlyHigher(0, 1)).toEqual({ accepted: true, state: 1 });
    expect(checkStrictlyHigher(5, 5)).toEqual({ accepted: false, reason: "duplicate" });
    expect(checkStrictlyHigher(5, 4)).toEqual({ accepted: false, reason: "tooOld" });
    expect(checkStrictlyHigher(5, MAX_U32)).toEqual({ accepted: true, state: MAX_U32 });
    expect(checkStrictlyHigher(MAX_U32, MAX_U32)).toEqual({ accepted: false, reason: "duplicate" });
    expect(() => checkStrictlyHigher(0, 0)).toThrow(RangeError);
  });
});

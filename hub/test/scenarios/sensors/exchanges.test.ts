/**
 * Sensor exchanges in the World with scripted sensors (hub-design.md section 11; protocol.md §7):
 * a link check answered, and one skipped when the hub hears it too late; a version change
 * reaching a sensor at its next heartbeat; a door report whose first try is lost, answered on its
 * retry with the countdown counted from the opening; and replies on a medium-rate site going
 * faster once the signal margin allows.
 */
import { describe, expect, test } from "bun:test";
import { mono } from "../../../src/core/model/time.ts";
import { SECOND } from "./bench.ts";
import { siteDay } from "./site-day.ts";

const MIN = 60 * SECOND;

describe("heartbeat replies", () => {
  test("a link check is answered at the moment the sensor listens, and the sensor takes it", () => {
    const day = siteDay({ count: 1, rate: 5, drifts: [0.01] });
    expect(day.bench.world.advanceTo(mono(20 * MIN)).isOk()).toBe(true);
    const [sensor] = day.sensors;
    const checks = day.bench.stand.radioOuts.filter((o) => o.purpose === "heartbeatReply");
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(sensor?.replies.length).toBe(1 + checks.length);
    expect(sensor?.misses).toBe(0);
  });

  test("one heard more than 700 ms ‡ after its end is skipped and recorded; the sensor asks again and is answered", () => {
    const day = siteDay({ count: 1, rate: 5 });
    const [sensor] = day.sensors;
    expect(day.bench.world.advanceTo(mono(12 * MIN)).isOk()).toBe(true);
    day.site.setDelayMs(750);
    expect(day.bench.world.advanceTo(mono(17 * MIN)).isOk()).toBe(true);
    expect(day.bench.decisions("reply_skipped").length).toBeGreaterThanOrEqual(1);
    expect(sensor?.misses).toBeGreaterThanOrEqual(1);
    day.site.setDelayMs(30);
    expect(day.bench.world.advanceTo(mono(25 * MIN)).isOk()).toBe(true);
    expect(sensor?.misses).toBe(0);
  });
});

describe("a version change", () => {
  test("reaches the sensor at its next heartbeat, which holds the old version", () => {
    const day = siteDay({ count: 1, rate: 5 });
    const [sensor] = day.sensors;
    expect(day.bench.world.advanceTo(mono(5 * MIN)).isOk()).toBe(true);
    const before = sensor?.held.version;
    day.bench.command({ kind: "sensorSet", name: "sensor-1", countdown: 45 });
    expect(day.bench.world.advanceTo(mono(9 * MIN)).isOk()).toBe(true);
    expect(sensor?.held.version).toBe((before ?? 0) + 1);
    expect(sensor?.held.countdownS).toBe(45);
  });
});

describe("a retried door report", () => {
  test("its first try lost, the retry about 2 s later carries the age; the countdown counts from the opening", () => {
    const day = siteDay({ count: 1, rate: 5 });
    const [sensor] = day.sensors;
    const device = day.bench.sensors[0]?.device;
    expect(day.bench.world.advanceTo(mono(5 * MIN)).isOk()).toBe(true);
    day.bench.command({ kind: "arm", sensors: "all", continue: true });
    expect(day.bench.world.advanceTo(mono(10 * MIN)).isOk()).toBe(true);
    expect(sensor?.armed).toBe(true);
    // The gateway does not hear the first try.
    day.site.unheard.add(0);
    sensor?.door(mono(10 * MIN + SECOND), true);
    expect(day.bench.world.advanceTo(mono(10 * MIN + 2 * SECOND)).isOk()).toBe(true);
    day.site.unheard.delete(0);
    expect(day.bench.world.advanceTo(mono(10 * MIN + 10 * SECOND)).isOk()).toBe(true);
    const doors = sensor?.sent.filter((s) => s.kind === "door") ?? [];
    expect(doors.length).toBe(2);
    const reply = sensor?.replies.at(-1)?.reply;
    expect(reply?.flags).toMatchObject({ armed: true, countdownStarted: true });
    // Opened at 10 min + 1 s, countdown 30 s; the retry left about 2 to 3 s later.
    const retryAt = (doors[1]?.end ?? 0) / SECOND - (10 * 60 + 1);
    expect(reply?.countdownRemainingSeconds).toBeLessThanOrEqual(30 - Math.floor(retryAt));
    expect(reply?.countdownRemainingSeconds).toBeGreaterThanOrEqual(27);
    expect(sensor?.buzzing).toBe(true);
    // The hub dates the opening from the retry's end less its age, in whole seconds (D106).
    const opened =
      device === undefined
        ? 0
        : (day.bench.world.state.alarm.countdowns.get(device)?.openedAt ?? 0);
    expect(opened).toBeGreaterThanOrEqual(10 * MIN + SECOND);
    expect(opened).toBeLessThan(10 * MIN + 2 * SECOND);
  });
});

describe("replies on a medium-rate site (DR2)", () => {
  test("with 10 samples of good margin the reply rate goes faster, by a version change, and the sensor hears at it", () => {
    const day = siteDay({ count: 1, rate: 2 });
    const [sensor] = day.sensors;
    expect(day.bench.world.advanceTo(mono(4 * 60 * MIN)).isOk()).toBe(true);
    // SNR +8 dB: s + 8 − 10 ≥ −7.5 with 3 dB to spare: DR5, three steps faster than DR2.
    expect(sensor?.held.replyRate).toBe(5);
    const late = day.bench.stand.radioOuts.filter((o) => o.purpose === "heartbeatReply").slice(-5);
    expect(late.every((o) => o.dataRate === 5)).toBe(true);
    expect(sensor?.misses).toBe(0);
    expect(sensor?.held.sendRate).toBe(2);
  });
});

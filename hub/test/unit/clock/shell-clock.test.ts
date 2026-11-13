/**
 * The shell's clocks (hub-design.md sections 3 and 5): a monotonic clock that never goes back,
 * and whether the wall clock can be trusted, probed no more often than section 5 says.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HubError } from "../../../src/core/model/errors.ts";
import { MonotonicMicros, SystemClock } from "../../../src/shell/clock/system-clock.ts";
import {
  HUB_BUILD_TIME_MS,
  PROBE_TRUSTED_MS,
  PROBE_UNTRUSTED_MS,
  probeFor,
  type Scheduler,
  type SyncProbe,
  SystemTimeTrust,
} from "../../../src/shell/clock/time-trust.ts";
import { tempDir } from "../storage/fixtures.ts";

/** A scheduler that runs nothing by itself: the test fires each timer and sees its delay. */
class ManualScheduler {
  readonly delays: number[] = [];
  #next: (() => void) | undefined;
  readonly schedule: Scheduler = (ms, run) => {
    this.delays.push(ms);
    this.#next = run;
    return { cancel: () => (this.#next = undefined) };
  };
  fire(): void {
    const run = this.#next;
    this.#next = undefined;
    run?.();
  }
}

const NOW = HUB_BUILD_TIME_MS + 86_400_000;

function trust(
  probe: SyncProbe | undefined,
  scheduler: ManualScheduler,
  failures: HubError[] = [],
  wall = () => NOW,
) {
  return new SystemTimeTrust({
    probe,
    scheduler: scheduler.schedule,
    wall,
    notBeforeMs: HUB_BUILD_TIME_MS,
    onProbeFailed: (e) => failures.push(e),
  });
}

describe("the monotonic clock", () => {
  test("never goes back, in whole microseconds", () => {
    const readings = [5_000, 9_999, 4_000, 12_345];
    const clock = new MonotonicMicros(() => readings.shift() ?? 0);
    expect([clock.now(), clock.now(), clock.now(), clock.now()]).toEqual([5, 9, 9, 12] as never);
  });

  test("the system clock stamps mono, wall and trust together", () => {
    const now = new SystemClock(
      { wallTrusted: () => true },
      new MonotonicMicros(() => 7_000),
      () => 42,
    ).now();
    expect(now).toEqual({ mono: 7, wall: 42, wallTrusted: true } as never);
  });
});

describe("whether the wall clock is trusted (section 5)", () => {
  test("on Linux, every 10 s until synchronised, then every hour, and never more often", () => {
    const answers = [false, false, false, true, true];
    const scheduler = new ManualScheduler();
    const probe: SyncProbe = () => ({ ok: true, synced: answers.shift() ?? true });
    const clock = trust(probe, scheduler);
    clock.start();
    expect(clock.wallTrusted()).toBe(false);
    scheduler.fire();
    scheduler.fire();
    expect(clock.wallTrusted()).toBe(false);
    scheduler.fire();
    expect(clock.wallTrusted()).toBe(true);
    scheduler.fire();
    expect(scheduler.delays).toEqual([
      PROBE_UNTRUSTED_MS,
      PROBE_UNTRUSTED_MS,
      PROBE_UNTRUSTED_MS,
      PROBE_TRUSTED_MS,
      PROBE_TRUSTED_MS,
    ]);
    expect(PROBE_UNTRUSTED_MS).toBe(10_000);
    expect(PROBE_TRUSTED_MS).toBe(3_600_000);
    clock.stop();
  });

  test("on macOS and Windows, trusted, with nothing polled", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const scheduler = new ManualScheduler();
      const clock = trust(probeFor(platform), scheduler);
      clock.start();
      expect(clock.wallTrusted()).toBe(true);
      expect(scheduler.delays).toEqual([]);
    }
  });

  test("never while it reads earlier than the build time or the last commit mark", () => {
    const scheduler = new ManualScheduler();
    let wall = HUB_BUILD_TIME_MS - 1;
    const clock = trust(undefined, scheduler, [], () => wall);
    expect(clock.wallTrusted()).toBe(false);
    wall = NOW;
    expect(clock.wallTrusted()).toBe(true);
    clock.setFloor(NOW + 1);
    expect(clock.wallTrusted()).toBe(false);
    wall = NOW + 1;
    expect(clock.wallTrusted()).toBe(true);
  });

  test("a probe that fails leaves it untrusted, is reported once, and is tried again", () => {
    const scheduler = new ManualScheduler();
    const failures: HubError[] = [];
    const error: HubError = { kind: "config", origin: "test", message: "EACCES" };
    const clock = trust(() => ({ ok: false, error }), scheduler, failures);
    clock.start();
    scheduler.fire();
    scheduler.fire();
    expect(clock.wallTrusted()).toBe(false);
    expect(failures).toEqual([error]);
    expect(scheduler.delays).toEqual([PROBE_UNTRUSTED_MS, PROBE_UNTRUSTED_MS, PROBE_UNTRUSTED_MS]);
  });

  test("Linux's probe is systemd's file", () => {
    const dir = tempDir("timesync");
    const path = join(dir.path, "synchronized");
    const probe = probeFor("linux", path);
    expect(probe?.()).toEqual({ ok: true, synced: false });
    writeFileSync(path, "");
    expect(probe?.()).toEqual({ ok: true, synced: true });
    expect(probeFor("linux", join(path, "below-a-file"))?.()).toMatchObject({ ok: false });
    dir.remove();
  });
});

/**
 * The boot step, in the whole core with `checkDeadlines`, when what was saved is already due
 * (hub-design.md section 5, "How long was the hub down?" and "What the hub does on a start where it
 * cannot know how long it was down"; section 7, "Hub restart"; section 8, "Arming and the
 * countdown"; D67, D80, D106, D113):
 *
 * - (a) an alarm whose sirens' time ran out during the downtime, the downtime known at the start:
 *   judged as if restored with it, it ends by itself in the boot step (section 5, point 3; D67);
 * - (b) an alarm whose sirens' time had run out by the last commit (its ending not committed), the
 *   downtime unknown: it had no time left, so it ends by itself in the boot step;
 * - (c) a countdown whose end passed during the downtime, the downtime known at the start: D106,
 *   in the boot step: the sirens for what is left counted from the would-be end
 *   (`late_report_sirens`), or, past even that, `late_report_notification` naming the opening;
 * - (d) a countdown with no time left at the last commit, the downtime unknown: it resumes with the
 *   time it had left (none), so it ends at the start and its sirens sound (D113).
 *
 * Each at the edge: the end a microsecond after the boot step, at it, and a microsecond before.
 * The last commit was at 50 s of boot 1; this boot starts at mono 0.
 */
import { describe, expect, test } from "bun:test";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";
import { bootId, deviceId, HUB_DEVICE, seq } from "../../../src/core/model/ids.ts";
import { AlarmTriggerKind, ArmState, DeviceState } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import { Home, sensorConfig } from "../../scenarios/alarm/harness.ts";
import type { Handler } from "../../../src/core/model/handler.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { eventAtOf } from "../../../src/core/model/decisions.ts";
import { makeCore, MODULES } from "../../../src/core/step.ts";
import { World } from "../../world/world.ts";
import { SIREN, sirenSnapshot } from "../sirens/direct.ts";

const SECOND = 1_000_000;
const FRONT = deviceId(100);
/** The wall clock at the last commit. */
const MARK_WALL = Date.UTC(2026, 10, 13, 22);
const MARK_MONO = 50 * SECOND;
const OPENED_MONO = 40 * SECOND;

interface Saved {
  /** The countdown's time left at the last commit, µs; none saved when undefined. */
  readonly countdownLeft?: number;
  /** The siren's time left at the last commit, µs; no alarm saved when undefined. */
  readonly alarmLeft?: number;
  /** Whether the last commit's wall clock was trusted: the downtime is known at the start. */
  readonly known: boolean;
}

function snapshot(saved: Saved): DurableSnapshot {
  const base = sirenSnapshot();
  const countdownLeft = saved.countdownLeft;
  const alarmLeft = saved.alarmLeft;
  return {
    ...base,
    devices: [
      ...base.devices,
      {
        id: FRONT,
        address: 0x5e000001,
        role: 1,
        name: "front",
        chipId: new Uint8Array(6),
        firmware: 0x010000,
        development: true,
        state: DeviceState.Contacted,
        addedMs: 0,
        removedMs: null,
      },
    ],
    sendCounters: [...base.sendCounters, { deviceId: FRONT, resumePoint: 1024 }],
    sensorConfig: [sensorConfig(FRONT, ArmState.Armed, 30)],
    countdowns:
      countdownLeft === undefined
        ? []
        : [
            {
              sensorId: FRONT,
              boot: bootId(1),
              openedMono: mono(OPENED_MONO),
              deadlineMono: mono(MARK_MONO + countdownLeft),
              newestCounter: 66,
              replyGatewayId: null,
              replyRate: 5,
              causeSeq: seq(9),
            },
          ],
    alarm:
      alarmLeft === undefined
        ? undefined
        : { boot: bootId(1), startedMono: mono(10 * SECOND), causeSeq: seq(8) },
    alarmTriggers:
      alarmLeft === undefined
        ? []
        : [
            {
              sensorId: FRONT,
              kind: AlarmTriggerKind.CountdownEnd,
              boot: bootId(1),
              atMono: mono(10 * SECOND),
            },
          ],
    alarmSirens:
      alarmLeft === undefined
        ? []
        : [
            {
              sirenId: SIREN,
              boot: bootId(1),
              untilMono: mono(MARK_MONO + alarmLeft),
              commanded: true,
            },
          ],
    deviceState: [
      {
        deviceId: HUB_DEVICE,
        boot: bootId(1),
        lastSeenMono: mono(MARK_MONO),
        lastSeenMs: MARK_WALL,
        clockOk: saved.known,
        window: null,
        reading: null,
        rssi: null,
        snrQ: null,
        bestGatewayId: null,
        uptimeS: null,
        estimates: null,
      },
    ],
  };
}

/** Every `notificationRaised` the modules exchanged, as the relay module (after notify) sees it. */
type Raised = Extract<Internal, { readonly kind: "notificationRaised" }>;

/** The hub starts `downtimeMs` after the last commit, on that snapshot. */
function start(
  saved: Saved,
  downtimeMs: number,
): { world: World; boot: readonly Effect[]; raised: Raised[] } {
  const raised: Raised[] = [];
  const relay: Handler<"relay"> = (slice, message, ctx) => {
    if (message.kind === "notificationRaised") raised.push(message);
    return MODULES.relay.handle(slice, message, ctx);
  };
  const world = new World({
    wallAtStartMs: MARK_WALL + downtimeMs,
    wallTrusted: true,
    core: makeCore({ ...MODULES, relay: { ...MODULES.relay, handle: relay } }),
  });
  const result = world.boot(snapshot(saved), 2);
  expect(result.isOk() ? "" : result.error.message).toBe("");
  return { world, boot: result.isOk() ? result.value.effects : [], raised };
}

function decisions(effects: readonly Effect[], kind: string) {
  return effects.flatMap((e) =>
    e.kind === "record" && e.record.kind === "decision" && e.record.row.kind === kind
      ? [{ ...e.record.row, durability: e.durability }]
      : [],
  );
}

/** The siren commands decided, as [action, seconds]. */
function commands(effects: readonly Effect[]): [number, number][] {
  return decisions(effects, "siren_command").map((row) => {
    const detail = row.detail ?? new Uint8Array(3);
    return [row.value ?? -1, new DataView(detail.buffer, detail.byteOffset).getUint16(1, true)];
  });
}

/** No fault, and no deadline of any module at or before the World's time. */
function noneLeft(world: World): void {
  expect(world.faults.map((f) => f.message)).toEqual([]);
  const now = world.now.mono;
  expect((world.core.deadlines?.(world.state) ?? []).filter((t) => t.at <= now)).toEqual([]);
}

function deletes(effects: readonly Effect[]): string[] {
  return effects.flatMap((e) => (e.kind === "write" && e.op.op === "delete" ? [e.op.table] : []));
}

describe("(a) an alarm whose sirens' time ran out during a downtime known at the start", () => {
  const DOWN_MS = 10_000;

  test("ran out a microsecond before the start: ended by itself in the boot step, once, nothing sent", () => {
    const { world, boot } = start({ alarmLeft: DOWN_MS * 1000 - 1, known: true }, DOWN_MS);
    expect(decisions(boot, "alarm_ended").map((d) => [d.value, d.durability])).toEqual([
      [0, "now"],
    ]);
    expect(new Set(deletes(boot))).toEqual(new Set(["alarm", "alarm_triggers", "alarm_sirens"]));
    expect(commands(boot)).toEqual([]);
    expect(world.state.alarm.alarm).toBeUndefined();
    noneLeft(world);
    expect(world.advanceByMs(10 * 60_000).isOk()).toBe(true);
    expect(decisions(world.effects, "alarm_ended")).toHaveLength(1);
    expect(decisions(world.effects, "alarm")).toEqual([]);
  });

  test("ran out exactly at the start: ended in the boot step", () => {
    const { world, boot } = start({ alarmLeft: DOWN_MS * 1000, known: true }, DOWN_MS);
    expect(decisions(boot, "alarm_ended")).toHaveLength(1);
    noneLeft(world);
  });

  test("a microsecond left at the start: it runs on, and ends by itself a microsecond later", () => {
    const { world, boot } = start({ alarmLeft: DOWN_MS * 1000 + 1, known: true }, DOWN_MS);
    expect(decisions(boot, "alarm_ended")).toEqual([]);
    expect(world.state.alarm.alarm?.sirens.get(SIREN)?.until).toBe(mono(1));
    noneLeft(world);
    expect(world.advanceTo(mono(1)).isOk()).toBe(true);
    expect(decisions(world.effects, "alarm_ended")).toHaveLength(1);
    expect(commands(world.effects)).toEqual([]);
    noneLeft(world);
  });
});

describe("(b) an alarm with no time left at the last commit, the downtime unknown", () => {
  test("a microsecond past by the last commit: ended by itself in the boot step, once, nothing sent", () => {
    const { world, boot } = start({ alarmLeft: -1, known: false }, 60_000);
    expect(world.state.clock.downtime.kind).toBe("unknown");
    expect(decisions(boot, "alarm_ended").map((d) => d.value)).toEqual([0]);
    expect(commands(boot)).toEqual([]);
    noneLeft(world);
    expect(world.advanceByMs(10 * 60_000).isOk()).toBe(true);
    expect(decisions(world.effects, "alarm_ended")).toHaveLength(1);
  });

  test("exactly at the last commit: ended in the boot step", () => {
    const { world, boot } = start({ alarmLeft: 0, known: false }, 60_000);
    expect(decisions(boot, "alarm_ended")).toHaveLength(1);
    noneLeft(world);
  });

  test("a microsecond left: it resumes with it (D113), and ends a microsecond after the start", () => {
    const { world, boot } = start({ alarmLeft: 1, known: false }, 60_000);
    expect(decisions(boot, "alarm_ended")).toEqual([]);
    expect(world.state.alarm.alarm?.sirens.get(SIREN)?.until).toBe(mono(1));
    noneLeft(world);
    expect(world.advanceTo(mono(1)).isOk()).toBe(true);
    expect(decisions(world.effects, "alarm_ended")).toHaveLength(1);
    noneLeft(world);
  });
});

describe("(c) a countdown whose end passed during a downtime known at the start (D106)", () => {
  const DOWN_MS = 10_000;

  test("ended a microsecond before the start: late_report_sirens in the boot step, the sirens for what is left", () => {
    const { world, boot } = start({ countdownLeft: DOWN_MS * 1000 - 1, known: true }, DOWN_MS);
    expect(decisions(boot, "late_report_sirens").map((d) => [d.value, d.durability])).toEqual([
      [300, "now"],
    ]);
    expect(decisions(boot, "alarm")).toEqual([]);
    expect(commands(boot)).toEqual([[1, 300]]);
    // Counted from the would-be end, a microsecond ago.
    expect(world.state.alarm.alarm?.sirens.get(SIREN)?.until).toBe(mono(300 * SECOND - 1));
    expect(world.state.alarm.countdowns.size).toBe(0);
    noneLeft(world);
  });

  test("ended exactly at the start: the same, the sirens for the whole automatic stop", () => {
    const { world, boot } = start({ countdownLeft: DOWN_MS * 1000, known: true }, DOWN_MS);
    expect(decisions(boot, "late_report_sirens").map((d) => d.value)).toEqual([300]);
    expect(world.state.alarm.alarm?.sirens.get(SIREN)?.until).toBe(mono(300 * SECOND));
    noneLeft(world);
  });

  test("a microsecond left: it runs on, and ends on time a microsecond later with `alarm`", () => {
    const { world, boot } = start({ countdownLeft: DOWN_MS * 1000 + 1, known: true }, DOWN_MS);
    expect(decisions(boot, "late_report_sirens")).toEqual([]);
    expect(world.state.alarm.countdowns.get(FRONT)?.deadline).toBe(mono(1));
    noneLeft(world);
    expect(world.advanceTo(mono(1)).isOk()).toBe(true);
    expect(decisions(world.effects, "alarm")).toHaveLength(1);
    noneLeft(world);
  });

  test("its sirens' time ran out too: only late_report_notification, naming when the door opened", () => {
    // Down 400 s with 100 s left: the countdown would have ended 300 s before the start.
    const { world, boot } = start({ countdownLeft: 100 * SECOND, known: true }, 400_000);
    expect(decisions(boot, "late_report_sirens")).toEqual([]);
    expect(commands(boot)).toEqual([]);
    // Opened 10 s before the last commit, on the wall clock.
    expect(decisions(boot, "late_report_notification").map((d) => d.value)).toEqual([
      Math.floor((MARK_WALL - 10_000) / 1000),
    ]);
    expect(world.state.alarm.alarm).toBeUndefined();
    noneLeft(world);
  });
});

describe("(d) a countdown with no time left at the last commit, the downtime unknown (D113)", () => {
  test("a microsecond past: it ends at the start, `alarm`, the sirens counted from its end", () => {
    const { world, boot } = start({ countdownLeft: -1, known: false }, 60_000);
    expect(decisions(boot, "alarm").map((d) => d.durability)).toEqual(["now"]);
    expect(decisions(boot, "late_report_sirens")).toEqual([]);
    expect(commands(boot)).toEqual([[1, 300]]);
    expect(world.state.alarm.alarm?.sirens.get(SIREN)?.until).toBe(mono(300 * SECOND - 1));
    expect(world.state.alarm.countdowns.size).toBe(0);
    noneLeft(world);
    // Once: the time going on raises no second alarm.
    expect(world.advanceByMs(60_000).isOk()).toBe(true);
    expect(decisions(world.effects, "alarm")).toHaveLength(1);
  });

  test("exactly at the last commit: it ends at the start", () => {
    const { world, boot } = start({ countdownLeft: 0, known: false }, 60_000);
    expect(decisions(boot, "alarm")).toHaveLength(1);
    expect(world.state.alarm.alarm?.sirens.get(SIREN)?.until).toBe(mono(300 * SECOND));
    noneLeft(world);
  });

  test("a microsecond left: it resumes with it, and ends a microsecond after the start", () => {
    const { world, boot } = start({ countdownLeft: 1, known: false }, 60_000);
    expect(decisions(boot, "alarm")).toEqual([]);
    noneLeft(world);
    expect(world.advanceTo(mono(1)).isOk()).toBe(true);
    expect(decisions(world.effects, "alarm")).toHaveLength(1);
    noneLeft(world);
  });
});

/** The notifications recorded, with their kind, detail's event time and durability. */
function notifications(effects: readonly Effect[]) {
  return effects.flatMap((e) =>
    e.kind === "record" && e.record.kind === "notification"
      ? [
          {
            kind: e.record.row.kind,
            happenedAt: eventAtOf(e.record.row.detail),
            at: e.record.row.atMs,
          },
        ]
      : [],
  );
}

describe("D102: a late notification says when the event happened and that it was delayed", () => {
  const HOURS_5 = 5 * 3_600_000;

  test("(d) five hours off: `alarm` at the start carries when the countdown ended, before the stop", () => {
    const { world, boot, raised } = start({ countdownLeft: -2 * SECOND, known: false }, HOURS_5);
    const alarm = decisions(boot, "alarm");
    expect(alarm.map((d) => [d.atMs, eventAtOf(d.detail)])).toEqual([
      [MARK_WALL + HOURS_5, MARK_WALL - 2_000],
    ]);
    expect(notifications(boot)).toEqual([
      { kind: "alarm", happenedAt: MARK_WALL - 2_000, at: MARK_WALL + HOURS_5 },
    ]);
    expect(raised.map((r) => [r.notification.kind, r.notification.delayed])).toEqual([
      ["alarm", true],
    ]);
    noneLeft(world);
  });

  test("(c) four minutes late: late_report_sirens carries the would-be end; delayed", () => {
    // 10 s left at the last commit, off 250 s: it would have ended 240 s before the start.
    const { boot, raised } = start({ countdownLeft: 10 * SECOND, known: true }, 250_000);
    const late = decisions(boot, "late_report_sirens");
    expect(late.map((d) => [d.value, eventAtOf(d.detail)])).toEqual([[60, MARK_WALL + 10_000]]);
    expect(notifications(boot).map((n) => [n.kind, n.happenedAt])).toEqual([
      ["late_report_sirens", MARK_WALL + 10_000],
    ]);
    expect(raised.map((r) => r.notification.delayed)).toEqual([true]);
  });

  test("(c) hours late: late_report_notification's opening, in its notification too; delayed", () => {
    const { boot, raised } = start({ countdownLeft: 10 * SECOND, known: true }, HOURS_5);
    const late = decisions(boot, "late_report_notification");
    expect(late.map((d) => d.value)).toEqual([Math.floor((MARK_WALL - 10_000) / 1000)]);
    expect(notifications(boot).map((n) => [n.kind, n.happenedAt])).toEqual([
      ["late_report_notification", MARK_WALL - 10_000],
    ]);
    expect(raised.map((r) => r.notification.delayed)).toEqual([true]);
  });

  test("exactly the rule's 60 s ‡ late: not delayed; a millisecond more: delayed", () => {
    // 10 s left, off 70 s: ended exactly 60 s before the start.
    const at = start({ countdownLeft: 10 * SECOND, known: true }, 70_000);
    expect(eventAtOf(decisions(at.boot, "late_report_sirens")[0]?.detail)).toBe(MARK_WALL + 10_000);
    expect(at.raised.map((r) => r.notification.delayed)).toEqual([false]);
    const past = start({ countdownLeft: 10 * SECOND, known: true }, 70_001);
    expect(past.raised.map((r) => r.notification.delayed)).toEqual([true]);
  });

  test("an alarm on time is unchanged: no detail, its notification neither, not delayed", () => {
    const { world, raised } = start({ countdownLeft: 1, known: false }, HOURS_5);
    expect(world.advanceTo(mono(1)).isOk()).toBe(true);
    const alarm = decisions(world.effects, "alarm");
    expect(alarm.map((d) => d.detail)).toEqual([null]);
    expect(notifications(world.effects).map((n) => [n.kind, n.happenedAt])).toEqual([
      ["alarm", undefined],
    ]);
    expect(raised.map((r) => [r.notification.kind, r.notification.delayed])).toEqual([
      ["alarm", false],
    ]);
  });
});

describe("D102 while the hub runs: a late door report (D106)", () => {
  test("late_report_sirens carries when its countdown would have ended", () => {
    const h = new Home({
      sensors: [{ name: "front", arm: ArmState.Armed }],
      sirens: [{ name: "hall" }],
    });
    const wall = h.world.now.wall;
    h.door("front", true, { ageS: 100 });
    // Opened 100 s ago with a 30 s countdown: it would have ended 70 s ago.
    expect(h.decisions("late_report_sirens").map((d) => [d.value, eventAtOf(d.detail)])).toEqual([
      [230, wall - 70_000],
    ]);
  });
});

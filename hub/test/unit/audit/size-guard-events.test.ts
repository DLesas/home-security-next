/**
 * What the core says about the size guard (hub-design.md section 6, "Nothing silent", D110):
 * from the writer's commit outcomes, a warning when trimming starts and once a day while it goes
 * on, a critical event the first time event rows go, a notice when it ends; never one per commit.
 */
import { describe, expect, test } from "bun:test";
import type { CommitOutcome, TrimReport } from "../../../src/core/model/events.ts";
import { World } from "../../world/world.ts";

const HOUR_US = 3_600_000_000;

function report(over: Partial<TrimReport> = {}): CommitOutcome {
  return {
    kind: "trimmed",
    report: {
      routineRows: 5000,
      eventRows: 0,
      oldestRoutineMs: Date.UTC(2026, 9, 1),
      oldestEventMs: Date.UTC(2025, 9, 1),
      inUseBytes: 221 * 1024 * 1024,
      ...over,
    },
  };
}

function guardEvents(world: World): readonly { level: string; code: string }[] {
  return world.writer.commits
    .flatMap((c) => c.items)
    .flatMap((item) =>
      item.kind === "record" &&
      item.record.kind === "hubEvent" &&
      ["history_shortened", "event_history_shortened", "history_trim_ended"].includes(
        item.record.row.code,
      )
        ? [{ level: item.record.row.level, code: item.record.row.code }]
        : [],
    );
}

describe("the size guard's hub events", () => {
  test("a warning at the start and once a day, a critical the first time events go, a notice at the end", () => {
    const world = new World();
    world.boot()._unsafeUnwrap();
    const commit = (outcome: CommitOutcome) => {
      world.input({ kind: "commit", outcome })._unsafeUnwrap();
      world.advanceByMs(1000)._unsafeUnwrap();
    };
    // A trimming commit every five minutes for 30 hours: two warnings, not 360.
    for (let i = 0; i < 360; i++) {
      commit(report({ eventRows: i === 100 || i === 200 ? 4000 : 0 }));
      world.advanceTo((world.now.mono + HOUR_US / 12) as never)._unsafeUnwrap();
    }
    commit({ kind: "trimEnded", inUseBytes: 204 * 1024 * 1024 });
    commit({ kind: "trimEnded", inUseBytes: 204 * 1024 * 1024 });
    world.writer.flush(world.now.mono);
    expect(guardEvents(world)).toEqual([
      { level: "warning", code: "history_shortened" },
      { level: "critical", code: "event_history_shortened" },
      { level: "warning", code: "history_shortened" },
      { level: "info", code: "history_trim_ended" },
    ]);
  });

  test("the warning names where routine history now starts", () => {
    const world = new World();
    world.boot()._unsafeUnwrap();
    world.input({ kind: "commit", outcome: report() })._unsafeUnwrap();
    world.writer.flush(world.now.mono);
    const message = world.writer.commits
      .flatMap((c) => c.items)
      .flatMap((i) =>
        i.kind === "record" && i.record.kind === "hubEvent" ? [i.record.row.message] : [],
      )
      .find((m) => m.startsWith("history shortened"));
    expect(message).toBe(
      "history shortened to stay within the disk limit; routine history now starts at 2026-10-01T00:00:00.000Z",
    );
  });

  test("its time is the ISO form of the oldest row's, a leap day and a time of day included", () => {
    const world = new World();
    world.boot()._unsafeUnwrap();
    const at = Date.UTC(2024, 1, 29, 13, 5, 7, 9);
    world.input({ kind: "commit", outcome: report({ oldestRoutineMs: at }) })._unsafeUnwrap();
    world.writer.flush(world.now.mono);
    const message = world.writer.commits
      .flatMap((c) => c.items)
      .flatMap((i) =>
        i.kind === "record" && i.record.kind === "hubEvent" ? [i.record.row.message] : [],
      )
      .find((m) => m.startsWith("history shortened"));
    expect(message?.endsWith(new Date(at).toISOString())).toBe(true);
  });

  test("nothing more can be trimmed: a warning, and the notice when it ends", () => {
    const world = new World();
    world.boot()._unsafeUnwrap();
    world
      .input({ kind: "commit", outcome: { kind: "trimExhausted", inUseBytes: 239 * 1024 * 1024 } })
      ._unsafeUnwrap();
    world
      .input({ kind: "commit", outcome: { kind: "trimEnded", inUseBytes: 204 * 1024 * 1024 } })
      ._unsafeUnwrap();
    world.writer.flush(world.now.mono);
    const events = world.writer.commits
      .flatMap((c) => c.items)
      .flatMap((i) =>
        i.kind === "record" && i.record.kind === "hubEvent"
          ? [[i.record.row.level, i.record.row.code, i.record.row.message]]
          : [],
      )
      .filter(([, code]) => code?.startsWith("history"));
    expect(events).toEqual([
      [
        "warning",
        "history_trim_exhausted",
        "the database is near its limit and nothing more can be trimmed",
      ],
      [
        "info",
        "history_trim_ended",
        "history is no longer being shortened: the database is back under its lower mark",
      ],
    ]);
  });
});

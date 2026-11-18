/**
 * No upkeep deadline is left at or before a step's time (hub-design.md section 2, "Timers"), in the
 * whole core with `checkDeadlines`, so a deadline left behind fails the step that left it:
 *
 * - `backup_overdue` already due at a start (m2-design.md section 9, "When the folder cannot be
 *   reached"): raised in the boot's own step, once, as the timer at the start's time raised it one
 *   turn later; due exactly then, the same; a moment short of it, by its timer at its exact time.
 * - A backup written more than an hour ‡ after a change it does not hold: the warning in that step.
 * - The daily backup's hour falling exactly on a start: written in that step.
 * - An approved update with nothing in its way: switched in the approval's step, not one later.
 */
import { describe, expect, test } from "bun:test";
import { nodeSha256 } from "@hsn/protocol";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { bootId, connId, jobId, requestId } from "../../../src/core/model/ids.ts";
import { BACKUP_STATE_DEFAULTS, type BackupStateRow } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import { emptyState, step } from "../../../src/core/step.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { HOUR_US, SECOND_US, snapshot, UTC_CALENDAR, WALL0 } from "./support.ts";

const deps = {
  cipher: VectorCipher.fromVectors(),
  rules: DEFAULT_RULES,
  calendar: UTC_CALENDAR,
  sha256: nodeSha256,
  deepFreeze: true,
  checkDeadlines: true,
};

const HOUR_MS = 3_600_000;
const KEY = { key: new Uint8Array(32).fill(0xab), epoch: 1 };

/** The whole core, one step at a time, with every effect kept. */
class Core {
  state: HubState = emptyState();
  at = 0;
  readonly effects: Effect[] = [];
  /** The wall clock at mono 0. */
  readonly wall0: number;

  constructor(wall0 = WALL0) {
    this.wall0 = wall0;
  }

  run(at: number, event: HubEvent): readonly Effect[] {
    this.at = at;
    const result = step(
      this.state,
      {
        now: { mono: mono(at), wall: this.wall0 + Math.floor(at / 1000), wallTrusted: true },
        entropy: new Uint8Array(32).fill(at & 0xff),
        event,
      },
      deps,
    );
    expect(result.isOk() ? "" : result.error.message).toBe("");
    if (result.isErr()) return [];
    this.state = result.value.state;
    this.effects.push(...result.value.effects);
    return result.value.effects;
  }

  boot(backup: Partial<BackupStateRow>): readonly Effect[] {
    return this.run(0, {
      kind: "boot",
      snapshot: snapshot({
        backupKey: KEY,
        backupState: { ...BACKUP_STATE_DEFAULTS, ...backup },
        scheduleState: { timeZone: "UTC" },
      }),
      boot: { id: bootId(2), previousExit: "clean", cause: undefined },
    });
  }

  /** Every upkeep timer, which must all be after the last step's time. */
  timers(): readonly { readonly kind: string; readonly at: Mono }[] {
    return this.state.upkeep.timers.map((t) => ({ kind: t.key.kind, at: t.at }));
  }

  noneLeft(): void {
    expect(this.timers().filter((t) => t.at <= this.at)).toEqual([]);
  }
}

function decisionsOf(effects: readonly Effect[], kind: string) {
  return effects.flatMap((e) =>
    e.kind === "record" && e.record.kind === "decision" && e.record.row.kind === kind
      ? [{ row: e.record.row, durability: e.durability }]
      : [],
  );
}

function jobsOf(effects: readonly Effect[]) {
  return effects.flatMap((e) => (e.kind === "fileJob" ? [e] : []));
}

/** A boot with a backup due since `dueForMs` ago to a folder that cannot be reached. */
function dueAtStart(dueForMs: number, over: Partial<BackupStateRow> = {}) {
  const core = new Core();
  const dueSinceMs = WALL0 - dueForMs;
  const booted = core.boot({ folder: "/backups", dueSinceMs, lastChangeMs: dueSinceMs, ...over });
  return { core, booted, dueSinceMs };
}

describe("backup_overdue already due at a start", () => {
  test("two hours due: raised in the boot's own step, once, a warning written now, no timer for it", () => {
    const { core, booted, dueSinceMs } = dueAtStart(2 * HOUR_MS);
    const overdue = decisionsOf(booted, "backup_overdue");
    expect(overdue.map((d) => [d.row.value, d.durability])).toEqual([[dueSinceMs, "now"]]);
    expect(core.timers().some((t) => t.kind === "backupOverdue")).toBe(false);
    core.noneLeft();
    // The backup the start asked for fails: the warning is not raised again, then or later.
    const job = jobsOf(booted)[0];
    expect(job?.work.kind).toBe("backup");
    core.run(SECOND_US, {
      kind: "fileReady",
      job: job?.job ?? jobId(0),
      outcome: { kind: "failed", reason: "unreachable", message: "gone" },
    });
    core.run(2 * HOUR_US, { kind: "tick" });
    expect(decisionsOf(core.effects, "backup_overdue")).toHaveLength(1);
    expect(core.state.upkeep.backup.overdueRaised).toBe(true);
  });

  test("due exactly an hour ‡: raised in the boot's step; an hour less a millisecond: by its timer at its exact time", () => {
    const exact = dueAtStart(HOUR_MS);
    expect(decisionsOf(exact.booted, "backup_overdue")).toHaveLength(1);
    exact.core.noneLeft();

    const short = dueAtStart(HOUR_MS - 1);
    expect(decisionsOf(short.booted, "backup_overdue")).toEqual([]);
    expect(short.core.timers().filter((t) => t.kind === "backupOverdue")).toEqual([
      { kind: "backupOverdue", at: mono(1000) },
    ]);
    short.core.noneLeft();
    expect(decisionsOf(short.core.run(999, { kind: "tick" }), "backup_overdue")).toEqual([]);
    expect(decisionsOf(short.core.run(1000, { kind: "tick" }), "backup_overdue")).toHaveLength(1);
    short.core.noneLeft();
    expect(decisionsOf(short.core.run(2000, { kind: "tick" }), "backup_overdue")).toEqual([]);
  });

  test("already raised before the stop: not raised again; with no folder: neither, and no timer left", () => {
    const raised = dueAtStart(2 * HOUR_MS, { overdueRaised: true });
    expect(decisionsOf(raised.booted, "backup_overdue")).toEqual([]);
    raised.core.noneLeft();
    const noFolder = dueAtStart(2 * HOUR_MS, { folder: null });
    expect(decisionsOf(noFolder.booted, "backup_overdue")).toEqual([]);
    expect(noFolder.core.timers().some((t) => t.kind === "backupOverdue")).toBe(false);
    noFolder.core.noneLeft();
  });
});

describe("a backup written after a change it does not hold, more than an hour ‡ old", () => {
  test("backup_overdue in the step of its outcome, after backup_written, once for that change", () => {
    const core = new Core();
    const booted = core.boot({ folder: "/backups", dueSinceMs: WALL0, lastChangeMs: WALL0 });
    const job = jobsOf(booted)[0];
    // A change two seconds into the job: the file the job writes does not hold it.
    core.run(2 * SECOND_US, {
      kind: "command",
      conn: connId(0),
      request: requestId(1),
      actor: "tester",
      command: { kind: "op", operation: { op: "person.create", body: { name: "Anna" } } },
    });
    expect(core.state.upkeep.running?.changedSinceMs).toBe(WALL0 + 2000);
    // An hour after the start, the backup due since it is overdue, by its timer.
    expect(decisionsOf(core.run(HOUR_US, { kind: "tick" }), "backup_overdue")).toHaveLength(1);
    // The job takes two hours (a share that hung) and then succeeds.
    const done = core.run(2 * HOUR_US, {
      kind: "fileReady",
      job: job?.job ?? jobId(0),
      outcome: { kind: "backupWritten", name: "hsn-x.hsnb", bytes: 1, sameDiskAsData: false },
    });
    const order = done.flatMap((e) =>
      e.kind === "record" && e.record.kind === "hubEvent" && e.record.row.code === "backup_written"
        ? ["backup_written"]
        : e.kind === "record" &&
            e.record.kind === "decision" &&
            e.record.row.kind === "backup_overdue"
          ? ["backup_overdue"]
          : [],
    );
    expect(order).toEqual(["backup_written", "backup_overdue"]);
    expect(decisionsOf(done, "backup_overdue")[0]?.row.value).toBe(WALL0 + 2000);
    core.noneLeft();
    core.run(2 * HOUR_US + SECOND_US, { kind: "tick" });
    expect(decisionsOf(core.effects, "backup_overdue")).toHaveLength(2);
  });
});

describe("the daily backup's hour falling exactly on a start", () => {
  test("written in the start's step; its timer is the next day's", () => {
    const core = new Core(WALL0 + 3 * HOUR_MS); // 03:00:00.000 UTC, the default hour ‡
    const booted = core.boot({ folder: "/backups" });
    expect(jobsOf(booted).map((j) => j.work.kind)).toEqual(["backup"]);
    expect(core.timers().filter((t) => t.kind === "backupDaily")).toEqual([
      { kind: "backupDaily", at: mono(24 * HOUR_US) },
    ]);
    core.noneLeft();
  });

  test("a millisecond before the hour: the daily backup at its timer, a millisecond later, once", () => {
    const core = new Core(WALL0 + 3 * HOUR_MS - 1);
    expect(jobsOf(core.boot({ folder: "/backups" }))).toEqual([]);
    expect(core.timers().filter((t) => t.kind === "backupDaily")).toEqual([
      { kind: "backupDaily", at: mono(1000) },
    ]);
    expect(jobsOf(core.run(1000, { kind: "tick" })).map((j) => j.work.kind)).toEqual(["backup"]);
    core.noneLeft();
  });
});

describe("an approved update with nothing in its way", () => {
  test("switches in the approval's own step, which answers it; no timer for it", () => {
    const core = new Core();
    core.boot({});
    const upload = jobsOf(
      core.run(SECOND_US, {
        kind: "command",
        conn: connId(0),
        request: requestId(1),
        actor: "tester",
        command: { kind: "op", operation: { op: "update.upload", body: { job: 5 } } },
      }),
    )[0];
    core.run(2 * SECOND_US, {
      kind: "fileReady",
      job: upload?.job ?? jobId(0),
      outcome: { kind: "updateStaged", version: "1.1.0" },
    });
    const approved = core.run(3 * SECOND_US, {
      kind: "command",
      conn: connId(0),
      request: requestId(2),
      actor: "tester",
      command: { kind: "op", operation: { op: "update.approve", body: {} } },
    });
    // The loop runs a turn's file jobs after its commit and its answers (hub-design.md section 4).
    expect(approved.find((e) => e.kind === "respond")).toMatchObject({
      reply: { ok: true, result: { body: { switchWhen: "now" } } },
    });
    expect(jobsOf(approved).map((j) => j.work)).toEqual([
      { kind: "switchUpdate", version: "1.1.0" },
    ]);
    expect(decisionsOf(approved, "update_switching")).toHaveLength(1);
    expect(core.timers().some((t) => t.kind === "updateWait")).toBe(false);
    core.noneLeft();
    expect(jobsOf(core.run(3 * SECOND_US + 1, { kind: "tick" }))).toEqual([]);
  });
});

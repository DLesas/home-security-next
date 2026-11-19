/**
 * `backup_overdue` once per episode (m2-design.md section 9, "When the folder cannot be reached":
 * "raised once per episode (`overdue_raised`) until a backup succeeds"), at each place that can
 * raise it, in the whole core: one decision and one notification in the step that raises it, none
 * again while the episode lasts (across a restart too), and one again in the next episode.
 *
 * The four places: a start with a backup already overdue (`onBoot`), a backup written more than an
 * hour ‡ after a change it does not hold (`onBackupDone`), the first change of an episode
 * (`noteChange`) and a folder chosen with a backup due (`folderChosen`); and the timer. The last two
 * count the hour ‡ from now, so they raise it in their own step only when the rule is no wait at
 * all (`warnAfterMs` 0); with the rule's hour, by the timer an hour later.
 */
import { describe, expect, test } from "bun:test";
import { nodeSha256 } from "@hsn/protocol";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { HubEvent } from "../../../src/core/model/events.ts";
import type { CoreDeps } from "../../../src/core/model/handler.ts";
import { bootId, connId, type JobId, jobId, requestId } from "../../../src/core/model/ids.ts";
import { BACKUP_STATE_DEFAULTS, type BackupStateRow } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES, type HubRules } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { mono } from "../../../src/core/model/time.ts";
import { emptyState, step } from "../../../src/core/step.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { HOUR_US, SECOND_US, snapshot, UTC_CALENDAR, WALL0 } from "./support.ts";

const HOUR_MS = 3_600_000;
const KEY = { key: new Uint8Array(32).fill(0xab), epoch: 1 };
const NO_WAIT: HubRules = {
  ...DEFAULT_RULES,
  backups: { ...DEFAULT_RULES.backups, warnAfterMs: 0 },
};

/** The whole core, one step at a time; each step's effects kept apart. */
class Core {
  state: HubState = emptyState();
  readonly steps: (readonly Effect[])[] = [];
  readonly #deps: CoreDeps;
  #request = 1;

  constructor(rules: HubRules = DEFAULT_RULES) {
    this.#deps = {
      cipher: VectorCipher.fromVectors(),
      rules,
      calendar: UTC_CALENDAR,
      sha256: nodeSha256,
      deepFreeze: true,
      checkDeadlines: true,
    };
  }

  run(at: number, event: HubEvent): readonly Effect[] {
    const result = step(
      this.state,
      {
        now: { mono: mono(at), wall: WALL0 + Math.floor(at / 1000), wallTrusted: true },
        entropy: new Uint8Array(32).fill(at & 0xff),
        event,
      },
      this.#deps,
    );
    expect(result.isOk() ? "" : result.error.message).toBe("");
    if (result.isErr()) return [];
    this.state = result.value.state;
    this.steps.push(result.value.effects);
    return result.value.effects;
  }

  boot(backup: Partial<BackupStateRow>, id = 2): readonly Effect[] {
    return this.run(0, {
      kind: "boot",
      snapshot: snapshot({
        backupKey: KEY,
        backupState: { ...BACKUP_STATE_DEFAULTS, ...backup },
        scheduleState: { timeZone: "UTC" },
      }),
      boot: { id: bootId(id), previousExit: "clean", cause: undefined },
    });
  }

  op(at: number, operation: Extract<HubEvent, { kind: "command" }>["command"]): readonly Effect[] {
    return this.run(at, {
      kind: "command",
      conn: connId(0),
      request: requestId(this.#request++),
      actor: "tester",
      command: operation,
    });
  }

  addPerson(at: number, name: string): readonly Effect[] {
    return this.op(at, { kind: "op", operation: { op: "person.create", body: { name } } });
  }

  written(at: number, job: JobId): readonly Effect[] {
    return this.run(at, {
      kind: "fileReady",
      job,
      outcome: { kind: "backupWritten", name: "hsn-x.hsnb", bytes: 1, sameDiskAsData: false },
    });
  }

  failed(at: number, job: JobId): readonly Effect[] {
    return this.run(at, {
      kind: "fileReady",
      job,
      outcome: { kind: "failed", reason: "unreachable", message: "gone" },
    });
  }

  get all(): readonly Effect[] {
    return this.steps.flat();
  }

  /** `backup_state` as this run last wrote it: what a restart reads. */
  committedBackup(): BackupStateRow | undefined {
    const rows = this.all.flatMap((e) =>
      e.kind === "write" && e.op.op === "upsert" && e.op.table === "backup_state" ? [e.op.row] : [],
    );
    return rows.at(-1);
  }
}

/** `backup_overdue`'s decisions and its notifications in some effects. */
function overdue(effects: readonly Effect[]): { decisions: number; notifications: number } {
  let decisions = 0;
  let notifications = 0;
  for (const e of effects) {
    if (e.kind !== "record") continue;
    if (e.record.kind === "decision" && e.record.row.kind === "backup_overdue") decisions++;
    if (e.record.kind === "notification" && e.record.row.kind === "backup_overdue") notifications++;
  }
  return { decisions, notifications };
}

const ONCE = { decisions: 1, notifications: 1 };
const NONE = { decisions: 0, notifications: 0 };

function backupJob(effects: readonly Effect[]): JobId {
  const job = effects.find((e) => e.kind === "fileJob" && e.work.kind === "backup");
  return job?.kind === "fileJob" ? job.job : jobId(0);
}

describe("a start with a backup already overdue (onBoot)", () => {
  test("once in the boot step; not again in the episode, nor at the next start; once again in the next", () => {
    const core = new Core();
    const dueSinceMs = WALL0 - 2 * HOUR_MS;
    const booted = core.boot({ folder: "/backups", dueSinceMs, lastChangeMs: dueSinceMs });
    expect(overdue(booted)).toEqual(ONCE);
    // The backup the start asked for fails, and is tried again: the episode goes on.
    core.failed(SECOND_US, backupJob(booted));
    core.run(6 * 60 * SECOND_US, { kind: "tick" });
    core.run(2 * HOUR_US, { kind: "tick" });
    expect(overdue(core.all)).toEqual(ONCE);

    // A start in the same episode, from what this run committed: nothing again.
    const saved = core.committedBackup();
    expect(saved).toMatchObject({ dueSinceMs, overdueRaised: true });
    const again = new Core();
    const rebooted = again.boot(saved ?? {}, 3);
    expect(overdue(rebooted)).toEqual(NONE);
    again.run(2 * HOUR_US, { kind: "tick" });
    expect(overdue(again.all)).toEqual(NONE);

    // The episode ends with a backup written; a new change, an hour ‡ unbacked: once again.
    again.written(2 * HOUR_US + SECOND_US, backupJob(again.all));
    expect(again.state.upkeep.backup).toMatchObject({ dueSinceMs: null, overdueRaised: false });
    const change = 2 * HOUR_US + 90 * SECOND_US;
    const job = backupJob(again.addPerson(change, "Anna"));
    again.failed(change + SECOND_US, job);
    expect(overdue(again.run(change + HOUR_US - 1000, { kind: "tick" }))).toEqual(NONE);
    expect(overdue(again.run(change + HOUR_US, { kind: "tick" }))).toEqual(ONCE);
    again.run(change + 3 * HOUR_US, { kind: "tick" });
    expect(overdue(again.all)).toEqual(ONCE);
  });
});

describe("a backup written more than an hour ‡ after a change it does not hold (onBackupDone)", () => {
  test("once in the step of its outcome, for that change; not again in that episode", () => {
    const core = new Core();
    const booted = core.boot({ folder: "/backups", dueSinceMs: WALL0, lastChangeMs: WALL0 });
    core.addPerson(2 * SECOND_US, "Anna");
    // The boot's own due backup is overdue by its timer, an hour after the start: that episode.
    expect(overdue(core.run(HOUR_US, { kind: "tick" }))).toEqual(ONCE);
    const done = core.written(2 * HOUR_US, backupJob(booted));
    expect(overdue(done)).toEqual(ONCE);
    core.run(5 * HOUR_US, { kind: "tick" });
    expect(overdue(core.all)).toEqual({ decisions: 2, notifications: 2 });
  });
});

describe("the first change of an episode (noteChange), the rule no wait at all", () => {
  test("once in the change's step; a second change in the episode raises none", () => {
    const core = new Core(NO_WAIT);
    const booted = core.boot({ folder: "/backups" });
    core.written(SECOND_US, backupJob(booted));
    const first = core.addPerson(2 * SECOND_US, "Anna");
    expect(overdue(first)).toEqual(ONCE);
    core.failed(3 * SECOND_US, backupJob(first));
    expect(overdue(core.addPerson(4 * SECOND_US, "Ben"))).toEqual(NONE);
    core.run(HOUR_US, { kind: "tick" });
    expect(overdue(core.all)).toEqual(ONCE);
  });
});

describe("a folder chosen with a backup due (folderChosen)", () => {
  const dueSinceMs = WALL0 - 2 * HOUR_MS;
  const choose = (core: Core, at: number) =>
    core.op(at, { kind: "op", operation: { op: "backup.settings", body: { folder: "/b" } } });

  test("the rule no wait at all: once in the step that chooses it, none after", () => {
    const core = new Core(NO_WAIT);
    // No folder: the start raises nothing (`backup_no_folder` is for a change, not a start).
    expect(overdue(core.boot({ folder: null, dueSinceMs, lastChangeMs: dueSinceMs }))).toEqual(
      NONE,
    );
    const chosen = choose(core, SECOND_US);
    expect(overdue(chosen)).toEqual(ONCE);
    core.failed(2 * SECOND_US, backupJob(chosen));
    core.run(2 * HOUR_US, { kind: "tick" });
    expect(overdue(core.all)).toEqual(ONCE);
  });

  test("the rule's hour: none in that step, once by the timer an hour later, none after", () => {
    const core = new Core();
    core.boot({ folder: null, dueSinceMs, lastChangeMs: dueSinceMs });
    const chosen = choose(core, SECOND_US);
    expect(overdue(chosen)).toEqual(NONE);
    core.failed(2 * SECOND_US, backupJob(chosen));
    expect(overdue(core.run(SECOND_US + HOUR_US - 1000, { kind: "tick" }))).toEqual(NONE);
    expect(overdue(core.run(SECOND_US + HOUR_US, { kind: "tick" }))).toEqual(ONCE);
    core.run(5 * HOUR_US, { kind: "tick" });
    expect(overdue(core.all)).toEqual(ONCE);
  });
});

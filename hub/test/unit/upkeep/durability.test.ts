/**
 * Every row and record upkeep writes, against m2-design.md section 3's classes: "now" for the
 * settings, the backup key, the update state, the due mark set, the overdue warning, the restore
 * mark and every decision; routine for a backup's result (its newest file, last result and
 * attempt, the due mark cleared) and for the hub events. One test per class, and the whole of a
 * day: the daily backup on its own causes no "now" item (the write budget's finding).
 */
import { describe, expect, test } from "bun:test";
import type { Effect } from "../../../src/core/model/effects.ts";
import { clientId, connId, jobId, seq } from "../../../src/core/model/ids.ts";
import type { AnswerTo, Internal } from "../../../src/core/model/messages.ts";
import { BACKUP_STATE_DEFAULTS, ClientKind } from "../../../src/core/model/rows.ts";
import type { Durability } from "../../../src/core/model/store.ts";
import { clientRow, HOUR_US, peopleChange, type Ran, Runner, snapshot, WALL0 } from "./support.ts";

const KEY = new Uint8Array(32).fill(0xab);
const CONSOLE: AnswerTo = {
  kind: "app",
  conn: connId(3),
  client: clientId(1),
  id: 7,
  seq: undefined,
};

function booted(): Runner {
  const runner = new Runner();
  runner.boot(
    snapshot({
      backupState: { ...BACKUP_STATE_DEFAULTS, folder: "/b" },
      backupKey: { key: KEY, epoch: 1 },
    }),
  );
  return runner;
}

/** Every item's class, as `table:durability` for writes and `record kind:durability`. */
function classes(ran: Ran): string[] {
  return ran.out.flatMap((item: Internal | Effect) => {
    if (item.kind === "write") return [`${item.op.table}:${item.durability}`];
    if (item.kind === "auditRecord")
      return [
        `${item.record.kind === "decision" ? item.record.row.kind : item.record.kind === "hubEvent" ? item.record.row.code : item.record.kind}:${item.durability}`,
      ];
    return [];
  });
}

function op(runner: Runner, o: Extract<Internal, { readonly kind: "opRequest" }>["op"]): Ran {
  return runner.send({
    kind: "opRequest",
    owner: "upkeep",
    op: o,
    actor: { kind: "computer", name: "d" },
    answerTo: CONSOLE,
    record: seq(0),
  });
}

function backupWritten(runner: Runner, job: number): Ran {
  return runner.send({
    kind: "fileReady",
    job: jobId(job),
    outcome: { kind: "backupWritten", name: "f.hsnb", bytes: 1, sameDiskAsData: false },
  });
}

const NOW: Durability = "now";

describe("the classes of section 3", () => {
  test("a change: the due mark set, now", () => {
    expect(classes(booted().send(peopleChange("person_added")))).toEqual([`backup_state:${NOW}`]);
  });

  test("the settings: now", () => {
    expect(classes(op(booted(), { op: "backup.settings", body: { hour: 4 } }))).toEqual([
      `backup_state:${NOW}`,
    ]);
  });

  test("a backup's result, written or failed: routine, as its hub event", () => {
    const ok = booted();
    ok.send(peopleChange("person_added"));
    expect(classes(backupWritten(ok, 1))).toEqual([
      "backup_state:routine",
      "backup_written:routine",
    ]);
    const bad = booted();
    bad.send(peopleChange("person_added"));
    const failed = bad.send({
      kind: "fileReady",
      job: jobId(1),
      outcome: { kind: "failed", reason: "unreachable", message: "x" },
    });
    expect(classes(failed)).toEqual(["backup_state:routine", "backup_failed:routine"]);
  });

  test("the daily backup with nothing changed: no item written now, all day", () => {
    const runner = booted();
    const day = runner.run(3 * HOUR_US + 1_000_000);
    expect(classes(day)).toEqual([]);
    expect(classes(backupWritten(runner, 1)).filter((c) => c.endsWith(":now"))).toEqual([]);
    expect(classes(runner.run(20 * HOUR_US)).filter((c) => c.endsWith(":now"))).toEqual([]);
  });

  test("the overdue warning and its mark: now", () => {
    const runner = booted();
    runner.send(peopleChange("person_added"));
    expect(classes(runner.run(HOUR_US + 1_000_000))).toEqual([
      `backup_state:${NOW}`,
      `backup_overdue:${NOW}`,
    ]);
  });

  test("with no folder, the change, its mark and backup_no_folder: now, once", () => {
    const runner = new Runner();
    runner.boot(snapshot({ backupKey: { key: KEY, epoch: 1 } }));
    expect(classes(runner.send(peopleChange("person_added")))).toEqual([
      `backup_state:${NOW}`,
      `backup_state:${NOW}`,
      `backup_no_folder:${NOW}`,
    ]);
    expect(classes(runner.run(HOUR_US + 1_000_000))).toEqual([]);
  });

  test("the backup key, made or replaced, and its warning: now", () => {
    const first = new Runner();
    expect(classes(first.boot(snapshot({ backupState: BACKUP_STATE_DEFAULTS })))).toEqual([
      `backup_key:${NOW}`,
      `backup_state:${NOW}`,
    ]);
    const runner = booted();
    const phone = clientId(5);
    runner.view = {
      ...runner.view,
      people: {
        ...runner.view.people,
        clients: new Map([[phone, { ...clientRow(phone, ClientKind.Phone, 1), removedMs: WALL0 }]]),
      },
    };
    const ran = classes(runner.send({ kind: "clientRemoved", client: phone }));
    expect(ran).toContain(`backup_key:${NOW}`);
    expect(ran).toContain(`backup_key_replaced:${NOW}`);
  });

  test("the restore mark and restored: now", () => {
    const runner = new Runner();
    const ran = runner.boot(
      snapshot({
        backupState: { ...BACKUP_STATE_DEFAULTS, restoredFromMs: WALL0 },
        backupKey: { key: KEY, epoch: 1 },
      }),
    );
    expect(classes(ran)).toEqual([`restored:${NOW}`, `backup_state:${NOW}`]);
  });

  test("the update state and its decisions: now; a refused release: routine", () => {
    const runner = booted();
    const upload = op(runner, { op: "update.upload", body: { job: 6 } });
    const job = upload.effects.find((e) => e.kind === "fileJob");
    const refused = runner.send({
      kind: "fileReady",
      job: job?.kind === "fileJob" ? job.job : jobId(0),
      outcome: { kind: "failed", reason: "badSignature", message: "x" },
    });
    expect(classes(refused)).toEqual(["update_refused:routine"]);
    const again = op(runner, { op: "update.upload", body: { job: 7 } }).effects.find(
      (e) => e.kind === "fileJob",
    );
    const staged = runner.send({
      kind: "fileReady",
      job: again?.kind === "fileJob" ? again.job : jobId(0),
      outcome: { kind: "updateStaged", version: "1.1.0" },
    });
    expect(classes(staged)).toEqual([`update_state:${NOW}`, `update_staged:${NOW}`]);
    // The approval, then the switch in the same step: nothing holds it back.
    expect(classes(op(runner, { op: "update.approve", body: {} }))).toEqual([
      `update_state:${NOW}`,
      `update_state:${NOW}`,
      `update_switching:${NOW}`,
    ]);
    expect(classes(runner.run(0))).toEqual([]);
  });
});

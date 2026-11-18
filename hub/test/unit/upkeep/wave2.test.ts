/**
 * Wave 2's rules in upkeep (m2-design.md section 9; "Step 1, wave 2: questions settled"): an
 * update's outcome kept across a restart (`update_state.last_result`); `hsn`'s connection naming
 * the upload and the export; a switch refused for want of room for
 * the database's copy drops the approval and says so; the folder on the data disk told once.
 */
import { describe, expect, test } from "bun:test";
import type { Effect } from "../../../src/core/model/effects.ts";
import { connId, jobId, requestId, seq } from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { BACKUP_STATE_DEFAULTS } from "../../../src/core/model/rows.ts";
import { peopleChange, type Ran, Runner, snapshot, WALL0 } from "./support.ts";

const KEY = new Uint8Array(32).fill(0xab);
const UPDATE = {
  stagedVersion: null,
  stagedMs: null,
  approvedBy: null,
  approvedMs: null,
  switchingMs: null,
  previousVersion: "1.0.0",
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

function answer(ran: Ran): unknown {
  const found = ran.messages.find((m) => m.kind === "opAnswer");
  return found?.kind === "opAnswer" ? found.outcome : undefined;
}

function job(ran: Ran): Extract<Effect, { readonly kind: "fileJob" }> | undefined {
  return ran.effects.find(
    (e): e is Extract<Effect, { readonly kind: "fileJob" }> => e.kind === "fileJob",
  );
}

/** `hsn` sends an operation: its `command` input, then control's `opRequest` for upkeep. */
function hsn(
  runner: Runner,
  operation: Extract<Internal, { readonly kind: "opRequest" }>["op"],
): Ran {
  const request = requestId(11);
  runner.send({
    kind: "command",
    request,
    actor: "dimitri",
    conn: connId(42),
    command: { kind: "op", operation },
  });
  return runner.send({
    kind: "opRequest",
    owner: "upkeep",
    op: operation,
    actor: { kind: "computer", name: "dimitri" },
    answerTo: { kind: "control", request, conn: connId(42) },
    record: seq(0),
  });
}

describe("an update's outcome", () => {
  test("survives a restart: written with its time, read back at boot", () => {
    const runner = new Runner();
    runner.boot(
      snapshot({
        backupKey: { key: KEY, epoch: 1 },
        updateState: {
          ...UPDATE,
          stagedVersion: "1.1.0",
          switchingMs: WALL0,
          lastResult: 0,
          lastResultMs: null,
        },
      }),
    );
    const facts = runner.send({
      kind: "hubFacts",
      version: "1.1.0",
      addresses: [],
      appsPort: 8444,
      consolePort: 8445,
      certificateSha256: new Uint8Array(32),
    });
    const write = facts.effects.find((e) => e.kind === "write");
    expect(write?.kind === "write" ? write.op : undefined).toMatchObject({
      table: "update_state",
      row: { lastResult: 1, lastResultMs: WALL0 },
    });
    const after = new Runner();
    after.boot(
      snapshot({
        backupKey: { key: KEY, epoch: 1 },
        updateState: { ...UPDATE, lastResult: 2, lastResultMs: WALL0 },
      }),
    );
    const status = after.send({
      kind: "opRequest",
      owner: "upkeep",
      op: { op: "update.status", body: {} },
      actor: { kind: "computer", name: "d" },
      answerTo: { kind: "control", request: requestId(1), conn: connId(42) },
      record: seq(0),
    });
    expect(answer(status)).toMatchObject({ ok: true, body: { lastResult: "rolledBack" } });
  });

  test("a staged release keeps the last outcome", () => {
    const runner = new Runner();
    runner.boot(
      snapshot({
        backupKey: { key: KEY, epoch: 1 },
        updateState: { ...UPDATE, lastResult: 1, lastResultMs: WALL0 },
      }),
    );
    const upload = job(hsn(runner, { op: "update.upload", body: { job: 3 } }));
    runner.send({
      kind: "fileReady",
      job: upload?.job ?? jobId(0),
      outcome: { kind: "updateStaged", version: "1.2.0" },
    });
    expect(runner.slice.update).toMatchObject({
      stagedVersion: "1.2.0",
      lastResult: 1,
      lastResultMs: WALL0,
    });
  });

  test("a switch without room for the copy: the approval dropped, update_refused, no retry", () => {
    const runner = booted();
    const upload = job(hsn(runner, { op: "update.upload", body: { job: 3 } }));
    runner.send({
      kind: "fileReady",
      job: upload?.job ?? jobId(0),
      outcome: { kind: "updateStaged", version: "1.2.0" },
    });
    // Nothing holds it back: the switch goes in the approval's own step.
    const switching = job(hsn(runner, { op: "update.approve", body: {} }));
    expect(switching?.work.kind).toBe("switchUpdate");
    const full = runner.send({
      kind: "fileReady",
      job: switching?.job ?? jobId(0),
      outcome: { kind: "failed", reason: "full", message: "10 MB free" },
    });
    expect(
      full.messages.some(
        (m) =>
          m.kind === "auditRecord" &&
          m.record.kind === "hubEvent" &&
          m.record.row.code === "update_refused",
      ),
    ).toBe(true);
    expect(runner.slice.update).toMatchObject({
      approvedBy: null,
      switchingMs: null,
      stagedVersion: "1.2.0",
    });
    expect(job(runner.run(60_000_000))).toBeUndefined();
  });
});

describe("hsn's connection", () => {
  test("names the upload of hsn update install and hsn restore, and the export of hsn backup export", () => {
    expect(job(hsn(booted(), { op: "update.upload", body: { job: 3 } }))?.work).toEqual({
      kind: "stageUpdate",
      upload: { conn: connId(42), job: 3 },
    });
    expect(job(hsn(booted(), { op: "restore.start", body: { job: 4 } }))?.work).toEqual({
      kind: "readRestore",
      upload: { conn: connId(42), job: 4 },
    });
    const exported = hsn(booted(), { op: "backup.export", body: { history: false } });
    expect(job(exported)?.work).toMatchObject({ kind: "export", conn: connId(42) });
    expect(answer(exported)).toMatchObject({ ok: true });
  });
});

describe("a folder on the data folder's disk", () => {
  test("told once per folder chosen", () => {
    const runner = booted();
    const count = (ran: Ran) =>
      ran.messages.filter(
        (m) =>
          m.kind === "auditRecord" &&
          m.record.kind === "decision" &&
          m.record.row.kind === "backup_folder_on_data_disk",
      ).length;
    runner.send(peopleChange("person_added"));
    const first = runner.send({
      kind: "fileReady",
      job: jobId(1),
      outcome: { kind: "backupWritten", name: "a", bytes: 1, sameDiskAsData: true },
    });
    expect(count(first)).toBe(1);
    runner.run(61_000_000);
    runner.send(peopleChange("person_added"));
    const again = runner.send({
      kind: "fileReady",
      job: jobId(2),
      outcome: { kind: "backupWritten", name: "b", bytes: 1, sameDiskAsData: true },
    });
    expect(count(again)).toBe(0);
  });
});

/**
 * The interlocks between backups, restore and updates (m2-design.md section 9), each pair in each
 * order: no backup while a restore is applied or switched, and one once it is over or abandoned;
 * no restore while an update switches; no upload, and no switch, while a restore is under way, and
 * the switch once it is over; no second upload, no cancel during an upload, no approval or cancel
 * once the switch began; and the restore's two device checks, at its start and at its header.
 */
import { describe, expect, test } from "bun:test";
import type { Effect } from "../../../src/core/model/effects.ts";
import {
  clientId,
  connId,
  jobId,
  seq,
  TOKEN_RANGES,
  tokenId,
} from "../../../src/core/model/ids.ts";
import type { AnswerTo, Internal } from "../../../src/core/model/messages.ts";
import { BACKUP_STATE_DEFAULTS } from "../../../src/core/model/rows.ts";
import { peopleChange, type Ran, Runner, sensorRow, snapshot, WALL0 } from "./support.ts";

const KEY = new Uint8Array(32).fill(0xab);
const PHONE_KEY = new Uint8Array(32).fill(0x5c);
const CONSOLE: AnswerTo = {
  kind: "app",
  conn: connId(3),
  client: clientId(1),
  id: 7,
  seq: undefined,
};
const TOKEN = tokenId(TOKEN_RANGES.restore.first);

function booted(): Runner {
  const runner = new Runner();
  runner.boot(
    snapshot({
      backupState: { ...BACKUP_STATE_DEFAULTS, folder: "/backups" },
      backupKey: { key: KEY, epoch: 1 },
    }),
  );
  return runner;
}

function op(runner: Runner, o: Extract<Internal, { readonly kind: "opRequest" }>["op"]): Ran {
  return runner.send({
    kind: "opRequest",
    owner: "upkeep",
    op: o,
    actor: { kind: "computer", name: "dimitri" },
    answerTo: CONSOLE,
    record: seq(0),
  });
}

function jobs(ran: Ran, kind: string): Extract<Effect, { readonly kind: "fileJob" }>[] {
  return ran.effects.filter(
    (e): e is Extract<Effect, { readonly kind: "fileJob" }> =>
      e.kind === "fileJob" && e.work.kind === kind,
  );
}

function refusal(ran: Ran): unknown {
  const found = ran.messages.find((m) => m.kind === "opAnswer");
  return found?.kind === "opAnswer" && !found.outcome.ok ? found.outcome.error : undefined;
}

function devices(runner: Runner): void {
  runner.view = {
    ...runner.view,
    registry: { ...runner.view.registry, devices: new Map([[sensorRow().id, sensorRow()]]) },
  };
}

/** A restore through to the phone's key: `applyRestore` running; its job number. */
function applying(runner: Runner): number {
  const start = jobs(op(runner, { op: "restore.start", body: { job: 4 } }), "readRestore")[0];
  runner.send({
    kind: "fileReady",
    job: start?.job ?? jobId(0),
    outcome: {
      kind: "restoreRead",
      identity: new Uint8Array(16).fill(0x42),
      epoch: 3,
      madeMs: WALL0,
      lastChangeMs: WALL0,
    },
  });
  runner.send({ kind: "restoreOpened", conn: connId(9), token: TOKEN });
  const apply = jobs(
    runner.send({ kind: "restoreKey", conn: connId(9), token: TOKEN, key: PHONE_KEY, epoch: 3 }),
    "applyRestore",
  )[0];
  return apply?.job ?? 0;
}

describe("backup and restore", () => {
  test("a change while the restore is applied starts no backup; abandoned (a wrong key), it starts", () => {
    const runner = booted();
    const job = applying(runner);
    expect(jobs(runner.send(peopleChange("person_added")), "backup")).toHaveLength(0);
    expect(runner.slice.backup.dueSinceMs).not.toBeNull();
    const bad = runner.send({
      kind: "fileReady",
      job: jobId(job),
      outcome: { kind: "failed", reason: "wrongKey", message: "no" },
    });
    expect(jobs(bad, "backup")).toHaveLength(1);
  });

  test("none while the restore is switched; one once the switch has failed and it is over", () => {
    const runner = booted();
    const job = applying(runner);
    const ready = runner.send({
      kind: "fileReady",
      job: jobId(job),
      outcome: { kind: "restoreReady" },
    });
    const switching = jobs(ready, "switchRestore")[0];
    expect(jobs(runner.send(peopleChange("person_added")), "backup")).toHaveLength(0);
    expect(jobs(runner.run(24 * 3_600_000_000), "backup")).toHaveLength(0);
    const over = runner.send({
      kind: "fileReady",
      job: switching?.job ?? jobId(0),
      outcome: { kind: "failed", reason: "io", message: "could not swap" },
    });
    expect(runner.slice.restore).toBeUndefined();
    expect(jobs(over, "backup")).toHaveLength(1);
  });

  test("a backup being written does not hold a restore back", () => {
    const runner = booted();
    expect(jobs(runner.send(peopleChange("person_added")), "backup")).toHaveLength(1);
    expect(jobs(op(runner, { op: "restore.start", body: { job: 4 } }), "readRestore")).toHaveLength(
      1,
    );
  });
});

describe("restore and updates", () => {
  function staged(runner: Runner): void {
    const upload = jobs(op(runner, { op: "update.upload", body: { job: 6 } }), "stageUpdate")[0];
    runner.send({
      kind: "fileReady",
      job: upload?.job ?? jobId(0),
      outcome: { kind: "updateStaged", version: "1.1.0" },
    });
  }

  test("no restore once an update is switching", () => {
    const runner = booted();
    staged(runner);
    expect(jobs(op(runner, { op: "update.approve", body: {} }), "switchUpdate")).toHaveLength(1);
    expect(refusal(op(runner, { op: "restore.start", body: { job: 4 } }))).toEqual({
      code: "busy",
      detail: { because: "updateSwitch" },
    });
  });

  test("no upload during a restore", () => {
    const runner = booted();
    op(runner, { op: "restore.start", body: { job: 4 } });
    expect(refusal(op(runner, { op: "update.upload", body: { job: 6 } }))).toEqual({
      code: "busy",
      detail: { because: "restore" },
    });
  });

  test("an approved update does not switch during a restore, and does once it is over", () => {
    const runner = booted();
    staged(runner);
    const read = jobs(op(runner, { op: "restore.start", body: { job: 4 } }), "readRestore")[0];
    expect(refusal(op(runner, { op: "update.approve", body: {} }))).toBeUndefined();
    expect(jobs(runner.run(60_000_000), "switchUpdate")).toHaveLength(0);
    // The message that ends the restore clears the way: the switch goes in its own step.
    const over = runner.send({
      kind: "fileReady",
      job: read?.job ?? jobId(0),
      outcome: { kind: "failed", reason: "badFile", message: "not a backup" },
    });
    expect(jobs(over, "switchUpdate")).toHaveLength(1);
    expect(jobs(runner.run(0), "switchUpdate")).toHaveLength(0);
  });

  test("a cancel or a restore drops a staging half-way: its upload answered, its outcome ignored", () => {
    const runner = booted();
    const first = jobs(op(runner, { op: "update.upload", body: { job: 6 } }), "stageUpdate")[0];
    const cancel = op(runner, { op: "update.cancel", body: {} });
    const answers = cancel.messages.filter((m) => m.kind === "opAnswer");
    expect(answers).toHaveLength(2);
    expect(runner.slice.staging).toBeUndefined();
    runner.send({
      kind: "fileReady",
      job: first?.job ?? jobId(0),
      outcome: { kind: "updateStaged", version: "1.1.0" },
    });
    expect(runner.slice.update.stagedVersion).toBeNull();
    jobs(op(runner, { op: "update.upload", body: { job: 7 } }), "stageUpdate");
    expect(jobs(op(runner, { op: "restore.start", body: { job: 4 } }), "readRestore")).toHaveLength(
      1,
    );
    expect(runner.slice.staging).toBeUndefined();
  });

  test("one upload at a time; no approval or cancel once switching", () => {
    const runner = booted();
    const upload = jobs(op(runner, { op: "update.upload", body: { job: 6 } }), "stageUpdate")[0];
    expect(refusal(op(runner, { op: "update.upload", body: { job: 7 } }))).toEqual({
      code: "busy",
      detail: { because: "upload" },
    });
    runner.send({
      kind: "fileReady",
      job: upload?.job ?? jobId(0),
      outcome: { kind: "updateStaged", version: "1.1.0" },
    });
    op(runner, { op: "update.approve", body: {} });
    runner.run(0);
    const busy = { code: "busy", detail: { because: "updateSwitch" } };
    expect(refusal(op(runner, { op: "update.approve", body: {} }))).toEqual(busy);
    expect(refusal(op(runner, { op: "update.cancel", body: {} }))).toEqual(busy);
    expect(refusal(op(runner, { op: "update.upload", body: { job: 8 } }))).toEqual(busy);
  });
});

describe("a restore and the hub's devices", () => {
  const noDevices = { code: "invalid", detail: { field: "", reason: "noDevicesRequired" } };

  test("refused at the start when the hub has a device", () => {
    const runner = booted();
    devices(runner);
    const ran = op(runner, { op: "restore.start", body: { job: 4 } });
    expect(refusal(ran)).toEqual(noDevices);
    expect(jobs(ran, "readRestore")).toHaveLength(0);
  });

  test("refused at the header when a device was added meanwhile: no token given", () => {
    const runner = booted();
    const read = jobs(op(runner, { op: "restore.start", body: { job: 4 } }), "readRestore")[0];
    devices(runner);
    const ran = runner.send({
      kind: "fileReady",
      job: read?.job ?? jobId(0),
      outcome: {
        kind: "restoreRead",
        identity: new Uint8Array(16),
        epoch: 1,
        madeMs: WALL0,
        lastChangeMs: WALL0,
      },
    });
    expect(refusal(ran)).toEqual(noDevices);
    expect(ran.effects.filter((e) => e.kind === "linkSecret")).toHaveLength(0);
    expect(runner.slice.restore).toBeUndefined();
  });
});

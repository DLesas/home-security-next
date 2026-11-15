/**
 * Every refusal upkeep's operations give (`backup.*`, `restore.*`, `update.*`), one row each, with
 * the code and detail answered, checked against the error table of m2-design.md section 5 (the
 * frozen `appError` schema) and the wave 2 rows (a file that is not a release or a backup is
 * `invalid {field: "job", reason: "badFile"}`, and so on).
 */
import { describe, expect, test } from "bun:test";
import { appError } from "@hsn/protocol/app";
import type { FileFailure } from "../../../src/core/model/events.ts";
import { clientId, connId, jobId, seq } from "../../../src/core/model/ids.ts";
import type { AnswerTo, Internal } from "../../../src/core/model/messages.ts";
import { BACKUP_STATE_DEFAULTS } from "../../../src/core/model/rows.ts";
import { ClientKind, clientRow, type Ran, Runner, sensorRow, snapshot } from "./support.ts";

const KEY = new Uint8Array(32).fill(0xab);
const CONSOLE: AnswerTo = {
  kind: "app",
  conn: connId(3),
  client: clientId(1),
  id: 7,
  seq: undefined,
};

function booted(folder: string | null = "/b"): Runner {
  const runner = new Runner();
  runner.boot(
    snapshot({
      backupState: { ...BACKUP_STATE_DEFAULTS, folder },
      backupKey: { key: KEY, epoch: 1 },
    }),
  );
  return runner;
}

type Op = Extract<Internal, { readonly kind: "opRequest" }>["op"];

function ask(
  runner: Runner,
  op: Op,
  actor: Extract<Internal, { readonly kind: "opRequest" }>["actor"] = {
    kind: "computer",
    name: "d",
  },
): Ran {
  return runner.send({
    kind: "opRequest",
    owner: "upkeep",
    op,
    actor,
    answerTo: CONSOLE,
    record: seq(0),
  });
}

function refusal(ran: Ran): unknown {
  const found = ran.messages.find((m) => m.kind === "opAnswer");
  const error = found?.kind === "opAnswer" && !found.outcome.ok ? found.outcome.error : undefined;
  // Every refusal is one of section 5's, its detail exactly as the table has it.
  if (error !== undefined) expect(appError.safeParse(error).success).toBe(true);
  return error;
}

function job(ran: Ran): number {
  const effect = ran.effects.find((e) => e.kind === "fileJob");
  return effect?.kind === "fileJob" ? effect.job : 0;
}

function failed(runner: Runner, j: number, reason: FileFailure): Ran {
  return runner.send({
    kind: "fileReady",
    job: jobId(j),
    outcome: { kind: "failed", reason, message: "x" },
  });
}

const busy = (because: string) => ({ code: "busy", detail: { because } });
const invalid = (field: string, reason: string) => ({ code: "invalid", detail: { field, reason } });

describe("backup.*", () => {
  test("backup.key from a client that is not a phone holding an older epoch: unauthorized {}", () => {
    const runner = booted();
    const web = clientId(6);
    runner.view = {
      ...runner.view,
      people: {
        ...runner.view.people,
        clients: new Map([[web, clientRow(web, ClientKind.Web, null)]]),
      },
    };
    expect(
      refusal(
        ask(
          runner,
          { op: "backup.key", body: {} },
          { kind: "person", person: 1 as never, client: web, name: "p" },
        ),
      ),
    ).toEqual({ code: "unauthorized", detail: {} });
  });

  test("backup.now with no folder chosen: invalid {folder, unknownReference}", () => {
    expect(refusal(ask(booted(null), { op: "backup.now", body: {} }))).toEqual(
      invalid("folder", "unknownReference"),
    );
  });

  test("backup.now and backup.export on an untrusted clock: unavailable {}", () => {
    const runner = booted();
    runner.trust(false);
    expect(refusal(ask(runner, { op: "backup.now", body: {} }))).toEqual({
      code: "unavailable",
      detail: {},
    });
    expect(refusal(ask(runner, { op: "backup.export", body: { history: false } }))).toEqual({
      code: "unavailable",
      detail: {},
    });
  });
});

describe("restore.start", () => {
  test("on a hub with devices: invalid {'', noDevicesRequired}", () => {
    const runner = booted();
    runner.view = {
      ...runner.view,
      registry: { ...runner.view.registry, devices: new Map([[sensorRow().id, sensorRow()]]) },
    };
    expect(refusal(ask(runner, { op: "restore.start", body: { job: 4 } }))).toEqual(
      invalid("", "noDevicesRequired"),
    );
  });

  test("with a restore under way: busy {restore}", () => {
    const runner = booted();
    ask(runner, { op: "restore.start", body: { job: 4 } });
    expect(refusal(ask(runner, { op: "restore.start", body: { job: 5 } }))).toEqual(
      busy("restore"),
    );
  });

  test("a file that is not a backup: invalid {job, badFile}; the hub unable to read it: unavailable {}", () => {
    const runner = booted();
    expect(
      refusal(
        failed(runner, job(ask(runner, { op: "restore.start", body: { job: 4 } })), "badFile"),
      ),
    ).toEqual(invalid("job", "badFile"));
    expect(
      refusal(failed(runner, job(ask(runner, { op: "restore.start", body: { job: 5 } })), "io")),
    ).toEqual({ code: "unavailable", detail: {} });
  });

  test("an upload that is not there: notFound {upload, the job named}", () => {
    const runner = booted();
    expect(
      refusal(
        failed(runner, job(ask(runner, { op: "restore.start", body: { job: 4 } })), "noUpload"),
      ),
    ).toEqual({ code: "notFound", detail: { what: "upload", id: 4 } });
  });
});

describe("update.*", () => {
  test.each(["badFile", "badSignature", "wrongSystem", "notNewer", "full"] as const)(
    "a release refused %s: invalid {job, %s}",
    (reason) => {
      const runner = booted();
      expect(
        refusal(
          failed(runner, job(ask(runner, { op: "update.upload", body: { job: 6 } })), reason),
        ),
      ).toEqual(invalid("job", reason));
    },
  );

  test("a release the hub could not stage (no install, a read failing): unavailable {}", () => {
    const runner = booted();
    expect(
      refusal(failed(runner, job(ask(runner, { op: "update.upload", body: { job: 6 } })), "io")),
    ).toEqual({ code: "unavailable", detail: {} });
  });

  test("an upload that is not there: notFound {upload, the job named}, and no update_refused", () => {
    const runner = booted();
    const ran = failed(
      runner,
      job(ask(runner, { op: "update.upload", body: { job: 6 } })),
      "noUpload",
    );
    expect(refusal(ran)).toEqual({ code: "notFound", detail: { what: "upload", id: 6 } });
    expect(
      ran.messages.some(
        (m) =>
          m.kind === "auditRecord" &&
          m.record.kind === "hubEvent" &&
          m.record.row.code === "update_refused",
      ),
    ).toBe(false);
  });

  test("a second upload: busy {upload}; during a restore: busy {restore}", () => {
    const runner = booted();
    ask(runner, { op: "update.upload", body: { job: 6 } });
    expect(refusal(ask(runner, { op: "update.upload", body: { job: 7 } }))).toEqual(busy("upload"));
    const other = booted();
    ask(other, { op: "restore.start", body: { job: 4 } });
    expect(refusal(ask(other, { op: "update.upload", body: { job: 7 } }))).toEqual(busy("restore"));
  });

  test("approve with nothing staged: invalid {'', unknownReference}; approve, cancel, upload and restore once switching: busy {updateSwitch}", () => {
    const runner = booted();
    expect(refusal(ask(runner, { op: "update.approve", body: {} }))).toEqual(
      invalid("", "unknownReference"),
    );
    const upload = job(ask(runner, { op: "update.upload", body: { job: 6 } }));
    runner.send({
      kind: "fileReady",
      job: jobId(upload),
      outcome: { kind: "updateStaged", version: "1.1.0" },
    });
    ask(runner, { op: "update.approve", body: {} });
    runner.run(0);
    for (const op of [
      { op: "update.approve", body: {} },
      { op: "update.cancel", body: {} },
      { op: "update.upload", body: { job: 8 } },
      { op: "restore.start", body: { job: 9 } },
    ] as const satisfies readonly Op[])
      expect(refusal(ask(runner, op))).toEqual(busy("updateSwitch"));
  });
});

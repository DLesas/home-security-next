/**
 * upkeep's backup rules (m2-design.md section 9, "Backup, export and restore"; D122; section 3's
 * durability): the key at the first start, a backup at once after each change and at most one more
 * a minute while changes keep coming, daily at the local hour, never on an untrusted clock, an
 * unreachable folder retried every 5 minutes and warned about after an hour, once; the key
 * replaced when a phone that holds it is removed; and the key in no record.
 */
import { describe, expect, test } from "bun:test";
import type { Effect } from "../../../src/core/model/effects.ts";
import { clientId, connId, jobId, requestId } from "../../../src/core/model/ids.ts";
import type { AnswerTo, Internal } from "../../../src/core/model/messages.ts";
import { BACKUP_STATE_DEFAULTS, type BackupStateRow } from "../../../src/core/model/rows.ts";
import {
  ClientKind,
  clientRow,
  deviceChange,
  HOUR_US,
  MINUTE_US,
  peopleChange,
  type Ran,
  Runner,
  SECOND_US,
  snapshot,
  WALL0,
} from "./support.ts";

const FOLDER = "/backups";
const KEY = new Uint8Array(32).fill(0xab);

function withFolder(row: Partial<BackupStateRow> = {}): BackupStateRow {
  return { ...BACKUP_STATE_DEFAULTS, folder: FOLDER, ...row };
}

/** A hub booted with its key and a folder, nothing due. */
function booted(row: Partial<BackupStateRow> = {}): Runner {
  const runner = new Runner();
  runner.boot(snapshot({ backupState: withFolder(row), backupKey: { key: KEY, epoch: 1 } }));
  return runner;
}

function jobs(ran: Ran, kind: string): Extract<Effect, { readonly kind: "fileJob" }>[] {
  return ran.effects.filter(
    (e): e is Extract<Effect, { readonly kind: "fileJob" }> =>
      e.kind === "fileJob" && e.work.kind === kind,
  );
}

function writesOf(ran: Ran, table: string): Extract<Effect, { readonly kind: "write" }>[] {
  return ran.effects.filter(
    (e): e is Extract<Effect, { readonly kind: "write" }> =>
      e.kind === "write" && e.op.table === table,
  );
}

function decisions(ran: Ran, kind: string): Extract<Internal, { readonly kind: "auditRecord" }>[] {
  return ran.messages.filter(
    (m): m is Extract<Internal, { readonly kind: "auditRecord" }> =>
      m.kind === "auditRecord" && m.record.kind === "decision" && m.record.row.kind === kind,
  );
}

function hubEvents(ran: Ran, code: string): Extract<Internal, { readonly kind: "auditRecord" }>[] {
  return ran.messages.filter(
    (m): m is Extract<Internal, { readonly kind: "auditRecord" }> =>
      m.kind === "auditRecord" && m.record.kind === "hubEvent" && m.record.row.code === code,
  );
}

function written(runner: Runner, job: number): Ran {
  return runner.send({
    kind: "fileReady",
    job: jobId(job),
    outcome: {
      kind: "backupWritten",
      name: `hsn-x-${job}.hsnb`,
      bytes: 1000,
      sameDiskAsData: false,
    },
  });
}

function failed(runner: Runner, job: number): Ran {
  return runner.send({
    kind: "fileReady",
    job: jobId(job),
    outcome: { kind: "failed", reason: "unreachable", message: "no such folder" },
  });
}

/** Whether `needle` appears anywhere in `hay`. */
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const encoder = new TextEncoder();

/** Every record's bytes, as they would be written: rows' fields and texts. */
function recordBytes(items: readonly (Internal | Effect)[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const item of items) {
    if (item.kind !== "auditRecord") continue;
    const row: object = item.record.row;
    for (const value of Object.values(row) as unknown[]) {
      if (value instanceof Uint8Array) out.push(value);
      else if (typeof value === "string") out.push(encoder.encode(value));
    }
  }
  return out;
}

describe("the backup key", () => {
  test("is made at the first start of M2 from the input's entropy, 32 bytes, epoch 1, written now", () => {
    const runner = new Runner();
    const ran = runner.boot(snapshot({ backupState: withFolder() }));
    const keys = writesOf(ran, "backup_key");
    expect(keys).toHaveLength(1);
    expect(keys[0]?.durability).toBe("now");
    const row = keys[0]?.op.op === "upsert" ? keys[0].op.row : undefined;
    expect(row !== undefined && "epoch" in row ? row.epoch : undefined).toBe(1);
    expect(runner.slice.key?.key).toEqual(runner.entropyOf(1));
    // A change a backup must hold: written at once into the chosen folder.
    expect(jobs(ran, "backup")).toHaveLength(1);
  });

  test("is kept as the snapshot has it at a later start", () => {
    const runner = booted();
    expect(runner.slice.key).toEqual({ key: KEY, epoch: 1 });
    expect(
      writesOf(
        {
          out: runner.all,
          effects: runner.all.filter((e): e is Effect => e.kind === "write"),
          messages: [],
        },
        "backup_key",
      ),
    ).toHaveLength(0);
  });

  test("is replaced when a phone that holds it is removed: a new key and epoch, a warning, a backup under it", () => {
    const runner = booted();
    const phone = clientId(5);
    runner.view = {
      ...runner.view,
      people: {
        ...runner.view.people,
        clients: new Map([[phone, { ...clientRow(phone, ClientKind.Phone, 1), removedMs: WALL0 }]]),
      },
    };
    runner.advance(SECOND_US);
    const ran = runner.send({ kind: "clientRemoved", client: phone });
    expect(runner.slice.key?.epoch).toBe(2);
    expect(runner.slice.key?.key).not.toEqual(KEY);
    expect(writesOf(ran, "backup_key")[0]?.durability).toBe("now");
    const replaced = decisions(ran, "backup_key_replaced");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.durability).toBe("now");
    const job = jobs(ran, "backup")[0];
    expect(job?.work.kind === "backup" ? job.work.epoch : undefined).toBe(2);
  });

  test("is not replaced when a browser, which never holds it, is removed", () => {
    const runner = booted();
    const browser = clientId(6);
    runner.view = {
      ...runner.view,
      people: {
        ...runner.view.people,
        clients: new Map([
          [browser, { ...clientRow(browser, ClientKind.Web, null), removedMs: WALL0 }],
        ]),
      },
    };
    runner.send({ kind: "clientRemoved", client: browser });
    expect(runner.slice.key?.epoch).toBe(1);
    // Only a phone's kind counts, whatever epoch a row says; and a phone that holds none is no risk.
    const odd = clientId(7);
    const fresh = clientId(8);
    runner.view = {
      ...runner.view,
      people: {
        ...runner.view.people,
        clients: new Map([
          [odd, { ...clientRow(odd, ClientKind.Web, 1), removedMs: WALL0 }],
          [fresh, { ...clientRow(fresh, ClientKind.Phone, null), removedMs: WALL0 }],
        ]),
      },
    };
    runner.send({ kind: "clientRemoved", client: odd });
    runner.send({ kind: "clientRemoved", client: fresh });
    expect(runner.slice.key?.epoch).toBe(1);
  });

  test("never enters a record, over a run of changes, failures and a replacement", () => {
    const runner = new Runner();
    runner.boot(snapshot({ backupState: withFolder() }));
    const first = runner.slice.key?.key ?? new Uint8Array(32);
    const phone = clientId(5);
    runner.view = {
      ...runner.view,
      people: {
        ...runner.view.people,
        clients: new Map([[phone, { ...clientRow(phone, ClientKind.Phone, 1), removedMs: WALL0 }]]),
      },
    };
    failed(runner, 1);
    runner.run(10 * MINUTE_US);
    runner.send(peopleChange("person_added"));
    runner.send({ kind: "clientRemoved", client: phone });
    runner.run(2 * HOUR_US);
    const second = runner.slice.key?.key ?? new Uint8Array(32);
    for (const bytes of recordBytes(runner.all)) {
      expect(contains(bytes, first)).toBe(false);
      expect(contains(bytes, second)).toBe(false);
    }
  });
});

describe("a backup at once after a change (D122)", () => {
  test("a person added: due since then, written now, and a job into the folder in the same step", () => {
    const runner = booted();
    runner.advance(SECOND_US);
    const ran = runner.send(peopleChange("person_added"));
    const state = writesOf(ran, "backup_state")[0];
    expect(state?.durability).toBe("now");
    expect(runner.slice.backup.dueSinceMs).toBe(WALL0 + 1000);
    expect(runner.slice.backup.lastChangeMs).toBe(WALL0 + 1000);
    const job = jobs(ran, "backup")[0];
    expect(job?.work).toEqual({ kind: "backup", folder: FOLDER, keep: 20, key: KEY, epoch: 1 });
  });

  test("a paired device renamed counts as a change too; a group change does not", () => {
    const runner = booted();
    expect(jobs(runner.send(deviceChange("device_renamed")), "backup")).toHaveLength(1);
    const other = booted();
    expect(jobs(other.send(deviceChange("usb_identity")), "backup")).toHaveLength(0);
    expect(other.slice.backup.dueSinceMs).toBeNull();
  });

  test("the file holds the step that started it: due is cleared when it is written", () => {
    const runner = booted();
    runner.send(peopleChange("person_added", 1));
    runner.send(peopleChange("permissions_changed", 2));
    const ran = written(runner, 1);
    expect(runner.slice.backup.dueSinceMs).toBeNull();
    expect(writesOf(ran, "backup_state")[0]?.durability).toBe("routine");
    expect(hubEvents(ran, "backup_written")[0]?.durability).toBe("routine");
  });

  test("changes within 60 s go into one more backup, when that one is done and the minute is over", () => {
    const runner = booted();
    runner.send(peopleChange("person_added", 1));
    let started = 1;
    for (let i = 0; i < 30; i++) {
      const ran = runner.run(SECOND_US);
      started += jobs(ran, "backup").length;
      started += jobs(runner.send(deviceChange("device_added")), "backup").length;
    }
    expect(started).toBe(1);
    // The first is done; the minute is not over yet.
    expect(jobs(written(runner, 1), "backup")).toHaveLength(0);
    expect(runner.slice.backup.dueSinceMs).toBe(WALL0 + 1000);
    const later = runner.run(31 * SECOND_US);
    expect(jobs(later, "backup")).toHaveLength(1);
  });

  test("a change while a job runs is due after it, until the next one holds it", () => {
    const runner = booted();
    runner.send(peopleChange("person_added", 1));
    runner.advance(5 * SECOND_US);
    runner.send(peopleChange("permissions_changed", 2));
    written(runner, 1);
    expect(runner.slice.backup.dueSinceMs).toBe(WALL0 + 5000);
    const next = runner.run(60 * SECOND_US);
    expect(jobs(next, "backup")).toHaveLength(1);
    written(runner, 2);
    expect(runner.slice.backup.dueSinceMs).toBeNull();
  });

  test("never on an untrusted clock; the backup due is written once it is trusted", () => {
    const runner = booted();
    runner.trust(false);
    const ran = runner.send(peopleChange("person_added"));
    expect(jobs(ran, "backup")).toHaveLength(0);
    expect(runner.slice.backup.dueSinceMs).not.toBeNull();
    runner.trust(true);
    const trusted = runner.send({ kind: "wallTrustChanged", trusted: true, stepMs: undefined });
    expect(jobs(trusted, "backup")).toHaveLength(1);
  });
});

describe("the daily backup", () => {
  test("at 03:00 local by default, without any change, and again the next day", () => {
    const runner = booted();
    const first = runner.run(3 * HOUR_US - SECOND_US);
    expect(jobs(first, "backup")).toHaveLength(0);
    const at3 = runner.run(2 * SECOND_US);
    expect(jobs(at3, "backup")).toHaveLength(1);
    written(runner, 1);
    const day = runner.run(24 * HOUR_US);
    expect(jobs(day, "backup")).toHaveLength(1);
  });

  test("at the hour manage system chose", () => {
    const runner = booted({ hour: 22 });
    expect(jobs(runner.run(21 * HOUR_US + 59 * MINUTE_US), "backup")).toHaveLength(0);
    expect(jobs(runner.run(2 * MINUTE_US), "backup")).toHaveLength(1);
  });
});

describe("an unreachable folder", () => {
  test("the change stays; backup_failed each try; tried again every 5 minutes, not sooner", () => {
    const runner = booted();
    runner.send(peopleChange("person_added"));
    const fail = failed(runner, 1);
    expect(hubEvents(fail, "backup_failed")).toHaveLength(1);
    expect(
      hubEvents(fail, "backup_failed")[0]?.record.kind === "hubEvent"
        ? hubEvents(fail, "backup_failed")[0]?.record.row
        : undefined,
    ).toMatchObject({ level: "warning" });
    expect(runner.slice.backup.dueSinceMs).toBe(WALL0);
    expect(jobs(runner.run(5 * MINUTE_US - SECOND_US), "backup")).toHaveLength(0);
    expect(jobs(runner.run(2 * SECOND_US), "backup")).toHaveLength(1);
  });

  test("after an hour with a backup due, one warning that cannot be turned off, once", () => {
    const runner = booted();
    runner.send(peopleChange("person_added"));
    let job = 1;
    let overdue = 0;
    for (let i = 0; i < 30; i++) {
      failed(runner, job);
      const ran = runner.run(5 * MINUTE_US);
      overdue += decisions(ran, "backup_overdue").length;
      job += jobs(ran, "backup").length;
    }
    expect(overdue).toBe(1);
    expect(runner.slice.backup.overdueRaised).toBe(true);
  });

  test("the warning is at an hour exactly, says why, and is written now", () => {
    const runner = booted();
    runner.send(peopleChange("person_added"));
    failed(runner, 1);
    const before = runner.run(HOUR_US - 2 * SECOND_US);
    expect(decisions(before, "backup_overdue")).toHaveLength(0);
    const after = runner.run(3 * SECOND_US);
    const warning = decisions(after, "backup_overdue")[0];
    expect(warning?.durability).toBe("now");
    const row = warning?.record.kind === "decision" ? warning.record.row : undefined;
    expect(row?.value).toBe(WALL0);
    expect(new TextDecoder().decode(row?.detail ?? new Uint8Array())).toBe("unreachable");
  });

  test("with no folder chosen, backup_no_folder once at the first change, never backup_overdue", () => {
    const runner = new Runner();
    // Not at boot, the first start's key included (a change, but not one a person made).
    expect(decisions(runner.boot(snapshot()), "backup_no_folder")).toHaveLength(0);
    const first = runner.send(peopleChange("person_added"));
    expect(decisions(first, "backup_no_folder")).toHaveLength(1);
    expect(decisions(first, "backup_no_folder")[0]?.durability).toBe("now");
    expect(writesOf(first, "backup_state").map((w) => w.durability)).toEqual(["now", "now"]);
    expect(runner.view.upkeep.backup.overdueRaised).toBe(true);
    // Never again until a folder is chosen; and no `backup_overdue` for a hub with no folder.
    expect(decisions(runner.send(deviceChange("device_added")), "backup_no_folder")).toHaveLength(
      0,
    );
    const day = runner.run(25 * HOUR_US);
    expect(decisions(day, "backup_no_folder")).toHaveLength(0);
    expect(decisions(day, "backup_overdue")).toHaveLength(0);
  });

  test("with no folder chosen, the first start's due backup never says backup_overdue", () => {
    const runner = new Runner();
    runner.boot(snapshot());
    expect(runner.view.upkeep.backup.dueSinceMs).not.toBeNull();
    const day = runner.run(25 * HOUR_US);
    expect(decisions(day, "backup_overdue")).toHaveLength(0);
    expect(decisions(day, "backup_no_folder")).toHaveLength(0);
  });

  test("with no folder chosen, a restart keeps it said", () => {
    const runner = new Runner();
    runner.boot(
      snapshot({
        backupState: { ...BACKUP_STATE_DEFAULTS, dueSinceMs: WALL0, overdueRaised: true },
        backupKey: { key: KEY, epoch: 1 },
      }),
    );
    expect(decisions(runner.send(peopleChange("person_added")), "backup_no_folder")).toHaveLength(
      0,
    );
    expect(decisions(runner.run(2 * HOUR_US), "backup_overdue")).toHaveLength(0);
  });

  test("a restart keeps the due backup and its hour", () => {
    const runner = new Runner();
    runner.boot(
      snapshot({
        backupState: withFolder({ dueSinceMs: WALL0 - 50 * 60_000 }),
        backupKey: { key: KEY, epoch: 1 },
      }),
    );
    failed(runner, 1);
    expect(decisions(runner.run(9 * MINUTE_US), "backup_overdue")).toHaveLength(0);
    expect(decisions(runner.run(2 * MINUTE_US), "backup_overdue")).toHaveLength(1);
  });
});

describe("its operations", () => {
  const app: AnswerTo = { kind: "app", conn: connId(3), client: clientId(2), id: 7, seq: 9 };
  const control: AnswerTo = { kind: "control", request: requestId(4), conn: connId(42) };
  const computer = { kind: "computer", name: "dimitri" } as const;

  function op(
    runner: Runner,
    o: Extract<Internal, { readonly kind: "opRequest" }>["op"],
    answerTo: AnswerTo = app,
  ): Ran {
    return runner.send({
      kind: "opRequest",
      owner: "upkeep",
      op: o,
      actor: computer,
      answerTo,
      record: 0 as never,
    });
  }

  function answer(ran: Ran): unknown {
    const found = ran.messages.find((m) => m.kind === "opAnswer");
    return found?.kind === "opAnswer" ? found.outcome : undefined;
  }

  test("backup.settings writes the row now and answers; backup.status says it back", () => {
    const runner = new Runner();
    // The first start: the key is made, a change no backup holds yet, with no folder to write to.
    runner.boot(snapshot());
    const set = op(runner, { op: "backup.settings", body: { folder: FOLDER, hour: 4, keep: 5 } });
    expect(writesOf(set, "backup_state")[0]?.durability).toBe("now");
    expect(answer(set)).toEqual({ ok: true, body: {} });
    // The key made at the first start is due; with a folder now, it is written.
    expect(jobs(set, "backup")[0]?.work).toMatchObject({ folder: FOLDER, keep: 5, epoch: 1 });
    const status = op(runner, { op: "backup.status", body: {} });
    expect(answer(status)).toEqual({
      ok: true,
      body: { folder: FOLDER, hour: 4, keep: 5, newestMs: null, due: true, lastResult: "never" },
    });
  });

  test("a folder chosen ends the no-folder warning; that folder then gets backup_overdue", () => {
    const runner = new Runner();
    runner.boot(snapshot({ backupKey: { key: KEY, epoch: 1 } }));
    runner.send(peopleChange("person_added"));
    runner.run(2 * HOUR_US);
    // Other settings leave the warning said.
    op(runner, { op: "backup.settings", body: { hour: 4 } });
    expect(runner.view.upkeep.backup.overdueRaised).toBe(true);
    const set = op(runner, { op: "backup.settings", body: { folder: FOLDER } });
    expect(runner.view.upkeep.backup.overdueRaised).toBe(false);
    expect(writesOf(set, "backup_state").every((w) => w.durability === "now")).toBe(true);
    const job = jobs(set, "backup")[0]?.job;
    runner.send({
      kind: "fileReady",
      job: jobId(job ?? 0),
      outcome: { kind: "failed", reason: "unreachable", message: "no such folder" },
    });
    // Its own hour from the folder's choosing, not from the first change.
    expect(decisions(runner.run(50 * MINUTE_US), "backup_overdue")).toHaveLength(0);
    const later = runner.run(11 * MINUTE_US);
    const row = decisions(later, "backup_overdue")[0]?.record;
    expect(
      row?.kind === "decision"
        ? new TextDecoder().decode(row.row.detail ?? new Uint8Array())
        : undefined,
    ).toBe("unreachable");
    expect(decisions(later, "backup_no_folder")).toHaveLength(0);
  });

  test("backup.now writes one at once, and needs a folder", () => {
    const runner = booted();
    const now = op(runner, { op: "backup.now", body: {} });
    expect(jobs(now, "backup")).toHaveLength(1);
    expect(answer(now)).toEqual({ ok: true, body: { job: 1 } });
    const none = new Runner();
    none.boot(snapshot({ backupKey: { key: KEY, epoch: 1 } }));
    expect(answer(op(none, { op: "backup.now", body: {} }))).toMatchObject({
      ok: false,
      error: { code: "invalid", detail: { field: "folder" } },
    });
  });

  test("backup.export streams to the asking connection, never through the folder", () => {
    const runner = booted();
    const ran = op(runner, { op: "backup.export", body: { history: true } });
    expect(jobs(ran, "export")[0]?.work).toEqual({
      kind: "export",
      conn: connId(3),
      history: true,
      key: KEY,
      epoch: 1,
    });
    expect(jobs(ran, "backup")).toHaveLength(0);
    expect(answer(ran)).toEqual({ ok: true, body: { job: 1 } });
    // `hsn backup export`: streamed on its control connection.
    const fromHsn = op(runner, { op: "backup.export", body: { history: false } }, control);
    expect(jobs(fromHsn, "export")[0]?.work).toMatchObject({ conn: connId(42) });
  });

  test("backup.key: only a phone whose epoch is older; a browser is refused", () => {
    const runner = booted();
    const phone = clientId(5);
    const browser = clientId(6);
    runner.view = {
      ...runner.view,
      people: {
        ...runner.view.people,
        clients: new Map([
          [phone, clientRow(phone, ClientKind.Phone, 0)],
          [browser, clientRow(browser, ClientKind.Web, null)],
        ]),
      },
    };
    const as = (client: typeof phone) =>
      runner.send({
        kind: "opRequest",
        owner: "upkeep",
        op: { op: "backup.key", body: {} },
        actor: { kind: "person", person: 1 as never, client, name: `p (client ${client})` },
        answerTo: { ...app, client },
        record: 0 as never,
      });
    expect(answer(as(phone))).toMatchObject({ ok: true, body: { epoch: 1 } });
    expect(answer(as(browser))).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });
});

/**
 * upkeep's restore and update rules (m2-design.md section 9; section 5, "Restore's messages"):
 * a restore only on a hub with no devices, the file's age said first, a QR-only 128-bit token
 * never stored, the phone's key sent on only into `applyRestore`, `RestoreResult` before the
 * switch, a wrong key leaving the token usable, the restored hub's first start; an update staged,
 * approved, switched only when nothing runs, and judged healthy or rolled back at the next start.
 */
import { describe, expect, test } from "bun:test";
import {
  appIdentityBytes,
  formatIdentity,
  parseLinkQr,
  secretLookup,
  secretPsk,
} from "@hsn/protocol/app";
import { nodeSha256 } from "@hsn/protocol";
import type { Effect } from "../../../src/core/model/effects.ts";
import {
  clientId,
  connId,
  jobId,
  requestId,
  seq,
  TOKEN_RANGES,
  tokenId,
} from "../../../src/core/model/ids.ts";
import type { AnswerTo, Internal } from "../../../src/core/model/messages.ts";
import { BACKUP_STATE_DEFAULTS, MoveStage } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import { switchBlockedBy } from "../../../src/core/upkeep/view.ts";
import {
  APP_PUBLIC,
  MINUTE_US,
  type Ran,
  Runner,
  SECOND_US,
  sensorRow,
  snapshot,
  WALL0,
} from "./support.ts";

const KEY = new Uint8Array(32).fill(0xab);
const PHONE_KEY = new Uint8Array(32).fill(0x5c);
const CONSOLE: AnswerTo = {
  kind: "app",
  conn: connId(3),
  client: clientId(1),
  id: 7,
  seq: undefined,
};
const COMPUTER = { kind: "computer", name: "dimitri" } as const;
const FILE_IDENTITY = new Uint8Array(16).fill(0x42);
const MADE = WALL0 - 86_400_000;
const LAST_CHANGE = WALL0 - 3 * 86_400_000;

function booted(): Runner {
  const runner = new Runner();
  runner.boot(snapshot({ backupState: BACKUP_STATE_DEFAULTS, backupKey: { key: KEY, epoch: 1 } }));
  return runner;
}

function op(
  runner: Runner,
  o: Extract<Internal, { readonly kind: "opRequest" }>["op"],
  answerTo: AnswerTo = CONSOLE,
): Ran {
  return runner.send({
    kind: "opRequest",
    owner: "upkeep",
    op: o,
    actor: COMPUTER,
    answerTo,
    record: seq(0),
  });
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

function handshakes(ran: Ran): unknown[] {
  return ran.effects.flatMap((e) =>
    e.kind === "appSend" && "kind" in e.message ? [e.message.body] : [],
  );
}

function decisionKinds(ran: Ran): string[] {
  return ran.messages.flatMap((m) =>
    m.kind === "auditRecord" && m.record.kind === "decision" ? [m.record.row.kind] : [],
  );
}

/** `restore.start` through to the header read: the token given, the answer sent. */
function offered(runner: Runner): Ran {
  const start = op(runner, { op: "restore.start", body: { job: 4 } });
  const read = job(start);
  expect(read?.work).toEqual({ kind: "readRestore", upload: { conn: connId(3), job: 4 } });
  return runner.send({
    kind: "fileReady",
    job: read?.job ?? jobId(0),
    outcome: {
      kind: "restoreRead",
      identity: FILE_IDENTITY,
      epoch: 3,
      madeMs: MADE,
      lastChangeMs: LAST_CHANGE,
    },
  });
}

/** Whether any byte array anywhere inside `value` equals `bytes`. */
function holds(value: unknown, bytes: Uint8Array): boolean {
  if (value instanceof Uint8Array)
    return value.length === bytes.length && value.every((b, i) => b === bytes[i]);
  if (value instanceof Map)
    return [...(value as Map<unknown, unknown>).values()].some((v) => holds(v, bytes));
  if (value instanceof Set) return [...(value as Set<unknown>)].some((v) => holds(v, bytes));
  if (typeof value === "object" && value !== null)
    return (Object.values(value) as unknown[]).some((v) => holds(v, bytes));
  return false;
}

const TOKEN = tokenId(TOKEN_RANGES.restore.first);

describe("restore", () => {
  test("only on a hub with no devices", () => {
    const runner = booted();
    runner.view = {
      ...runner.view,
      registry: { ...runner.view.registry, devices: new Map([[sensorRow().id, sensorRow()]]) },
    };
    expect(answer(op(runner, { op: "restore.start", body: { job: 4 } }))).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "", reason: "noDevicesRequired" } },
    });
  });

  test("restore.start is a read: nothing written; one restore at a time", () => {
    const runner = booted();
    const start = op(runner, { op: "restore.start", body: { job: 4 } });
    expect(start.effects.filter((e) => e.kind === "write")).toHaveLength(0);
    expect(answer(start)).toBeUndefined();
    expect(answer(op(runner, { op: "restore.start", body: { job: 5 } }))).toEqual({
      ok: false,
      error: { code: "busy", detail: { because: "restore" } },
    });
  });

  test("the header: the file's identity, when it was made and how old its people are, and a QR-only token", () => {
    const runner = booted();
    const ran = offered(runner);
    const outcome = answer(ran) as {
      ok: true;
      body: { identity: string; madeMs: number; lastChangeMs: number; qr: string };
    };
    expect(outcome.ok).toBe(true);
    expect(outcome.body.identity).toBe(formatIdentity(FILE_IDENTITY));
    expect(outcome.body.madeMs).toBe(MADE);
    expect(outcome.body.lastChangeMs).toBe(LAST_CHANGE);
    const qr = parseLinkQr(outcome.body.qr, "restore");
    expect(qr).toBeDefined();
    // The QR code names the new hub's own app key, which the restore replaces (section 9).
    expect(qr?.identity).toBe(formatIdentity(appIdentityBytes(nodeSha256, APP_PUBLIC)));
    expect(qr?.port).toBe(8444);
    const secret = qr?.secret ?? new Uint8Array();
    const given = ran.effects.find((e) => e.kind === "linkSecret");
    expect(given).toEqual({
      kind: "linkSecret",
      token: TOKEN,
      purpose: "restore",
      askName: false,
      lookup: secretLookup(nodeSha256, secret),
      psk: secretPsk(nodeSha256, secret),
    });
    expect(secret).toHaveLength(16);
    // Never stored: no write, and the slice keeps neither the secret nor its key.
    expect(ran.effects.filter((e) => e.kind === "write")).toHaveLength(0);
    expect(holds(runner.slice, secret)).toBe(false);
    expect(holds(runner.slice, secretPsk(nodeSha256, secret))).toBe(false);
  });

  test("message 4 on the phone's connection; a token that is not live is told it expired", () => {
    const runner = booted();
    offered(runner);
    const opened = runner.send({ kind: "restoreOpened", conn: connId(9), token: TOKEN });
    expect(handshakes(opened)).toEqual([
      {
        identity: formatIdentity(FILE_IDENTITY),
        epoch: 3,
        madeMs: MADE,
        lastChangeMs: LAST_CHANGE,
      },
    ]);
    const stranger = runner.send({
      kind: "restoreOpened",
      conn: connId(10),
      token: tokenId(TOKEN + 1),
    });
    expect(handshakes(stranger)).toEqual([{ ok: false, reason: "expired" }]);
  });

  test("a key of another epoch is wrongKey and the token stays; the right one goes into applyRestore only", () => {
    const runner = booted();
    offered(runner);
    runner.send({ kind: "restoreOpened", conn: connId(9), token: TOKEN });
    const wrong = runner.send({
      kind: "restoreKey",
      conn: connId(9),
      token: TOKEN,
      key: PHONE_KEY,
      epoch: 2,
    });
    expect(handshakes(wrong)).toEqual([{ ok: false, reason: "wrongKey" }]);
    expect(wrong.effects.filter((e) => e.kind === "linkSecret")).toHaveLength(0);
    const right = runner.send({
      kind: "restoreKey",
      conn: connId(9),
      token: TOKEN,
      key: PHONE_KEY,
      epoch: 3,
    });
    expect(job(right)?.work).toEqual({
      kind: "applyRestore",
      upload: { conn: connId(3), job: 4 },
      key: PHONE_KEY,
    });
    // The key is in no slice field and no message.
    const slice = runner.slice;
    expect(
      Object.values(slice.restore ?? {}).some((v) => v instanceof Uint8Array && v[0] === 0x5c),
    ).toBe(false);
    expect(right.messages).toHaveLength(0);
  });

  test("ready: RestoreResult ok first, the token withdrawn, then the switch", () => {
    const runner = booted();
    offered(runner);
    runner.send({ kind: "restoreOpened", conn: connId(9), token: TOKEN });
    const applying = job(
      runner.send({ kind: "restoreKey", conn: connId(9), token: TOKEN, key: PHONE_KEY, epoch: 3 }),
    );
    const ready = runner.send({
      kind: "fileReady",
      job: applying?.job ?? jobId(0),
      outcome: { kind: "restoreReady" },
    });
    expect(
      ready.effects.map((e) => (e.kind === "fileJob" ? `fileJob:${e.work.kind}` : e.kind)),
    ).toEqual(["appSend", "linkSecret", "fileJob:switchRestore"]);
    expect(handshakes(ready)).toEqual([{ ok: true }]);
    expect(ready.effects[1]).toEqual({
      kind: "linkSecret",
      token: TOKEN,
      purpose: "restore",
      askName: false,
      lookup: null,
      psk: null,
    });
  });

  test("a file damaged after its first chunk is badFile; one the hub could not prepare, busy", () => {
    for (const [reason, told] of [
      ["badFile", "badFile"],
      ["io", "busy"],
    ] as const) {
      const runner = booted();
      offered(runner);
      runner.send({ kind: "restoreOpened", conn: connId(9), token: TOKEN });
      const applying = job(
        runner.send({
          kind: "restoreKey",
          conn: connId(9),
          token: TOKEN,
          key: PHONE_KEY,
          epoch: 3,
        }),
      );
      const bad = runner.send({
        kind: "fileReady",
        job: applying?.job ?? jobId(0),
        outcome: { kind: "failed", reason, message: "chunk 3" },
      });
      expect(handshakes(bad)).toEqual([{ ok: false, reason: told }]);
    }
  });

  test("a file the key does not open is wrongKey, and a phone may try again", () => {
    const runner = booted();
    offered(runner);
    runner.send({ kind: "restoreOpened", conn: connId(9), token: TOKEN });
    const applying = job(
      runner.send({ kind: "restoreKey", conn: connId(9), token: TOKEN, key: PHONE_KEY, epoch: 3 }),
    );
    const bad = runner.send({
      kind: "fileReady",
      job: applying?.job ?? jobId(0),
      outcome: { kind: "failed", reason: "wrongKey", message: "decryptFailed" },
    });
    expect(handshakes(bad)).toEqual([{ ok: false, reason: "wrongKey" }]);
    expect(
      handshakes(runner.send({ kind: "restoreOpened", conn: connId(11), token: TOKEN })),
    ).toHaveLength(1);
  });

  test("the token expires after 10 minutes: withdrawn, and the phone mid-way told so", () => {
    const runner = booted();
    offered(runner);
    runner.send({ kind: "restoreOpened", conn: connId(9), token: TOKEN });
    expect(runner.run(10 * MINUTE_US - SECOND_US).effects).toHaveLength(0);
    const expired = runner.run(2 * SECOND_US);
    expect(expired.effects.find((e) => e.kind === "linkSecret")).toMatchObject({
      lookup: null,
      psk: null,
    });
    expect(handshakes(expired)).toEqual([{ ok: false, reason: "expired" }]);
    expect(runner.slice.restore).toBeUndefined();
  });

  test("the restored hub's first start records restored and clears the mark, in one step", () => {
    const runner = new Runner();
    const ran = runner.boot(
      snapshot({
        backupState: { ...BACKUP_STATE_DEFAULTS, restoredFromMs: MADE, lastChangeMs: LAST_CHANGE },
        backupKey: { key: PHONE_KEY, epoch: 3 },
      }),
    );
    expect(decisionKinds(ran)).toEqual(["restored"]);
    const write = ran.effects.find((e) => e.kind === "write" && e.op.table === "backup_state");
    expect(write?.kind === "write" ? write.durability : undefined).toBe("now");
    expect(runner.slice.backup.restoredFromMs).toBeNull();
    // Its people are the file's: the header's age stays the file's.
    expect(runner.slice.backup.lastChangeMs).toBe(LAST_CHANGE);
  });

  test("hsn restore names its upload on its control connection", () => {
    const runner = booted();
    const ran = op(
      runner,
      { op: "restore.start", body: { job: 4 } },
      { kind: "control", request: requestId(2), conn: connId(5) },
    );
    expect(job(ran)?.work).toEqual({ kind: "readRestore", upload: { conn: connId(5), job: 4 } });
  });
});

describe("updates", () => {
  function staged(runner: Runner): void {
    const upload = op(runner, { op: "update.upload", body: { job: 6 } });
    expect(job(upload)?.work).toEqual({ kind: "stageUpdate", upload: { conn: connId(3), job: 6 } });
    const ready = runner.send({
      kind: "fileReady",
      job: job(upload)?.job ?? jobId(0),
      outcome: { kind: "updateStaged", version: "1.1.0" },
    });
    expect(answer(ready)).toEqual({ ok: true, body: { version: "1.1.0" } });
    expect(decisionKinds(ready)).toEqual(["update_staged"]);
    expect(
      ready.effects.find((e) => e.kind === "write" && e.op.table === "update_state"),
    ).toMatchObject({ durability: "now" });
  }

  test("staged, approved, then switched in the next step, written now, with the running version kept", () => {
    const runner = booted();
    runner.send({
      kind: "hubFacts",
      version: "1.0.0",
      addresses: [],
      appsPort: 8444,
      consolePort: 8445,
      certificateSha256: new Uint8Array(32),
    });
    staged(runner);
    const approve = op(runner, { op: "update.approve", body: {} });
    expect(answer(approve)).toEqual({ ok: true, body: { switchWhen: "now" } });
    expect(job(approve)).toBeUndefined();
    const next = runner.run(0);
    expect(decisionKinds(next)).toEqual(["update_switching"]);
    expect(job(next)?.work).toEqual({ kind: "switchUpdate", version: "1.1.0" });
    expect(runner.slice.update.previousVersion).toBe("1.0.0");
    expect(runner.slice.update.switchingMs).not.toBeNull();
  });

  test("never during a countdown: it waits until the countdown has ended", () => {
    const runner = booted();
    staged(runner);
    const alarm = runner.view.alarm;
    const counting = new Map([
      [
        sensorRow().id,
        {
          openedAt: mono(0),
          deadline: mono(30 * SECOND_US),
          newestCounter: 1,
          replyGateway: undefined,
          replyRate: 5,
          cause: seq(1),
          restored: false,
        },
      ],
    ]);
    runner.view = { ...runner.view, alarm: { ...alarm, countdowns: counting } };
    const approve = op(runner, { op: "update.approve", body: {} });
    expect(answer(approve)).toEqual({ ok: true, body: { switchWhen: "after:countdown" } });
    expect(switchBlockedBy(runner.view)).toBe("countdown");
    expect(job(runner.run(10 * MINUTE_US))).toBeUndefined();
    runner.view = { ...runner.view, alarm };
    // The next message after it ended looks again; the switch comes in the step after.
    runner.send({ kind: "tick" });
    expect(job(runner.run(0))?.work.kind).toBe("switchUpdate");
  });

  test("never during a site move", () => {
    const runner = booted();
    staged(runner);
    runner.view = {
      ...runner.view,
      site: {
        ...runner.view.site,
        row: { ...runner.view.site.row, moveId: 1, moveStage: MoveStage.Announcing },
      },
    };
    op(runner, { op: "update.approve", body: {} });
    expect(job(runner.run(MINUTE_US))).toBeUndefined();
  });

  test("a switch the shell refused waits again", () => {
    const runner = booted();
    staged(runner);
    op(runner, { op: "update.approve", body: {} });
    const switching = job(runner.run(0));
    const refused = runner.send({
      kind: "fileReady",
      job: switching?.job ?? jobId(0),
      outcome: { kind: "failed", reason: "io", message: "a countdown started" },
    });
    expect(refused.effects.find((e) => e.kind === "write")).toMatchObject({
      op: { row: { switchingMs: null } },
    });
    expect(job(runner.run(0))?.work.kind).toBe("switchUpdate");
  });

  test("the next start: the version switched to is running, so update_healthy", () => {
    const runner = new Runner();
    runner.boot(
      snapshot({
        backupKey: { key: KEY, epoch: 1 },
        updateState: {
          stagedVersion: "1.1.0",
          stagedMs: WALL0,
          approvedBy: "a",
          approvedMs: WALL0,
          switchingMs: WALL0,
          previousVersion: "1.0.0",
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
    expect(decisionKinds(facts)).toEqual(["update_healthy"]);
    expect(runner.slice.update).toMatchObject({
      stagedVersion: null,
      switchingMs: null,
      previousVersion: "1.0.0",
    });
    // Step 0 owner, wave 2: `update.status` gains `lastResultMs` (frozen), checked as present.
    expect(answer(op(runner, { op: "update.status", body: {} }))).toEqual({
      ok: true,
      body: {
        staged: null,
        approvedBy: null,
        switching: false,
        lastResult: "healthy",
        lastResultMs: expect.any(Number) as unknown as number,
      },
    });
    // Once only: a later hubFacts (a new address) records nothing.
    expect(
      decisionKinds(
        runner.send({
          kind: "hubFacts",
          version: "1.1.0",
          addresses: ["10.0.0.2"],
          appsPort: 8444,
          consolePort: 8445,
          certificateSha256: new Uint8Array(32),
        }),
      ),
    ).toEqual([]);
  });

  test("the next start: the old version is running, so the launcher rolled back: update_rolled_back", () => {
    const runner = new Runner();
    runner.boot(
      snapshot({
        backupKey: { key: KEY, epoch: 1 },
        updateState: {
          stagedVersion: "1.1.0",
          stagedMs: WALL0,
          approvedBy: "a",
          approvedMs: WALL0,
          switchingMs: WALL0,
          previousVersion: "1.0.0",
          lastResult: 0,
          lastResultMs: null,
        },
      }),
    );
    const facts = runner.send({
      kind: "hubFacts",
      version: "1.0.0",
      addresses: [],
      appsPort: 8444,
      consolePort: 8445,
      certificateSha256: new Uint8Array(32),
    });
    expect(decisionKinds(facts)).toEqual(["update_rolled_back"]);
    expect(runner.slice.update.switchingMs).toBeNull();
    expect(runner.slice.update.lastResult).toBe(2);
  });

  test("cancel drops what was staged; nothing to approve then", () => {
    const runner = booted();
    staged(runner);
    expect(answer(op(runner, { op: "update.cancel", body: {} }))).toEqual({ ok: true, body: {} });
    expect(answer(op(runner, { op: "update.approve", body: {} }))).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
  });

  test("a release refused by its signature is invalid", () => {
    const runner = booted();
    const upload = op(runner, { op: "update.upload", body: { job: 6 } });
    const refused = runner.send({
      kind: "fileReady",
      job: job(upload)?.job ?? jobId(0),
      outcome: { kind: "failed", reason: "badSignature", message: "bad" },
    });
    expect(answer(refused)).toMatchObject({
      ok: false,
      error: { code: "invalid", detail: { field: "job" } },
    });
    expect(runner.slice.update.stagedVersion).toBeNull();
  });
});

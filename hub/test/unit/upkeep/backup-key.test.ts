/**
 * The backup key's fault and its fix (m3-design section 4, A8): `backup.key` answers any linked
 * phone at any time with the current key, and records nothing; `backup.keyHeld {epoch}` records the
 * epoch as held, only the current one; the snapshot's `backupKeyEpoch` is the current epoch. So a
 * phone that lost the reply, or failed to write the key, fetches it again, also after a restart.
 *
 * upkeep on its own, given the requests as `app` routes them (`backup.key` a version 1 row, an
 * `opRequest`; `backup.keyHeld` version 2's own, a `v2OpRequest`); then the whole core through a
 * phone's version 2 session, across restarts from what was committed.
 */
import { describe, expect, test } from "bun:test";
import { type AppOp, type AppOpV2, isVersion1Op } from "@hsn/protocol/app";
import type { Effect } from "../../../src/core/model/effects.ts";
import { type ClientId, clientId, type ConnId, connId, seq } from "../../../src/core/model/ids.ts";
import type { Actor, AnswerTo, Internal } from "../../../src/core/model/messages.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { MODULES } from "../../../src/core/step.ts";
import { backupKeyEpoch } from "../../../src/core/upkeep/view.ts";
import {
  ANNA,
  ANNA_LAPTOP,
  ANNA_PHONE,
  client,
  Committed,
  household,
  Hub,
  nowWrites,
  onlyReply,
  testModules,
} from "../people/support/hub.ts";
import { ClientKind, clientRow, type Ran, Runner, snapshot } from "./support.ts";

const KEY = new Uint8Array(32).fill(0xab);
const EPOCH = 3;

// ----- upkeep on its own -----

const PHONE = clientId(5);
const OLD_PHONE = clientId(6);
const BROWSER = clientId(7);
const GONE = clientId(8);
const CONSOLE = clientId(9);

function booted(): Runner {
  const runner = new Runner();
  runner.boot(snapshot({ backupKey: { key: KEY, epoch: EPOCH } }));
  const removed = { ...clientRow(GONE, ClientKind.Phone, EPOCH), removedMs: 1 };
  runner.view = {
    ...runner.view,
    people: {
      ...runner.view.people,
      clients: new Map([
        [PHONE, clientRow(PHONE, ClientKind.Phone, EPOCH)],
        [OLD_PHONE, clientRow(OLD_PHONE, ClientKind.Phone, EPOCH - 1)],
        [BROWSER, clientRow(BROWSER, ClientKind.Web, null)],
        [GONE, removed],
        [CONSOLE, clientRow(CONSOLE, ClientKind.Console, null)],
      ]),
    },
  };
  return runner;
}

/**
 * What `app` sends upkeep for an operation (H1, docs/m3-m4-plan.md step 2): a version 1 row as an
 * `opRequest`, a row only version 2 names as a `v2OpRequest`.
 */
function upkeepRequest(op: AppOpV2, actor: Actor, answerTo: AnswerTo): Internal {
  return isVersion1Op(op.op)
    ? { kind: "opRequest", owner: "upkeep", op: op as AppOp, actor, answerTo, record: seq(0) }
    : { kind: "v2OpRequest", owner: "upkeep", op, actor, answerTo, record: seq(0) };
}

function request(op: AppOpV2, from: ReturnType<typeof clientId> | "computer"): Internal {
  const actor: Actor =
    from === "computer"
      ? { kind: "computer", name: "root" }
      : { kind: "person", person: ANNA, client: from, name: `p (client ${from})` };
  const answerTo: AnswerTo =
    from === "computer"
      ? { kind: "control", request: 1 as never, conn: connId(0) }
      : { kind: "app", conn: connId(40), client: from, id: 1, seq: undefined };
  return upkeepRequest(op, actor, answerTo);
}

function answer(ran: Ran): unknown {
  const found = ran.messages.find((m) => m.kind === "opAnswer");
  return found?.kind === "opAnswer" ? found.outcome : undefined;
}

const UNAUTHORIZED = { ok: false, error: { code: "unauthorized", detail: {} } };
const KEY_REPLY = { ok: true, body: { key: Buffer.from(KEY).toString("base64url"), epoch: EPOCH } };

describe("backup.key: any linked phone, at any time, the current key (m3-design section 4)", () => {
  test("a phone recorded at the current epoch is answered, as one at an older epoch is", () => {
    const runner = booted();
    expect(answer(runner.send(request({ op: "backup.key", body: {} }, PHONE)))).toEqual(KEY_REPLY);
    expect(answer(runner.send(request({ op: "backup.key", body: {} }, OLD_PHONE)))).toEqual(
      KEY_REPLY,
    );
  });

  test("asked again and again: answered each time, and upkeep writes nothing for it", () => {
    const runner = booted();
    for (let i = 0; i < 3; i++) {
      const ran = runner.send(request({ op: "backup.key", body: {} }, PHONE));
      expect(answer(ran)).toEqual(KEY_REPLY);
      expect(ran.effects.filter((e) => e.kind === "write")).toEqual([]);
    }
  });

  test("a browser, the console, a removed phone and the hub computer: unauthorized {}", () => {
    const runner = booted();
    for (const from of [BROWSER, CONSOLE, GONE, "computer"] as const)
      expect([from, answer(runner.send(request({ op: "backup.key", body: {} }, from)))]).toEqual([
        from,
        UNAUTHORIZED,
      ]);
  });
});

describe("backup.keyHeld {epoch}: only the current epoch (m3-design section 4)", () => {
  test("the current epoch: ok {}; one below or above it: invalid {epoch, range}", () => {
    const runner = booted();
    const held = (epoch: number) =>
      answer(runner.send(request({ op: "backup.keyHeld", body: { epoch } }, OLD_PHONE)));
    expect(held(EPOCH)).toEqual({ ok: true, body: {} });
    for (const epoch of [EPOCH - 1, EPOCH + 1, 0])
      expect([epoch, held(epoch)]).toEqual([
        epoch,
        { ok: false, error: { code: "invalid", detail: { field: "epoch", reason: "range" } } },
      ]);
  });

  test("only from a phone: a browser, the console, a removed phone, the hub computer are refused", () => {
    const runner = booted();
    for (const from of [BROWSER, CONSOLE, GONE, "computer"] as const)
      expect([
        from,
        answer(runner.send(request({ op: "backup.keyHeld", body: { epoch: EPOCH } }, from))),
      ]).toEqual([from, UNAUTHORIZED]);
  });

  test("after the key is replaced, the old epoch is stale and the new one accepted", () => {
    const runner = booted();
    runner.send({ kind: "clientRemoved", client: GONE });
    const epoch = runner.slice.key?.epoch;
    expect(epoch).toBe(EPOCH + 1);
    expect(
      answer(runner.send(request({ op: "backup.keyHeld", body: { epoch: EPOCH } }, PHONE))),
    ).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(
      answer(runner.send(request({ op: "backup.keyHeld", body: { epoch: EPOCH + 1 } }, PHONE))),
    ).toEqual({ ok: true, body: {} });
  });
});

describe("the snapshot's backupKeyEpoch (m3-design section 4)", () => {
  test("the current epoch, from upkeep's view; a replacement moves it; null before the boot", () => {
    expect(backupKeyEpoch(new Runner().view)).toBeNull();
    const runner = booted();
    expect(backupKeyEpoch(runner.view)).toBe(EPOCH);
    runner.send({ kind: "clientRemoved", client: GONE });
    expect(backupKeyEpoch(runner.view)).toBe(EPOCH + 1);
  });
});

// ----- the whole core: a phone's version 2 session -----

/** Anna's phone recorded at `held`; the key at `EPOCH`. */
function home(held: number | null) {
  const base = household({
    clients: [
      client(1, null),
      client(7, 1),
      client(8, 1, { kind: ClientKind.Phone, backupKeyEpoch: held }),
    ],
  });
  return { ...base, m2: { ...base.m2, backupKey: { key: KEY, epoch: EPOCH } } };
}

function realHub(): Hub {
  return new Hub(testModules({ upkeep: MODULES.upkeep }));
}

/** A version 2 session of `client` (docs/m3-m4-plan.md: version 2 for the phone). */
function sessionV2(hub: Hub, client: ClientId, conn: ConnId): ConnId {
  hub.input({ kind: "clientConnected", conn, client, listener: "lan", proto: 2, app: "2.0.0" });
  return conn;
}

let nextId = 1;
/** A request on a version 2 session; `seq` for a change. */
function askV2(
  hub: Hub,
  conn: ConnId,
  client: ClientId,
  op: AppOpV2,
  seqOf: number | undefined,
): readonly Effect[] {
  return hub.input({
    kind: "clientRequest",
    conn,
    client,
    request: { id: nextId++, seq: seqOf, op },
  });
}

/**
 * The epochs written for a client, in order (its row is also written for a change's `seq`, which
 * is the stored-reply rule's, M2 5, and keeps the epoch it had).
 */
function epochsWritten(effects: readonly Effect[], of = ANNA_PHONE): readonly (number | null)[] {
  return nowWrites(effects).flatMap((op) =>
    op.table === "clients" && op.op === "upsert" && op.row.id === of ? [op.row.backupKeyEpoch] : [],
  );
}

function epochOf(state: HubState, of = ANNA_PHONE): number | null | undefined {
  return state.people.clients.get(of)?.backupKeyEpoch;
}

/** The next start, from what was committed, with the backup key as it was. */
function restart(committed: Committed): Hub {
  const hub = realHub();
  const snap = committed.snapshot();
  committed.apply(hub.boot({ ...snap, m2: { ...snap.m2, backupKey: { key: KEY, epoch: EPOCH } } }));
  return hub;
}

const INVALID_EPOCH = {
  ok: false,
  error: { code: "invalid", detail: { field: "epoch", reason: "range" } },
};

describe("a phone that lost the reply fetches the key again, across a restart", () => {
  test("held at the current epoch (M2 refused it): answered on a version 2 session; nothing recorded", () => {
    const hub = realHub();
    hub.boot(home(EPOCH));
    const phone = sessionV2(hub, ANNA_PHONE, connId(70));
    const effects = askV2(hub, phone, ANNA_PHONE, { op: "backup.key", body: {} }, undefined);
    expect(onlyReply(effects, phone)).toMatchObject({
      ok: true,
      body: { key: Buffer.from(KEY).toString("base64url"), epoch: EPOCH },
    });
    expect(epochsWritten(effects)).toEqual([]);
  });

  test("lost, the hub restarts, asked again and answered; keyHeld then records it, written now; it survives the next restart", () => {
    const committed = new Committed(home(null));
    const first = realHub();
    committed.apply(first.boot(home(null)));
    const phone = sessionV2(first, ANNA_PHONE, connId(70));
    const lost = askV2(first, phone, ANNA_PHONE, { op: "backup.key", body: {} }, undefined);
    expect(onlyReply(lost, phone)).toMatchObject({ ok: true, body: { epoch: EPOCH } });
    // The reply never reached the phone: the hub records nothing as held.
    expect(epochsWritten(lost)).toEqual([]);
    expect(epochOf(first.state)).toBeNull();
    committed.apply(lost);

    const second = restart(committed);
    expect(epochOf(second.state)).toBeNull();
    const again = sessionV2(second, ANNA_PHONE, connId(71));
    const asked = askV2(second, again, ANNA_PHONE, { op: "backup.key", body: {} }, undefined);
    expect(onlyReply(asked, again)).toMatchObject({
      ok: true,
      body: { key: Buffer.from(KEY).toString("base64url"), epoch: EPOCH },
    });
    expect(epochsWritten(asked)).toEqual([]);
    committed.apply(asked);
    // keyHeld for a stale epoch: refused, nothing recorded; then the current one: recorded, now.
    const stale = askV2(
      second,
      again,
      ANNA_PHONE,
      { op: "backup.keyHeld", body: { epoch: EPOCH - 1 } },
      1,
    );
    expect(onlyReply(stale, again)).toMatchObject(INVALID_EPOCH);
    expect(epochsWritten(stale).filter((e) => e !== null)).toEqual([]);
    committed.apply(stale);
    const held = askV2(
      second,
      again,
      ANNA_PHONE,
      { op: "backup.keyHeld", body: { epoch: EPOCH } },
      2,
    );
    expect(onlyReply(held, again)).toMatchObject({ ok: true, body: {} });
    expect(epochsWritten(held)).toContain(EPOCH);
    expect(epochsWritten(held).filter((e) => e !== null && e !== EPOCH)).toEqual([]);
    expect(epochOf(second.state)).toBe(EPOCH);
    committed.apply(held);

    // It is on the disk: the next start finds the phone holding it, as the snapshot says.
    const third = restart(committed);
    expect(epochOf(third.state)).toBe(EPOCH);
    expect(backupKeyEpoch(third.state)).toBe(EPOCH);
  });

  test("keyHeld from a browser's version 2 session: refused, nothing recorded", () => {
    const hub = realHub();
    hub.boot(home(null));
    const laptop = sessionV2(hub, ANNA_LAPTOP, connId(72));
    const effects = askV2(
      hub,
      laptop,
      ANNA_LAPTOP,
      { op: "backup.keyHeld", body: { epoch: EPOCH } },
      1,
    );
    expect(onlyReply(effects, laptop)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
    expect(epochsWritten(effects, ANNA_LAPTOP).filter((e) => e !== null)).toEqual([]);
    expect(epochOf(hub.state, ANNA_LAPTOP)).toBeNull();
  });

  test("keyHeld above the current epoch: refused, the phone's older epoch kept", () => {
    const hub = realHub();
    hub.boot(home(EPOCH - 1));
    const phone = sessionV2(hub, ANNA_PHONE, connId(73));
    const effects = askV2(
      hub,
      phone,
      ANNA_PHONE,
      { op: "backup.keyHeld", body: { epoch: EPOCH + 1 } },
      1,
    );
    expect(onlyReply(effects, phone)).toMatchObject(INVALID_EPOCH);
    expect(epochsWritten(effects).filter((e) => e !== EPOCH - 1)).toEqual([]);
    expect(epochOf(hub.state)).toBe(EPOCH - 1);
  });
});

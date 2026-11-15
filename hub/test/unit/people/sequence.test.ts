/**
 * The replay rule (m2-design.md section 5, "`seq` gives every change exactly one effect"): a
 * change with a `seq` at or below the client's last is never run again, whether its reply is kept
 * (sent again, `repeat`) or not (`seqTooLow`), before and after a restart; and people's own guards
 * keep an old `seq` from moving the client's last back or replacing a kept reply.
 */
import { describe, expect, test } from "bun:test";
import { changeAnswered, changeSent } from "../../../src/core/people/sequence.ts";
import {
  ANNA_LAPTOP,
  codeOf,
  Committed,
  household,
  Hub,
  nowWrites,
  onlyReply,
} from "./support/hub.ts";
import type { Internal } from "../../../src/core/model/messages.ts";

function booted(): Hub {
  const hub = new Hub();
  hub.boot(household());
  return hub;
}

/** Whether a step sent anything on to an owner (an `opRequest`). */
function forwarded(effects: readonly unknown[]): boolean {
  return effects.some((e) => (e as Internal).kind === "opRequest");
}

describe("a seq at or below the last is not run again (section 5)", () => {
  test("not kept, after a restart: seqTooLow {last}, nothing written, nothing done", () => {
    const committed = new Committed(household());
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    const first = hub.request(conn, ANNA_LAPTOP, { op: "person.create", body: { name: "Cleo" } });
    committed.apply(first.effects);
    for (let i = 0; i < 16; i++)
      committed.apply(
        hub.request(conn, ANNA_LAPTOP, { op: "client.rename", body: { client: 7, name: `n${i}` } })
          .effects,
      );
    const again = new Hub();
    again.boot(committed.snapshot(), 2);
    const conn2 = again.connect(ANNA_LAPTOP);
    const people = again.state.people.people.size;
    const replay = again.request(
      conn2,
      ANNA_LAPTOP,
      { op: "person.create", body: { name: "Dora" } },
      { seq: first.seq ?? 0 },
    );
    expect(onlyReply(replay.effects, conn2)).toMatchObject({
      ok: false,
      error: { code: "seqTooLow", detail: { last: 17 } },
    });
    expect(again.state.people.people.size).toBe(people);
    expect(nowWrites(replay.effects)).toEqual([]);
    expect(again.state.people.clients.get(ANNA_LAPTOP)?.lastSeq).toBe(17);
  });

  test("a seq below the last that was never used is seqTooLow too, not run", () => {
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    hub.request(
      conn,
      ANNA_LAPTOP,
      { op: "client.rename", body: { client: 7, name: "a" } },
      { seq: 5 },
    );
    const low = hub.request(
      conn,
      ANNA_LAPTOP,
      { op: "client.rename", body: { client: 7, name: "b" } },
      { seq: 3 },
    );
    expect(codeOf(onlyReply(low.effects, conn))).toBe("seqTooLow");
    expect(forwarded(low.effects)).toBe(false);
    expect(hub.state.people.clients.get(ANNA_LAPTOP)?.name).toBe("a");
  });

  test("kept: the reply again, marked repeat, and nothing goes to the owner", () => {
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    const first = hub.request(conn, ANNA_LAPTOP, {
      op: "client.rename",
      body: { client: 7, name: "a" },
    });
    hub.request(conn, ANNA_LAPTOP, { op: "client.rename", body: { client: 7, name: "b" } });
    const retry = hub.request(
      conn,
      ANNA_LAPTOP,
      { op: "client.rename", body: { client: 7, name: "a" } },
      { seq: first.seq ?? 0 },
    );
    expect(onlyReply(retry.effects, conn)).toMatchObject({ ok: true, repeat: true });
    expect(forwarded(retry.effects)).toBe(false);
    expect(hub.state.people.clients.get(ANNA_LAPTOP)?.name).toBe("b");
  });
});

describe("people's own guards (`sequence.ts`)", () => {
  test("a request on its way with a seq at or below the last changes nothing", () => {
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    hub.request(
      conn,
      ANNA_LAPTOP,
      { op: "client.rename", body: { client: 7, name: "a" } },
      { seq: 4 },
    );
    const slice = hub.state.people;
    for (const seq of [4, 2]) {
      const sent = changeSent(slice, ANNA_LAPTOP, seq);
      expect(sent.slice).toBe(slice);
      expect(sent.out).toEqual([]);
    }
    expect(changeSent(slice, ANNA_LAPTOP, 5).slice.clients.get(ANNA_LAPTOP)?.lastSeq).toBe(5);
  });

  test("an answer for an old seq with no reply kept changes nothing", () => {
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    hub.request(
      conn,
      ANNA_LAPTOP,
      { op: "client.rename", body: { client: 7, name: "a" } },
      { seq: 4 },
    );
    const slice = hub.state.people;
    const answered = changeAnswered(
      slice,
      { kind: "app", conn, client: ANNA_LAPTOP, id: 9, seq: 2 },
      { ok: true, body: {} },
      16,
    );
    expect(answered.slice).toBe(slice);
    expect(answered.out).toEqual([]);
  });
});

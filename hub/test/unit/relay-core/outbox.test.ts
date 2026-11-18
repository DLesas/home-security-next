/**
 * The push outbox (docs/m4-design.md section 4, "The outbox (D102)"; QR8): which notifications are
 * pushed and to whom, each row as durable as its notification, the burst when the link returns
 * (every critical one and the newest 10 ‡ others per phone, the rest dropped and recorded), late
 * marking, rows too old, results and retries at their edges, and the test push.
 */
import { describe, expect, test } from "bun:test";
import type { OutboxId } from "../../../src/core/model/ids.ts";
import { outboxId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  ANNA_LAPTOP,
  ANNA_PHONE,
  BEN,
  BEN_PHONE,
  BEN_PHONE2,
  CONSOLE_CLIENT,
  countdown,
  DAY_US,
  householdSnapshot,
  hubEvents,
  MINUTE_US,
  ordinary,
  outboxDeletes,
  outboxUpserts,
  personActor,
  pushes,
  relayRunner,
  relaySnapshot,
  type Runner,
  SECOND_US,
  targetRow,
  WALL0,
  writes,
} from "./support.ts";

function upRunner(): Runner {
  const runner = relayRunner();
  runner.up();
  return runner;
}

function ids(runner: Runner): readonly OutboxId[] {
  return [...runner.slice.outbox.keys()];
}

describe("raising: which notifications are pushed, and to whom", () => {
  test("each phone among notify's clients with a valid target gets a row; browsers and the console none", () => {
    const runner = upRunner();
    const raised = runner.raise(
      ordinary([CONSOLE_CLIENT, ANNA_PHONE, ANNA_LAPTOP, BEN_PHONE, ANNA_PHONE]),
    );
    expect(pushes(raised.out).map((p) => p.client)).toEqual([ANNA_PHONE, BEN_PHONE]);
    // BEN_PHONE2 is registered but notify did not name it (its categories, say): no row.
    expect([...runner.slice.outbox.values()].map((p) => p.row.clientId)).toEqual([
      ANNA_PHONE,
      BEN_PHONE,
    ]);
  });

  test("an ordinary notification's rows are routine; a critical one's now; the first send counted", () => {
    const runner = upRunner();
    const quiet = runner.raise(ordinary([ANNA_PHONE]));
    expect(outboxUpserts(quiet.out)).toEqual([
      {
        id: outboxId(1),
        notificationSeq: quiet.row.seq,
        clientId: ANNA_PHONE,
        createdMs: WALL0,
        attempts: 1,
        armed: 0,
        facts: null,
        durability: "routine",
      },
    ]);
    const loud = runner.raise(countdown([ANNA_PHONE]));
    expect(outboxUpserts(loud.out).map((r) => [r.durability, r.attempts])).toEqual([["now", 1]]);
    // Exactly one write per row: the outbox adds no commit of its own.
    expect(writes(loud.out)).toHaveLength(1);
  });

  test("with the link down the rows are written with no attempt, and nothing is sent", () => {
    const runner = relayRunner();
    const raised = runner.raise(countdown([ANNA_PHONE, BEN_PHONE]));
    expect(pushes(raised.out)).toEqual([]);
    expect(outboxUpserts(raised.out).map((r) => [r.clientId, r.attempts, r.durability])).toEqual([
      [ANNA_PHONE, 0, "now"],
      [BEN_PHONE, 0, "now"],
    ]);
  });

  test("relay_unreachable is told to sessions only, never pushed", () => {
    const runner = upRunner();
    const raised = runner.raise({
      kind: "relay_unreachable",
      category: "hub",
      critical: false,
      device: null,
      clients: [ANNA_PHONE],
    });
    expect(raised.out).toEqual([]);
    expect(runner.slice.outbox.size).toBe(0);
  });

  test("a removed phone, and a phone of a removed person, get no row", () => {
    const runner = upRunner();
    runner.removeClient(BEN_PHONE2);
    const people = new Map(runner.view.people.people);
    const ben = people.get(BEN);
    if (ben !== undefined) people.set(BEN, { ...ben, removedMs: WALL0 });
    runner.view = { ...runner.view, people: { ...runner.view.people, people } };
    const raised = runner.raise(ordinary([ANNA_PHONE, BEN_PHONE, BEN_PHONE2]));
    expect(pushes(raised.out).map((p) => p.client)).toEqual([ANNA_PHONE]);
  });

  test("a hub without its app key yet keeps the rows, sends nothing, and sends them once it has one", () => {
    const runner = upRunner();
    const people = runner.view.people;
    runner.view = { ...runner.view, people: { ...people, appStaticPublic: undefined } };
    const raised = runner.raise(countdown([ANNA_PHONE]));
    expect(pushes(raised.out)).toEqual([]);
    expect(outboxUpserts(raised.out).map((r) => [r.attempts, r.durability])).toEqual([[0, "now"]]);
    expect(runner.slice.outbox.get(outboxId(1))?.inFlight).toBe(false);
    runner.view = { ...runner.view, people };
    runner.down();
    expect(pushes(runner.up().out).map((p) => p.id)).toEqual([outboxId(1)]);
  });

  test("with no relay in use nothing is kept, whatever is registered", () => {
    const snapshot = householdSnapshot({ pushTargets: [targetRow(ANNA_PHONE)] });
    const runner = relayRunner(snapshot);
    const before = runner.slice;
    expect(runner.raise(countdown([ANNA_PHONE])).out).toEqual([]);
    expect(runner.slice).toBe(before);
  });
});

describe("results and retries", () => {
  test("accepted deletes the row, routine", () => {
    const runner = upRunner();
    runner.raise(ordinary([ANNA_PHONE]));
    const [id = outboxId(0)] = ids(runner);
    const accepted = runner.results([{ id, outcome: "accepted" }]);
    expect(writes(accepted.out)).toEqual([
      {
        kind: "write",
        durability: "routine",
        op: { table: "push_outbox", op: "delete", key: { id } },
      },
    ]);
    expect(runner.slice.outbox.size).toBe(0);
  });

  test("limited and failed: again after 1, 5, 15 minutes, then every 15, each attempt counted", () => {
    const runner = upRunner();
    runner.raise(countdown([ANNA_PHONE]));
    const [id = outboxId(0)] = ids(runner);
    const waits = [1, 5, 15, 15, 15].map((m) => m * MINUTE_US);
    let attempts = 1;
    for (const [i, wait] of waits.entries()) {
      runner.results([{ id, outcome: i % 2 === 0 ? "limited" : "failed" }]);
      expect(runner.slice.outbox.get(id)?.inFlight).toBe(false);
      // One microsecond early: nothing.
      expect(pushes(runner.run(wait - 1).out)).toEqual([]);
      const again = runner.run(1);
      expect(pushes(again.out).map((p) => p.id)).toEqual([id]);
      attempts += 1;
      expect(outboxUpserts(again.out)).toEqual([
        expect.objectContaining({ id, attempts, durability: "routine" }),
      ]);
    }
    expect(DEFAULT_RULES.relay.retryAfterMs).toEqual([60_000, 300_000, 900_000]);
  });

  test("a retry due while the link is down waits for the link; the link back sends it", () => {
    const runner = upRunner();
    runner.raise(ordinary([ANNA_PHONE]));
    const [id = outboxId(0)] = ids(runner);
    runner.results([{ id, outcome: "failed" }]);
    runner.down();
    expect(runner.timerAt("pushRetry")).toBeUndefined();
    expect(pushes(runner.run(2 * MINUTE_US).out)).toEqual([]);
    expect(pushes(runner.up().out).map((p) => p.id)).toEqual([id]);
  });

  test("a result for no row is ignored; limited for a row not in flight is ignored", () => {
    const runner = upRunner();
    expect(runner.results([{ id: outboxId(99), outcome: "badToken" }]).out).toEqual([]);
    runner.raise(ordinary([ANNA_PHONE]));
    const [id = outboxId(0)] = ids(runner);
    runner.results([{ id, outcome: "limited" }]);
    const timers = runner.slice.timers;
    // Later, a second answer for the same send: the retry stays where the first one set it.
    runner.advance(10 * SECOND_US);
    expect(runner.results([{ id, outcome: "limited" }]).out).toEqual([]);
    expect(runner.slice.timers).toEqual(timers);
  });

  test("accepted for a row sent before the link dropped deletes it: not sent again", () => {
    const runner = upRunner();
    runner.raise(ordinary([ANNA_PHONE]));
    const [id = outboxId(0)] = ids(runner);
    runner.down();
    expect(runner.results([{ id, outcome: "accepted" }]).out).toEqual([
      {
        kind: "write",
        durability: "routine",
        op: { table: "push_outbox", op: "delete", key: { id } },
      },
    ]);
    expect(pushes(runner.up().out)).toEqual([]);
  });

  test("a push in flight when the link drops is sent again when it returns", () => {
    const runner = upRunner();
    runner.raise(countdown([ANNA_PHONE]));
    runner.down();
    expect(runner.slice.outbox.get(outboxId(1))?.inFlight).toBe(false);
    const back = runner.up();
    expect(pushes(back.out).map((p) => p.id)).toEqual([outboxId(1)]);
    expect(outboxUpserts(back.out)[0]?.attempts).toBe(2);
  });
});

describe("the burst when the link returns (QR8)", () => {
  test("per phone every critical row and the newest 10 others, in order; the rest dropped and recorded", () => {
    const runner = relayRunner();
    runner.up();
    runner.down();
    const annaOrdinary: OutboxId[] = [];
    for (let i = 0; i < 12; i++) {
      runner.raise(ordinary([ANNA_PHONE]));
      annaOrdinary.push(outboxId(runner.slice.nextId - 1));
      if (i === 3) runner.raise(countdown([ANNA_PHONE]));
    }
    runner.raise(countdown([ANNA_PHONE, BEN_PHONE]));
    for (let i = 0; i < 3; i++) runner.raise(ordinary([BEN_PHONE]));
    const before = [...runner.slice.outbox.values()];
    const back = runner.up();
    const sent = pushes(back.out);
    const annaSent = sent.filter((p) => p.client === ANNA_PHONE).map((p) => p.id);
    const annaCritical = before
      .filter((p) => p.row.clientId === ANNA_PHONE && p.notice.critical)
      .map((p) => p.row.id);
    expect(annaCritical).toHaveLength(2);
    expect(annaSent).toEqual([...annaCritical, ...annaOrdinary.slice(2)].toSorted((a, b) => a - b));
    expect(sent.filter((p) => p.client === BEN_PHONE)).toHaveLength(4);
    expect(sent.map((p) => p.id)).toEqual([...sent.map((p) => p.id)].toSorted((a, b) => a - b));
    expect(outboxDeletes(back.out)).toEqual(annaOrdinary.slice(0, 2));
    expect(hubEvents(back.out)).toEqual([
      {
        code: "push_dropped",
        durability: "routine",
        level: "info",
        detail: { reason: "burst", rows: 2 },
      },
    ]);
  });

  test("exactly 10 others: nothing dropped, nothing recorded", () => {
    const runner = relayRunner();
    for (let i = 0; i < DEFAULT_RULES.relay.burstOthersPerPhone; i++) {
      runner.raise(ordinary([ANNA_PHONE]));
    }
    const back = runner.up();
    expect(pushes(back.out)).toHaveLength(10);
    expect(outboxDeletes(back.out)).toEqual([]);
    expect(hubEvents(back.out)).toEqual([]);
  });

  test("the rule's number is the one used", () => {
    const rules = { ...DEFAULT_RULES, relay: { ...DEFAULT_RULES.relay, burstOthersPerPhone: 2 } };
    const runner = relayRunner(relaySnapshot(), rules);
    for (let i = 0; i < 3; i++) runner.raise(ordinary([ANNA_PHONE]));
    const back = runner.up();
    expect(pushes(back.out).map((p) => p.id)).toEqual([outboxId(2), outboxId(3)]);
  });
});

describe("late marking (D102)", () => {
  test("delayed only when sent more than 60 s ‡ after it was raised", () => {
    const runner = relayRunner();
    runner.raise(ordinary([ANNA_PHONE]));
    runner.raise(ordinary([BEN_PHONE]));
    runner.advance(60 * SECOND_US);
    runner.up();
    expect(pushes(runner.all).map((p) => p.content.delayed)).toEqual([false, false]);

    const later = relayRunner();
    later.raise(ordinary([ANNA_PHONE]));
    later.advance(60 * SECOND_US + 1000);
    expect(pushes(later.up().out).map((p) => p.content.delayed)).toEqual([true]);
  });

  test("a push sent at once is not delayed", () => {
    const runner = upRunner();
    expect(pushes(runner.raise(countdown([ANNA_PHONE])).out)[0]?.content.delayed).toBe(false);
  });
});

describe("rows too old", () => {
  test("kept until 7 days ‡, dropped at 7 days and recorded; the timer follows the oldest row", () => {
    const runner = relayRunner();
    runner.raise(ordinary([ANNA_PHONE]));
    const first = runner.timerAt("outboxExpiry");
    expect(first).toBe(runner.now.mono + 7 * DAY_US);
    runner.advance(DAY_US);
    runner.raise(ordinary([BEN_PHONE]));
    expect(runner.timerAt("outboxExpiry")).toBe(first);
    const early = runner.run(6 * DAY_US - 1);
    expect(outboxDeletes(early.out)).toEqual([]);
    const due = runner.run(1);
    expect(outboxDeletes(due.out)).toEqual([outboxId(1)]);
    expect(hubEvents(due.out)).toEqual([
      {
        code: "push_dropped",
        durability: "routine",
        level: "info",
        detail: { reason: "age", rows: 1 },
      },
    ]);
    expect(runner.timerAt("outboxExpiry")).toBe(runner.now.mono + DAY_US);
    runner.run(DAY_US);
    expect(runner.slice.outbox.size).toBe(0);
    expect(runner.timerAt("outboxExpiry")).toBeUndefined();
  });

  test("the link back after 7 days sends nothing old", () => {
    const runner = relayRunner();
    runner.raise(countdown([ANNA_PHONE]));
    runner.advance(7 * DAY_US);
    const back = runner.up();
    expect(pushes(back.out)).toEqual([]);
    expect(hubEvents(back.out).map((e) => e.detail)).toEqual([{ reason: "age", rows: 1 }]);
  });
});

describe("push.test", () => {
  test("sent to this phone alone when its target is valid and the link is up; never stored", () => {
    const runner = upRunner();
    const test1 = runner.op({ op: "push.test", body: {} }, personActor(BEN_PHONE));
    expect(test1.answer).toEqual({ ok: true, body: { sent: true } });
    const [push] = pushes(test1.out);
    expect(push?.client).toBe(BEN_PHONE);
    expect(push?.content.n).toEqual({
      seq: test1.record,
      atMs: WALL0,
      clockOk: true,
      kind: "push_test",
      category: "hub",
      critical: false,
      device: null,
      cause: null,
    });
    expect(writes(test1.out)).toEqual([]);
    expect(runner.slice.outbox.size).toBe(0);
    // Accepted: forgotten. A second one takes a new id.
    runner.results([{ id: push?.id ?? outboxId(0), outcome: "accepted" }]);
    expect(runner.slice.tests.size).toBe(0);
    const test2 = runner.op({ op: "push.test", body: {} }, personActor(BEN_PHONE));
    expect(pushes(test2.out)[0]?.id).not.toBe(push?.id);
  });

  test("not sent while the link is down, nor without a valid target", () => {
    const down = relayRunner();
    expect(down.op({ op: "push.test", body: {} }, personActor(ANNA_PHONE)).answer).toEqual({
      ok: true,
      body: { sent: false },
    });
    const none = relayRunner(relaySnapshot([BEN_PHONE]));
    none.up();
    const result = none.op({ op: "push.test", body: {} }, personActor(ANNA_PHONE));
    expect(result.answer).toEqual({ ok: true, body: { sent: false } });
    expect(pushes(result.out)).toEqual([]);
  });

  test("badToken for a test push marks the target invalid", () => {
    const runner = upRunner();
    const sent = runner.op({ op: "push.test", body: {} }, personActor(BEN_PHONE2));
    runner.results([{ id: pushes(sent.out)[0]?.id ?? outboxId(0), outcome: "badToken" }]);
    expect(runner.slice.targets.get(BEN_PHONE2)?.invalidMs).toBe(WALL0);
    expect(runner.op({ op: "push.test", body: {} }, personActor(BEN_PHONE2)).answer).toEqual({
      ok: true,
      body: { sent: false },
    });
  });

  test("a test push in flight when the link drops is forgotten", () => {
    const runner = upRunner();
    runner.op({ op: "push.test", body: {} }, personActor(ANNA_PHONE));
    runner.down();
    expect(runner.slice.tests.size).toBe(0);
    expect(pushes(runner.up().out)).toEqual([]);
  });
});

/**
 * The outbox through an outage and a restart of the hub at every point (docs/m4-design.md section
 * 4, "The outbox (D102)": "what M2 commits now is never lost by a restart and is pushed after it;
 * routine notices may be lost with the last five minutes, as their notification rows already
 * are"; HD 4's crash table). The relay module is rebuilt from the rows a power cut leaves (every
 * write and record up to the last "now" one), and the script carries on:
 *
 * - nothing committed is lost: every notification whose row survived reaches each of its phones
 *   (an `accepted` result), in one run or the other;
 * - nothing is pushed twice: with the routine batch committed by the time of the cut, no phone has
 *   one notification accepted twice; at a power cut that loses the routine delete of an accepted
 *   row, the repeat carries the same `n` (seq, time, kind), which the phone drops (section 4:
 *   "delivery is at least once").
 */
import { describe, expect, test } from "bun:test";
import type { PushContent } from "@hsn/protocol/app";
import { type ClientId, type OutboxId, RECORDS_PER_BOOT } from "../../../src/core/model/ids.ts";
import {
  ArmState,
  type NotificationRow,
  type PushOutboxRow,
  type PushTargetRow,
} from "../../../src/core/model/rows.ts";
import {
  ANNA_PHONE,
  BEN_PHONE,
  bootedView,
  countdown,
  type Item,
  MINUTE_US,
  ordinary,
  relaySnapshot,
  Runner,
  S1,
  S2,
  SECOND_US,
  targetRow,
} from "./support.ts";

type Step = (runner: Runner) => void;

/** An alarm about a sensor (critical). */
function alarm(clients: readonly ClientId[]) {
  return { kind: "alarm", category: "alarm", critical: true, device: S1, clients } as const;
}

/** The first push in flight answered `failed`, the rest `accepted`. */
const oneFails: Step = (r) => {
  const flying = [...r.slice.outbox.values()].filter((p) => p.inFlight).map((p) => p.row.id);
  r.results(flying.map((id, i) => ({ id, outcome: i === 0 ? "failed" : "accepted" })));
};

const SCRIPT: readonly Step[] = [
  (r) => r.up(),
  (r) => r.raise(countdown([ANNA_PHONE, BEN_PHONE], S1)),
  (r) => r.answerAll(),
  (r) => r.raise(ordinary([ANNA_PHONE, BEN_PHONE], S2)),
  (r) => r.down(),
  (r) => r.raise(ordinary([ANNA_PHONE, BEN_PHONE], S1)),
  (r) => {
    r.arm(S1);
  },
  (r) => {
    const cause = r.decision("countdown_started", 30, S2);
    r.raise(countdown([ANNA_PHONE, BEN_PHONE], S2, cause));
  },
  (r) => r.raise(ordinary([ANNA_PHONE], S2)),
  (r) => r.raise(alarm([ANNA_PHONE, BEN_PHONE])),
  (r) => {
    // Disarmed before the link returns: what the late pushes say of `armed` is when they were raised.
    r.arm(S1, ArmState.Disarmed);
  },
  (r) => r.run(200 * SECOND_US),
  (r) => r.up(),
  oneFails,
  (r) => r.run(5 * MINUTE_US),
  (r) => r.answerAll(),
  (r) => r.raise(ordinary([BEN_PHONE], S2)),
  (r) => r.answerAll(),
];

const PHONES = [ANNA_PHONE, BEN_PHONE];

function fresh(): Runner {
  const snapshot = relaySnapshot(PHONES);
  const runner = new Runner(bootedView(snapshot));
  runner.boot(snapshot);
  return runner;
}

interface Committed {
  readonly targets: Map<ClientId, PushTargetRow>;
  readonly outbox: Map<OutboxId, PushOutboxRow>;
  readonly notifications: Map<number, NotificationRow>;
}

/** What is on disk after the first `count` items: written now, or staged before something now. */
function committed(all: readonly Item[], count: number, everything: boolean): Committed {
  const items = all.slice(0, count);
  const durable = (item: Item): boolean =>
    (item.kind === "write" || item.kind === "auditRecord") && item.durability === "now";
  const last = everything ? items.length - 1 : items.findLastIndex(durable);
  const rows: Committed = {
    targets: new Map(PHONES.map((p) => [p, targetRow(p)])),
    outbox: new Map(),
    notifications: new Map(),
  };
  for (const item of items.slice(0, last + 1)) {
    if (item.kind === "auditRecord" && item.record.kind === "notification") {
      rows.notifications.set(item.record.row.seq, item.record.row);
    }
    if (item.kind !== "write") continue;
    const { op } = item;
    if (op.table === "push_outbox") {
      if (op.op === "upsert") rows.outbox.set(op.row.id, op.row);
      else rows.outbox.delete(op.key.id);
    }
    if (op.table === "push_targets") {
      if (op.op === "upsert") rows.targets.set(op.row.clientId, op.row);
      else rows.targets.delete(op.key.clientId);
    }
  }
  return rows;
}

/** One push accepted: to whom, and what it said. */
interface Delivered {
  readonly client: ClientId;
  readonly content: PushContent;
  /** Its place in the run's log. */
  readonly at: number;
}

/** The pushes a run saw accepted, from its log: each result matched with its send. */
function delivered(runner: Runner): readonly Delivered[] {
  const sent = new Map<OutboxId, { client: ClientId; content: PushContent }>();
  const out: Delivered[] = [];
  runner.log.forEach((entry, at) => {
    if ("output" in entry) {
      if (entry.output.kind === "pushSend") {
        sent.set(entry.output.id, { client: entry.output.client, content: entry.output.content });
      }
      return;
    }
    if (entry.input.kind !== "pushResults") return;
    for (const result of entry.input.results) {
      const push = sent.get(result.id);
      if (result.outcome === "accepted" && push !== undefined) out.push({ ...push, at });
      sent.delete(result.id);
    }
  });
  return out;
}

function pairKey(client: ClientId, seq: number): string {
  return `${client}:${seq}`;
}

/** The index in the log at which `all` had `count` items. */
function logIndexOf(runner: Runner, count: number): number {
  let seen = 0;
  for (const [i, entry] of runner.log.entries()) {
    if (seen === count) return i;
    if ("output" in entry) seen += 1;
  }
  return runner.log.length;
}

/** The script without a restart: what each push says when nothing stops. */
const REFERENCE = ((): Runner => {
  const runner = fresh();
  for (const step of SCRIPT) step(runner);
  return runner;
})();

/** Pushes after a restart compared with the run without one. */
let restoredCompared = 0;

/** Repeats seen at power cuts, so the test shows it met the case it allows. */
let repeatsSeen = 0;

function runRestart(k: number, everything: boolean): void {
  const before = fresh();
  for (const step of SCRIPT.slice(0, k + 1)) step(before);
  const rows = committed(before.all, before.all.length, everything);
  const cut = everything
    ? before.all.length
    : before.all.findLastIndex(
        (item) =>
          (item.kind === "write" || item.kind === "auditRecord") && item.durability === "now",
      ) + 1;

  const snapshot = relaySnapshot(
    [...rows.targets.keys()],
    { url: before.slice.settings.url, revision: before.slice.settings.revision },
    { pushTargets: [...rows.targets.values()], pushOutbox: [...rows.outbox.values()] },
    [...rows.notifications.values()],
  );
  const after = new Runner(bootedView(snapshot), undefined, 2);
  after.now = before.now;
  const booted = after.boot(snapshot);
  // Nothing is sent at the start itself: the link is down until the shell joins again.
  expect(booted.effects.filter((e) => e.kind === "pushSend")).toEqual([]);
  // Every committed row with its notification is rebuilt.
  for (const row of rows.outbox.values()) {
    if (rows.notifications.has(row.notificationSeq)) {
      expect(after.slice.outbox.get(row.id)?.row).toEqual(row);
    }
  }
  if (before.slice.link.kind === "up") after.up();
  for (const step of SCRIPT.slice(k + 1)) step(after);
  // Whatever is left waits for the link or a retry: bring it up, and answer everything sent.
  after.up();
  for (let round = 0; round < 4; round++) {
    after.answerAll();
    after.run(20 * MINUTE_US);
  }
  expect(after.slice.outbox.size).toBe(0);

  const both = [...delivered(before), ...delivered(after)];
  // Nothing lost: each committed notification reached each phone that was to get a push of it.
  const raisedAfter = after.all.flatMap((item) =>
    item.kind === "auditRecord" && item.record.kind === "notification" ? [item.record.row.seq] : [],
  );
  const mustReach = new Set<string>();
  const wanted = (seq: number, clients: readonly ClientId[]) => {
    for (const c of clients) mustReach.add(pairKey(c, seq));
  };
  for (const row of rows.outbox.values()) {
    if (rows.notifications.has(row.notificationSeq)) wanted(row.notificationSeq, [row.clientId]);
  }
  for (const d of delivered(before)) {
    if (rows.notifications.has(d.content.n.seq)) wanted(d.content.n.seq, [d.client]);
  }
  const reached = new Set(both.map((d) => pairKey(d.client, d.content.n.seq)));
  for (const pair of mustReach)
    expect({ k, pair, reached: reached.has(pair) }).toEqual({ k, pair, reached: true });
  for (const seq of raisedAfter) {
    for (const p of after.all.filter((i) => i.kind === "pushSend" && i.content.n.seq === seq)) {
      if (p.kind === "pushSend") expect(reached.has(pairKey(p.client, seq))).toBe(true);
    }
  }

  // A push brought back after the restart says what it would have said without one, but `delayed`.
  const reference = new Map<string, PushContent>();
  for (const item of REFERENCE.all) {
    if (item.kind === "pushSend")
      reference.set(pairKey(item.client, item.content.n.seq), item.content);
  }
  for (const item of after.all) {
    if (item.kind !== "pushSend" || item.content.n.seq >= 2 * RECORDS_PER_BOOT) continue;
    restoredCompared += 1;
    const expected: unknown = reference.get(pairKey(item.client, item.content.n.seq));
    const sent: unknown = { ...item.content, delayed: undefined };
    expect({ k, sent }).toEqual({
      k,
      sent: typeof expected === "object" ? { ...expected, delayed: undefined } : expected,
    });
  }

  // Nothing pushed twice.
  const byPair = new Map<string, Delivered[]>();
  for (const d of both) {
    const key = pairKey(d.client, d.content.n.seq);
    byPair.set(key, [...(byPair.get(key) ?? []), d]);
  }
  const cutAt = logIndexOf(before, cut);
  const beforeDelivered = new Set(delivered(before));
  for (const [pair, list] of byPair) {
    if (list.length === 1) continue;
    repeatsSeen += 1;
    // A repeat only where the first run's acceptance came after the last commit…
    expect({ k, pair, everything }).toEqual({ k, pair, everything: false });
    const firsts = list.filter((d) => beforeDelivered.has(d));
    for (const first of firsts) expect(first.at).toBeGreaterThanOrEqual(cutAt);
    // …and it says the same thing, so the phone drops it by hub and seq.
    const ns = list.map((d) => d.content.n);
    for (const n of ns) expect(n).toEqual(list[0]?.content.n ?? n);
  }
}

describe("the outbox through an outage", () => {
  test("without a restart: every push reaches every phone once, the burst marks the late ones", () => {
    const runner = fresh();
    for (const step of SCRIPT) step(runner);
    const list = delivered(runner);
    const pairs = list.map((d) => pairKey(d.client, d.content.n.seq));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(list).toHaveLength(2 + 2 + 2 + 2 + 1 + 2 + 1);
    const late = list.filter((d) => d.content.delayed).map((d) => d.content.n.kind);
    // Everything sent after the outage is late, the two in flight when it began included.
    expect(late.toSorted()).toEqual([
      "alarm",
      "alarm",
      ...Array.from({ length: 5 }, () => "battery_low"),
      "countdown_started",
      "countdown_started",
    ]);
    // Raised while armed, sent after the disarm: they say armed; the countdown its seconds.
    const countdownS2 = list.filter(
      (d) => d.content.n.kind === "countdown_started" && d.content.delayed,
    );
    expect(countdownS2.map((d) => [d.content.armed, d.content.detail])).toEqual([
      [true, { seconds: 30 }],
      [true, { seconds: 30 }],
    ]);
    expect(runner.slice.outbox.size).toBe(0);
  });
});

describe("a restart of the hub at every point of the script", () => {
  test.each(SCRIPT.map((_, k) => [k]))(
    "after step %i, the routine batch committed: nothing lost, nothing pushed twice",
    (k) => {
      runRestart(k, true);
    },
  );

  test.each(SCRIPT.map((_, k) => [k]))(
    "after step %i, at a power cut: what was committed now is pushed; a repeat says the same",
    (k) => {
      runRestart(k, false);
    },
  );

  test("the power cuts above met at least one repeat (an accepted row's delete lost)", () => {
    expect(repeatsSeen).toBeGreaterThan(0);
  });

  test("the restarts above brought pushes back and compared them", () => {
    expect(restoredCompared).toBeGreaterThan(20);
  });
});

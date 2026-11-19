/**
 * `seq` gives every change exactly one effect, at version 2 too (m2-design.md section 5; A8's
 * finding, the coordinator's follow-up 1): every change version 2 adds goes through the same
 * sequence check, kept reply and `lastSeq` as a version 1 change. Sent twice with one `seq` it
 * has one effect and the same reply: on the same connection, after a reconnect, after a restart,
 * and while its first reply is still pending (an answer that comes in a later step, as a file
 * job's does). A `seq` too low is refused as in version 1; `first`, a session's first request, is
 * no different.
 */
import { describe, expect, test } from "bun:test";
import { APP_OPS_V2, type AppOpV2, NEW_OPS_V2 } from "@hsn/protocol/app";
import type { Effect } from "../../../src/core/model/effects.ts";
import { jobId } from "../../../src/core/model/ids.ts";
import { ANNA_PHONE, CONSOLE_CLIENT } from "../people/support/hub.ts";
import { framesTo, PhoneHub, replyTo } from "./support/phone-hub.ts";

/** An Identity (§10): a siren, its chip, firmware 1.2.3, unpaired, a release build. */
const IDENTITY = `f10202a1b2c3d4e5f601020300${"00".repeat(8)}00`;

/** One body for each change only version 2 names (the table fails to compile without a row). */
const CHANGES: { readonly [N in AppOpV2["op"]]?: Extract<AppOpV2, { readonly op: N }>["body"] } = {
  "backup.keyHeld": { epoch: 99 },
  "pair.prepare": { identity: IDENTITY, name: "porch" },
  "pair.finish": { device: 77, result: "f10400" },
  "presence.set": { away: true },
  "push.register": {
    platform: "fcm",
    environment: "development",
    token: "token-1",
    keyId: "0011223344556677",
    key: "A".repeat(43),
  },
  "push.unregister": {},
  "push.test": {},
  "relay.set": { url: "wss://relay.example.org" },
  "update.fetch": { version: "9.9.9" },
  "firmware.fetch": { version: "9.9.9" },
  "firmware.upload": { job: 1 },
  "firmware.remove": { image: 5 },
  "firmware.bluetooth": { device: 11 },
  "rollout.start": { image: 5 },
  "rollout.pause": { rollout: 1 },
  "rollout.resume": { rollout: 1 },
  "rollout.cancel": { rollout: 1 },
};

const NEW_CHANGES = NEW_OPS_V2.filter((op) => APP_OPS_V2[op].change);

function opOf(name: AppOpV2["op"]): AppOpV2 {
  return { op: name, body: CHANGES[name] } as AppOpV2;
}

/** What a step did that counts as an effect of a change: writes, records, jobs. */
function effectsOf(effects: readonly Effect[]): readonly string[] {
  return effects.flatMap((e) =>
    e.kind === "write" ||
    e.kind === "fileJob" ||
    (e.kind === "record" && e.record.kind === "command")
      ? [e.kind === "write" ? `write:${e.op.table}` : e.kind]
      : [],
  );
}

/** A reply without its `id` and `repeat`, which a repeat changes. */
function strip(value: unknown): unknown {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([k]) => k !== "id" && k !== "repeat"),
  );
}

describe("every version 2 change, sent twice with one seq", () => {
  test("the table names every change version 2 adds", () => {
    expect([...NEW_CHANGES].toSorted() as string[]).toEqual(Object.keys(CHANGES).toSorted());
  });

  test.each(NEW_CHANGES)("%s: the same reply, marked repeat, and nothing done again", (name) => {
    const hub = new PhoneHub().boot();
    const conn = hub.connect(ANNA_PHONE);
    const first = hub.request(conn, ANNA_PHONE, opOf(name));
    // From a phone each is answered in its own step (a file job's later answer is below).
    const reply = replyTo(first.effects, conn);
    expect(hub.state.people.clients.get(ANNA_PHONE)?.lastSeq).toBe(first.seq);
    // Again on the same connection, then on a new one, then after a restart.
    const again = hub.request(conn, ANNA_PHONE, opOf(name), { seq: first.seq ?? 0 });
    expect(replyTo(again.effects, conn).repeat).toBe(true);
    expect(strip(replyTo(again.effects, conn))).toEqual(strip(reply));
    expect(effectsOf(again.effects)).toEqual([]);
    const other = hub.connect(ANNA_PHONE);
    const reconnected = hub.request(other, ANNA_PHONE, opOf(name), { seq: first.seq ?? 0 });
    expect(strip(replyTo(reconnected.effects, other))).toEqual(strip(reply));
    expect(effectsOf(reconnected.effects)).toEqual([]);
    const restarted = hub.restart();
    const after = restarted.connect(ANNA_PHONE);
    const retried = restarted.request(after, ANNA_PHONE, opOf(name), { seq: first.seq ?? 0 });
    expect(replyTo(retried.effects, after).repeat).toBe(true);
    expect(strip(replyTo(retried.effects, after))).toEqual(strip(reply));
    expect(effectsOf(retried.effects)).toEqual([]);
  });
});

describe("a change whose reply is still pending", () => {
  test("firmware.upload: a retry waits for the one file job, and is answered with it", () => {
    const hub = new PhoneHub().boot();
    const conn = hub.connect(CONSOLE_CLIENT, 2, "console");
    const first = hub.request(conn, CONSOLE_CLIENT, opOf("firmware.upload"));
    expect(framesTo(first.effects, conn)).toEqual([]);
    const jobs = first.effects.flatMap((e) => (e.kind === "fileJob" ? [e.job] : []));
    expect(jobs).toHaveLength(1);
    // The `seq` is written now, with the request (section 3): a retry is not a new change.
    expect(hub.state.people.clients.get(CONSOLE_CLIENT)?.lastSeq).toBe(first.seq);
    const retry = hub.connect(CONSOLE_CLIENT, 2, "console");
    const again = hub.request(retry, CONSOLE_CLIENT, opOf("firmware.upload"), {
      seq: first.seq ?? 0,
    });
    expect(again.effects.filter((e) => e.kind === "fileJob")).toEqual([]);
    expect(framesTo(again.effects, retry)).toEqual([]);
    const done = hub.input({
      kind: "fileReady",
      job: jobs[0] ?? jobId(0),
      outcome: { kind: "failed", reason: "io", message: "-" },
    });
    const original = replyTo(done, conn);
    const repeated = replyTo(done, retry);
    expect(repeated.repeat).toBe(true);
    expect(strip(repeated)).toEqual(strip(original));
  });
});

describe("a seq too low, and first", () => {
  test("a seq at or below the last whose reply is not kept: seqTooLow {last}, nothing done", () => {
    const hub = new PhoneHub().boot();
    const conn = hub.connect(ANNA_PHONE);
    hub.request(conn, ANNA_PHONE, opOf("presence.set"), { seq: 40 });
    const low = hub.request(conn, ANNA_PHONE, opOf("relay.set"), { seq: 39 });
    expect(replyTo(low.effects, conn)).toMatchObject({
      ok: false,
      error: { code: "seqTooLow", detail: { last: 40 } },
    });
    expect(effectsOf(low.effects)).toEqual([]);
  });

  test("first in message 1 at version 2: replayed on a new session, answered once", () => {
    const hub = new PhoneHub().boot();
    // `first` is the session's first request, given right after `clientConnected` (section 5).
    const one = hub.connect(ANNA_PHONE);
    const first = hub.request(one, ANNA_PHONE, opOf("presence.set"));
    const reply = replyTo(first.effects, one);
    const two = hub.connect(ANNA_PHONE);
    const replayed = hub.request(two, ANNA_PHONE, opOf("presence.set"), { seq: first.seq ?? 0 });
    expect(replyTo(replayed.effects, two).repeat).toBe(true);
    expect(strip(replyTo(replayed.effects, two))).toEqual(strip(reply));
    expect(effectsOf(replayed.effects)).toEqual([]);
  });
});

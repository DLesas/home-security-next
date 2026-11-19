/**
 * Push targets and keys (docs/m4-design.md sections 4, 5 and 9; D126): registering, registering
 * again with a new key, unregistering, a target the push service calls invalid, a client removed;
 * the roster; who may ask; and that a key never reaches a record, an event, a decision or the
 * slice, only the `push_keys` write and the `pushKey` effect.
 */
import { describe, expect, test } from "bun:test";
import { NOT_A_PHONE } from "@hsn/protocol/app";
import { relayAlertContent } from "@hsn/protocol/relay";
import { outboxId } from "../../../src/core/model/ids.ts";
import { pushTargetState } from "../../../src/core/relay/view.ts";
import { hubIdentity } from "../../../src/core/relay/content.ts";
import { PushEnvironmentCode, PushPlatformCode } from "../../../src/core/model/rows.ts";
import {
  S2,
  BEN,
  DAY_US,
  hubEvents,
  ANNA_LAPTOP,
  ANNA_PHONE,
  base64url,
  BEN_PHONE,
  BEN_PHONE2,
  COMPUTER,
  CONSOLE,
  CONSOLE_CLIENT,
  decisions,
  hex,
  householdSnapshot,
  type Item,
  keyIdOf,
  keyOf,
  ordinary,
  personActor,
  pushes,
  relayRunner,
  relaySnapshot,
  rosterClients,
  rosters,
  S1,
  tokenOf,
  WALL0,
  writes,
} from "./support.ts";

function registered() {
  const runner = relayRunner(relaySnapshot([]));
  runner.up();
  return runner;
}

/** Every place a key could leak into: everything but `push_keys` writes and `pushKey` effects. */
function leaks(items: readonly Item[], key: Uint8Array): readonly string[] {
  const text = base64url(key);
  const found: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (value instanceof Uint8Array) {
      if (value.length >= key.length && hex(value).includes(hex(key))) found.push(path);
      return;
    }
    if (typeof value === "string") {
      if (value.includes(text) || value.includes(hex(key))) found.push(path);
      return;
    }
    if (value instanceof Map) {
      for (const [k, v] of value) visit(v, `${path}.${String(k)}`);
      return;
    }
    if (value instanceof Set) {
      for (const v of value) visit(v, `${path}[]`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        visit(v, `${path}[${i}]`);
      });
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
    }
  };
  items.forEach((item, i) => {
    if (item.kind === "pushKey") return;
    if (item.kind === "write" && item.op.table === "push_keys") return;
    if (item.kind === "v2OpRequest") return;
    visit(item, `out[${i}]`);
  });
  return found;
}

describe("push.register", () => {
  test("a phone's first registration: target and key written now, the key to the port, a decision, a roster", () => {
    const runner = registered();
    const result = runner.register(ANNA_PHONE);
    expect(result.answer).toEqual({ ok: true, body: { registered: true } });
    expect(writes(result.out)).toEqual([
      {
        kind: "write",
        durability: "now",
        op: {
          table: "push_targets",
          op: "upsert",
          row: {
            clientId: ANNA_PHONE,
            keyId: keyIdOf(ANNA_PHONE),
            platform: PushPlatformCode.Apns,
            environment: PushEnvironmentCode.Production,
            token: tokenOf(ANNA_PHONE),
            registeredMs: WALL0,
            invalidMs: null,
          },
        },
      },
      {
        kind: "write",
        durability: "now",
        op: {
          table: "push_keys",
          op: "upsert",
          row: { clientId: ANNA_PHONE, key: keyOf(ANNA_PHONE) },
        },
      },
    ]);
    expect(result.effects.filter((e) => e.kind === "pushKey")).toEqual([
      { kind: "pushKey", client: ANNA_PHONE, keyId: keyIdOf(ANNA_PHONE), key: keyOf(ANNA_PHONE) },
    ]);
    expect(decisions(result.out)).toEqual([
      { kind: "push_registered", value: ANNA_PHONE, durability: "now", cause: result.record },
    ]);
    expect(rosterClients(rosters(result.out)[0])).toEqual([ANNA_PHONE]);
    expect(pushTargetState(runner.view, ANNA_PHONE)).toEqual({ registered: true, valid: true });
  });

  test("an FCM token and the development environment are kept as given", () => {
    const runner = registered();
    runner.op(
      {
        op: "push.register",
        body: {
          platform: "fcm",
          environment: "development",
          token: "fcm-token:abc",
          keyId: hex(keyIdOf(BEN_PHONE)),
          key: base64url(keyOf(BEN_PHONE)),
        },
      },
      personActor(BEN_PHONE),
    );
    expect(runner.slice.targets.get(BEN_PHONE)).toMatchObject({
      platform: PushPlatformCode.Fcm,
      environment: PushEnvironmentCode.Development,
      token: "fcm-token:abc",
    });
    const entry = rosters(runner.all).at(-1)?.targets[0];
    expect(entry).toMatchObject({
      platform: "fcm",
      environment: "development",
      token: "fcm-token:abc",
    });
  });

  test("again with a new key and key id: both replaced, the port given the new key, waiting pushes kept", () => {
    const runner = registered();
    runner.register(ANNA_PHONE);
    runner.down();
    runner.raise(ordinary([ANNA_PHONE]));
    const again = runner.register(ANNA_PHONE, { generation: 1 });
    expect(again.answer?.ok).toBe(true);
    expect(runner.slice.targets.get(ANNA_PHONE)?.keyId).toEqual(keyIdOf(ANNA_PHONE, 1));
    expect(runner.slice.targets.get(ANNA_PHONE)?.token).toBe(tokenOf(ANNA_PHONE, 1));
    expect(again.effects.filter((e) => e.kind === "pushKey")).toEqual([
      {
        kind: "pushKey",
        client: ANNA_PHONE,
        keyId: keyIdOf(ANNA_PHONE, 1),
        key: keyOf(ANNA_PHONE, 1),
      },
    ]);
    expect(runner.slice.outbox.size).toBe(1);
    // The link is down: no roster until it is up; then the new key id's.
    expect(rosters(again.out)).toEqual([]);
    const up = runner.up();
    expect(rosters(up.out)[0]?.targets.map((t) => hex(t.keyId))).toEqual([
      hex(keyIdOf(ANNA_PHONE, 1)),
    ]);
    expect(pushes(up.out).map((p) => p.client)).toEqual([ANNA_PHONE]);
  });

  test("a key id another phone's target holds is refused taken; the same phone's own is fine", () => {
    const runner = registered();
    runner.register(ANNA_PHONE);
    const taken = runner.register(BEN_PHONE, { keyId: hex(keyIdOf(ANNA_PHONE)) });
    expect(taken.answer).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "keyId", reason: "taken" } },
    });
    expect(writes(taken.out)).toEqual([]);
    expect(taken.effects.filter((e) => e.kind === "pushKey")).toEqual([]);
    expect(runner.register(ANNA_PHONE).answer?.ok).toBe(true);
  });

  test("a key or key id that does not decode to its size is refused format", () => {
    const runner = registered();
    expect(runner.register(ANNA_PHONE, { keyId: "00".repeat(7) }).answer).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "keyId", reason: "format" } },
    });
    expect(runner.register(ANNA_PHONE, { key: "A".repeat(42) }).answer).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "key", reason: "format" } },
    });
    // 43 characters whose unused low bits are not zero: not a spelling of 32 bytes.
    expect(runner.register(ANNA_PHONE, { key: `${"A".repeat(42)}B` }).answer).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "key", reason: "format" } },
    });
    expect(runner.slice.targets.size).toBe(0);
  });

  test("the key never reaches a record, a decision, a roster, a message or the slice", () => {
    const runner = registered();
    runner.register(ANNA_PHONE);
    runner.raise(ordinary([ANNA_PHONE]));
    runner.answerAll();
    runner.register(ANNA_PHONE, { generation: 1 });
    runner.op({ op: "push.test", body: {} }, personActor(ANNA_PHONE));
    runner.op({ op: "push.unregister", body: {} }, personActor(ANNA_PHONE));
    for (const key of [keyOf(ANNA_PHONE), keyOf(ANNA_PHONE, 1)]) {
      expect(leaks(runner.all, key)).toEqual([]);
      expect(
        leaks(
          [{ kind: "tick" }, ...[runner.slice].map((slice) => ({ kind: "x", slice }) as never)],
          key,
        ),
      ).toEqual([]);
    }
    // The leak check finds a key where one is.
    expect(leaks([{ kind: "x", key: keyOf(ANNA_PHONE) } as never], keyOf(ANNA_PHONE))).not.toEqual(
      [],
    );
  });
});

describe("who may register, unregister and test: the phone itself", () => {
  const ops = [
    { op: "push.unregister", body: {} },
    { op: "push.test", body: {} },
  ] as const;

  test("hsn, the console and a browser are refused unauthorized; nothing written", () => {
    for (const actor of [COMPUTER, CONSOLE, personActor(ANNA_LAPTOP)]) {
      const runner = registered();
      const register = runner.op(
        {
          op: "push.register",
          body: {
            platform: "apns",
            environment: "production",
            token: tokenOf(ANNA_PHONE),
            keyId: hex(keyIdOf(ANNA_PHONE)),
            key: base64url(keyOf(ANNA_PHONE)),
          },
        },
        actor,
      );
      expect(register.answer).toEqual({ ok: false, error: NOT_A_PHONE });
      expect(writes(register.out)).toEqual([]);
      for (const op of ops)
        expect(runner.op(op, actor).answer).toEqual({ ok: false, error: NOT_A_PHONE });
    }
  });

  test("a removed phone is refused", () => {
    const runner = registered();
    runner.removeClient(BEN_PHONE2);
    expect(runner.register(BEN_PHONE2).answer).toEqual({ ok: false, error: NOT_A_PHONE });
  });

  test("the console's client is not a phone, whatever it asks", () => {
    expect(CONSOLE_CLIENT).not.toBe(ANNA_PHONE);
    const runner = registered();
    expect(pushTargetState(runner.view, CONSOLE_CLIENT)).toBeNull();
    expect(pushTargetState(runner.view, ANNA_LAPTOP)).toBeNull();
    expect(pushTargetState(runner.view, ANNA_PHONE)).toEqual({ registered: false, valid: false });
  });
});

describe("push.unregister and a removed client", () => {
  test("unregistering deletes target, key and waiting pushes in one step, records it, a new roster", () => {
    const runner = registered();
    runner.register(ANNA_PHONE);
    runner.register(BEN_PHONE);
    runner.down();
    runner.raise(ordinary([ANNA_PHONE, BEN_PHONE]));
    runner.up();
    const ids = [...runner.slice.outbox.values()]
      .filter((p) => p.row.clientId === ANNA_PHONE)
      .map((p) => p.row.id);
    expect(ids).toHaveLength(1);
    const gone = runner.op({ op: "push.unregister", body: {} }, personActor(ANNA_PHONE));
    expect(gone.answer).toEqual({ ok: true, body: {} });
    expect(writes(gone.out).map((w) => [w.durability, w.op])).toEqual([
      ["routine", { table: "push_outbox", op: "delete", key: { id: ids[0] ?? outboxId(0) } }],
      ["now", { table: "push_targets", op: "delete", key: { clientId: ANNA_PHONE } }],
      ["now", { table: "push_keys", op: "delete", key: { clientId: ANNA_PHONE } }],
    ]);
    expect(gone.effects.filter((e) => e.kind === "pushKey")).toEqual([
      { kind: "pushKey", client: ANNA_PHONE, keyId: keyIdOf(ANNA_PHONE), key: null },
    ]);
    expect(decisions(gone.out)).toEqual([
      { kind: "push_unregistered", value: ANNA_PHONE, durability: "now", cause: gone.record },
    ]);
    expect(rosterClients(rosters(gone.out)[0])).toEqual([BEN_PHONE]);
    expect([...runner.slice.outbox.values()].map((p) => p.row.clientId)).toEqual([BEN_PHONE]);
    expect(pushTargetState(runner.view, ANNA_PHONE)).toEqual({ registered: false, valid: false });
  });

  test("unregistering with no target answers and does nothing", () => {
    const runner = registered();
    const gone = runner.op({ op: "push.unregister", body: {} }, personActor(ANNA_PHONE));
    expect(gone.answer).toEqual({ ok: true, body: {} });
    expect(gone.out.filter((m) => m.kind !== "opAnswer")).toEqual([]);
  });

  test("a removed client's target, key and pushes go in the step of its removal, without a cause", () => {
    const runner = registered();
    runner.register(BEN_PHONE);
    runner.down();
    runner.raise(ordinary([BEN_PHONE]));
    const removed = runner.removeClient(BEN_PHONE);
    expect(writes(removed.out).map((w) => w.op.table)).toEqual([
      "push_outbox",
      "push_targets",
      "push_keys",
    ]);
    expect(decisions(removed.out)).toEqual([
      { kind: "push_unregistered", value: BEN_PHONE, durability: "now", cause: null },
    ]);
    expect(runner.slice.targets.has(BEN_PHONE)).toBe(false);
    expect(runner.slice.outbox.size).toBe(0);
  });

  test("a client removed with no target emits nothing", () => {
    const runner = registered();
    const before = runner.slice;
    expect(runner.removeClient(BEN_PHONE).out).toEqual([]);
    expect(runner.slice).toBe(before);
  });
});

describe("a person removed while their pushes wait", () => {
  test("their phones' pushes are dropped and recorded; nothing of theirs is sent after the step", () => {
    const runner = registered();
    runner.register(BEN_PHONE);
    runner.register(BEN_PHONE2);
    runner.register(ANNA_PHONE);
    runner.down();
    runner.raise(ordinary([ANNA_PHONE, BEN_PHONE, BEN_PHONE2], S2));
    runner.raise(ordinary([BEN_PHONE], S2));
    // `people` removes Ben and both his clients, then tells each client's removal.
    const people = new Map(runner.view.people.people);
    const ben = people.get(BEN);
    if (ben !== undefined) people.set(BEN, { ...ben, removedMs: runner.now.wall });
    runner.view = { ...runner.view, people: { ...runner.view.people, people } };
    const first = runner.removeClient(BEN_PHONE);
    const second = runner.removeClient(BEN_PHONE2);
    expect(hubEvents([...first.out, ...second.out])).toEqual([
      {
        code: "push_dropped",
        durability: "routine",
        level: "info",
        detail: { reason: "removed", rows: 2 },
      },
      {
        code: "push_dropped",
        durability: "routine",
        level: "info",
        detail: { reason: "removed", rows: 1 },
      },
    ]);
    expect(decisions([...first.out, ...second.out]).map((d) => [d.kind, d.value])).toEqual([
      ["push_unregistered", BEN_PHONE],
      ["push_unregistered", BEN_PHONE2],
    ]);
    // Nothing of Ben's after: not at the link's return, not in a new notification, not a roster.
    const mark = runner.all.length;
    runner.up();
    runner.raise(ordinary([ANNA_PHONE, BEN_PHONE, BEN_PHONE2], S2));
    runner.answerAll();
    runner.run(DAY_US);
    const later = runner.all.slice(mark);
    expect(pushes(later).length).toBeGreaterThan(0);
    for (const push of pushes(later)) expect(push.client).toBe(ANNA_PHONE);
    expect(rosters(later).length).toBeGreaterThan(0);
    for (const roster of rosters(later)) expect(rosterClients(roster)).toEqual([ANNA_PHONE]);
  });

  test("a person removed before their clients' removals reach relay: nothing pushed to them meanwhile", () => {
    const runner = registered();
    runner.register(BEN_PHONE);
    const people = new Map(runner.view.people.people);
    const ben = people.get(BEN);
    if (ben !== undefined) people.set(BEN, { ...ben, removedMs: runner.now.wall });
    runner.view = { ...runner.view, people: { ...runner.view.people, people } };
    expect(pushes(runner.raise(ordinary([BEN_PHONE], S2)).out)).toEqual([]);
    expect(runner.slice.outbox.size).toBe(0);
  });
});

describe("an invalid target (badToken)", () => {
  test.each(["notification", "test"] as const)(
    "an old %s push's refusal preserves a refreshed token under the same key",
    (kind) => {
      const runner = registered();
      runner.register(ANNA_PHONE);
      const sent =
        kind === "test"
          ? runner.op({ op: "push.test", body: {} }, personActor(ANNA_PHONE))
          : runner.raise(ordinary([ANNA_PHONE]));
      const id = pushes(sent.out)[0]?.id ?? outboxId(0);
      expect(id).not.toBe(outboxId(0));
      const refreshed = runner.register(ANNA_PHONE, {
        generation: 1,
        keyId: hex(keyIdOf(ANNA_PHONE)),
        key: base64url(keyOf(ANNA_PHONE)),
      });
      expect(refreshed.answer).toMatchObject({ ok: true });
      runner.raise(ordinary([ANNA_PHONE], S1));
      const refused = runner.results([{ id, outcome: "badToken" }]);
      expect(decisions(refused.out)).toEqual([]);
      expect(rosters(refused.out)).toEqual([]);
      expect(pushTargetState(runner.view, ANNA_PHONE)).toEqual({ registered: true, valid: true });
      expect(runner.slice.outbox.size).toBe(kind === "test" ? 1 : 2);
      if (kind === "notification") {
        const retry = runner.run(60_000_000);
        expect(pushes(retry.out).map((push) => push.id)).toEqual([id]);
        runner.results([{ id, outcome: "badToken" }]);
        expect(pushTargetState(runner.view, ANNA_PHONE)?.valid).toBe(false);
      }
    },
  );

  test("marked invalid now, its pushes deleted, recorded, a roster without it; registering makes it valid", () => {
    const runner = registered();
    runner.register(ANNA_PHONE);
    runner.register(BEN_PHONE);
    runner.raise(ordinary([ANNA_PHONE, BEN_PHONE]));
    const anna = [...runner.slice.outbox.values()].find((p) => p.row.clientId === ANNA_PHONE);
    runner.advance(1_000_000);
    const refused = runner.results([{ id: anna?.row.id ?? (0 as never), outcome: "badToken" }]);
    expect(writes(refused.out).map((w) => [w.durability, w.op.table, w.op.op])).toEqual([
      ["routine", "push_outbox", "delete"],
      ["now", "push_targets", "upsert"],
    ]);
    expect(runner.slice.targets.get(ANNA_PHONE)?.invalidMs).toBe(WALL0 + 1000);
    expect(decisions(refused.out)).toEqual([
      { kind: "push_target_invalid", value: ANNA_PHONE, durability: "now", cause: null },
    ]);
    expect(rosterClients(rosters(refused.out)[0])).toEqual([BEN_PHONE]);
    expect(pushTargetState(runner.view, ANNA_PHONE)).toEqual({ registered: true, valid: false });
    // No new push for it while invalid; the key stays with the port.
    expect(refused.effects.filter((e) => e.kind === "pushKey")).toEqual([]);
    expect(
      pushes(runner.raise(ordinary([ANNA_PHONE, BEN_PHONE])).out).map((p) => p.client),
    ).toEqual([BEN_PHONE]);
    // A second badToken for it records nothing more.
    const ben = [...runner.slice.outbox.values()].find((p) => p.row.clientId === BEN_PHONE);
    runner.answerAll("accepted");
    expect(ben).toBeDefined();
    runner.register(ANNA_PHONE, { generation: 1 });
    expect(pushTargetState(runner.view, ANNA_PHONE)).toEqual({ registered: true, valid: true });
    expect(pushes(runner.raise(ordinary([ANNA_PHONE])).out).map((p) => p.client)).toEqual([
      ANNA_PHONE,
    ]);
  });

  test("badToken for a target already invalid records nothing more", () => {
    const runner = registered();
    runner.register(ANNA_PHONE);
    runner.raise(ordinary([ANNA_PHONE]));
    runner.raise(ordinary([ANNA_PHONE], S1));
    const ids = [...runner.slice.outbox.keys()];
    runner.results([{ id: ids[0] ?? (0 as never), outcome: "badToken" }]);
    expect(runner.slice.outbox.size).toBe(0);
    const again = runner.results([{ id: ids[1] ?? (0 as never), outcome: "badToken" }]);
    expect(again.out).toEqual([]);
  });
});

describe("the roster", () => {
  test("every valid target of a live phone, by client, each with the relay's two alerts", () => {
    const snapshot = relaySnapshot();
    const runner = relayRunner(snapshot);
    const up = runner.up();
    const [roster] = rosters(up.out);
    expect(roster?.rev).toBe(1);
    expect(rosterClients(roster)).toEqual([ANNA_PHONE, BEN_PHONE, BEN_PHONE2]);
    const hub = hubIdentity(runner.view, runner.deps) ?? "";
    expect(hub).toMatch(/^[a-z2-7]{26}$/u);
    for (const target of roster?.targets ?? []) {
      expect(target.unreachable).toEqual(relayAlertContent("unreachable", hub, false));
      expect(target.back).toEqual(relayAlertContent("back", hub, false));
      expect(target.platform).toBe("apns");
      expect(target.token).toBe(tokenOf(target.client));
    }
  });

  test("not sent while the link is down; sent when it comes up", () => {
    const runner = relayRunner(relaySnapshot([]));
    expect(rosters(runner.register(ANNA_PHONE).out)).toEqual([]);
    expect(rosterClients(rosters(runner.up().out)[0])).toEqual([ANNA_PHONE]);
  });

  test("leaves out an invalid target and a removed phone's", () => {
    const snapshot = householdSnapshot({
      relaySettings: { url: "ws://127.0.0.1:8480", revision: 1 },
      pushTargets: [
        {
          clientId: ANNA_PHONE,
          keyId: keyIdOf(ANNA_PHONE),
          platform: 0,
          environment: 0,
          token: tokenOf(ANNA_PHONE),
          registeredMs: WALL0,
          invalidMs: WALL0,
        },
        {
          clientId: BEN_PHONE,
          keyId: keyIdOf(BEN_PHONE),
          platform: 0,
          environment: 0,
          token: tokenOf(BEN_PHONE),
          registeredMs: WALL0,
          invalidMs: null,
        },
      ],
    });
    const runner = relayRunner(snapshot);
    expect(rosterClients(rosters(runner.up("ws://127.0.0.1:8480").out)[0])).toEqual([BEN_PHONE]);
  });

  test("sent again, with the alerts' `armed`, when whether any sensor is armed changes", () => {
    const runner = relayRunner();
    runner.up();
    runner.arm(S1);
    const armed = runner.send({ kind: "armedChanged", sensor: S1, arm: 1, cause: undefined });
    expect(rosters(armed.out)[0]?.targets[0]?.unreachable.armed).toBe(true);
    expect(rosters(armed.out)[0]?.rev).toBe(2);
    // A second sensor armed changes nothing the alerts say: no roster.
    expect(runner.send({ kind: "armedChanged", sensor: S1, arm: 1, cause: undefined }).out).toEqual(
      [],
    );
    runner.arm(S1, 0);
    const disarmed = runner.send({ kind: "armedChanged", sensor: S1, arm: 0, cause: undefined });
    expect(rosters(disarmed.out)[0]?.targets[0]?.back.armed).toBe(false);
  });
});

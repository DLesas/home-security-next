/**
 * Step 1, wave 2 (m2-design.md section 11, "Step 1, wave 2: questions settled"), owner A3:
 * `clientRefused` recorded, `hsn open`'s `consoleTokenWait`, and the snapshot's configuration as a
 * restricted person may see it.
 */
import { describe, expect, test } from "bun:test";
import { SESSION_LIMITS } from "@hsn/protocol/app";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { ClientRefusalReason } from "../../../src/core/model/events.ts";
import {
  connId,
  groupId,
  modeId,
  scheduleId,
  tokenId,
  type DeviceId,
} from "../../../src/core/model/ids.ts";
import { ScheduleAction, type ScheduleRow } from "../../../src/core/model/rows.ts";
import { MODULES } from "../../../src/core/step.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import {
  ANNA,
  BEN,
  BEN_LAPTOP,
  bodyOf,
  entropy,
  FRONT,
  GARAGE,
  household,
  Hub,
  onlyReply,
  permission,
  role,
  SECOND,
  testModules,
  ANNA_LAPTOP,
  ANNA_PHONE,
  emitter,
} from "../people/support/hub.ts";

function booted(): Hub {
  const hub = new Hub();
  hub.boot(household());
  return hub;
}

function refusedRecords(effects: readonly Effect[]) {
  return effects.flatMap((e) =>
    e.kind === "record" && e.record.kind === "hubEvent" && e.record.row.code === "client_refused"
      ? [{ durability: e.durability, level: e.record.row.level }]
      : [],
  );
}

const REASONS: readonly ClientRefusalReason[] = [
  "unknownKey",
  "removedKey",
  "consoleOnLan",
  "noVersion",
  "timeout",
  "malformed",
  "rateLimited",
  "unknownToken",
];

describe("clientRefused: client_refused, routine info, the warning now (D112)", () => {
  test.each([...REASONS])("%s is one routine info record", (reason) => {
    const hub = booted();
    const effects = hub.input({ kind: "clientRefused", address: "10.0.0.9", reason, count: 1 });
    expect(refusedRecords(effects)).toEqual([{ durability: "routine", level: "info" }]);
  });

  test("past 10 in an hour from one address, one warning, written now; then info again", () => {
    const hub = booted();
    const levels: string[] = [];
    for (let i = 0; i < 14; i++) {
      const effects = hub.input({
        kind: "clientRefused",
        address: "10.0.0.9",
        reason: "unknownKey",
        count: 1,
      });
      for (const r of refusedRecords(effects)) {
        expect(r.durability).toBe(r.level === "warning" ? "now" : "routine");
        levels.push(r.level);
      }
      hub.at = (hub.at + 60 * SECOND) as typeof hub.at;
    }
    const at = SESSION_LIMITS.refusedWarningPerHour;
    expect(levels).toEqual([
      ...Array<string>(at).fill("info"),
      "warning",
      ...Array<string>(14 - at - 1).fill("info"),
    ]);
  });

  test("a minute's count counts; another address, and the next hour, count on their own", () => {
    const hub = booted();
    const big = hub.input({
      kind: "clientRefused",
      address: "many",
      reason: "rateLimited",
      count: 500,
    });
    expect(refusedRecords(big)).toEqual([{ durability: "now", level: "warning" }]);
    const other = hub.input({
      kind: "clientRefused",
      address: "10.0.0.2",
      reason: "timeout",
      count: 1,
    });
    expect(refusedRecords(other).map((r) => r.level)).toEqual(["info"]);
    hub.at = (hub.at + 3_601 * SECOND) as typeof hub.at;
    const later = hub.input({
      kind: "clientRefused",
      address: "many",
      reason: "rateLimited",
      count: 500,
    });
    expect(refusedRecords(later).map((r) => r.level)).toEqual(["warning"]);
  });

  test("hammering writes one record per input, and info never now", () => {
    const hub = booted();
    for (let i = 0; i < 200; i++) {
      const effects = hub.input({
        kind: "clientRefused",
        address: `10.0.${i % 70}.1`,
        reason: "malformed",
        count: 1,
      });
      const records = refusedRecords(effects);
      expect(records).toHaveLength(1);
      for (const r of records) if (r.level === "info") expect(r.durability).toBe("routine");
    }
  });
});

describe('consoleTokenWait (section 11, wave 2: "Knowing the page was read")', () => {
  const SECRET = new Uint8Array(16).fill(0x3c);

  function token(hub: Hub): number {
    const effects = hub.command({ kind: "consoleToken" }, entropy(SECRET));
    const respond = effects.find((e) => e.kind === "respond");
    const result =
      respond?.kind === "respond" && respond.reply.ok ? respond.reply.result : undefined;
    return result?.kind === "consoleToken" ? result.token : 0;
  }

  function wait(hub: Hub, t: number): readonly Effect[] {
    return hub.command({ kind: "consoleTokenWait", token: t });
  }

  function used(effects: readonly Effect[]): readonly unknown[] {
    return effects.flatMap((e) =>
      e.kind === "respond" && e.reply.ok && e.reply.result.kind === "consoleTokenWait"
        ? [e.reply.result.used]
        : [],
    );
  }

  test("a live token: no answer until its use, then {used: true}", () => {
    const hub = booted();
    const t = token(hub);
    expect(used(wait(hub, t))).toEqual([]);
    const linked = hub.input({
      kind: "linkCompleted",
      conn: connId(70),
      token: tokenId(t),
      staticKey: new Uint8Array(32).fill(0x61),
      listener: "console",
      link: { name: "console", kind: "web" },
    });
    expect(used(linked)).toEqual([true]);
    // Asked after its use, the same answer at once.
    expect(used(wait(hub, t))).toEqual([true]);
  });

  test("a live token that expires unused: {used: false}", () => {
    const hub = booted();
    const t = token(hub);
    wait(hub, t);
    expect(used(hub.advance(2 * 60 * 1000))).toEqual([false]);
  });

  test("an unknown number and a link token's both answer {used: false} at once, with no secret", () => {
    const hub = booted();
    const anna = hub.connect(7 as never);
    hub.request(anna, 7 as never, { op: "link.create", body: { kind: "ownDevice", form: "qr" } });
    const unknown = wait(hub, 999);
    const link = wait(hub, 1);
    expect(used(unknown)).toEqual([false]);
    expect(used(link)).toEqual([false]);
    const text = JSON.stringify([...unknown, ...link].filter((e) => e.kind === "respond"));
    expect(text).not.toContain(Buffer.from(SECRET).toString("base64url"));
    expect(text).not.toContain("console=");
    expect(hub.state.people.tokens.size).toBe(1);
  });
});

describe("the snapshot's configuration, as a restricted person sees it (section 5)", () => {
  function schedule(id: number, target: Partial<ScheduleRow>): ScheduleRow {
    return {
      id: scheduleId(id),
      name: `entry ${id}`,
      action: ScheduleAction.Arm,
      modeId: null,
      groupId: null,
      sensorId: null,
      localTime: 22 * 60,
      days: 0b111_1111,
      date: null,
      enabled: true,
      createdBy: "Anna (client 7)",
      lastRunMs: null,
      lastRunLocalDate: null,
      missedDueMs: null,
      missedWhy: null,
      missedCount: 0,
      revision: 0,
      ...target,
    };
  }

  function configured(): Hub {
    const hub = new Hub(testModules({ layout: MODULES.layout, schedules: MODULES.schedules }));
    const base = household({
      userManagement: true,
      roles: [role(ANNA, true, true), role(BEN, false, false)],
      permissions: [permission(BEN, FRONT, false, true)],
    });
    const member = (group: number, sensor: DeviceId) => ({
      groupId: groupId(group),
      sensorId: sensor,
    });
    hub.boot({
      ...base,
      m2: {
        ...base.m2,
        groups: [
          { id: groupId(1), name: "Front", allSirens: true, revision: 0 },
          { id: groupId(2), name: "Garage", allSirens: true, revision: 0 },
          { id: groupId(3), name: "Both", allSirens: true, revision: 0 },
        ],
        groupMembers: [member(1, FRONT), member(2, GARAGE), member(3, FRONT), member(3, GARAGE)],
        schedules: [
          schedule(1, { sensorId: FRONT }),
          schedule(2, { sensorId: GARAGE }),
          schedule(3, { groupId: groupId(2) }),
          schedule(4, { groupId: groupId(3) }),
          schedule(5, { action: ScheduleAction.SwitchMode, modeId: modeId(1) }),
        ],
      },
    });
    return hub;
  }

  test("every mode; groups with only viewable sensors; entries aimed at hidden targets left out", () => {
    const hub = configured();
    const ben = hub.connect(BEN_LAPTOP);
    const snapshot = bodyOf(
      onlyReply(hub.request(ben, BEN_LAPTOP, { op: "snapshot", body: {} }).effects, ben),
    );
    expect((snapshot.modes as { id: number }[]).map((m) => m.id)).toEqual([1, 2]);
    expect(
      (snapshot.groups as { id: number; sensors: number[] }[]).map((g) => [g.id, g.sensors]),
    ).toEqual([
      [1, [FRONT]],
      [2, []],
      [3, [FRONT]],
    ]);
    expect((snapshot.schedules as { id: number }[]).map((s) => s.id)).toEqual([1, 4, 5]);
  });

  test("someone who may view everything sees every sensor and entry", () => {
    const hub = configured();
    const console = hub.connect(1 as never, "console");
    const snapshot = bodyOf(
      onlyReply(hub.request(console, 1 as never, { op: "snapshot", body: {} }).effects, console),
    );
    expect((snapshot.groups as { sensors: number[] }[]).map((g) => g.sensors)).toEqual([
      [FRONT],
      [GARAGE],
      [FRONT, GARAGE],
    ]);
    expect((snapshot.schedules as { id: number }[]).map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("wave 2: the warning's bound, backupKeyChanged, retention", () => {
  /**
   * Steps the refusals made commit (HD 4): those with a `client_refused` record, or `audit`'s
   * notice that the cap was reached, written now. (Other modules' own now items, a sensor silent
   * in this household, are not the refusals' doing.)
   */
  function nowSteps(hub: Hub, from: number): number {
    return hub.steps
      .slice(from)
      .filter((effects) =>
        effects.some(
          (e) =>
            e.kind === "record" &&
            e.durability === "now" &&
            e.record.kind === "hubEvent" &&
            (e.record.row.code === "client_refused" || e.record.row.code === "warning_cap_reached"),
        ),
      ).length;
  }

  test("an hour of hammering from one address: one now commit, its warning", () => {
    const hub = booted();
    const from = hub.steps.length;
    for (let minute = 0; minute < 60; minute++) {
      hub.input({ kind: "clientRefused", address: "10.0.0.9", reason: "unknownKey", count: 1_000 });
      hub.at = (hub.at + 60 * SECOND) as typeof hub.at;
    }
    expect(nowSteps(hub, from)).toBe(1);
  });

  test("an hour from more than 64 addresses, each new, plus many: at most 61 now commits", () => {
    const hub = booted();
    const from = hub.steps.length;
    for (let minute = 0; minute < 60; minute++) {
      for (let a = 0; a < 64; a++)
        hub.input({
          kind: "clientRefused",
          address: `10.${minute}.${a}.1`,
          reason: "malformed",
          count: 1_000,
        });
      hub.input({ kind: "clientRefused", address: "many", reason: "rateLimited", count: 1_000 });
      hub.at = (hub.at + 60 * SECOND) as typeof hub.at;
    }
    // `audit`'s cap: 60 ‡ warnings an hour for `core/app` now, and its one notice that the cap
    // was reached; every other warning goes into the routine batch.
    expect(nowSteps(hub, from)).toBeLessThanOrEqual(61);
  });

  test("backupKeyChanged goes to the phones' sessions only, with the new epoch", () => {
    const replaced: Internal = {
      kind: "auditRecord",
      durability: "now",
      record: {
        kind: "decision",
        row: {
          seq: 2 ** 32 + 77,
          atMs: 1_000,
          clockOk: true,
          kind: "backup_key_replaced",
          deviceId: null,
          causeSeq: null,
          value: 3,
          detail: null,
        } as never,
      },
    };
    const hub = new Hub(testModules({ upkeep: emitter("upkeep", [replaced]) }));
    hub.boot(household());
    const phone = hub.connect(ANNA_PHONE);
    const laptop = hub.connect(ANNA_LAPTOP);
    const effects = hub.input({ kind: "tick" });
    const evs = (conn: typeof phone) =>
      effects.flatMap((e) =>
        e.kind === "appSend" && e.conn === conn && "t" in e.message && e.message.t === "evt"
          ? [[e.message.ev, e.message.body]]
          : [],
      );
    expect(evs(phone)).toEqual([["backupKeyChanged", { epoch: 3 }]]);
    expect(evs(laptop)).toEqual([]);
  });

  test("site.set takes both retentions, and the site shows them", () => {
    const hub = booted();
    const anna = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(anna, ANNA_LAPTOP, {
        op: "site.set",
        body: { retentionRoutineDays: 14, retentionEventDays: 400 },
      }).effects,
      anna,
    );
    expect(reply).toMatchObject({
      ok: true,
      body: { retentionRoutineDays: 14, retentionEventDays: 400 },
    });
    expect(hub.state.site.row.retentionRoutineDays).toBe(14);
  });
});

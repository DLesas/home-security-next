/**
 * What each push says, per recipient (docs/m4-design.md section 5; D76, D96, D102, O15; m3-design
 * section 6): Disarm only for someone who may manage the sensor, Arm away for a presence offer,
 * nothing a recipient may not see, `armed` as it was when raised, the decision's facts, the size
 * rule, and household-typed names only where the design puts them.
 */
import { describe, expect, test } from "bun:test";
import { pushContent, type PushContent } from "@hsn/protocol/app";
import { eventAtDetail } from "@hsn/protocol/records";
import { PRESENCE_OFFER_KINDS, PRESENCE_OFFERS } from "../../../src/core/relay/content.ts";
import { DEFAULT_RULES, type HubRules } from "../../../src/core/model/rules.ts";
import { ArmState } from "../../../src/core/model/rows.ts";
import { outboxId, type Seq } from "../../../src/core/model/ids.ts";
import {
  ANNA,
  ANNA_PHONE,
  BEN_PHONE,
  countdown,
  DAY_US,
  DEVICE_NAMES,
  hubEvents,
  type Item,
  NIGHT_MODE,
  ordinary,
  outboxDeletes,
  pushes,
  R1,
  relayRunner,
  relaySnapshot,
  rosters,
  type Runner,
  S1,
  S2,
  S3,
  SECOND_US,
} from "./support.ts";

function upRunner(rules?: HubRules): Runner {
  const runner = relayRunner(relaySnapshot(), rules);
  runner.up();
  return runner;
}

function byClient(items: readonly Item[]): ReadonlyMap<number, PushContent> {
  return new Map(pushes(items).map((p) => [p.client, p.content]));
}

/** Every name the household typed in this test's snapshot (people, clients, devices, a mode). */
const TYPED = [
  "Anna",
  "Ben",
  "Anna's phone",
  "Anna's laptop",
  "Ben's phone",
  "Ben's old phone",
  "Night at Anna's",
  ...Object.values(DEVICE_NAMES),
];

/** The content's JSON with its `names` taken out: where no typed name may be. */
function outsideNames(content: PushContent): string {
  return JSON.stringify({ ...content, names: undefined });
}

describe("actions: Disarm for those who may disarm the trigger (D76)", () => {
  test("a countdown on S1: Disarm for Anna (manages S1), none for Ben (views S1 only)", () => {
    const runner = upRunner();
    const sent = byClient(runner.raise(countdown([ANNA_PHONE, BEN_PHONE], S1)).out);
    expect(sent.get(ANNA_PHONE)?.actions).toEqual(["disarm"]);
    expect(sent.get(BEN_PHONE)?.actions).toEqual([]);
  });

  test("a countdown on S2: Disarm for both (Ben manages S2)", () => {
    const runner = upRunner();
    const sent = byClient(runner.raise(countdown([ANNA_PHONE, BEN_PHONE], S2)).out);
    expect(sent.get(ANNA_PHONE)?.actions).toEqual(["disarm"]);
    expect(sent.get(BEN_PHONE)?.actions).toEqual(["disarm"]);
  });

  test("an alarm offers Disarm as a countdown does; an ordinary notification offers nothing", () => {
    const runner = upRunner();
    const alarm = byClient(
      runner.raise({
        kind: "alarm",
        category: "alarm",
        critical: true,
        device: S1,
        clients: [ANNA_PHONE, BEN_PHONE],
      }).out,
    );
    expect(alarm.get(ANNA_PHONE)?.actions).toEqual(["disarm"]);
    expect(alarm.get(BEN_PHONE)?.actions).toEqual([]);
    const battery = byClient(runner.raise(ordinary([ANNA_PHONE], S1)).out);
    expect(battery.get(ANNA_PHONE)?.actions).toEqual([]);
  });

  test("a countdown naming no device offers nothing", () => {
    const runner = upRunner();
    const sent = byClient(
      runner.raise({
        kind: "countdown_started",
        category: "countdown",
        critical: true,
        device: null,
        clients: [ANNA_PHONE],
      }).out,
    );
    expect(sent.get(ANNA_PHONE)?.actions).toEqual([]);
  });
});

describe("presence offers (m3-design section 6, F16)", () => {
  test("an away offer carries Arm away for everyone it goes to", () => {
    expect(PRESENCE_OFFERS).toEqual({
      [PRESENCE_OFFER_KINDS.armAway]: "armAway",
      [PRESENCE_OFFER_KINDS.disarm]: "disarm",
    });
    const runner = upRunner();
    const sent = byClient(
      runner.raise({
        kind: PRESENCE_OFFER_KINDS.armAway,
        category: "armDisarm",
        critical: false,
        device: null,
        clients: [ANNA_PHONE, BEN_PHONE],
      }).out,
    );
    expect(sent.get(ANNA_PHONE)?.actions).toEqual(["armAway"]);
    expect(sent.get(BEN_PHONE)?.actions).toEqual(["armAway"]);
  });

  test("a disarm offer carries Disarm only to someone who may manage a sensor that is armed", () => {
    const runner = upRunner();
    const offer = {
      kind: PRESENCE_OFFER_KINDS.disarm,
      category: "armDisarm",
      critical: false,
      device: null,
      clients: [ANNA_PHONE, BEN_PHONE],
    } as const;
    // Nothing armed: no Disarm for anyone.
    let sent = byClient(runner.raise(offer).out);
    expect(sent.get(ANNA_PHONE)?.actions).toEqual([]);
    // S1 armed: Anna manages it, Ben only views it.
    runner.arm(S1);
    sent = byClient(runner.raise(offer).out);
    expect(sent.get(ANNA_PHONE)?.actions).toEqual(["disarm"]);
    expect(sent.get(BEN_PHONE)?.actions).toEqual([]);
    // S2 armed too (waiting for its door counts as armed): Ben manages that.
    runner.arm(S2, ArmState.WaitsForCloseAfterArming);
    sent = byClient(runner.raise(offer).out);
    expect(sent.get(BEN_PHONE)?.actions).toEqual(["disarm"]);
  });
});

describe("nothing a recipient may not see", () => {
  test("the device's name for those who may view it; a siren's for everyone", () => {
    const runner = upRunner();
    const sensor = byClient(runner.raise(ordinary([ANNA_PHONE, BEN_PHONE], S1)).out);
    expect(sensor.get(ANNA_PHONE)?.names).toEqual({ device: "front-door" });
    expect(sensor.get(BEN_PHONE)?.names).toEqual({ device: "front-door" });
    const siren = byClient(
      runner.raise({
        kind: "siren_silent",
        category: "sirenSilent",
        critical: false,
        device: R1,
        clients: [BEN_PHONE],
      }).out,
    );
    expect(siren.get(BEN_PHONE)?.names).toEqual({ device: "hall-siren" });
  });

  test("a push waiting while the recipient's view was taken away is not sent, and its row goes", () => {
    const runner = relayRunner();
    runner.raise(ordinary([ANNA_PHONE, BEN_PHONE], S1));
    runner.forbid(ANNA, S1);
    const back = runner.up();
    expect(pushes(back.out).map((p) => p.client)).toEqual([BEN_PHONE]);
    expect(outboxDeletes(back.out)).toEqual([outboxId(1)]);
    expect(runner.slice.outbox.has(outboxId(1))).toBe(false);
  });

  test("a sensor someone may view but not manage: its name, no Disarm (S3 is Anna's alone)", () => {
    const runner = upRunner();
    const sent = byClient(runner.raise(countdown([ANNA_PHONE], S3)).out);
    expect(sent.get(ANNA_PHONE)).toMatchObject({
      names: { device: "study-window" },
      actions: ["disarm"],
    });
  });
});

describe("the decision's facts, the hub and `n`", () => {
  test("a countdown's seconds and a late report's opening time are `detail`; a mode's name is `names.mode`", () => {
    const runner = upRunner();
    const countdownCause = runner.decision("countdown_started", 30, S1);
    const late = runner.decision("late_report_notification", 1_795_000_000, S1);
    const mode = runner.decision("mode_switched", NIGHT_MODE);
    const a = byClient(runner.raise(countdown([ANNA_PHONE], S1, countdownCause)).out);
    expect(a.get(ANNA_PHONE)?.detail).toEqual({ seconds: 30 });
    const b = byClient(
      runner.raise({
        kind: "late_report_notification",
        category: "alarm",
        critical: true,
        device: S1,
        cause: late,
        clients: [ANNA_PHONE],
      }).out,
    );
    expect(b.get(ANNA_PHONE)?.detail).toEqual({ openedAtMs: 1_795_000_000_000 });
    const c = byClient(
      runner.raise({
        kind: "mode_switched",
        category: "armDisarm",
        critical: false,
        device: null,
        cause: mode,
        clients: [ANNA_PHONE],
      }).out,
    );
    expect(c.get(ANNA_PHONE)?.names).toEqual({ mode: "Night at Anna's" });
    expect(c.get(ANNA_PHONE)?.detail).toBeUndefined();
  });

  test("a cause not seen (or another decision's) adds nothing", () => {
    const runner = upRunner();
    runner.decision("countdown_started", 30, S1);
    const sent = byClient(runner.raise(countdown([ANNA_PHONE], S1, 12_345 as Seq)).out);
    expect(sent.get(ANNA_PHONE)?.detail).toBeUndefined();
  });

  test("`n` is the notification's, `hub` the identity, and every content passes the strict schema", () => {
    const runner = upRunner();
    const raised = runner.raise(countdown([ANNA_PHONE], S1));
    const content = byClient(raised.out).get(ANNA_PHONE);
    expect(content?.n).toEqual({
      seq: raised.row.seq,
      atMs: raised.row.atMs,
      clockOk: true,
      kind: "countdown_started",
      category: "countdown",
      critical: true,
      device: S1,
      cause: null,
    });
    expect(content?.hub).toMatch(/^[a-z2-7]{26}$/u);
    expect(pushContent.safeParse(content).success).toBe(true);
  });
});

describe("armed (D96, O15)", () => {
  test("as it was when raised, even when sent later after the house changed", () => {
    const runner = relayRunner();
    runner.arm(S1);
    runner.raise(ordinary([ANNA_PHONE]));
    runner.arm(S1, ArmState.Disarmed);
    runner.raise(ordinary([BEN_PHONE]));
    runner.arm(S2);
    const back = byClient(runner.up().out);
    expect(back.get(ANNA_PHONE)?.armed).toBe(true);
    expect(back.get(BEN_PHONE)?.armed).toBe(false);
  });
});

describe("the size rule (1,279 bytes ‡)", () => {
  /** The rules with room for exactly `bytes` of content. */
  function room(bytes: number): HubRules {
    return { ...DEFAULT_RULES, relay: { ...DEFAULT_RULES.relay, contentMaxBytes: bytes } };
  }
  function measure(rules?: HubRules): {
    readonly full: number;
    readonly noDetail: number;
    readonly bare: number;
  } {
    const runner = upRunner(rules);
    const cause = runner.decision("countdown_started", 30, S1);
    const content = byClient(runner.raise(countdown([ANNA_PHONE], S1, cause)).out).get(ANNA_PHONE);
    const size = (c: unknown) => new TextEncoder().encode(JSON.stringify(c)).length;
    if (content === undefined) return { full: 0, noDetail: 0, bare: 0 };
    const noDetail = { ...content, detail: undefined };
    return {
      full: size(content),
      noDetail: size(noDetail),
      bare: size({ ...noDetail, names: {} }),
    };
  }

  test("the whole content when it fits, to the byte; detail left out past it; then names; then not sent", () => {
    const sizes = measure();
    expect(sizes.full).toBeLessThanOrEqual(DEFAULT_RULES.relay.contentMaxBytes);
    const cases: readonly [number, "full" | "noDetail" | "bare" | "none"][] = [
      [sizes.full, "full"],
      [sizes.full - 1, "noDetail"],
      [sizes.noDetail, "noDetail"],
      [sizes.noDetail - 1, "bare"],
      [sizes.bare, "bare"],
      [sizes.bare - 1, "none"],
    ];
    for (const [bytes, expected] of cases) {
      const runner = upRunner(room(bytes));
      const cause = runner.decision("countdown_started", 30, S1);
      const raised = runner.raise(countdown([ANNA_PHONE], S1, cause));
      const content = byClient(raised.out).get(ANNA_PHONE);
      const got =
        content === undefined
          ? "none"
          : content.detail !== undefined
            ? "full"
            : Object.keys(content.names).length > 0
              ? "noDetail"
              : "bare";
      expect({ bytes, got }).toEqual({ bytes, got: expected });
      if (expected === "none") {
        expect(runner.slice.outbox.size).toBe(0);
        expect(hubEvents(raised.out).map((e) => e.detail)).toEqual([
          { reason: "tooLong", rows: 1 },
        ]);
      }
    }
  });

  test("names of 64 characters of four UTF-8 bytes each still fit under the default rule", () => {
    const runner = upRunner();
    const long = "\u{1F6AA}".repeat(32); // 64 UTF-16 units, 128 bytes
    const devices = new Map(runner.view.registry.devices);
    const row = devices.get(S1);
    if (row !== undefined) devices.set(S1, { ...row, name: long });
    runner.view = { ...runner.view, registry: { ...runner.view.registry, devices } };
    const cause = runner.decision("countdown_started", 30, S1);
    const content = byClient(runner.raise(countdown([ANNA_PHONE], S1, cause)).out).get(ANNA_PHONE);
    expect(content?.names.device).toBe(long);
    expect(pushContent.safeParse(content).success).toBe(true);
  });

  test("a name over 64 characters is left out, never cut", () => {
    const runner = upRunner();
    const devices = new Map(runner.view.registry.devices);
    const row = devices.get(S1);
    if (row !== undefined) devices.set(S1, { ...row, name: "x".repeat(65) });
    runner.view = { ...runner.view, registry: { ...runner.view.registry, devices } };
    const content = byClient(runner.raise(countdown([ANNA_PHONE], S1)).out).get(ANNA_PHONE);
    expect(content?.names).toEqual({});
  });
});

describe("household-typed names only where the design puts them", () => {
  test("never outside `names` in any push, never in the roster's alerts, never in a test push", () => {
    const runner = upRunner();
    const cause = runner.decision("mode_switched", NIGHT_MODE);
    runner.raise({
      kind: "mode_switched",
      category: "armDisarm",
      critical: false,
      device: null,
      cause,
      clients: [ANNA_PHONE, BEN_PHONE],
    });
    runner.raise(countdown([ANNA_PHONE, BEN_PHONE], S1));
    runner.raise(ordinary([ANNA_PHONE, BEN_PHONE], S2));
    runner.op(
      { op: "push.test", body: {} },
      { kind: "person", person: ANNA, client: ANNA_PHONE, name: "Anna (client 11)" },
    );
    runner.arm(S1);
    runner.send({ kind: "armedChanged", sensor: S1, arm: 1, cause: undefined });
    const all = pushes(runner.all).map((p) => p.content);
    expect(all.length).toBeGreaterThanOrEqual(7);
    for (const content of all) {
      expect(pushContent.safeParse(content).success).toBe(true);
      for (const name of TYPED) expect(outsideNames(content)).not.toContain(name);
      expect(Object.keys(content.names).every((k) => k === "device" || k === "mode")).toBe(true);
    }
    for (const roster of rosters(runner.all)) {
      for (const target of roster.targets) {
        for (const alert of [target.unreachable, target.back]) {
          expect(alert.names).toEqual({});
          expect(alert.detail).toBeUndefined();
          for (const name of TYPED) expect(JSON.stringify(alert)).not.toContain(name);
        }
      }
    }
  });
});

describe("timing (D102): late is counted from when the event happened", () => {
  const FIVE_HOURS_US = 5 * 3_600 * SECOND_US;

  /** At a start, five hours after S1's countdown ended unseen: the alarm raised now, its time in detail. */
  function lateAlarm(runner: Runner): number {
    const endedAtMs = runner.now.wall - FIVE_HOURS_US / 1000;
    const cause = runner.decision("alarm", null, S1, eventAtDetail(endedAtMs));
    runner.raise({
      kind: "alarm",
      category: "alarm",
      critical: true,
      device: S1,
      cause,
      clients: [ANNA_PHONE],
    });
    return endedAtMs;
  }

  test("an alarm raised at a start for a countdown ended 5 hours before: delayed, with when it ended", () => {
    const runner = relayRunner();
    runner.advance(FIVE_HOURS_US);
    runner.up();
    const raisedAt = runner.now.wall;
    const endedAtMs = lateAlarm(runner);
    const content = byClient(pushes(runner.all)).get(ANNA_PHONE);
    // Sent the moment it was raised, yet late: the event was five hours before.
    expect(content?.n.atMs).toBe(raisedAt);
    expect(content?.detail).toEqual({ endedAtMs });
    expect(content?.delayed).toBe(true);
    expect(pushContent.safeParse(content).success).toBe(true);
  });

  test("an alarm on time: no detail, not delayed", () => {
    const runner = upRunner();
    const cause = runner.decision("alarm", null, S1);
    const sent = byClient(
      runner.raise({
        kind: "alarm",
        category: "alarm",
        critical: true,
        device: S1,
        cause,
        clients: [ANNA_PHONE],
      }).out,
    );
    expect(sent.get(ANNA_PHONE)?.detail).toBeUndefined();
    expect(sent.get(ANNA_PHONE)?.delayed).toBe(false);
  });

  test("a late report's sirens: `endedAtMs` from the decision; delayed past 60 s ‡ from it, to the millisecond", () => {
    for (const [agoMs, delayed] of [
      [60_000, false],
      [60_001, true],
    ] as const) {
      const runner = upRunner();
      runner.advance(DAY_US);
      const endedAtMs = runner.now.wall - agoMs;
      const cause = runner.decision("late_report_sirens", 20, S1, eventAtDetail(endedAtMs));
      const sent = byClient(
        runner.raise({
          kind: "late_report_sirens",
          category: "alarm",
          critical: true,
          device: S1,
          cause,
          clients: [ANNA_PHONE],
        }).out,
      );
      expect({
        agoMs,
        detail: sent.get(ANNA_PHONE)?.detail,
        delayed: sent.get(ANNA_PHONE)?.delayed,
      }).toEqual({
        agoMs,
        detail: { endedAtMs },
        delayed,
      });
    }
  });

  test("a report so late only a notification is left: delayed from when the door opened", () => {
    for (const [agoS, delayed] of [
      [60, false],
      [61, true],
    ] as const) {
      const runner = upRunner();
      runner.advance(DAY_US);
      const openedS = Math.floor(runner.now.wall / 1000) - agoS;
      const cause = runner.decision("late_report_notification", openedS, S1);
      const sent = byClient(
        runner.raise({
          kind: "late_report_notification",
          category: "alarm",
          critical: true,
          device: S1,
          cause,
          clients: [ANNA_PHONE],
        }).out,
      );
      expect(sent.get(ANNA_PHONE)?.detail).toEqual({ openedAtMs: openedS * 1000 });
      expect({ agoS, delayed: sent.get(ANNA_PHONE)?.delayed }).toEqual({ agoS, delayed });
    }
  });

  test("the event time counts even when the size rule left `detail` out", () => {
    const runner = upRunner();
    runner.advance(DAY_US);
    const cause = runner.decision("alarm", null, S1, eventAtDetail(runner.now.wall - 3_600_000));
    const full = byClient(
      runner.raise({
        kind: "alarm",
        category: "alarm",
        critical: true,
        device: S1,
        cause,
        clients: [ANNA_PHONE],
      }).out,
    ).get(ANNA_PHONE);
    const size = new TextEncoder().encode(JSON.stringify(full)).length;
    const tight = upRunner({
      ...DEFAULT_RULES,
      relay: { ...DEFAULT_RULES.relay, contentMaxBytes: size - 1 },
    });
    tight.advance(DAY_US);
    const again = tight.decision("alarm", null, S1, eventAtDetail(tight.now.wall - 3_600_000));
    const content = byClient(
      tight.raise({
        kind: "alarm",
        category: "alarm",
        critical: true,
        device: S1,
        cause: again,
        clients: [ANNA_PHONE],
      }).out,
    ).get(ANNA_PHONE);
    expect(content?.detail).toBeUndefined();
    expect(content?.delayed).toBe(true);
  });

  test("a late push still says when it happened (`n.atMs`) and that it is late", () => {
    const runner = relayRunner();
    const raised = runner.raise(countdown([ANNA_PHONE], S1));
    runner.advance(5 * 60 * SECOND_US);
    const content = byClient(runner.up().out).get(ANNA_PHONE);
    expect(content?.n.atMs).toBe(raised.row.atMs);
    expect(content?.delayed).toBe(true);
  });
});

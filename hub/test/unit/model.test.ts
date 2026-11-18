/**
 * The frozen model's own checks (hub-design.md sections 2, 8 and 11): decision kinds cover the
 * bench's `HubAction`, the rules take the event listen time from `@hsn/protocol`, sequence
 * numbers compose as section 2 says, and internal messages and effects never share a kind.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_LISTEN_MS } from "@hsn/protocol";
import { ALL_DECISION_KINDS, DECISION_KINDS } from "../../src/core/model/decisions.ts";
import { EFFECT_KINDS, type Effect } from "../../src/core/model/effects.ts";
import {
  bootId,
  MAX_BOOT_ID,
  RECORDS_PER_BOOT,
  recordSeq,
  seq,
  seqBoot,
} from "../../src/core/model/ids.ts";
import type { Internal } from "../../src/core/model/messages.ts";
import { M2_MODULES, M3M4_MODULES, MODULE_ORDER } from "../../src/core/model/modules.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";

const HUB_LOG = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "firmware",
  "platform",
  "host",
  "include",
  "hsn",
  "host",
  "hub_log.hpp",
);

/** The enumerators of `enum class HubAction`, read from the bench's header. */
function benchHubActions(): readonly string[] {
  const header = readFileSync(HUB_LOG, "utf8");
  const body = /enum class HubAction\b[^{]*\{([^}]*)\}/.exec(header)?.[1] ?? "";
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** How many of the bench's names are M1a's: `DECISION_KINDS`' first, in the bench's order. */
const M1A_BENCH_ACTIONS = 30;

/**
 * The rule the bench's names keep with the hub's (section 11): its first 30, M1a's, are the
 * first 30 of `DECISION_KINDS` in its order; each after them, in its order, is one of
 * `ALL_DECISION_KINDS` (a decision of the joint step 0, or a name `benchActions` gives a packet
 * record). The problems, empty when it holds.
 */
function benchNameProblems(actions: readonly string[]): readonly string[] {
  const all: readonly string[] = ALL_DECISION_KINDS;
  const m1a = actions.slice(0, M1A_BENCH_ACTIONS);
  const problems: string[] = [];
  if (actions.length <= M1A_BENCH_ACTIONS) problems.push(`only ${String(actions.length)} names`);
  if (JSON.stringify(m1a) !== JSON.stringify(DECISION_KINDS.slice(0, M1A_BENCH_ACTIONS)))
    problems.push(`the first ${String(M1A_BENCH_ACTIONS)} are not DECISION_KINDS' first`);
  for (const action of actions.slice(M1A_BENCH_ACTIONS))
    if (!all.includes(action)) problems.push(`${action}: not a decision kind`);
  if (new Set(actions).size !== actions.length) problems.push("a name twice");
  return problems;
}

describe("decision kinds", () => {
  test("include every HubAction of the bench, name for name (section 11)", () => {
    expect(benchNameProblems(benchHubActions())).toEqual([]);
  });

  test("the bench's rule refuses what breaks it", () => {
    const m1a = DECISION_KINDS.slice(0, M1A_BENCH_ACTIONS);
    expect(benchNameProblems([...m1a, "firmware_offer", "key_changed"])).toEqual([]);
    expect(benchNameProblems(m1a)).toEqual(["only 30 names"]);
    expect(benchNameProblems([...m1a.slice(1), m1a[0] ?? "", "rollout_done"])).toEqual([
      "the first 30 are not DECISION_KINDS' first",
    ]);
    expect(benchNameProblems([...m1a, "update_go_ahead"])).toEqual([
      "update_go_ahead: not a decision kind",
    ]);
    expect(benchNameProblems([...m1a, "rollout_done", "rollout_done"])).toEqual(["a name twice"]);
  });

  test("are distinct snake-case names", () => {
    expect(new Set(DECISION_KINDS).size).toBe(DECISION_KINDS.length);
    for (const kind of DECISION_KINDS) expect(kind).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
  });
});

describe("rules", () => {
  test("take the event listen time from @hsn/protocol, so hub and sensor read one table (§8)", () => {
    expect(DEFAULT_RULES.replies.eventListenMs).toBe(EVENT_LISTEN_MS);
  });

  test("hold section 8's values", () => {
    expect(DEFAULT_RULES.replies.heartbeatReplyMomentMs).toBe(1000);
    expect(DEFAULT_RULES.sirens.wifiPathLostMs).toBe(70_000);
    expect(DEFAULT_RULES.sirens.loraPathLostMs).toBe(630_000);
    expect(DEFAULT_RULES.silence.sensorDefaultMissed).toBe(5);
    expect(DEFAULT_RULES.persistence.routineBatchMs).toBe(300_000);
    expect(DEFAULT_RULES.arming).toEqual({
      openedBeforeArmingToleranceMs: 2000,
      countdownDefaultS: 30,
      autoStopS: 300,
    });
  });
});

describe("record sequence numbers (section 2)", () => {
  test("are boot × 2³² + n", () => {
    expect(recordSeq(bootId(2), 5)).toBe(seq(2 * RECORDS_PER_BOOT + 5));
    expect(seqBoot(seq(2 * RECORDS_PER_BOOT + 5))).toBe(bootId(2));
  });

  test("stay exact below 2⁵³, and refuse what would not", () => {
    const last = recordSeq(bootId(MAX_BOOT_ID), RECORDS_PER_BOOT - 1);
    expect(last !== undefined && Number.isSafeInteger(last)).toBe(true);
    expect(recordSeq(bootId(MAX_BOOT_ID + 1), 0)).toBeUndefined();
    expect(recordSeq(bootId(1), RECORDS_PER_BOOT)).toBeUndefined();
    expect(recordSeq(bootId(1), -1)).toBeUndefined();
  });
});

describe("messages and effects", () => {
  test("never share a kind, so the dispatcher can tell them apart", () => {
    // A compile-time check: no internal message kind is an effect kind.
    const disjoint: Extract<Internal["kind"], Effect["kind"]> extends never ? true : false = true;
    expect(disjoint).toBe(true);
    // M1a's seven, M2's seven (m2-design.md section 2), and the joint step 0's seven.
    expect(EFFECT_KINDS).toHaveLength(21);
  });

  test("the module order is section 2's table, M2's seven in their places (m2-design.md section 2)", () => {
    expect(MODULE_ORDER).toEqual([
      "clock",
      "registry",
      "links",
      "setup",
      "control",
      "people",
      "relay",
      "layout",
      "app",
      "schedules",
      "gateways",
      "intake",
      "alarm",
      "site",
      "firmware",
      "sensors",
      "slots",
      "sirens",
      "health",
      "notify",
      "upkeep",
      "audit",
    ]);
    // M1a's thirteen keep their relative order.
    const added: readonly string[] = [...M2_MODULES, ...M3M4_MODULES];
    const m1a = MODULE_ORDER.filter((m) => !added.includes(m));
    expect(m1a).toEqual([
      "clock",
      "registry",
      "links",
      "setup",
      "control",
      "gateways",
      "intake",
      "alarm",
      "site",
      "sensors",
      "slots",
      "sirens",
      "audit",
    ]);
  });
});

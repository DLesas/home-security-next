/**
 * The frozen model's own checks (hub-design.md sections 2, 8 and 11): decision kinds cover the
 * bench's `HubAction`, the rules take the event listen time from `@hsn/protocol`, sequence
 * numbers compose as section 2 says, and internal messages and effects never share a kind.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_LISTEN_MS } from "@hsn/protocol";
import { DECISION_KINDS } from "../../src/core/model/decisions.ts";
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
import { M2_MODULES, MODULE_ORDER } from "../../src/core/model/modules.ts";
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

describe("decision kinds", () => {
  test("include every HubAction of the bench, name for name (section 11)", () => {
    const actions = benchHubActions();
    expect(actions.length).toBeGreaterThan(20);
    const kinds: readonly string[] = DECISION_KINDS;
    expect(actions.filter((action) => !kinds.includes(action))).toEqual([]);
    expect(kinds.slice(0, actions.length)).toEqual([...actions]);
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
    // M1a's seven, and M2's seven (m2-design.md section 2).
    expect(EFFECT_KINDS).toHaveLength(14);
  });

  test("the module order is section 2's table, M2's seven in their places (m2-design.md section 2)", () => {
    expect(MODULE_ORDER).toEqual([
      "clock",
      "registry",
      "links",
      "setup",
      "control",
      "people",
      "layout",
      "app",
      "schedules",
      "gateways",
      "intake",
      "alarm",
      "site",
      "sensors",
      "slots",
      "sirens",
      "health",
      "notify",
      "upkeep",
      "audit",
    ]);
    // M1a's thirteen keep their relative order.
    const m1a = MODULE_ORDER.filter((m) => !(M2_MODULES as readonly string[]).includes(m));
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

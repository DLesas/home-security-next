/**
 * The gateway's noise against its long-term level (hub-design.md section 8, D82, §14) at its
 * boundaries: the first hour's 20th percentile ‡, learning only within 3 dB ‡, interference
 * after 2 ‡ statuses at B + 10 dB † and its end 3 dB below, the learned-as-normal rule, and
 * damaged packets over 2 statuses with at least 10 ‡ packets; then the same through the handler.
 */
import { describe, expect, test } from "bun:test";
import { sessionBinding } from "@hsn/protocol";
import { linkId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import { averaged, judgeStatus, percentile } from "../../../src/core/gateways/noise.ts";
import {
  EMPTY_NOISE,
  type NoiseState,
  type StatusReading,
} from "../../../src/core/gateways/state.ts";
import {
  connectVectors,
  decisionsIn,
  deviceOf,
  effectsOf,
  GATEWAY_ADDRESS,
  GATEWAY_RANDOM,
  Harness,
  HUB_RANDOM,
  ofKind,
  statusMessage,
  toHub,
} from "./harness.ts";

const RULES = DEFAULT_RULES;
const MINUTE = 60_000_000;
const HOUR = 60 * MINUTE;
const B = -120;

function status(at: Mono, median: number, extra: Partial<StatusReading> = {}): StatusReading {
  return {
    at,
    settingsVersion: 1,
    uptimeSeconds: 0,
    airtimeHundredthsPercent: 0,
    noiseMedianDbm: median,
    noiseHighestDbm: median + 5,
    normalNoiseDbm: B,
    packetsReceived: 0,
    packetsCrcFailed: 0,
    body: new Uint8Array(),
    ...extra,
  };
}

/** A baseline B learned at time 0. */
const LEARNED: NoiseState = { ...EMPTY_NOISE, baseline: B, baselineAt: mono(0) };

/** Feeds statuses 30 s apart from `start`; returns the state and every decision kind. */
function feed(start: NoiseState, medians: readonly number[], extra: Partial<StatusReading> = {}) {
  let noise = start;
  const kinds: string[] = [];
  medians.forEach((median, i) => {
    const judged = judgeStatus(noise, status(mono((i + 1) * 30_000_000), median, extra), RULES);
    noise = judged.noise;
    kinds.push(...judged.decisions.map((d) => d.kind));
  });
  return { noise, kinds };
}

describe("the baseline", () => {
  test("the nearest-rank percentile", () => {
    expect(percentile([5, 1, 4, 2, 3], 20)).toBe(1);
    expect(percentile([5, 1, 4, 2, 3], 21)).toBe(2);
    expect(percentile([7], 20)).toBe(7);
    expect(percentile([], 20)).toBeUndefined();
  });

  test("starts as the 20th percentile of the first hour's medians, with no alert during it", () => {
    let noise = EMPTY_NOISE;
    const kinds: string[] = [];
    // An hour of statuses every 30 s, the first ten loud: during the first hour nothing is raised.
    for (let i = 0; i < 120; i++) {
      const judged = judgeStatus(
        noise,
        status(mono(i * 30_000_000), i < 10 ? -80 : -120 + (i % 5)),
        RULES,
      );
      noise = judged.noise;
      kinds.push(...judged.decisions.map((d) => d.kind));
    }
    expect(noise.baseline).toBeUndefined();
    expect(kinds).toEqual([]);
    // The status at one hour after the first starts B from the 120 medians before it: 22 each
    // of −120 to −116 and ten of −80, so the 24th smallest, −119.
    noise = judgeStatus(noise, status(mono(HOUR), -80), RULES).noise;
    expect(noise.baseline).toBe(-119);
    expect(noise.baselineAt).toBe(mono(HOUR));
  });

  test("learns a median at most 3 dB ‡ above B with the 24 h ‡ time constant, and never a louder one", () => {
    const after = judgeStatus(LEARNED, status(mono(HOUR), B + 3), RULES).noise;
    expect(after.baseline).toBeCloseTo(averaged(B, B + 3, 3_600_000, RULES), 10);
    expect(after.baseline).toBeCloseTo(B + 3 * (1 - Math.exp(-1 / 24)), 10);
    const louder = judgeStatus(LEARNED, status(mono(HOUR), B + 3.5), RULES).noise;
    expect(louder.baseline).toBe(B);
    expect(louder.baselineAt).toBe(mono(0));
  });

  test("noise rising slowly is learned and never raised", () => {
    // 2 dB over 12 hours, a status every 30 s.
    const medians = Array.from({ length: 1440 }, (_, i) => B + (2 * i) / 1440);
    const { noise, kinds } = feed(LEARNED, medians);
    expect(kinds).toEqual([]);
    expect(noise.baseline).toBeGreaterThan(B + 0.2);
  });
});

describe("the hub's own interference rule", () => {
  test("raised at B + 10 dB † in 2 ‡ consecutive statuses, not 1, not just below", () => {
    expect(feed(LEARNED, [B + 10]).kinds).toEqual([]);
    expect(feed(LEARNED, [B + 10, B + 9.9]).kinds).toEqual([]);
    expect(feed(LEARNED, [B + 10, B + 9.9, B + 10]).kinds).toEqual([]);
    expect(feed(LEARNED, [B + 10, B + 10]).kinds).toEqual(["noise_interference_started"]);
    expect(feed(LEARNED, [B + 10, B + 10, B + 30]).kinds).toEqual(["noise_interference_started"]);
  });

  test("ends after 2 statuses below B + 10 − 3 dB, not at exactly that level", () => {
    const loud = feed(LEARNED, [B + 15, B + 15]).noise;
    expect(feed(loud, [B + 7, B + 7]).kinds).toEqual([]);
    expect(feed(loud, [B + 6.9, B + 7]).kinds).toEqual([]);
    expect(feed(loud, [B + 6.9, B + 6.9]).kinds).toEqual(["noise_interference_ended"]);
  });

  test("interference is not learned: B stays while it lasts", () => {
    const { noise } = feed(
      LEARNED,
      Array.from({ length: 100 }, () => B + 20),
    );
    expect(noise.baseline).toBe(B);
  });
});

describe("a gateway that learned interference as normal (§14)", () => {
  test("raised once when its normal level is at least B + 10 dB, again only after it dropped", () => {
    expect(feed(LEARNED, [B], { normalNoiseDbm: B + 9 }).kinds).toEqual([]);
    const learned = feed(LEARNED, [B, B], { normalNoiseDbm: B + 10 });
    expect(learned.kinds).toEqual(["interference_learned_as_normal"]);
    expect(feed(learned.noise, [B], { normalNoiseDbm: B }).kinds).toEqual([]);
    const dropped = feed(learned.noise, [B], { normalNoiseDbm: B }).noise;
    expect(feed(dropped, [B], { normalNoiseDbm: B + 12 }).kinds).toEqual([
      "interference_learned_as_normal",
    ]);
  });
});

describe("damaged packets", () => {
  test("more than half of the packets heard (good + CRC failed) over 2 statuses with at least 10 ‡; raised once", () => {
    // Each pair is one status: [packets received with a good CRC, packets that failed it] (§6).
    const run = (counts: readonly (readonly [number, number])[]) => {
      let noise = LEARNED;
      const kinds: string[] = [];
      counts.forEach(([received, failed], i) => {
        const judged = judgeStatus(
          noise,
          status(mono(i * 30_000_000), B, { packetsReceived: received, packetsCrcFailed: failed }),
          RULES,
        );
        noise = judged.noise;
        kinds.push(...judged.decisions.map((d) => d.kind));
      });
      return kinds;
    };
    expect(run([[0, 20]])).toEqual([]); // one status is not enough
    expect(
      run([
        [2, 3],
        [2, 3],
      ]),
    ).toEqual(["damaged_packets"]); // 6 failed of 10 heard
    expect(
      run([
        [3, 2],
        [2, 3],
      ]),
    ).toEqual([]); // 5 of 10: exactly half
    expect(
      run([
        [0, 4],
        [0, 5],
      ]),
    ).toEqual([]); // 9 heard
    // 6 failed against 10 good is 6 of 16 heard: not damaged (the good count excludes failures).
    expect(
      run([
        [5, 3],
        [5, 3],
      ]),
    ).toEqual([]);
    expect(
      run([
        [0, 5],
        [0, 5],
        [0, 5],
      ]),
    ).toEqual(["damaged_packets"]);
    expect(
      run([
        [0, 5],
        [0, 5],
        [5, 0],
        [5, 0],
        [0, 5],
        [0, 5],
      ]),
    ).toEqual(["damaged_packets", "damaged_packets"]);
  });

  test("judged from the first status, before the baseline exists", () => {
    let noise = EMPTY_NOISE;
    const kinds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const judged = judgeStatus(
        noise,
        status(mono(i), B, { packetsReceived: 0, packetsCrcFailed: 10 }),
        RULES,
      );
      noise = judged.noise;
      kinds.push(...judged.decisions.map((d) => d.kind));
    }
    expect(kinds).toEqual(["damaged_packets"]);
  });
});

describe("through the handler", () => {
  const SESSION = sessionBinding(GATEWAY_RANDOM, HUB_RANDOM);
  const GATEWAY = deviceOf(GATEWAY_ADDRESS);

  function learned(): Harness {
    const h = new Harness();
    connectVectors(h, linkId(1));
    const entry = h.state.gateways.gateways.get(GATEWAY);
    if (entry !== undefined) {
      const gateways = new Map(h.state.gateways.gateways);
      gateways.set(GATEWAY, { ...entry, noise: LEARNED });
      h.state = { ...h.state, gateways: { ...h.state.gateways, gateways } };
    }
    return h;
  }

  test("each judgement is a decision written now, with the gateway and the status as its cause", () => {
    const h = learned();
    h.frame(
      linkId(1),
      toHub(GATEWAY_ADDRESS, statusMessage({ noiseMedianDbm: B + 12 }), 10, SESSION),
    );
    const out = h.frame(
      linkId(1),
      toHub(GATEWAY_ADDRESS, statusMessage({ noiseMedianDbm: B + 12 }), 11, SESSION),
    );
    const records = ofKind(out.messages, "auditRecord");
    const rx = records.find((r) => r.record.kind === "rx");
    const decision = records.find((r) => r.record.kind === "decision");
    expect(decision?.durability).toBe("now");
    expect(decision?.record.kind === "decision" ? decision.record.row : undefined).toMatchObject({
      kind: "noise_interference_started",
      deviceId: GATEWAY,
      causeSeq: rx?.record.kind === "rx" ? rx.record.row.seq : -1,
      value: B + 12,
    });
    // The status itself is routine, and so is the reading it leaves.
    expect(rx?.durability).toBe("routine");
    expect(effectsOf(out.effects, "write").map((w) => [w.op.table, w.durability])).toEqual([
      ["device_state", "routine"],
    ]);
  });

  test("a status naming another settings version is answered with the settings; the same version is not", () => {
    const h = learned();
    expect(
      effectsOf(
        h.frame(
          linkId(1),
          toHub(GATEWAY_ADDRESS, statusMessage({ settingsVersion: 1 }), 10, SESSION),
        ).effects,
        "send",
      ),
    ).toEqual([]);
    const out = h.frame(
      linkId(1),
      toHub(GATEWAY_ADDRESS, statusMessage({ settingsVersion: 0 }), 11, SESSION),
    );
    expect(effectsOf(out.effects, "send")).toHaveLength(1);
    expect(decisionsIn(out.messages)).toEqual(["gateway_settings"]);
  });
});

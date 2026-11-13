/**
 * The gateway's noise against its long-term level (hub-design.md section 8, D82, §14): the
 * hub's own interference rule, the gateway that learned interference as normal, and damaged
 * packets. Pure: each status gives the new state and the decisions to record; none sounds a
 * siren, and each is a warning, so it is written now (section 5).
 */
import type { DecisionKind } from "../model/decisions.ts";
import type { HubRules } from "../model/rules.ts";
import { type Mono, msBetween } from "../model/time.ts";
import type { NoiseState, StatusReading } from "./state.ts";

/** One decision the noise rules raise, with the figures it records. */
export interface NoiseDecision {
  readonly kind: DecisionKind;
  readonly value: number;
  readonly detail: Uint8Array;
}

/** Tenths of a dB, as the baseline is stored and recorded. */
const TENTHS_PER_DB = 10;

/** The pth percentile (0–100) of `values` by the nearest-rank method; undefined when empty. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * B after one more median, `elapsedMs` after B last moved: an exponential average with the
 * rules' time constant (24 hours ‡), so its weight follows time, not the number of statuses.
 */
export function averaged(
  baseline: number,
  median: number,
  elapsedMs: number,
  rules: HubRules,
): number {
  const weight = 1 - Math.exp(-Math.max(0, elapsedMs) / rules.noise.baselineTimeConstantMs);
  return baseline + weight * (median - baseline);
}

function i8(value: number): number {
  return Math.max(-128, Math.min(127, Math.round(value)));
}

function i16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

/** The status's figures and B: median, highest, normal (dBm, i8), B in tenths of dB (i16 LE). */
function noiseDetail(status: StatusReading, baseline: number): Uint8Array {
  const detail = new Uint8Array(5);
  const view = new DataView(detail.buffer);
  view.setInt8(0, i8(status.noiseMedianDbm));
  view.setInt8(1, i8(status.noiseHighestDbm));
  view.setInt8(2, i8(status.normalNoiseDbm));
  view.setInt16(3, i16(baseline * TENTHS_PER_DB), true);
  return detail;
}

/** Packets received and failed over the window (u16 LE each), for `damaged_packets`. */
function packetDetail(received: number, failed: number): Uint8Array {
  const detail = new Uint8Array(4);
  const view = new DataView(detail.buffer);
  view.setUint16(0, Math.min(received, 0xffff), true);
  view.setUint16(2, Math.min(failed, 0xffff), true);
  return detail;
}

/**
 * Damaged packets (section 8): a warning when the packets failing the radio's CRC are more than
 * half of those heard over 2 ‡ statuses with at least 10 ‡ packets heard. A status's "packets
 * received" counts only good-CRC packets (§6), so the packets heard are the sum of its two
 * fields. Raised once when the condition starts; it can be raised again after it has cleared.
 */
function judgeDamage(
  noise: NoiseState,
  status: StatusReading,
  rules: HubRules,
): { readonly noise: NoiseState; readonly decisions: readonly NoiseDecision[] } {
  const { damagedStatuses, damagedMinPackets, damagedFraction } = rules.noise;
  const packets = [
    ...noise.packets,
    { received: status.packetsReceived, failed: status.packetsCrcFailed },
  ].slice(-damagedStatuses);
  const received = packets.reduce((sum, p) => sum + p.received, 0);
  const failed = packets.reduce((sum, p) => sum + p.failed, 0);
  const heard = received + failed;
  const damaged =
    packets.length >= damagedStatuses &&
    heard >= damagedMinPackets &&
    failed > damagedFraction * heard;
  const decisions: NoiseDecision[] =
    damaged && !noise.damaged
      ? [{ kind: "damaged_packets", value: failed, detail: packetDetail(received, failed) }]
      : [];
  return { noise: { ...noise, packets, damaged }, decisions };
}

/**
 * The first hour (section 8): B starts as the 20th percentile ‡ of the medians of the statuses
 * in a new gateway's first hour, and no hub-side alert is raised before then.
 */
function learnFirst(noise: NoiseState, status: StatusReading, rules: HubRules): NoiseState {
  const startedAt = noise.firstStartedAt ?? status.at;
  if (msBetween(startedAt, status.at) < rules.noise.firstPeriodMs) {
    return {
      ...noise,
      firstStartedAt: startedAt,
      firstMedians: [...noise.firstMedians, status.noiseMedianDbm],
    };
  }
  const baseline = percentile(noise.firstMedians, rules.noise.firstPeriodPercentile);
  return baseline === undefined
    ? { ...noise, firstStartedAt: status.at, firstMedians: [status.noiseMedianDbm] }
    : { ...noise, baseline, baselineAt: status.at, firstMedians: [], firstStartedAt: undefined };
}

/**
 * Judges one status (section 8): first against B as it stood (the interference rule and the
 * learned-as-normal rule), then B learns the median if it is at most 3 dB ‡ above B, so
 * interference is never learned.
 */
export function judgeStatus(
  before: NoiseState,
  status: StatusReading,
  rules: HubRules,
): { readonly noise: NoiseState; readonly decisions: readonly NoiseDecision[] } {
  const damage = judgeDamage(before, status, rules);
  const noise = damage.noise;
  const decisions: NoiseDecision[] = [...damage.decisions];
  const { baseline, baselineAt } = noise;
  if (baseline === undefined || baselineAt === undefined) {
    return { noise: learnFirst(noise, status, rules), decisions };
  }

  const { alertDb, alertStatuses, endBelowAlertDb, learnMaxAboveDb } = rules.noise;
  const median = status.noiseMedianDbm;
  const detail = noiseDetail(status, baseline);
  const above = median >= baseline + alertDb ? noise.above + 1 : 0;
  const below =
    noise.interference && median < baseline + alertDb - endBelowAlertDb ? noise.below + 1 : 0;
  let interference = noise.interference;
  if (!interference && above >= alertStatuses) {
    interference = true;
    decisions.push({ kind: "noise_interference_started", value: median, detail });
  } else if (interference && below >= alertStatuses) {
    interference = false;
    decisions.push({ kind: "noise_interference_ended", value: median, detail });
  }

  const learnedAsNormal = status.normalNoiseDbm >= baseline + alertDb;
  if (learnedAsNormal && !noise.learnedAsNormal) {
    decisions.push({
      kind: "interference_learned_as_normal",
      value: status.normalNoiseDbm,
      detail,
    });
  }

  const learns = median <= baseline + learnMaxAboveDb;
  return {
    noise: {
      ...noise,
      above,
      below: interference ? below : 0,
      interference,
      learnedAsNormal,
      baseline: learns
        ? averaged(baseline, median, msBetween(baselineAt, status.at), rules)
        : baseline,
      baselineAt: learns ? status.at : baselineAt,
    },
    decisions,
  };
}

/** The baseline as stored in `device_state.estimates` after the format byte: tenths of dB, i16 LE. */
export function encodeBaseline(baseline: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setInt16(0, i16(baseline * TENTHS_PER_DB), true);
  return bytes;
}

/** The baseline back from its two bytes, or undefined when they are missing. */
export function decodeBaseline(bytes: Uint8Array): number | undefined {
  if (bytes.length < 2) return undefined;
  return (
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(0, true) / TENTHS_PER_DB
  );
}

/** A restored baseline starts learning again from the boot's first status. */
export function restoredNoise(
  baseline: number | undefined,
  at: Mono,
  empty: NoiseState,
): NoiseState {
  return baseline === undefined ? empty : { ...empty, baseline, baselineAt: at };
}

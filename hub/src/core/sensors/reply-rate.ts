/**
 * The reply rate (hub-design.md section 8, "The reply rate"; protocol.md §7, "Faster replies";
 * D108): which rate a reply goes at, and the reply-rate setting chosen from the signal margin
 * of the sensor's packets. Pure.
 */
import { spreadingFactor } from "@hsn/protocol";
import type { HubRules } from "../model/rules.ts";
import { FASTEST_RATE, isKnownRate, stepRate } from "./radio.ts";

/** The spreading factor of SF7, from which the demodulation limit is counted (`lora_physics.cpp`). */
const BASE_SPREADING_FACTOR = 7;
/** Per cent, for percentiles. */
const PER_CENT = 100;

/** The p-th percentile of `values` by nearest rank (p from 0 to 100); undefined when empty. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / PER_CENT) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** The demodulation limit at a rate's spreading factor, dB: −7.5 − 2.5 × (F − 7) (section 8). */
export function demodulationLimitDb(rules: HubRules, rate: number): number | undefined {
  const sf = spreadingFactor(rate);
  if (sf === undefined) return undefined;
  const { demodLimitSf7Db, demodLimitPerSfDb } = rules.replyRate;
  return demodLimitSf7Db + demodLimitPerSfDb * (sf - BASE_SPREADING_FACTOR);
}

/** What the choice is made from. */
export interface ReplyRateInputs {
  /** SNR in dB of the sensor's last accepted packets at its best gateway, oldest first. */
  readonly snrDb: readonly number[];
  readonly sendRate: number;
  /** The reply-rate setting now. */
  readonly current: number;
  /** The gateway's default transmit power, which replies use (section 8, "Powers"). */
  readonly replyPowerDbm: number;
  /** False within 6 hours ‡ of the last change to a faster rate or of a flag bit 7. */
  readonly fasterAllowed: boolean;
}

/** The fastest rate a reply may use: at most 3 steps faster than the sending rate (§8). */
function fastestAllowed(rules: HubRules, sendRate: number): number {
  return Math.min(FASTEST_RATE, sendRate + rules.replyRate.maxStepsFaster);
}

/** `rate` kept between the sending rate and 3 steps faster: never slower than the sending rate. */
export function boundReplyRate(rules: HubRules, sendRate: number, rate: number): number {
  return Math.min(fastestAllowed(rules, sendRate), Math.max(sendRate, rate));
}

/**
 * The reply-rate setting (section 8, "Choosing the setting" and "Changing it"). s is the 10th
 * percentile of the SNR samples; the downlink estimate is s + (reply power − 14 dBm). A rate
 * holds when its demodulation limit is at least 10 dB ‡ below the estimate. The setting goes
 * faster only to a rate that holds with 3 dB ‡ to spare, and only when `fasterAllowed`; it goes
 * slower at once, to the fastest rate that holds, when its own rate fails. With fewer than 10
 * samples, or with an unlisted sending rate, it stays as it is, bounded to the sending rate.
 */
export function chooseReplyRate(rules: HubRules, inputs: ReplyRateInputs): number {
  const { sendRate, replyPowerDbm, fasterAllowed } = inputs;
  if (!isKnownRate(sendRate)) return inputs.current;
  const current = boundReplyRate(rules, sendRate, inputs.current);
  const { minSamples, snrSamples, snrPercentile, sensorPowerDbm, marginDb, hysteresisDb } =
    rules.replyRate;
  const s = percentile(inputs.snrDb.slice(-snrSamples), snrPercentile);
  if (inputs.snrDb.length < minSamples || s === undefined) return current;
  const estimate = s + (replyPowerDbm - sensorPowerDbm);
  const holds = (rate: number, spareDb: number): boolean => {
    const limit = demodulationLimitDb(rules, rate);
    return limit !== undefined && limit <= estimate - marginDb - spareDb;
  };
  const fastestHolding = (spareDb: number): number => {
    for (let rate = fastestAllowed(rules, sendRate); rate > sendRate; rate--) {
      if (holds(rate, spareDb)) return rate;
    }
    return sendRate;
  };
  if (!holds(current, 0)) return fastestHolding(0);
  const faster = fastestHolding(hysteresisDb);
  return faster > current && fasterAllowed ? faster : current;
}

/**
 * The setting after a packet with flag bit 7, two faster replies just lost (§7): one step ‡
 * slower at once, never slower than the sending rate.
 */
export function fallBackReplyRate(rules: HubRules, sendRate: number, current: number): number {
  return boundReplyRate(rules, sendRate, stepRate(current, -rules.replyRate.stepsSlowerOnFallback));
}

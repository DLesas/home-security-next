/**
 * A sensor's estimates as `device_state.estimates` stores them (hub-design.md section 6): a
 * format byte, then the slot (phase, interval and span in microseconds, u32 each) and the clock
 * samples (a count, then each drift in hundredths of a ppm, i32), little-endian.
 */
import type { Slot } from "./plan.ts";

/** The format byte (section 6: every blob of our own layout starts with one). */
export const ESTIMATES_FORMAT = 1;
/** A drift is stored in hundredths of a part per million. */
const DRIFT_SCALE = 100_000_000;
const HEADER_BYTES = 1 + 4 + 4 + 4 + 1;
const SAMPLE_BYTES = 4;
const MAX_I32 = 0x7fffffff;

/** What the blob holds. */
export interface Estimates {
  readonly phaseUs: number;
  readonly intervalUs: number;
  readonly spanUs: number;
  readonly samples: readonly number[];
}

export function encodeEstimates(slot: Slot, samples: readonly number[]): Uint8Array {
  const blob = new Uint8Array(HEADER_BYTES + samples.length * SAMPLE_BYTES);
  const view = new DataView(blob.buffer);
  view.setUint8(0, ESTIMATES_FORMAT);
  view.setUint32(1, slot.phaseUs, true);
  view.setUint32(5, slot.intervalUs, true);
  view.setUint32(9, slot.spanUs, true);
  view.setUint8(13, samples.length);
  samples.forEach((drift, i) => {
    const scaled = Math.max(-MAX_I32, Math.min(MAX_I32, Math.round(drift * DRIFT_SCALE)));
    view.setInt32(HEADER_BYTES + i * SAMPLE_BYTES, scaled, true);
  });
  return blob;
}

/** The estimates of a blob, or undefined for one of another format or too short. */
export function decodeEstimates(blob: Uint8Array | null): Estimates | undefined {
  if (blob === null || blob.length < HEADER_BYTES || blob[0] !== ESTIMATES_FORMAT) return undefined;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const count = view.getUint8(13);
  if (blob.length < HEADER_BYTES + count * SAMPLE_BYTES) return undefined;
  const samples = Array.from(
    { length: count },
    (_, i) => view.getInt32(HEADER_BYTES + i * SAMPLE_BYTES, true) / DRIFT_SCALE,
  );
  return {
    phaseUs: view.getUint32(1, true),
    intervalUs: view.getUint32(5, true),
    spanUs: view.getUint32(9, true),
    samples,
  };
}

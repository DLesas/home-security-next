/**
 * The bench's result type: `Outcome`, the shape the phone's frozen Bluetooth interfaces use
 * (`app/src/platform/split.ts`), so a scripted board's answers are what the app's code already
 * reads. The workspace has no dependencies (as `tools/push-standins`), so it keeps this small
 * type rather than neverthrow's: nothing here throws; what can fail returns one of these.
 */
import type { Outcome } from "../../../app/src/platform/split.ts";

export type { Outcome };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function fault<F>(why: F): { readonly ok: false; readonly fault: F } {
  return { ok: false, fault: why };
}

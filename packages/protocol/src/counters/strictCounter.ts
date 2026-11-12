/**
 * The strictly-higher rule (section 4), used by sirens for commands and settings and by both
 * ends of a gateway connection: accept only a counter higher than the last one accepted.
 */
import { accept, assertReceivedCounter, type CounterCheck, reject } from "./check.ts";

/**
 * `lastAccepted` is 0 before the first. An exact repeat is reported as `duplicate`, so a siren
 * can answer it again as section 7 asks; anything lower is `tooOld`.
 */
export function checkStrictlyHigher(lastAccepted: number, counter: number): CounterCheck<number> {
  assertReceivedCounter(counter);
  if (counter > lastAccepted) return accept(counter);
  return reject(counter === lastAccepted ? "duplicate" : "tooOld");
}

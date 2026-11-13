// Lint probe: protocol-safe.ts may use the throwing names and try.
// Expect: clean
import { Result } from "neverthrow";
import { timeOnAirMs } from "@hsn/protocol";

export const safe = Result.fromThrowable(timeOnAirMs, () => "thrown");

export function attempt(run: () => number): number {
  try {
    return run();
  } catch {
    return 0;
  }
}

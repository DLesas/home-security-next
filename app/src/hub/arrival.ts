/**
 * The code the page was opened with (m2-design.md section 5): taken out of the address as the
 * app's very first step, before the router or any screen loads (`src/entry.ts` imports this
 * first), and kept here, in memory only, until the root layout links with it.
 */
import { takeArrivedCode } from "./browser";
import type { ArrivedCode } from "./fragment";

let arrived: ArrivedCode | undefined = takeArrivedCode();

/** The code, once: after this the secret is held only by the linking call. */
export function claimArrivedCode(): ArrivedCode | undefined {
  const code = arrived;
  arrived = undefined;
  return code;
}

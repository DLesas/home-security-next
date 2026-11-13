/**
 * Whether the wall clock is trusted (hub-design.md section 5, "The clock"): when the system says
 * so and it reads no earlier than a trusted last commit mark. Shared by the handler and the
 * selectors, so a timer that runs before the clock module has seen this input's time still
 * stamps its records with it.
 */
import type { DeviceStateRow } from "../model/rows.ts";
import type { Now } from "../model/time.ts";

export function trustedNow(now: Now, mark: DeviceStateRow | undefined): boolean {
  if (!now.wallTrusted) return false;
  return mark === undefined || !mark.clockOk || now.wall >= mark.lastSeenMs;
}

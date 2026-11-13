/**
 * Read-only selectors over the clock module's slice that other modules may use (hub-design.md
 * section 2; section 5, "Raspberry Pi"). Every record's `at_ms` and `clock_ok` come from
 * `recordStamp`, so `at_ms` never decreases within a table (section 6).
 */
import type { BootId } from "../model/ids.ts";
import type { DeviceStateRow } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import type { Mono, Now } from "../model/time.ts";
import type { Downtime } from "./state.ts";
import { trustedNow } from "./trust.ts";

/** This run's boot, once the boot event has been handled. */
export function bootOf(view: HubState): BootId | undefined {
  return view.clock.boot?.id;
}

/** When this run started, on its monotonic clock. */
export function startedAt(view: HubState): Mono | undefined {
  return view.clock.started?.mono;
}

/**
 * The time and trust a record made at `now` is stamped with (section 6, `at_ms`, `clock_ok`):
 * the highest wall time seen, so `at_ms` never decreases. It takes the input's `now`, since a
 * timer runs before the clock module has seen this input.
 */
export function recordStamp(
  view: HubState,
  now: Now,
): { readonly atMs: number; readonly clockOk: boolean } {
  return { atMs: Math.max(view.clock.recordWallMs, now.wall), clockOk: wallTrusted(view, now) };
}

/** Whether the wall clock is trusted at `now` (section 5). Retention runs only while it is. */
export function wallTrusted(view: HubState, now: Now): boolean {
  return trustedNow(now, view.clock.mark);
}

/** How long the hub was off before this run (D113). */
export function downtime(view: HubState): Downtime {
  return view.clock.downtime;
}

/** The last commit mark before this start, from which saved countdowns are re-expressed (D80). */
export function lastCommitMark(view: HubState): DeviceStateRow | undefined {
  return view.clock.mark;
}

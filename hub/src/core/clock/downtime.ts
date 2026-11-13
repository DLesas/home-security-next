/**
 * How long the hub was off (hub-design.md section 5, "How long was the hub down?"; D113), from
 * the last commit before the stop to this run's first input, in the order of preference:
 *
 * 1. the last commit mark's wall time and the wall clock now are both trusted: their difference;
 * 2. a gateway that did not restart: the uptime of its first status after the start, less the
 *    uptime of its last status before the stop (saved with the commit mark), less the time from
 *    that status to the last commit and from the start to the new status;
 * 3. otherwise it is not known.
 */
import type { DeviceStateRow } from "../model/rows.ts";
import { type Mono, MILLISECONDS_PER_SECOND, msBetween, type Now } from "../model/time.ts";
import type { UptimeWitness } from "./state.ts";

/** Way 1: by the wall clock, when the mark's and the start's are both trusted; never negative. */
export function downtimeByWallClock(mark: DeviceStateRow, startWallMs: number): number | undefined {
  if (!mark.clockOk) return undefined;
  const ms = startWallMs - mark.lastSeenMs;
  return ms >= 0 ? ms : undefined;
}

/** The wall time of the start, as the wall clock now reads it, counted back on the monotonic clock. */
export function startWallMs(started: Now, now: Now): number {
  return now.wall - msBetween(started.mono, now.mono);
}

/**
 * Way 2: by a gateway's uptime. Undefined when the gateway restarted meanwhile (its uptime did
 * not cover the gap), or when its last status came after the last commit.
 */
export function downtimeByUptime(
  witness: UptimeWitness,
  mark: DeviceStateRow,
  startedMono: Mono,
  status: { readonly uptimeS: number; readonly atMono: Mono },
): number | undefined {
  const elapsedMs = (status.uptimeS - witness.uptimeS) * MILLISECONDS_PER_SECOND;
  const statusToCommitMs = msBetween(witness.statusMono, mark.lastSeenMono);
  const startToStatusMs = msBetween(startedMono, status.atMono);
  if (statusToCommitMs < 0 || startToStatusMs < 0) return undefined;
  const ms = elapsedMs - statusToCommitMs - startToStatusMs;
  return ms >= 0 ? ms : undefined;
}

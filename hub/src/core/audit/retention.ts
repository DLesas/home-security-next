/**
 * Retention (hub-design.md section 6, "Retention"; D57). Every 10 minutes ‡, while the wall clock
 * is trusted, each audit table deletes up to 2,000 ‡ of its rows older than its retention, inside
 * the next routine commit. Each delete names its cutoff as a wall time; the writer resolves it by
 * a binary search of `seq` by `at_ms` inside the commit (section 6), which the core cannot do.
 * `loss_daily` is pruned in the same rounds, by `day`, at the routine retention.
 */
import type { PruneOp } from "../model/store.ts";
import type { Retention } from "./state.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Device log levels (§6): 0 debug, 1 info, then warning and worse; the rest kept as sent. */
const DEVICE_LOG_BELOW_WARNING: readonly number[] = [0, 1];
/** Every level a device can send: a level is one byte (§6). */
const DEVICE_LOG_EVERY_LEVEL: readonly number[] = Array.from({ length: 256 }, (_, level) => level);

/** One round's deletes at `nowWallMs`, each of at most `limit` rows. */
export function retentionRound(
  retention: Retention,
  nowWallMs: number,
  limit: number,
): readonly PruneOp[] {
  const routine = nowWallMs - retention.routineDays * DAY_MS;
  const event = nowWallMs - retention.eventDays * DAY_MS;
  return [
    { table: "rejects", op: "prune", beforeMs: routine, limit },
    { table: "loss_daily", op: "prune", beforeDay: Math.floor(routine / DAY_MS), limit },
    { table: "rx_routine", op: "prune", beforeMs: routine, limit },
    { table: "tx_routine", op: "prune", beforeMs: routine, limit },
    {
      table: "device_log",
      op: "prune",
      beforeMs: routine,
      limit,
      levels: DEVICE_LOG_BELOW_WARNING,
    },
    { table: "hub_events", op: "prune", beforeMs: routine, limit, levels: ["debug"] },
    { table: "rx_event", op: "prune", beforeMs: event, limit },
    { table: "tx_event", op: "prune", beforeMs: event, limit },
    { table: "decisions", op: "prune", beforeMs: event, limit },
    { table: "commands", op: "prune", beforeMs: event, limit },
    { table: "device_log", op: "prune", beforeMs: event, limit, levels: DEVICE_LOG_EVERY_LEVEL },
    {
      table: "hub_events",
      op: "prune",
      beforeMs: event,
      limit,
      levels: ["debug", "info", "warning", "critical"],
    },
  ];
}

/**
 * The cap on warnings written at once (hub-design.md section 5, "Durability classes"): every
 * record at warning level or above is written "now", at most 60 ‡ an hour per source; beyond
 * that it goes into the routine batch, and one warning says the cap was reached. A faulty
 * device's warnings then cannot commit every second and wear out the card. Only records that
 * arrive "now" and are warnings count; an event report and its decisions, which are "now" for
 * another reason (D112), are never capped.
 */
import type { AuditRecord } from "../model/audit.ts";
import type { DecisionKind } from "../model/decisions.ts";
import type { Durability } from "../model/store.ts";
import { type Mono, monoAfterMs } from "../model/time.ts";
import type { WarningWindow } from "./state.ts";

/** The cap counts warnings per source over an hour from the first (section 5). */
export const WARNING_WINDOW_MS = 3_600_000;

/** Device log level 2 is a warning; 3 error and 4 critical are worse (§6, Log entries). */
const DEVICE_LOG_WARNING = 2;

/**
 * Decisions at warning level or above. SPEC-QUESTION: `decisions` has no level column; these
 * are the kinds sections 7 and 8 and `DecisionKind`'s comments call a warning or critical.
 */
export const WARNING_DECISIONS: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  "alarm",
  "late_report_notification",
  "siren_unreachable",
  "door_changes_missed",
  "door_state_unexpected",
  "alarm_may_be_cut_short",
  "siren_wifi_lost",
  "siren_lora_lost",
  "siren_silent",
  "sensor_silent",
  "gateway_offline",
  "interference_started",
  "noise_interference_started",
  "interference_learned_as_normal",
  "damaged_packets",
  "move_stalled",
  "move_forced",
]);

/** The source a warning counts against, or undefined for a record below warning level. */
export function warningSource(record: AuditRecord): string | undefined {
  switch (record.kind) {
    case "hubEvent":
      return record.row.level === "warning" || record.row.level === "critical"
        ? `event:${record.row.origin}`
        : undefined;
    case "deviceLog":
      return record.row.level >= DEVICE_LOG_WARNING ? `device:${record.row.deviceId}` : undefined;
    case "decision":
      if (!WARNING_DECISIONS.has(record.row.kind)) return undefined;
      return record.row.deviceId === null ? "hub" : `device:${record.row.deviceId}`;
    default:
      return undefined;
  }
}

/** What the cap makes of one record. */
export interface Capped {
  readonly durability: Durability;
  readonly window: WarningWindow | undefined;
  /** The record is the first over the cap in its hour: say so, once. */
  readonly reached: boolean;
}

/** Applies the cap of `perHour` to a record of `source` arriving with `durability` at `now`. */
export function cap(
  window: WarningWindow | undefined,
  durability: Durability,
  now: Mono,
  perHour: number,
): Capped {
  if (durability !== "now") return { durability, window, reached: false };
  const current =
    window === undefined || now >= monoAfterMs(window.since, WARNING_WINDOW_MS)
      ? { since: now, count: 0, noticed: false }
      : window;
  const count = current.count + 1;
  if (count <= perHour) return { durability: "now", window: { ...current, count }, reached: false };
  return {
    durability: "routine",
    window: { ...current, count, noticed: true },
    reached: !current.noticed,
  };
}

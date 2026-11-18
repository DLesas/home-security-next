/**
 * What the relay keeps of each hub identity besides its presence (docs/m4-design.md section 3,
 * "What the relay stores", and D142's rows "New hub identities" and "Identities that never
 * settle"). Pure.
 *
 * - An identity is **established** once it has connected on `settledAfterDays` different UTC days.
 * - An established identity is deleted, with its targets, once `establishedHubMs` have passed
 *   since its last contact; one not established once `unsettledHubMs` have. At the edge itself it
 *   is deleted: it is kept *until* that long without contact.
 * - Last contact here is the real one, `seenMs`: the first frame of each UTC day and the link's
 *   last frame when it closes are stored, so a relay restart (which starts the presence clock
 *   afresh, D96) never makes an identity look recently seen.
 */
import { RETENTION_RULES } from "./rules.ts";
import { utcDay } from "./time.ts";

/** A hub identity's row, beside its presence. */
export interface HubRecord {
  readonly identity: string;
  readonly firstSeenMs: number;
  /** Different UTC days it has connected on, counted up to `settledAfterDays`. */
  readonly daysSeen: number;
  /** The UTC day of `seenMs`. */
  readonly lastDay: number;
  /** Its last contact as stored. */
  readonly seenMs: number;
}

export function isEstablished(record: HubRecord): boolean {
  return record.daysSeen >= RETENTION_RULES.settledAfterDays;
}

/** A record for an identity first heard at `atMs`. */
export function newRecord(identity: string, atMs: number): HubRecord {
  return { identity, firstSeenMs: atMs, daysSeen: 1, lastDay: utcDay(atMs), seenMs: atMs };
}

/**
 * The record after a frame at `atMs`, and whether it must be stored: only on a new UTC day, when
 * it counts one more day seen.
 */
export function seenOn(record: HubRecord, atMs: number): { record: HubRecord; store: boolean } {
  const today = utcDay(atMs);
  if (today <= record.lastDay) return { record, store: false };
  return {
    record: {
      ...record,
      daysSeen: Math.min(record.daysSeen + 1, RETENTION_RULES.settledAfterDays),
      lastDay: today,
      seenMs: atMs,
    },
    store: true,
  };
}

/** The record when its link closes at `atMs`, its last frame having come at `lastFrameMs`. */
export function linkClosed(record: HubRecord, lastFrameMs: number): HubRecord {
  return lastFrameMs > record.seenMs ? { ...record, seenMs: lastFrameMs } : record;
}

/** How long without contact `record` is kept. */
export function retentionOf(record: HubRecord): number {
  return isEstablished(record) ? RETENTION_RULES.establishedHubMs : RETENTION_RULES.unsettledHubMs;
}

/** Whether `record` is to be deleted at `nowMs`. */
export function isExpired(record: HubRecord, nowMs: number): boolean {
  return nowMs - record.seenMs >= retentionOf(record);
}

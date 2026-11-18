/**
 * Timers are data (hub-design.md section 2, "Timers"): `{ at, key }`, kept in the slice of the
 * module that owns them. The dispatcher runs every due timer at the start of every step, as a
 * `timer` message to that module only. Each module's `deadlines(slice)` lists its timers.
 */
import type { DeviceId, LinkId, OutboxId, RolloutId, ScheduleId, TokenId } from "./ids.ts";
import type { ModuleName } from "./modules.ts";
import type { Mono } from "./time.ts";

export type TimerKey =
  /** A Provision got no answer in 5 s ‡ (section 9). */
  | { readonly module: "setup"; readonly kind: "provisionAnswer"; readonly link: LinkId }
  /** Nothing from a gateway for 60 s: offline (§7, D97). */
  | { readonly module: "gateways"; readonly kind: "offline"; readonly gateway: DeviceId }
  /** A second session not proven within 10 s ‡: its link is closed (section 8). */
  | { readonly module: "gateways"; readonly kind: "unprovenSession"; readonly link: LinkId }
  /** No transmit result by the latest moment + 5 s ‡, or 10 s ‡ with no limit (section 7). */
  | {
      readonly module: "gateways";
      readonly kind: "transmitResult";
      readonly gateway: DeviceId;
      readonly requestCounter: number;
    }
  /** A sensor has not confirmed the site move after 4 of its intervals †: `move_stalled` (D115). */
  | { readonly module: "site"; readonly kind: "moveStalled"; readonly sensor: DeviceId }
  /** The silence grace after a switch ends; the move is done for whoever has not followed (D115). */
  | { readonly module: "site"; readonly kind: "followGraceEnd" }
  /** A sensor's countdown ends (AL3). */
  | { readonly module: "alarm"; readonly kind: "countdownEnd"; readonly sensor: DeviceId }
  /** Every siren's time has passed: the alarm ends by itself (D67). */
  | { readonly module: "alarm"; readonly kind: "alarmEnd" }
  /** The second copy of a disarmed notice, 2 s after the first (D24). */
  | { readonly module: "sensors"; readonly kind: "disarmedNoticeCopy"; readonly sensor: DeviceId }
  /** A sensor's silence threshold, n × I + 30 s ‡ (D107). */
  | { readonly module: "sensors"; readonly kind: "silence"; readonly sensor: DeviceId }
  /** The daily choice of each sensor's n (D107). */
  | { readonly module: "sensors"; readonly kind: "dailyLoss" }
  /** A siren command's next repeat on Wi-Fi, every 2 s (§8). */
  | { readonly module: "sirens"; readonly kind: "wifiRepeat"; readonly siren: DeviceId }
  /** A siren command's next repeat on LoRa, every 5 s (§8). */
  | { readonly module: "sirens"; readonly kind: "loraRepeat"; readonly siren: DeviceId }
  /** A minute without confirmation: `siren_unreachable` (§7). */
  | { readonly module: "sirens"; readonly kind: "giveUp"; readonly siren: DeviceId }
  /** During a site move, siren settings repeat every 60 s ‡ after the first minute (D115). */
  | { readonly module: "sirens"; readonly kind: "settingsRepeat"; readonly siren: DeviceId }
  /** Nothing on Wi-Fi for 70 s ‡, or its link not back within 70 s ‡ (D73). */
  | { readonly module: "sirens"; readonly kind: "wifiPathLost"; readonly siren: DeviceId }
  /** Nothing on LoRa for 630 s ‡ while Wi-Fi works (D73). */
  | { readonly module: "sirens"; readonly kind: "loraPathLost"; readonly siren: DeviceId }
  /** On LoRa alone, nothing for 2P + max(10 s, P ÷ 10) ‡ (§7, D52). */
  | { readonly module: "sirens"; readonly kind: "silent"; readonly siren: DeviceId }
  /** The end of the 120 s ‡ after a start within which each siren is sent "report now" (section 7). */
  | { readonly module: "sirens"; readonly kind: "reportNowWindow" }
  /** A retention round, every 10 minutes ‡ (section 6). */
  | { readonly module: "audit"; readonly kind: "retention" }
  // M2 (m2-design.md section 2).
  /** A link token's expiry, on the monotonic clock from its creation (section 5). */
  | { readonly module: "people"; readonly kind: "tokenExpiry"; readonly token: TokenId }
  /** A schedule entry's next time, as a monotonic deadline (section 7, "Schedules"). */
  | { readonly module: "schedules"; readonly kind: "entryDue"; readonly schedule: ScheduleId }
  /** The daily backup, at its local hour (section 9, D122). */
  | { readonly module: "upkeep"; readonly kind: "backupDaily" }
  /** The end of the 60 s ‡ that gathers changes into one more backup (section 9). */
  | { readonly module: "upkeep"; readonly kind: "backupCoalesce" }
  /** A failed backup's retry, every 5 minutes ‡ (section 9). */
  | { readonly module: "upkeep"; readonly kind: "backupRetry" }
  /** An hour ‡ with a backup due: `backup_overdue`, once (section 9). */
  | { readonly module: "upkeep"; readonly kind: "backupOverdue" }
  /** The restore token's expiry, 10 minutes ‡ after it was made (section 9). */
  | { readonly module: "upkeep"; readonly kind: "restoreExpiry" }
  /** An approved update waiting for no countdown, alarm, site move, provisioning or restore (D54). */
  | { readonly module: "upkeep"; readonly kind: "updateWait" }
  // The joint step 0 of M3 and M4 (docs/m3-m4-plan.md).
  /** relay: the link down for 180 s ‡: `relay_unreachable`, once per outage (m4-design section 4). */
  | { readonly module: "relay"; readonly kind: "unreachable" }
  /** relay: the end of the hour ‡ whose ups and downs one `relay_link` record sums. */
  | { readonly module: "relay"; readonly kind: "linkRecord" }
  /** relay: a `limited` or `failed` push tried again (1, 5, 15 minutes ‡, then every 15). */
  | { readonly module: "relay"; readonly kind: "pushRetry"; readonly id: OutboxId }
  /** relay: the oldest outbox row reaches 7 days ‡: `push_dropped`. */
  | { readonly module: "relay"; readonly kind: "outboxExpiry" }
  /** relay: the roster's sealed alerts made again ‡. */
  | { readonly module: "relay"; readonly kind: "rosterRefresh" }
  /** firmware: the soak after the last pilot ends (an hour ‡). */
  | { readonly module: "firmware"; readonly kind: "soakEnd"; readonly rollout: RolloutId }
  /** firmware: a go-ahead's trial deadline plus 2 minutes ‡ without a Started: `noContact`. */
  | { readonly module: "firmware"; readonly kind: "trialWatch"; readonly device: DeviceId }
  /** firmware: a Bluetooth session's life ends (15 minutes ‡). */
  | { readonly module: "firmware"; readonly kind: "sessionExpiry"; readonly device: DeviceId }
  /** firmware: D91's reminder for a sensor held armed (24 hours ‡, then daily). */
  | { readonly module: "firmware"; readonly kind: "armedReminder"; readonly device: DeviceId }
  /** firmware: a gateway held as always busy is offered again (an hour ‡). */
  | { readonly module: "firmware"; readonly kind: "gatewayBusyRetry"; readonly device: DeviceId }
  /** firmware: the next `deviceUpdate` progress event may go (2 s ‡). */
  | { readonly module: "firmware"; readonly kind: "progressEvent"; readonly device: DeviceId };

/** The timer keys one module owns. */
export type TimerKeyOf<M extends ModuleName> = Extract<TimerKey, { readonly module: M }>;

/** A timer: run `key`'s module at or after `at`. */
export interface Timer<K extends TimerKey = TimerKey> {
  readonly at: Mono;
  readonly key: K;
}

/** The timers one module owns. */
export type TimerOf<M extends ModuleName> = Timer<TimerKeyOf<M>>;

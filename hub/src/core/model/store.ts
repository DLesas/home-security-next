/**
 * Writes to the database (hub-design.md sections 2, 5 and 6): one `StoreOp` variant per table.
 * Each is a full value, never a delta, so a write can be repeated after a failed commit without
 * harm. Rows of the audit tables are written as `AuditRecord`s; their only `StoreOp` is
 * retention's prune.
 */
import type { BootId, DeviceId } from "./ids.ts";
import type {
  AlarmRow,
  AlarmSirenRow,
  AlarmTriggerRow,
  BootRow,
  CountdownRow,
  DeviceKeyRow,
  DeviceRow,
  DeviceStateRow,
  GatewayConfigRow,
  HubKeysRow,
  LossDailyRow,
  SendCounterRow,
  SensorConfigRow,
  SirenConfigRow,
  SiteRow,
} from "./rows.ts";

/**
 * When an item reaches the disk (section 5, "Durability classes"). "now": committed at once,
 * and nothing that depends on it leaves the hub first. "routine": held and committed with the
 * next flush, within five minutes.
 */
export type Durability = "now" | "routine";

/** The row each configuration and state table holds, by table name. */
export interface StateTables {
  readonly devices: DeviceRow;
  readonly device_keys: DeviceKeyRow;
  readonly send_counters: SendCounterRow;
  readonly hub_keys: HubKeysRow;
  readonly site: SiteRow;
  readonly sensor_config: SensorConfigRow;
  readonly siren_config: SirenConfigRow;
  readonly gateway_config: GatewayConfigRow;
  readonly countdowns: CountdownRow;
  readonly alarm: AlarmRow;
  readonly alarm_triggers: AlarmTriggerRow;
  readonly alarm_sirens: AlarmSirenRow;
  readonly boots: BootRow;
  readonly device_state: DeviceStateRow;
  readonly loss_daily: LossDailyRow;
}

/** The key that names one row of each table; a single-row table's is `undefined`. */
export interface StateTableKeys {
  readonly devices: { readonly id: DeviceId };
  readonly device_keys: { readonly deviceId: DeviceId };
  readonly send_counters: { readonly deviceId: DeviceId };
  readonly hub_keys: undefined;
  readonly site: undefined;
  readonly sensor_config: { readonly deviceId: DeviceId };
  readonly siren_config: { readonly deviceId: DeviceId };
  readonly gateway_config: { readonly deviceId: DeviceId };
  readonly countdowns: { readonly sensorId: DeviceId };
  readonly alarm: undefined;
  readonly alarm_triggers: { readonly sensorId: DeviceId };
  readonly alarm_sirens: { readonly sirenId: DeviceId };
  readonly boots: { readonly id: BootId };
  readonly device_state: { readonly deviceId: DeviceId };
  readonly loss_daily: { readonly deviceId: DeviceId; readonly day: number };
}

/** The audit tables of section 6. */
export type AuditTable =
  | "rx_routine"
  | "rx_event"
  | "tx_routine"
  | "tx_event"
  | "decisions"
  | "device_log"
  | "hub_events"
  | "commands"
  | "rejects";

export type StateTable = keyof StateTables;

/** Writes the whole row, inserting it or replacing the row with the same key. */
export type UpsertOp = {
  readonly [T in StateTable]: {
    readonly table: T;
    readonly op: "upsert";
    readonly row: StateTables[T];
  };
}[StateTable];

/** Deletes the row with this key; for a single-row table, its one row. */
export type DeleteOp = {
  readonly [T in StateTable]: {
    readonly table: T;
    readonly op: "delete";
    readonly key: StateTableKeys[T];
  };
}[StateTable];

/**
 * Retention (section 6): deletes up to `limit` of the oldest rows stamped before `beforeMs` (wall
 * milliseconds); in `device_log` and `hub_events` only the levels listed. The writer resolves the
 * cutoff inside the commit, by a binary search of `seq` by `at_ms` (or by `minute` for
 * `rejects`), so the core needs no sequence number for it. Repeatable after a failed commit.
 */
export type PruneOp =
  | {
      readonly table: Exclude<AuditTable, "device_log" | "hub_events">;
      readonly op: "prune";
      readonly beforeMs: number;
      readonly limit: number;
    }
  | {
      readonly table: "device_log";
      readonly op: "prune";
      readonly beforeMs: number;
      readonly limit: number;
      /** Device log levels, as the device sends them (§6). */
      readonly levels: readonly number[];
    }
  | {
      readonly table: "hub_events";
      readonly op: "prune";
      readonly beforeMs: number;
      readonly limit: number;
      readonly levels: readonly ("debug" | "info" | "warning" | "critical")[];
    }
  /** `loss_daily`, by day (days since 1970), at the routine retention (section 6, "Retention"). */
  | {
      readonly table: "loss_daily";
      readonly op: "prune";
      readonly beforeDay: number;
      readonly limit: number;
    };

/** One write to the database, carried by a `write` effect. */
export type StoreOp = UpsertOp | DeleteOp | PruneOp;

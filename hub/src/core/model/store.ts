/**
 * Writes to the database (hub-design.md sections 2, 5 and 6): one `StoreOp` variant per table.
 * Each is a full value, never a delta, so a write can be repeated after a failed commit without
 * harm. Rows of the audit tables are written as `AuditRecord`s; their only `StoreOp` is
 * retention's prune.
 */
import type {
  BootId,
  ClientId,
  DeviceId,
  GroupId,
  ImageId,
  ModeId,
  OutboxId,
  PersonId,
  RolloutId,
  ScheduleId,
  TokenId,
} from "./ids.ts";
import type {
  AlarmRow,
  AlarmSirenRow,
  AlarmTriggerRow,
  BackupKeyRow,
  BackupStateRow,
  BootRow,
  ClientReplyRow,
  ClientRow,
  CountdownRow,
  DeviceKeyRow,
  DeviceRow,
  DeviceUpdateRow,
  FirmwareImageRow,
  DeviceStateRow,
  GatewayConfigRow,
  GroupMemberRow,
  GroupRow,
  GroupSirenRow,
  HealthStateRow,
  HubKeysRow,
  LinkSecretRow,
  LinkTokenRow,
  LossDailyRow,
  ModeGroupRow,
  ModeRow,
  ModeStateRow,
  NotificationPrefsRow,
  PeopleSettingsRow,
  PermissionRow,
  PersonRoleRow,
  PersonRow,
  PushKeyRow,
  PushOutboxRow,
  PushTargetRow,
  Rekey,
  RelaySettingsRow,
  RolloutRow,
  ScheduleRow,
  ScheduleStateRow,
  SendCounterRow,
  SensorConfigRow,
  SirenConfigRow,
  SiteRow,
  UpdateStateRow,
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
  // M2 (m2-design.md section 4).
  readonly people: PersonRow;
  readonly clients: ClientRow;
  readonly client_replies: ClientReplyRow;
  readonly permissions: PermissionRow;
  readonly person_roles: PersonRoleRow;
  readonly link_tokens: LinkTokenRow;
  readonly link_secrets: LinkSecretRow;
  readonly groups: GroupRow;
  readonly group_members: GroupMemberRow;
  readonly group_sirens: GroupSirenRow;
  readonly modes: ModeRow;
  readonly mode_groups: ModeGroupRow;
  readonly schedules: ScheduleRow;
  readonly health_state: HealthStateRow;
  readonly notification_prefs: NotificationPrefsRow;
  // M2's single rows, one writer each (section 4).
  readonly mode_state: ModeStateRow;
  readonly people_settings: PeopleSettingsRow;
  readonly schedule_state: ScheduleStateRow;
  readonly backup_state: BackupStateRow;
  readonly backup_key: BackupKeyRow;
  readonly update_state: UpdateStateRow;
  // Migration 3: the joint step 0 of M3 and M4. `push_keys` as `link_secrets`: the core writes the
  // row now with `push.register` and gives the `PushKeys` port the key by `pushKey`; it keeps no
  // key in its slice (m4-design section 4).
  readonly firmware_images: FirmwareImageRow;
  readonly rollouts: RolloutRow;
  readonly device_updates: DeviceUpdateRow;
  readonly relay_settings: RelaySettingsRow;
  readonly push_targets: PushTargetRow;
  readonly push_keys: PushKeyRow;
  readonly push_outbox: PushOutboxRow;
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
  // M2.
  readonly people: { readonly id: PersonId };
  readonly clients: { readonly id: ClientId };
  readonly client_replies: { readonly clientId: ClientId; readonly seq: number };
  readonly permissions: { readonly personId: PersonId; readonly deviceId: DeviceId };
  readonly person_roles: { readonly personId: PersonId };
  readonly link_tokens: { readonly id: TokenId };
  readonly link_secrets: { readonly tokenId: TokenId };
  readonly groups: { readonly id: GroupId };
  readonly group_members: { readonly groupId: GroupId; readonly sensorId: DeviceId };
  readonly group_sirens: { readonly groupId: GroupId; readonly sirenId: DeviceId };
  readonly modes: { readonly id: ModeId };
  readonly mode_groups: { readonly modeId: ModeId; readonly groupId: GroupId };
  readonly schedules: { readonly id: ScheduleId };
  readonly health_state: { readonly deviceId: DeviceId };
  readonly notification_prefs: { readonly clientId: ClientId };
  readonly mode_state: undefined;
  readonly people_settings: undefined;
  readonly schedule_state: undefined;
  readonly backup_state: undefined;
  readonly backup_key: undefined;
  readonly update_state: undefined;
  // Migration 3.
  readonly firmware_images: { readonly id: ImageId };
  readonly rollouts: { readonly id: RolloutId };
  readonly device_updates: { readonly deviceId: DeviceId };
  readonly relay_settings: undefined;
  readonly push_targets: { readonly clientId: ClientId };
  readonly push_keys: { readonly clientId: ClientId };
  readonly push_outbox: { readonly id: OutboxId };
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
  | "rejects"
  // M2 (m2-design.md section 4).
  | "notifications"
  | "notification_reads";

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

/**
 * The pending key change of one device after a restore (D141, m3-updates-design section 7): sets
 * `device_keys.next_key` and `rekey` of the row with this device's id, and nothing else, so the
 * core never names the device's current key, which it is never given (hub-design.md section 2).
 * Repeatable: the same values written again change nothing, and for a device with no row it
 * writes nothing.
 */
export interface PendingKeyOp {
  readonly table: "device_keys";
  readonly op: "pendingKey";
  readonly key: StateTableKeys["device_keys"];
  readonly nextKey: Uint8Array;
  readonly rekey: Rekey;
}

/** One write to the database, carried by a `write` effect. */
export type StoreOp = UpsertOp | DeleteOp | PruneOp | PendingKeyOp;

/**
 * The first migration against hub-design.md section 6: applied to an empty database on Bun's
 * built-in SQLite, it must give every table with exactly the columns, keys and unique keys the
 * design lists. The expected lists below are written from the design, not from `schema.ts`.
 * A type-level check holds the core's row types to the Drizzle tables' columns.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type * as rows from "../../src/core/model/rows.ts";
import type * as schema from "../../src/db/schema.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

/** Every table of section 6: its columns in order, its key, and whether it has a row id. */
const EXPECTED: Readonly<Record<string, { columns: string; key: string; rowid?: false }>> = {
  devices: {
    columns: "id address role name chip_id firmware development state added_ms removed_ms",
    key: "id",
  },
  // Migration 3 adds `next_key` and `rekey` (m3-updates-design section 7).
  device_keys: { columns: "device_id key next_key rekey", key: "device_id" },
  send_counters: { columns: "device_id resume_point", key: "device_id" },
  hub_keys: {
    columns:
      "signing_private signing_public identity app_static_private app_static_public tls_private " +
      "tls_certificate",
    key: "",
  },
  site: {
    columns:
      "channel rate_mask move_id move_stage move_channel move_rate move_actor move_requested_ms " +
      "move_forced move_switched_boot move_switched_mono wifi_name wifi_password " +
      "countdown_default_s auto_stop_s reply_power_dbm siren_power_dbm retention_routine_days " +
      "retention_event_days",
    key: "",
  },
  sensor_config: {
    columns:
      "device_id arm armed_boot armed_mono countdown_s heartbeat_units link_check_every send_rate " +
      "reply_rate reply_rate_fixed correction_units correction_fixed next_channel next_rate " +
      "move_confirmed move_followed version version_history",
    key: "device_id",
  },
  siren_config: {
    columns:
      "device_id version wifi_interval_s lora_check_units max_sound_s send_rate command_rate " +
      "site_channel version_history",
    key: "device_id",
  },
  gateway_config: {
    columns:
      "device_id version status_interval_s interference_db interference_s default_power_dbm " +
      "siren_power_dbm",
    key: "device_id",
  },
  countdowns: {
    columns:
      "sensor_id boot opened_mono deadline_mono newest_counter reply_gateway_id reply_rate cause_seq",
    key: "sensor_id",
  },
  alarm: { columns: "boot started_mono cause_seq", key: "" },
  alarm_triggers: { columns: "sensor_id kind boot at_mono", key: "sensor_id" },
  alarm_sirens: { columns: "siren_id boot until_mono commanded", key: "siren_id" },
  boots: {
    columns:
      "id started_ms started_trusted previous_exit cause clean_stop_ms trusted_at_mono clock_step_ms",
    key: "id",
  },
  device_state: {
    columns:
      "device_id boot last_seen_mono last_seen_ms clock_ok window reading rssi snr_q " +
      "best_gateway_id uptime_s estimates",
    key: "device_id",
  },
  loss_daily: { columns: "device_id day received expected", key: "device_id day", rowid: false },
  rx_routine: {
    columns:
      "seq at_ms clock_ok device_id type counter path gateway_id gw_us rssi snr_q rate body gw_counter " +
      "old_key",
    key: "seq",
  },
  rx_event: {
    columns:
      "seq at_ms clock_ok device_id type counter path gateway_id gw_us rssi snr_q rate body gw_counter " +
      "old_key",
    key: "seq",
  },
  tx_routine: {
    columns:
      "seq at_ms clock_ok device_id type counter path gateway_id request_counter rate power " +
      "outcome gw_sent_us body result_counter",
    key: "seq",
  },
  tx_event: {
    columns:
      "seq at_ms clock_ok device_id type counter path gateway_id request_counter rate power " +
      "outcome gw_sent_us body result_counter",
    key: "seq",
  },
  decisions: {
    columns: "seq at_ms clock_ok kind device_id cause_seq value detail",
    key: "seq",
  },
  device_log: {
    columns: "seq at_ms clock_ok device_id counter made_ms level code text repeat_of",
    key: "seq",
  },
  hub_events: { columns: "seq at_ms clock_ok level origin code message detail", key: "seq" },
  commands: { columns: "seq at_ms clock_ok actor kind args outcome detail", key: "seq" },
  rejects: {
    columns: "minute via reason count address sample",
    key: "minute via reason",
    rowid: false,
  },
  // M2 (m2-design.md section 4, migration 2).
  people: { columns: "id name created_ms removed_ms revision", key: "id" },
  clients: {
    columns:
      "id person_id static_key kind name linked_by_client created_ms removed_ms last_seq " +
      "last_seen_ms backup_key_epoch",
    key: "id",
  },
  client_replies: { columns: "client_id seq reply", key: "client_id seq", rowid: false },
  permissions: {
    columns: "person_id device_id manage view",
    key: "person_id device_id",
    rowid: false,
  },
  person_roles: { columns: "person_id manage_users manage_system revision", key: "person_id" },
  link_tokens: {
    columns:
      "id lookup kind person_id person_name created_by_client created_boot created_mono " +
      "expires_after_ms typed failures used_ms",
    key: "id",
  },
  link_secrets: { columns: "token_id psk", key: "token_id" },
  groups: { columns: "id name all_sirens revision", key: "id" },
  group_members: { columns: "group_id sensor_id", key: "group_id sensor_id", rowid: false },
  group_sirens: { columns: "group_id siren_id", key: "group_id siren_id", rowid: false },
  modes: { columns: "id name fixed revision", key: "id" },
  mode_groups: { columns: "mode_id group_id", key: "mode_id group_id", rowid: false },
  schedules: {
    columns:
      "id name action mode_id group_id sensor_id local_time days date enabled created_by " +
      "last_run_ms last_run_local_date missed_due_ms missed_why missed_count revision",
    key: "id",
  },
  health_state: { columns: "device_id battery_low tamper_open", key: "device_id" },
  notification_prefs: { columns: "client_id categories revision", key: "client_id" },
  mode_state: { columns: "current_mode_id mode_modified", key: "" },
  people_settings: { columns: "user_management", key: "" },
  schedule_state: { columns: "time_zone", key: "" },
  backup_state: {
    columns:
      "folder hour keep last_change_ms due_since_ms overdue_raised newest_name newest_ms " +
      "last_result last_attempt_ms restored_from_ms",
    key: "",
  },
  backup_key: { columns: "key epoch", key: "" },
  update_state: {
    columns:
      "staged_version staged_ms approved_by approved_ms switching_ms previous_version last_result " +
      "last_result_ms",
    key: "",
  },
  notifications: {
    columns: "seq at_ms clock_ok kind category critical device_id cause_seq recipients detail",
    key: "seq",
  },
  notification_reads: { columns: "seq at_ms clock_ok notification_seq client_id", key: "seq" },
  // The joint step 0 of M3 and M4 (docs/m3-m4-plan.md, migration 3), from m3-updates-design
  // section 4 and m4-design section 4.
  firmware_images: {
    columns:
      "id image_id sha256 version kind roles bytes header manifest file added_ms added_by " +
      "removed_ms",
    key: "id",
  },
  rollouts: {
    columns:
      "id image devices pilots stage approved_by approved_ms soak_until_ms paused_reason " +
      "paused_device ended_ms",
    key: "id",
  },
  device_updates: {
    columns:
      "device_id rollout_id same_version state method held bytes attempts last_reason since_ms " +
      "ble_nonce ble_expires_ms reminded_ms",
    key: "device_id",
  },
  relay_settings: { columns: "url revision", key: "" },
  push_targets: {
    columns: "client_id key_id platform environment token registered_ms invalid_ms",
    key: "client_id",
  },
  push_keys: { columns: "client_id key", key: "client_id" },
  // `armed` and `facts` (B5): what a push brought back after a restart says.
  push_outbox: {
    columns: "id notification_seq client_id created_ms attempts armed facts",
    key: "id",
  },
};

interface ColumnInfo {
  readonly name: string;
  readonly pk: number;
}
interface TableInfo {
  readonly name: string;
  readonly wr: number;
}
interface IndexInfo {
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
}

function migrated(): Database {
  const database = new Database(":memory:");
  migrate(drizzle(database), { migrationsFolder: MIGRATIONS });
  return database;
}

describe("the first migration (section 6)", () => {
  const database = migrated();
  const tables = database
    .query<TableInfo, []>(
      "SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' " +
        "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all();

  test("creates exactly the tables of section 6", () => {
    expect(tables.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test.each(Object.entries(EXPECTED))("%s has the design's columns and key", (name, expected) => {
    const columns = database
      .query<ColumnInfo, []>(`SELECT name, pk FROM pragma_table_info('${name}')`)
      .all();
    expect(columns.map((c) => c.name).join(" ")).toBe(expected.columns);
    const key = columns.filter((c) => c.pk > 0).toSorted((a, b) => a.pk - b.pk);
    expect(key.map((c) => c.name).join(" ")).toBe(expected.key);
    const withoutRowid = tables.find((t) => t.name === name)?.wr === 1;
    expect(withoutRowid).toBe(expected.rowid === false);
  });

  test("the only other indexes are the unique keys: devices' two, and M2's five (section 4)", () => {
    const indexes = Object.keys(EXPECTED).flatMap((name) =>
      database
        .query<IndexInfo, []>(`SELECT name, "unique", origin FROM pragma_index_list('${name}')`)
        .all()
        .filter((index) => index.origin !== "pk")
        .map((index) => ({
          table: name,
          unique: index.unique,
          columns: indexColumns(database, index.name),
        })),
    );
    const sort = (rows: readonly { table: string; unique: number; columns: string }[]) =>
      rows.toSorted((a, b) => `${a.table} ${a.columns}`.localeCompare(`${b.table} ${b.columns}`));
    expect(sort(indexes)).toEqual(
      sort([
        { table: "devices", unique: 1, columns: "address" },
        { table: "devices", unique: 1, columns: "name" },
        // M2: people's names among those not removed, tokens' lookups among unused ones (partial).
        { table: "people", unique: 1, columns: "name" },
        { table: "clients", unique: 1, columns: "static_key" },
        { table: "link_tokens", unique: 1, columns: "lookup" },
        { table: "groups", unique: 1, columns: "name" },
        { table: "modes", unique: 1, columns: "name" },
        // Migration 3: an image id among those not removed; one rollout not ended (an index on
        // the expression `ended_ms IS NULL`, which has no column name).
        { table: "firmware_images", unique: 1, columns: "image_id" },
        { table: "rollouts", unique: 1, columns: "" },
      ]),
    );
  });

  test("an audit row's seq is its row id", () => {
    database.run(
      "INSERT INTO decisions (seq, at_ms, clock_ok, kind) VALUES (4294967297, 1, 1, 'alarm')",
    );
    expect(database.query("SELECT rowid AS id FROM decisions").get()).toEqual({ id: 4294967297 });
  });
});

function indexColumns(database: Database, index: string): string {
  return database
    .query<{ name: string }, []>(`SELECT name FROM pragma_index_info('${index}')`)
    .all()
    .map((c) => c.name)
    .join(" ");
}

// The core's row types and the Drizzle tables have the same columns.
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never]
  ? true
  : {
      readonly onlyInModel: Exclude<keyof A, keyof B>;
      readonly onlyInSchema: Exclude<keyof B, keyof A>;
    };
type Columns<T extends { $inferSelect: unknown }> = T["$inferSelect"];

export const rowsMatchSchema: readonly true[] = [
  true satisfies SameKeys<rows.DeviceRow, Columns<typeof schema.devices>>,
  true satisfies SameKeys<rows.DeviceKeyRow, Columns<typeof schema.deviceKeys>>,
  true satisfies SameKeys<rows.SendCounterRow, Columns<typeof schema.sendCounters>>,
  true satisfies SameKeys<rows.HubKeysRow, Columns<typeof schema.hubKeys>>,
  true satisfies SameKeys<rows.SiteRow, Columns<typeof schema.site>>,
  true satisfies SameKeys<rows.SensorConfigRow, Columns<typeof schema.sensorConfig>>,
  true satisfies SameKeys<rows.SirenConfigRow, Columns<typeof schema.sirenConfig>>,
  true satisfies SameKeys<rows.GatewayConfigRow, Columns<typeof schema.gatewayConfig>>,
  true satisfies SameKeys<rows.CountdownRow, Columns<typeof schema.countdowns>>,
  true satisfies SameKeys<rows.AlarmRow, Columns<typeof schema.alarm>>,
  true satisfies SameKeys<rows.AlarmTriggerRow, Columns<typeof schema.alarmTriggers>>,
  true satisfies SameKeys<rows.AlarmSirenRow, Columns<typeof schema.alarmSirens>>,
  true satisfies SameKeys<rows.BootRow, Columns<typeof schema.boots>>,
  true satisfies SameKeys<rows.DeviceStateRow, Columns<typeof schema.deviceState>>,
  true satisfies SameKeys<rows.LossDailyRow, Columns<typeof schema.lossDaily>>,
  true satisfies SameKeys<rows.RxRow, Columns<typeof schema.rxRoutine>>,
  true satisfies SameKeys<rows.RxRow, Columns<typeof schema.rxEvent>>,
  true satisfies SameKeys<rows.TxRow, Columns<typeof schema.txRoutine>>,
  true satisfies SameKeys<rows.TxRow, Columns<typeof schema.txEvent>>,
  true satisfies SameKeys<rows.DecisionRow, Columns<typeof schema.decisions>>,
  true satisfies SameKeys<rows.DeviceLogRow, Columns<typeof schema.deviceLog>>,
  true satisfies SameKeys<rows.HubEventRow, Columns<typeof schema.hubEvents>>,
  true satisfies SameKeys<rows.CommandRow, Columns<typeof schema.commands>>,
  true satisfies SameKeys<rows.RejectRow, Columns<typeof schema.rejects>>,
  // M2 (migration 2).
  true satisfies SameKeys<rows.PersonRow, Columns<typeof schema.people>>,
  true satisfies SameKeys<rows.ClientRow, Columns<typeof schema.clients>>,
  true satisfies SameKeys<rows.ClientReplyRow, Columns<typeof schema.clientReplies>>,
  true satisfies SameKeys<rows.PermissionRow, Columns<typeof schema.permissions>>,
  true satisfies SameKeys<rows.PersonRoleRow, Columns<typeof schema.personRoles>>,
  true satisfies SameKeys<rows.LinkTokenRow, Columns<typeof schema.linkTokens>>,
  true satisfies SameKeys<rows.LinkSecretRow, Columns<typeof schema.linkSecrets>>,
  true satisfies SameKeys<rows.GroupRow, Columns<typeof schema.groups>>,
  true satisfies SameKeys<rows.GroupMemberRow, Columns<typeof schema.groupMembers>>,
  true satisfies SameKeys<rows.GroupSirenRow, Columns<typeof schema.groupSirens>>,
  true satisfies SameKeys<rows.ModeRow, Columns<typeof schema.modes>>,
  true satisfies SameKeys<rows.ModeGroupRow, Columns<typeof schema.modeGroups>>,
  true satisfies SameKeys<rows.ScheduleRow, Columns<typeof schema.schedules>>,
  true satisfies SameKeys<rows.HealthStateRow, Columns<typeof schema.healthState>>,
  true satisfies SameKeys<rows.NotificationPrefsRow, Columns<typeof schema.notificationPrefs>>,
  true satisfies SameKeys<rows.UpdateStateRow, Columns<typeof schema.updateState>>,
  true satisfies SameKeys<rows.NotificationRow, Columns<typeof schema.notifications>>,
  true satisfies SameKeys<rows.NotificationReadRow, Columns<typeof schema.notificationReads>>,
  // Migration 3.
  true satisfies SameKeys<rows.FirmwareImageRow, Columns<typeof schema.firmwareImages>>,
  true satisfies SameKeys<rows.RolloutRow, Columns<typeof schema.rollouts>>,
  true satisfies SameKeys<rows.DeviceUpdateRow, Columns<typeof schema.deviceUpdates>>,
  true satisfies SameKeys<rows.RelaySettingsRow, Columns<typeof schema.relaySettings>>,
  true satisfies SameKeys<rows.PushTargetRow, Columns<typeof schema.pushTargets>>,
  true satisfies SameKeys<rows.PushKeyRow, Columns<typeof schema.pushKeys>>,
  true satisfies SameKeys<rows.PushOutboxRow, Columns<typeof schema.pushOutbox>>,
];

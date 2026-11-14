/**
 * The tables the writer and the reader use (hub-design.md section 6), described once from the
 * Drizzle schema, so no column list is written twice: each table's SQL name, its columns as
 * property and column names, and the columns of its key. Single-row tables (`site`, `hub_keys`,
 * `alarm`) have no key.
 */
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AuditTable, StateTable } from "../../core/model/store.ts";
import * as schema from "../../db/schema.ts";

/** One column: the row type's property name and the table's column name. */
export interface ColumnSpec {
  readonly prop: string;
  readonly name: string;
  /** Read back as 0 or 1, and given to the core as a boolean. */
  readonly boolean: boolean;
  /** Read back as bytes, and given to the core as a plain `Uint8Array`. */
  readonly blob: boolean;
}

export interface TableSpec {
  readonly name: string;
  readonly table: SQLiteTable;
  readonly columns: readonly ColumnSpec[];
  /** The primary key's columns, in order; empty for a single-row table. */
  readonly key: readonly ColumnSpec[];
}

/** The Drizzle table of each configuration and state table, by its SQL name. */
export const STATE_TABLES = {
  devices: schema.devices,
  device_keys: schema.deviceKeys,
  send_counters: schema.sendCounters,
  hub_keys: schema.hubKeys,
  site: schema.site,
  sensor_config: schema.sensorConfig,
  siren_config: schema.sirenConfig,
  gateway_config: schema.gatewayConfig,
  countdowns: schema.countdowns,
  alarm: schema.alarm,
  alarm_triggers: schema.alarmTriggers,
  alarm_sirens: schema.alarmSirens,
  boots: schema.boots,
  device_state: schema.deviceState,
  loss_daily: schema.lossDaily,
  people: schema.people,
  clients: schema.clients,
  client_replies: schema.clientReplies,
  permissions: schema.permissions,
  person_roles: schema.personRoles,
  link_tokens: schema.linkTokens,
  link_secrets: schema.linkSecrets,
  groups: schema.groups,
  group_members: schema.groupMembers,
  group_sirens: schema.groupSirens,
  modes: schema.modes,
  mode_groups: schema.modeGroups,
  schedules: schema.schedules,
  health_state: schema.healthState,
  notification_prefs: schema.notificationPrefs,
  mode_state: schema.modeState,
  people_settings: schema.peopleSettings,
  schedule_state: schema.scheduleState,
  backup_state: schema.backupState,
  backup_key: schema.backupKey,
  update_state: schema.updateState,
} as const satisfies Readonly<Record<StateTable, SQLiteTable>>;

/** The Drizzle table of each audit table, by its SQL name. */
export const AUDIT_TABLES = {
  rx_routine: schema.rxRoutine,
  rx_event: schema.rxEvent,
  tx_routine: schema.txRoutine,
  tx_event: schema.txEvent,
  decisions: schema.decisions,
  device_log: schema.deviceLog,
  hub_events: schema.hubEvents,
  commands: schema.commands,
  rejects: schema.rejects,
  notifications: schema.notifications,
  notification_reads: schema.notificationReads,
} as const satisfies Readonly<Record<AuditTable, SQLiteTable>>;

function describe(table: SQLiteTable): TableSpec {
  const config = getTableConfig(table);
  const columns = Object.entries(getTableColumns(table)).map(([prop, column]): ColumnSpec => ({
    prop,
    name: column.name,
    boolean: column.dataType === "boolean",
    blob: column.dataType === "buffer",
  }));
  const byName = (name: string): readonly ColumnSpec[] =>
    columns.filter((column) => column.name === name);
  const composite = config.primaryKeys[0];
  const key =
    composite === undefined
      ? columns.filter((column) => config.columns.some((c) => c.name === column.name && c.primary))
      : composite.columns.flatMap((column) => byName(column.name));
  return { name: config.name, table, columns, key };
}

function describeAll<T extends string>(
  tables: Readonly<Record<T, SQLiteTable>>,
): Readonly<Record<T, TableSpec>> {
  const entries = Object.entries<SQLiteTable>(tables).map(([name, table]) => [
    name,
    describe(table),
  ]);
  // The keys are exactly `T`'s, since they come from `tables`.
  return Object.fromEntries(entries) as Readonly<Record<T, TableSpec>>;
}

/** Each configuration and state table's description. */
export const STATE_SPECS: Readonly<Record<StateTable, TableSpec>> = describeAll(STATE_TABLES);

/** Each audit table's description. */
export const AUDIT_SPECS: Readonly<Record<AuditTable, TableSpec>> = describeAll(AUDIT_TABLES);

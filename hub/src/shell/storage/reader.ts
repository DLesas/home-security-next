/**
 * Reading the database (hub-design.md sections 3 and 6), on the writer's connection. `snapshot`
 * is read once at start, before the boot event: the configuration tables, the readings, the
 * countdowns and the alarm, all small (section 6, "Restoring at start"). `query` serves
 * `hsn log` only, after the writer has flushed: it finds a time by a binary search of `seq` by
 * `at_ms` (rows keep `at_ms` from decreasing, so no time index is needed), and reads newest
 * first, with a limit.
 */
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { desc } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { err, ok, type Result } from "neverthrow";
import type { AuditRecord } from "../../core/model/audit.ts";
import type { DurableSnapshot } from "../../core/model/events.ts";
import { type DeviceId, deviceId, HUB_DEVICE } from "../../core/model/ids.ts";
import {
  type BootRow,
  DeviceState,
  type DeviceStateRow,
  type HubAppKeys,
  type HubSigningKeys,
  type NotificationReadRow,
  type NotificationRow,
  Rekey,
} from "../../core/model/rows.ts";
import type { AuditTable, StateTable, StateTables } from "../../core/model/store.ts";
import * as schema from "../../db/schema.ts";
import type { LogQuery, Reader } from "../../ports/reader.ts";
import type { StorageError } from "../../ports/writer.ts";
import { sqlite } from "../safe/sqlite.ts";
import { AUDIT_SPECS, STATE_SPECS, STATE_TABLES, type TableSpec } from "./tables.ts";

const ORIGIN = "shell/storage/reader";

/**
 * `hsn log` shows at most this many records ‡. SPEC-QUESTION: section 6 reads the newest
 * records "with a limit", which neither section 9 nor the `log` command gives.
 */
export const LOG_LIMIT = 1_000;

const MINUTE_MS = 60_000;

type Raw = Readonly<Record<string, unknown>>;

/**
 * A row as the core reads it: 0 and 1 as booleans in boolean columns, and bytes as plain
 * `Uint8Array`s (Drizzle gives `Buffer`s). The result has the columns of `spec`, which the
 * schema test holds to the core's row types, so the caller may take it as its row type.
 */
function normalize(spec: TableSpec, raw: Raw): Raw {
  const row: Record<string, unknown> = {};
  for (const column of spec.columns) {
    const value = raw[column.prop] ?? raw[column.name] ?? null;
    if (column.boolean && typeof value === "number") row[column.prop] = value !== 0;
    else if (column.blob && value instanceof Uint8Array) row[column.prop] = new Uint8Array(value);
    else row[column.prop] = value;
  }
  return row;
}

/**
 * A row read back as the core's row type. `normalize` gave it exactly the columns of its table,
 * which the schema test holds to the core's row types; this is the one place that says so.
 */
function asRow<T extends StateTable>(_table: T, row: Raw): StateTables[T] {
  return row as unknown as StateTables[T];
}

/** A record of the kind its table's rows are, by the same reasoning as `asRow`. */
function asRecord(record: {
  readonly kind: AuditRecord["kind"];
  readonly table?: "routine" | "event";
  readonly row: Raw;
}): AuditRecord {
  return record as unknown as AuditRecord;
}

/** Which audit tables each `hsn log --kind` reads (section 9). */
const TABLES_BY_KIND: Readonly<Record<NonNullable<LogQuery["logKind"]>, readonly AuditTable[]>> = {
  rx: ["rx_routine", "rx_event"],
  tx: ["tx_routine", "tx_event"],
  decision: ["decisions"],
  log: ["device_log"],
  event: ["hub_events", "commands"],
  reject: ["rejects"],
  notification: ["notifications", "notification_reads"],
};

const ALL_AUDIT_TABLES = Object.keys(AUDIT_SPECS) as readonly AuditTable[];

function recordOf(table: AuditTable, row: Raw): AuditRecord {
  switch (table) {
    case "rx_routine":
      return asRecord({ kind: "rx", table: "routine", row });
    case "rx_event":
      return asRecord({ kind: "rx", table: "event", row });
    case "tx_routine":
      return asRecord({ kind: "tx", table: "routine", row });
    case "tx_event":
      return asRecord({ kind: "tx", table: "event", row });
    case "decisions":
      return asRecord({ kind: "decision", row });
    case "device_log":
      return asRecord({ kind: "deviceLog", row });
    case "hub_events":
      return asRecord({ kind: "hubEvent", row });
    case "commands":
      return asRecord({ kind: "command", row });
    case "rejects":
      return asRecord({ kind: "reject", row });
    case "notifications":
      return asRecord({ kind: "notification", row });
    case "notification_reads":
      return asRecord({ kind: "notificationRead", row });
  }
}

/** The order of records in a log answer: by `seq`, and rejection counts by their minute. */
function orderOf(record: AuditRecord): number {
  return record.kind === "reject" ? record.row.minute * MINUTE_MS : record.row.seq;
}

export class SqliteReader implements Reader {
  readonly #db: Database;
  readonly #drizzle;
  readonly #lossDays: number;
  readonly #unreadWindowMs: number;

  /**
   * `lossDays`: how many days of `loss_daily` the snapshot carries, for D107's n;
   * `unreadWindowMs`: how far before the last commit's wall time it carries notifications and their
   * reads (7 days ‡, m2-design.md section 7), so what is unread survives a restart.
   */
  constructor(db: Database, lossDays: number, unreadWindowMs = 0) {
    this.#db = db;
    this.#drizzle = drizzle(db);
    this.#lossDays = lossDays;
    this.#unreadWindowMs = unreadWindowMs;
  }

  snapshot(): Result<DurableSnapshot, StorageError> {
    return sqlite(ORIGIN, "read the snapshot", () => {
      const all = <T extends StateTable>(table: T): readonly StateTables[T][] =>
        this.#rows(STATE_TABLES[table], STATE_SPECS[table]).map((row) => asRow(table, row));
      const one = <T extends StateTable>(table: T): StateTables[T] | undefined => all(table)[0];
      const lossDaily = all("loss_daily");
      const deviceState = all("device_state");
      const lastDay = Math.max(...lossDaily.map((row) => row.day));
      const keys = one("hub_keys");
      const hubKeys: HubSigningKeys | undefined =
        keys === undefined
          ? undefined
          : { signingPublic: keys.signingPublic, identity: keys.identity };
      const appKeys: HubAppKeys | undefined =
        keys?.appStaticPublic == null ? undefined : { appStaticPublic: keys.appStaticPublic };
      return {
        devices: all("devices"),
        sendCounters: all("send_counters"),
        hubKeys,
        site: one("site"),
        sensorConfig: all("sensor_config"),
        sirenConfig: all("siren_config"),
        gatewayConfig: all("gateway_config"),
        countdowns: all("countdowns"),
        alarm: one("alarm"),
        alarmTriggers: all("alarm_triggers"),
        alarmSirens: all("alarm_sirens"),
        previousBoot: this.#latestBoot(),
        deviceState,
        lossDaily: lossDaily.filter((row) => row.day > lastDay - this.#lossDays),
        provisioningKeys: this.#provisioningKeys(),
        // Every table small and read whole; link tokens without their keys (m2-design.md section 2);
        // the backup key whole, as `upkeep` keeps it in its slice.
        m2: {
          appKeys,
          modeState: one("mode_state"),
          peopleSettings: one("people_settings"),
          scheduleState: one("schedule_state"),
          backupState: one("backup_state"),
          backupKey: one("backup_key"),
          people: all("people"),
          clients: all("clients"),
          clientReplies: all("client_replies"),
          permissions: all("permissions"),
          personRoles: all("person_roles"),
          linkTokens: all("link_tokens"),
          groups: all("groups"),
          groupMembers: all("group_members"),
          groupSirens: all("group_sirens"),
          modes: all("modes"),
          modeGroups: all("mode_groups"),
          schedules: all("schedules"),
          healthState: all("health_state"),
          notificationPrefs: all("notification_prefs"),
          updateState: one("update_state"),
          ...this.#recentNotifications(deviceState),
        },
        // Migration 3 (the joint step 0 of M3 and M4): every table small and read whole, as the
        // firmware and relay modules' `boot.ts` rebuild from them; push keys stay in the shell
        // (`PushKeys`). The pending key changes after a restore (D141), with each pending key.
        m3m4: {
          firmwareImages: all("firmware_images"),
          rollouts: all("rollouts"),
          deviceUpdates: all("device_updates"),
          relaySettings: one("relay_settings"),
          pushTargets: all("push_targets"),
          pushOutbox: all("push_outbox"),
          ...this.#rekey(),
        },
      };
    });
  }

  query(query: LogQuery): Result<readonly AuditRecord[], StorageError> {
    const device = query.device === undefined ? undefined : this.#deviceId(query.device);
    if (device?.isErr() === true) return err(device.error);
    const id = device?.isOk() === true ? device.value : undefined;
    if (query.device !== undefined && id === undefined) return ok([]);
    const tables = query.logKind === undefined ? ALL_AUDIT_TABLES : TABLES_BY_KIND[query.logKind];
    const records: AuditRecord[] = [];
    for (const table of tables) {
      const rows = this.#newest(table, query.since, id);
      if (rows.isErr()) return err(rows.error);
      records.push(...rows.value.map((row) => recordOf(table, row)));
    }
    return ok(records.toSorted((a, b) => orderOf(a) - orderOf(b)).slice(-LOG_LIMIT));
  }

  /**
   * The newest committed records of `tables` for a history page (m2-design.md section 7): at most
   * `scan` rows of each table, newest first, with `seq` below `before` and `at_ms` within
   * `since` and `until` when given. `rejects`, which have no `seq` (a minute's count), come only on
   * a first page (no `before`), by their minute. The caller merges, filters and cuts the page.
   */
  historyRows(page: {
    readonly tables: readonly AuditTable[];
    readonly since: number | undefined;
    readonly until: number | undefined;
    readonly before: number | undefined;
    readonly scan: number;
  }): Result<readonly AuditRecord[], StorageError> {
    const records: AuditRecord[] = [];
    for (const table of page.tables) {
      const rows = sqlite(ORIGIN, `read a page of ${table}`, (): readonly Raw[] => {
        if (table === "rejects") {
          if (page.before !== undefined) return [];
          return this.#db
            .query<Raw, [number, number]>(
              `SELECT * FROM "rejects" WHERE "minute" >= ? AND "minute" <= ? ORDER BY "minute" DESC LIMIT ${page.scan}`,
            )
            .all(
              page.since === undefined ? 0 : Math.floor(page.since / MINUTE_MS),
              page.until === undefined
                ? Number.MAX_SAFE_INTEGER
                : Math.floor(page.until / MINUTE_MS),
            );
        }
        const from = page.since === undefined ? 0 : this.#firstSeqAt(table, page.since);
        return this.#db
          .query<Raw, [number, number, number]>(
            `SELECT * FROM "${table}" WHERE "seq" >= ? AND "seq" < ? AND "at_ms" <= ? ORDER BY "seq" DESC LIMIT ${page.scan}`,
          )
          .all(from, page.before ?? Number.MAX_SAFE_INTEGER, page.until ?? Number.MAX_SAFE_INTEGER);
      });
      if (rows.isErr()) return err(rows.error);
      const spec = AUDIT_SPECS[table];
      records.push(...rows.value.map((row) => recordOf(table, normalize(spec, row))));
    }
    return ok(records);
  }

  /** Every row of a state table, through Drizzle. */
  #rows(table: SQLiteTable, spec: TableSpec): readonly Raw[] {
    const rows: readonly Raw[] = this.#drizzle.select().from(table).all();
    return rows.map((row) => normalize(spec, row));
  }

  /**
   * The key of each device still provisioning (section 9): a retry after a restart sends the same
   * address and key. The only keys the snapshot carries.
   */
  #provisioningKeys(): ReadonlyMap<DeviceId, Uint8Array> {
    const rows = this.#db
      .query<{ id: number; key: Uint8Array }, [number]>(
        `SELECT "devices"."id" AS id, "device_keys"."key" AS key FROM "devices" ` +
          `JOIN "device_keys" ON "device_keys"."device_id" = "devices"."id" WHERE "devices"."state" = ?`,
      )
      .all(DeviceState.Provisioning);
    return new Map(rows.map((row) => [deviceId(row.id), new Uint8Array(row.key)]));
  }

  /**
   * The devices whose key change after a restore is not finished (`device_keys.rekey`, D141), those
   * of them both of whose keys were held at the backup, and the pending next key of each that has
   * one: with the provisioning keys, the only keys the snapshot carries (hub-design.md section 2).
   * Never a device's current key.
   */
  #rekey(): {
    readonly rekey: readonly DeviceId[];
    readonly rekeyBothHeld: readonly DeviceId[];
    readonly rekeyKeys: ReadonlyMap<DeviceId, Uint8Array>;
  } {
    const rows = this.#db
      .query<{ id: number; rekey: number; next: Uint8Array | null }, [number]>(
        `SELECT "device_id" AS id, "rekey" AS rekey, "next_key" AS next FROM "device_keys" ` +
          `WHERE "rekey" <> ? ORDER BY "device_id"`,
      )
      .all(Rekey.None);
    const rekeyKeys = new Map<DeviceId, Uint8Array>();
    for (const row of rows) {
      if (row.next !== null) rekeyKeys.set(deviceId(row.id), new Uint8Array(row.next));
    }
    return {
      rekey: rows.map((row) => deviceId(row.id)),
      rekeyBothHeld: rows
        .filter((row) => row.rekey === Rekey.BothHeld)
        .map((row) => deviceId(row.id)),
      rekeyKeys,
    };
  }

  /** The previous run's boot row: the newest. */
  #latestBoot(): BootRow | undefined {
    const row = this.#drizzle
      .select()
      .from(schema.boots)
      .orderBy(desc(schema.boots.id))
      .limit(1)
      .get();
    return row === undefined ? undefined : asRow("boots", normalize(STATE_SPECS.boots, row));
  }

  #deviceId(name: string): Result<number | undefined, StorageError> {
    return sqlite(ORIGIN, "find the device", () => {
      const row = this.#db
        .query<{ id: number }, [string]>(`SELECT "id" FROM "devices" WHERE "name" = ?`)
        .get(name);
      return row?.id;
    });
  }

  /**
   * The notifications and reads stamped within the unread window before the last commit's wall
   * time (device 0's row, the commit mark); none before any commit. Inside the snapshot's read.
   */
  #recentNotifications(deviceState: readonly DeviceStateRow[]): {
    readonly notifications: readonly NotificationRow[];
    readonly notificationReads: readonly NotificationReadRow[];
  } {
    const mark = deviceState.find((row) => row.deviceId === HUB_DEVICE);
    if (mark === undefined || this.#unreadWindowMs <= 0)
      return { notifications: [], notificationReads: [] };
    const from = mark.lastSeenMs - this.#unreadWindowMs;
    const since = (table: "notifications" | "notification_reads"): readonly Raw[] =>
      this.#db
        .query<Raw, [number]>(`SELECT * FROM "${table}" WHERE "seq" >= ? ORDER BY "seq"`)
        .all(this.#firstSeqAt(table, from))
        .map((row) => normalize(AUDIT_SPECS[table], row));
    // By the same reasoning as `asRow`: `normalize` gave each its table's exact columns.
    return {
      notifications: since("notifications").map((row) => row as unknown as NotificationRow),
      notificationReads: since("notification_reads").map(
        (row) => row as unknown as NotificationReadRow,
      ),
    };
  }

  /** The newest `LOG_LIMIT` rows of a table from `since`, of one device if given. */
  #newest(
    table: AuditTable,
    since: number | undefined,
    device: number | undefined,
  ): Result<readonly Raw[], StorageError> {
    const spec = AUDIT_SPECS[table];
    return sqlite(ORIGIN, `read ${table}`, () => {
      const hasDevice = spec.columns.some((column) => column.name === "device_id");
      if (device !== undefined && !hasDevice && table !== "rejects") return [];
      if (table === "rejects") {
        const from = since === undefined ? 0 : Math.floor(since / MINUTE_MS);
        const via = device === undefined ? undefined : `device:${device}`;
        const rows = this.#db
          .query<Raw, [number, string | null, string | null]>(
            `SELECT * FROM "rejects" WHERE "minute" >= ? AND (? IS NULL OR "via" = ?) ORDER BY "minute" DESC LIMIT ${LOG_LIMIT}`,
          )
          .all(from, via ?? null, via ?? null);
        return rows.map((row) => normalize(spec, row));
      }
      const from = since === undefined ? 0 : this.#firstSeqAt(table, since);
      const rows = this.#db
        .query<Raw, [number, number | null, number | null]>(
          `SELECT * FROM "${table}" WHERE "seq" >= ?` +
            (hasDevice ? ` AND (? IS NULL OR "device_id" = ?)` : ` AND ? IS NULL AND ? IS NULL`) +
            ` ORDER BY "seq" DESC LIMIT ${LOG_LIMIT}`,
        )
        .all(from, device ?? null, device ?? null);
      return rows.map((row) => normalize(spec, row));
    });
  }

  /**
   * The first `seq` whose `at_ms` is at or after `since`, by a binary search over `seq`; past
   * the last row when none is. Each probe is one look-up of the row-id tree (section 6).
   */
  #firstSeqAt(table: AuditTable, since: number): number {
    const probe = this.#db.query<{ seq: number; at_ms: number }, [number]>(
      `SELECT "seq", "at_ms" FROM "${table}" WHERE "seq" >= ? ORDER BY "seq" LIMIT 1`,
    );
    const last = this.#db
      .query<{ seq: number | null }, []>(`SELECT max("seq") AS "seq" FROM "${table}"`)
      .get();
    let lo = 0;
    let hi = (last?.seq ?? -1) + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const row = probe.get(mid);
      if (row === null || row.seq >= hi) hi = mid;
      else if (row.at_ms >= since) hi = row.seq;
      else lo = row.seq + 1;
    }
    return lo;
  }
}

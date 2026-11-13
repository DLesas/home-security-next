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
import { type DeviceId, deviceId } from "../../core/model/ids.ts";
import { type BootRow, DeviceState, type HubKeysRow } from "../../core/model/rows.ts";
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

  /** `lossDays`: how many days of `loss_daily` the snapshot carries, for D107's n. */
  constructor(db: Database, lossDays: number) {
    this.#db = db;
    this.#drizzle = drizzle(db);
    this.#lossDays = lossDays;
  }

  snapshot(): Result<DurableSnapshot, StorageError> {
    return sqlite(ORIGIN, "read the snapshot", () => {
      const all = <T extends StateTable>(table: T): readonly StateTables[T][] =>
        this.#rows(STATE_TABLES[table], STATE_SPECS[table]).map((row) => asRow(table, row));
      const one = <T extends StateTable>(table: T): StateTables[T] | undefined => all(table)[0];
      const lossDaily = all("loss_daily");
      const lastDay = Math.max(...lossDaily.map((row) => row.day));
      const keys = one("hub_keys");
      const hubKeys: Omit<HubKeysRow, "signingPrivate"> | undefined =
        keys === undefined
          ? undefined
          : { signingPublic: keys.signingPublic, identity: keys.identity };
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
        deviceState: all("device_state"),
        lossDaily: lossDaily.filter((row) => row.day > lastDay - this.#lossDays),
        provisioningKeys: this.#provisioningKeys(),
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

/**
 * The history file, `backup.export` with `history: true` (m2-design.md section 9, "Export on
 * demand"; HB22): `hsn-<identity>-<UTC>-history.jsonl`, UTF-8 JSON Lines, not sealed, since it
 * holds no key (device keys and secrets are never in the audit tables), streamed to the asking
 * connection and never written to the hub's disk. Never a database image: nothing is serialised.
 *
 * - Line 1: `{"format":"hsn-history/1","hub":<identity>,"madeMs":…,"schema":<migrations
 *   applied>,"upToSeq":<the highest committed record's seq when it began>}`.
 * - Then one line per record, `{"kind": …, "row": {…}}` exactly as `history.query` and
 *   `hsn log --json` give them (`recordJson`), in `seq` order, every record committed up to
 *   `upToSeq`.
 * - Then the two audit tables without a `seq`, each after its line `{"part":"rejects"}` or
 *   `{"part":"lossDaily"}`: `reject` rows in (`minute`, `via`, `reason`) order up to the minute
 *   the export began, then `lossDaily` rows in (`day`, `deviceId`) order up to the day it began,
 *   each read in pages of `HISTORY_ROWS_PER_PAGE` ‡ by its key. `boots` is not exported (each run
 *   is a `restarted` hub event among the records). Nothing else.
 *
 * Read through the writer's connection after what is staged is flushed (as `hsn log`), in pages
 * of `HISTORY_ROWS_PER_PAGE` ‡ rows of one table by `seq`, one query a piece, and merged by `seq`,
 * at most a page of lines a piece. Each query is its own short read: no read transaction outlives
 * a piece, so the writer commits and checkpoints between pieces. A row retention trims meanwhile is
 * simply absent. The stream's end mark carries its SHA-256 (section 6); a stream cut short (the
 * hub stopping, the connection gone) has no end mark, and the asking side is told `failed`.
 */
import type { Database } from "bun:sqlite";
import { createHash, type Hash } from "node:crypto";
import { FILE_CHUNK_BYTES, formatIdentity } from "@hsn/protocol/app";
import type { RecordJson } from "@hsn/protocol/records";
import { Result } from "neverthrow";
import type { AuditRecord } from "../../core/model/audit.ts";
import type { FileOutcome } from "../../core/model/events.ts";
import type { ConnId } from "../../core/model/ids.ts";
import type { AuditTable } from "../../core/model/store.ts";
import { recordJson } from "../control/records.ts";
import { AUDIT_SPECS, type TableSpec } from "../storage/tables.ts";
import { joined } from "./files.ts";
import {
  base64url,
  type ExportChunk,
  type ExportSink,
  headerFacts,
  stampOf,
  type WriteDeps,
} from "./write.ts";

/** Rows of one table read in one piece ‡ (section 9). */
export const HISTORY_ROWS_PER_PAGE = 500;

/** The first line's `format`. */
export const HISTORY_FORMAT = "hsn-history/1";

/** The first bytes of every history file: how `restore` knows one (section 9). */
export const HISTORY_MAGIC = `{"format":"${HISTORY_FORMAT}"`;

/**
 * At most about this many bytes of lines written in one piece ‡ (section 3's pieces of about
 * 256 KB): a page of large rows ends its piece early, so a piece's work does not grow with a
 * row's size.
 */
export const HISTORY_PIECE_BYTES = 256 * 1024;

/** The history file's name for this hub at this time. */
export function historyName(identity: Uint8Array, ms: number): string {
  return `hsn-${formatIdentity(identity)}-${stampOf(ms)}-history.jsonl`;
}

/** The audit tables whose rows carry a `seq`, each one record kind (`recordJson`). */
const KINDS: Readonly<
  Record<Exclude<AuditTable, "rejects">, { kind: AuditRecord["kind"]; table?: string }>
> = {
  rx_routine: { kind: "rx", table: "routine" },
  rx_event: { kind: "rx", table: "event" },
  tx_routine: { kind: "tx", table: "routine" },
  tx_event: { kind: "tx", table: "event" },
  decisions: { kind: "decision" },
  device_log: { kind: "deviceLog" },
  hub_events: { kind: "hubEvent" },
  commands: { kind: "command" },
  notifications: { kind: "notification" },
  notification_reads: { kind: "notificationRead" },
};

type SeqTable = keyof typeof KINDS;

/** The tables merged by `seq`, in this order on a tie; `rejects` and `loss_daily` follow. */
export const HISTORY_EXPORT_TABLES = Object.keys(KINDS) as readonly SeqTable[];

type Raw = Readonly<Record<string, unknown>>;

/** One table's page: the rows read and not yet written, and where the next page starts. */
interface Page {
  readonly table: SeqTable;
  readonly spec: TableSpec;
  rows: Raw[];
  at: number;
  last: number;
  /** The last read gave less than a page: nothing more up to `upToSeq`. */
  exhausted: boolean;
}

export interface HistoryWork {
  readonly conn: ConnId;
}

export interface HistoryDeps extends WriteDeps {
  /** What is staged committed first, as for `hsn log`; the job then reads only what is committed. */
  readonly flush?: () => Result<unknown, string>;
}

type Phase = "start" | "read" | "rejects" | "lossDaily";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export class HistoryExport {
  readonly #db: Database;
  readonly #job: number;
  readonly #work: HistoryWork;
  readonly #sink: ExportSink;
  readonly #deps: HistoryDeps;
  readonly #encoder = new TextEncoder();
  #phase: Phase = "start";
  #upToSeq = 0;
  #madeMs = 0;
  /** The last key written of the part being read; undefined before its first page. */
  #after: readonly (number | string)[] | undefined;
  #pages: Page[] = [];
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #sent = 0;
  #bytes = 0;
  #lines = 0;
  /** Every line's bytes so far, the first included: what a piece's work is bounded by. */
  #lineBytes = 0;
  #hash: Hash = createHash("sha256");
  #ended: FileOutcome | undefined;

  constructor(db: Database, job: number, work: HistoryWork, sink: ExportSink, deps: HistoryDeps) {
    this.#db = db;
    this.#job = job;
    this.#work = work;
    this.#sink = sink;
    this.#deps = deps;
  }

  /** Where it is, for measurements. */
  get phase(): Phase {
    return this.#phase;
  }

  /** The lines written so far, the first included. */
  get lines(): number {
    return this.#lines;
  }

  /** The bytes of lines written so far. */
  get lineBytes(): number {
    return this.#lineBytes;
  }

  /** The highest `seq` the file holds records up to. */
  get upToSeq(): number {
    return this.#upToSeq;
  }

  next(): FileOutcome | undefined {
    if (this.#ended !== undefined) return this.#ended;
    const step = Result.fromThrowable(
      (): FileOutcome | undefined => this.#step(),
      (thrown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    )();
    if (step.isErr()) return this.abort(step.error);
    if (step.value !== undefined) this.#end(step.value);
    return step.value;
  }

  abort(message: string): FileOutcome {
    if (this.#ended !== undefined) return this.#ended;
    const outcome: FileOutcome = { kind: "failed", reason: "io", message };
    this.#end(outcome);
    return outcome;
  }

  #end(outcome: FileOutcome): void {
    this.#ended = outcome;
    this.#pages = [];
    this.#pending = [];
  }

  #step(): FileOutcome | undefined {
    switch (this.#phase) {
      case "start":
        return this.#start();
      case "read":
        return this.#read();
      case "rejects":
        return this.#rejects();
      case "lossDaily":
        return this.#lossDaily();
    }
  }

  /** Piece 1: the staged records committed, the first line, and where the records end. */
  #start(): FileOutcome | undefined {
    const flushed = this.#deps.flush?.();
    if (flushed?.isErr() === true)
      return { kind: "failed", reason: "io", message: `the flush failed: ${flushed.error}` };
    const facts = headerFacts(this.#db);
    if (facts.isErr()) return { kind: "failed", ...facts.error };
    let upToSeq = 0;
    for (const table of HISTORY_EXPORT_TABLES) {
      const row = this.#db
        .query<{ s: number | null }, []>(`SELECT max("seq") AS s FROM "${table}"`)
        .get();
      upToSeq = Math.max(upToSeq, row?.s ?? 0);
    }
    this.#upToSeq = upToSeq;
    this.#madeMs = this.#deps.nowMs();
    this.#pages = HISTORY_EXPORT_TABLES.map((table) => ({
      table,
      spec: AUDIT_SPECS[table],
      rows: [],
      at: 0,
      last: 0,
      exhausted: false,
    }));
    this.#line({
      format: HISTORY_FORMAT,
      hub: formatIdentity(facts.value.identity),
      madeMs: this.#madeMs,
      schema: facts.value.schema,
      upToSeq,
    });
    this.#phase = "read";
    return this.#flushChunks(false);
  }

  /**
   * One piece: a table's next page read when one is needed, else up to a page of records written
   * in `seq` order, stopping where a table still to read has none left in hand.
   */
  #read(): FileOutcome | undefined {
    const empty = this.#pages.find((p) => p.at >= p.rows.length && !p.exhausted);
    if (empty !== undefined) {
      this.#fill(empty);
      return undefined;
    }
    const startBytes = this.#lineBytes;
    for (let written = 0; written < HISTORY_ROWS_PER_PAGE; written++) {
      if (this.#lineBytes - startBytes >= HISTORY_PIECE_BYTES) break;
      let next: Page | undefined;
      for (const page of this.#pages) {
        if (page.at >= page.rows.length) {
          if (!page.exhausted) return this.#flushChunks(false);
          continue;
        }
        if (next === undefined || seqOf(page.rows[page.at]) < seqOf(next.rows[next.at]))
          next = page;
      }
      if (next === undefined) {
        this.#line({ part: "rejects" });
        this.#phase = "rejects";
        this.#pages = [];
        return this.#flushChunks(false);
      }
      const raw = next.rows[next.at];
      next.at += 1;
      if (raw !== undefined) this.#line(recordJson(recordOf(next.spec, KINDS[next.table], raw)));
    }
    return this.#flushChunks(false);
  }

  /** A page of rejection counts by (`minute`, `via`, `reason`), up to the export's minute. */
  #rejects(): FileOutcome | undefined {
    const upTo = Math.floor(this.#madeMs / MINUTE_MS);
    const after = this.#after ?? [-1, "", ""];
    const rows = this.#db
      .query<Raw, [number, string, string, number]>(
        `SELECT * FROM "rejects" WHERE ("minute", "via", "reason") > (?, ?, ?) AND "minute" <= ? ORDER BY "minute", "via", "reason" LIMIT ${HISTORY_ROWS_PER_PAGE}`,
      )
      .all(Number(after[0]), String(after[1]), String(after[2]), upTo);
    for (const raw of rows)
      this.#line(recordJson(recordOf(AUDIT_SPECS.rejects, { kind: "reject" }, raw)));
    const last = rows.at(-1);
    this.#after =
      last === undefined ? undefined : [Number(last.minute), String(last.via), String(last.reason)];
    if (rows.length < HISTORY_ROWS_PER_PAGE) {
      this.#line({ part: "lossDaily" });
      this.#phase = "lossDaily";
      this.#after = undefined;
    }
    return this.#flushChunks(false);
  }

  /** A page of daily loss counts by (`day`, `deviceId`), up to the export's day; then the end. */
  #lossDaily(): FileOutcome | undefined {
    const upTo = Math.floor(this.#madeMs / DAY_MS);
    const after = this.#after ?? [-1, -1];
    const rows = this.#db
      .query<Raw, [number, number, number]>(
        `SELECT * FROM "loss_daily" WHERE ("day", "device_id") > (?, ?) AND "day" <= ? ORDER BY "day", "device_id" LIMIT ${HISTORY_ROWS_PER_PAGE}`,
      )
      .all(Number(after[0]), Number(after[1]), upTo);
    for (const raw of rows) {
      const line: RecordJson = {
        kind: "lossDaily",
        row: {
          deviceId: Number(raw.device_id),
          day: Number(raw.day),
          received: Number(raw.received),
          expected: Number(raw.expected),
        },
      };
      this.#line(line);
    }
    const last = rows.at(-1);
    this.#after = last === undefined ? undefined : [Number(last.day), Number(last.device_id)];
    return this.#flushChunks(rows.length < HISTORY_ROWS_PER_PAGE);
  }

  /** A page of `table`'s rows after the last one read, up to `upToSeq`: one short read. */
  #fill(page: Page): void {
    const rows = this.#db
      .query<Raw, [number, number]>(
        `SELECT * FROM "${page.table}" WHERE "seq" > ? AND "seq" <= ? ORDER BY "seq" LIMIT ${HISTORY_ROWS_PER_PAGE}`,
      )
      .all(page.last, this.#upToSeq);
    page.rows = rows;
    page.at = 0;
    page.exhausted = rows.length < HISTORY_ROWS_PER_PAGE;
    const last = rows.at(-1);
    if (last !== undefined) page.last = seqOf(last);
  }

  #line(value: unknown): void {
    const bytes = this.#encoder.encode(`${JSON.stringify(value)}\n`);
    this.#pending.push(bytes);
    this.#pendingBytes += bytes.length;
    this.#lineBytes += bytes.length;
    this.#lines += 1;
  }

  /** Every whole 48 KB chunk in hand sent; at the end, the rest with the end mark. */
  #flushChunks(last: boolean): FileOutcome | undefined {
    if (!last && this.#pendingBytes <= FILE_CHUNK_BYTES) return undefined;
    const bytes = joined(this.#pending);
    let at = 0;
    while (bytes.length - at > FILE_CHUNK_BYTES || (last && (at < bytes.length || at === 0))) {
      const part = bytes.subarray(at, at + FILE_CHUNK_BYTES);
      at += part.length;
      this.#bytes += part.length;
      this.#hash.update(part);
      const end = last && at >= bytes.length;
      const chunk: ExportChunk = end
        ? {
            job: this.#job,
            n: this.#sent,
            data: base64url(part),
            end: { chunks: this.#sent + 1, sha256: this.#hash.digest("hex") },
          }
        : { job: this.#job, n: this.#sent, data: base64url(part) };
      const sent = this.#sink.send(this.#work.conn, chunk);
      if (sent.isErr())
        return {
          kind: "failed",
          reason: "io",
          message: `the export stopped after chunk ${this.#sent}: ${sent.error}`,
        };
      this.#sent += 1;
      if (end) return { kind: "exportSent", bytes: this.#bytes };
    }
    const rest = bytes.slice(at);
    this.#pending = rest.length === 0 ? [] : [rest];
    this.#pendingBytes = rest.length;
    return undefined;
  }
}

function seqOf(raw: Raw | undefined): number {
  const seq = raw?.seq;
  return typeof seq === "number" ? seq : Number(seq ?? 0);
}

/**
 * A row as the core's record: the table's columns by their names, 0 and 1 as booleans where the
 * column is one, bytes as plain `Uint8Array`s (as `storage/reader.ts` reads them for `hsn log`).
 * The columns are the table's spec's, which the schema test holds to the core's row types; this
 * is the one place that says so.
 */
function recordOf(
  spec: TableSpec,
  kind: { readonly kind: AuditRecord["kind"]; readonly table?: string },
  raw: Raw,
): AuditRecord {
  const row: Record<string, unknown> = {};
  for (const column of spec.columns) {
    const value = raw[column.name] ?? raw[column.prop] ?? null;
    if (column.boolean && typeof value === "number") row[column.prop] = value !== 0;
    else if (column.blob && value instanceof Uint8Array) row[column.prop] = new Uint8Array(value);
    else row[column.prop] = value;
  }
  const record = kind.table === undefined ? { kind: kind.kind, row } : { ...kind, row };
  return record as unknown as AuditRecord;
}

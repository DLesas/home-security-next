/**
 * `history.query`'s page, the shell's half (m2-design.md sections 6 and 7): `app` has checked the
 * person and given the `historyRead` effect with the query and what they may see (`allowed`); the
 * shell reads the committed rows merged, by `seq`, with the writer's staged records (a read never
 * forces a commit), keeps what `allowed` lets the person see, newest first, and replies with
 * `{rows, next?}`: `next` the `seq` to ask `before` for the page after, when there may be one.
 *
 * The filter is `core/app/history.ts`'s rule, applied to the filter `app` computed: a row naming a
 * device the person may view; a `commands` row of one of their clients; a notification to them
 * and their client's read of one; and, with manage system, every row naming no device.
 *
 * What bounds a page (section 3's limit per turn): each table the query names is read at most
 * `limit` rows (≤ 500 ‡) back from `before`, through indexed `seq` ranges, and nothing is
 * committed for it: the staged records are merged in memory, never flushed (section 7, "Reads
 * never force a commit"; only `hsn log` flushes first). A person who may see few of those rows
 * gets a shorter page with `next`, and asks again. A read that fails is answered `unavailable`.
 */
import type { AppMessage, HistoryRow } from "@hsn/protocol/app";
import type { Result } from "neverthrow";
import { recordJson } from "../core/app/history.ts";
import type { AuditRecord } from "../core/model/audit.ts";
import type { HistoryFilter, HistoryQuery } from "../core/model/effects.ts";
import type { AuditTable } from "../core/model/store.ts";
import type { StorageError } from "../ports/writer.ts";

const MINUTE_MS = 60_000;

/** The tables of each kind a query may name. */
const TABLES: Readonly<Record<HistoryRow["kind"], readonly AuditTable[]>> = {
  rx: ["rx_routine", "rx_event"],
  tx: ["tx_routine", "tx_event"],
  decision: ["decisions"],
  deviceLog: ["device_log"],
  hubEvent: ["hub_events"],
  command: ["commands"],
  reject: ["rejects"],
  notification: ["notifications"],
  notificationRead: ["notification_reads"],
};

/** What a page needs of the store. */
export interface HistorySource {
  rows(page: {
    readonly tables: readonly AuditTable[];
    readonly since: number | undefined;
    readonly until: number | undefined;
    readonly before: number | undefined;
    readonly scan: number;
  }): Result<readonly AuditRecord[], StorageError>;
  staged(): readonly AuditRecord[];
}

/** The device a record names, or null for one about the hub as a whole. */
function deviceOf(record: AuditRecord): number | null {
  switch (record.kind) {
    case "rx":
    case "tx":
    case "deviceLog":
    case "decision":
    case "notification":
      return record.row.deviceId;
    case "reject": {
      const via = /^device:(\d+)$/u.exec(record.row.via);
      return via?.[1] === undefined ? null : Number(via[1]);
    }
    default:
      return null;
  }
}

function recipientsHold(recipients: Uint8Array, person: number): boolean {
  for (let at = 0; at + 4 <= recipients.length; at += 4) {
    const id =
      (recipients[at] ?? 0) |
      ((recipients[at + 1] ?? 0) << 8) |
      ((recipients[at + 2] ?? 0) << 16) |
      ((recipients[at + 3] ?? 0) * 2 ** 24);
    if (id === person) return true;
  }
  return false;
}

/** Whether `allowed` lets the person see this record (`core/app/history.ts`'s rule). */
export function allowedBy(allowed: HistoryFilter, record: AuditRecord): boolean {
  if (allowed.person === null) return true;
  const device = deviceOf(record);
  if (device !== null && (allowed.devices === "all" || allowed.devices.some((d) => d === device)))
    return true;
  const clients = new Set<number>(allowed.clients);
  if (record.kind === "command") {
    const own = / \(client (\d+)\)$/u.exec(record.row.actor);
    if (own?.[1] !== undefined && clients.has(Number(own[1]))) return true;
  }
  if (record.kind === "notification" && recipientsHold(record.row.recipients, allowed.person))
    return true;
  if (record.kind === "notificationRead" && clients.has(record.row.clientId)) return true;
  return device === null && allowed.hub;
}

/** The order rows are listed in, newest first: `seq`; among rejects, their minute. */
function orderOf(record: AuditRecord): number {
  return record.kind === "reject" ? record.row.minute * MINUTE_MS : record.row.seq;
}

function atOf(record: AuditRecord): number {
  return record.kind === "reject" ? record.row.minute * MINUTE_MS : record.row.atMs;
}

function matches(query: HistoryQuery, record: AuditRecord): boolean {
  const kind = recordJson(record).kind;
  if (query.kinds !== undefined && !query.kinds.includes(kind)) return false;
  if (query.devices !== undefined) {
    const device = deviceOf(record);
    if (device === null || !query.devices.some((d) => d === device)) return false;
  }
  const at = atOf(record);
  if (query.since !== undefined && at < query.since) return false;
  if (query.until !== undefined && at > query.until) return false;
  if (query.before !== undefined && (record.kind === "reject" || record.row.seq >= query.before))
    return false;
  return true;
}

/** The page: `{rows, next?}`, as `history.query`'s reply has it (section 6). */
export function historyPage(
  source: HistorySource,
  query: HistoryQuery,
  allowed: HistoryFilter,
): Result<{ readonly rows: readonly HistoryRow[]; readonly next?: number }, StorageError> {
  const kinds = query.kinds ?? (Object.keys(TABLES) as HistoryRow["kind"][]);
  const tables = kinds.flatMap((kind) => TABLES[kind]);
  return source
    .rows({
      tables,
      since: query.since,
      until: query.until,
      before: query.before,
      scan: query.limit,
    })
    .map((committed) => {
      // A staged record committed meanwhile is not read twice: by kind and `seq`.
      const seen = new Set(committed.map((r) => `${r.kind}:${String(orderOf(r))}`));
      const staged = source
        .staged()
        .filter((r) => r.kind !== "reject" && !seen.has(`${r.kind}:${String(orderOf(r))}`));
      const all = [...committed, ...staged].filter(
        (record) => matches(query, record) && allowedBy(allowed, record),
      );
      // By `seq`, newest first; a first page's rejects (a minute's count, no `seq`) after them.
      const numbered = all
        .filter((record) => record.kind !== "reject")
        .toSorted((a, b) => orderOf(b) - orderOf(a));
      const rejects = all
        .filter((record) => record.kind === "reject")
        .toSorted((a, b) => orderOf(b) - orderOf(a));
      const rows = [...numbered, ...rejects].slice(0, query.limit);
      // More may follow when the numbered rows filled the page, or a table was read to its scan's
      // end: `next` is the last numbered row's `seq` (the page after may then be empty).
      const shown = rows.filter((record) => record.kind !== "reject");
      const last = shown.at(-1);
      const more = numbered.length > shown.length || committed.length >= query.limit;
      const next = more && last !== undefined ? last.row.seq : undefined;
      return {
        rows: rows.map((record): HistoryRow => {
          const row = recordJson(record);
          return { kind: row.kind, row };
        }),
        ...(next === undefined ? {} : { next }),
      };
    });
}

/** `history.query`'s reply on the connection that asked: the page, or `unavailable`. */
export function historyReply(
  source: HistorySource,
  effect: {
    readonly id: number;
    readonly query: HistoryQuery;
    readonly allowed: HistoryFilter;
  },
): { readonly message: AppMessage; readonly error: StorageError | undefined } {
  const page = historyPage(source, effect.query, effect.allowed);
  return page.isOk()
    ? { message: { t: "res", id: effect.id, ok: true, body: page.value }, error: undefined }
    : {
        message: { t: "res", id: effect.id, ok: false, error: { code: "unavailable", detail: {} } },
        error: page.error,
      };
}

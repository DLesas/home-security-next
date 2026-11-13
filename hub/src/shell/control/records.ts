/**
 * Audit records on the control socket (hub-design.md sections 6 and 9): the core's
 * `AuditRecord` as the control protocol's `RecordJson`, bytes as lowercase hex, and the filter
 * `hsn log --device --since --kind` applies to records streamed to `--follow`.
 */
import { toHex } from "@hsn/protocol";
import type { AuditRecord } from "../../core/model/audit.ts";
import type { RecordJson } from "../../core/model/control.ts";
import type { LogQuery } from "../../ports/reader.ts";

/** One record as JSON, one field per column (control-protocol `recordJson`). */
export function recordJson(record: AuditRecord): RecordJson {
  switch (record.kind) {
    case "rx":
      return {
        kind: "rx",
        table: record.table,
        row: { ...record.row, body: toHex(record.row.body) },
      };
    case "tx":
      return {
        kind: "tx",
        table: record.table,
        row: { ...record.row, body: toHex(record.row.body) },
      };
    case "decision":
      return {
        kind: "decision",
        row: {
          ...record.row,
          detail: record.row.detail === null ? null : toHex(record.row.detail),
        },
      };
    case "deviceLog":
      return { kind: "deviceLog", row: { ...record.row, text: toHex(record.row.text) } };
    case "hubEvent":
      return { kind: "hubEvent", row: { ...record.row } };
    case "command":
      return { kind: "command", row: { ...record.row } };
    case "reject":
      return { kind: "reject", row: { ...record.row, sample: toHex(record.row.sample) } };
  }
}

/** `--kind` by record kind (section 9); a command record has no kind of its own. */
const KIND_OF: Readonly<Record<AuditRecord["kind"], LogQuery["logKind"]>> = {
  rx: "rx",
  tx: "tx",
  decision: "decision",
  deviceLog: "log",
  hubEvent: "event",
  reject: "reject",
  command: undefined,
};

const MS_PER_MINUTE = 60_000;

/** What a `--follow` stream keeps: `device` already resolved to its id. */
export interface FollowFilter {
  readonly device: number | undefined;
  readonly since: number | undefined;
  readonly logKind: LogQuery["logKind"];
}

function deviceOf(record: AuditRecord): number | null {
  switch (record.kind) {
    case "rx":
    case "tx":
    case "decision":
    case "deviceLog":
      return record.row.deviceId;
    default:
      return null;
  }
}

function timeOf(record: AuditRecord): number {
  return record.kind === "reject" ? record.row.minute * MS_PER_MINUTE : record.row.atMs;
}

/** True when a streamed record is one the follower asked for. */
export function matches(filter: FollowFilter, record: AuditRecord): boolean {
  if (filter.logKind !== undefined && KIND_OF[record.kind] !== filter.logKind) return false;
  if (filter.device !== undefined && deviceOf(record) !== filter.device) return false;
  return filter.since === undefined || timeOf(record) >= filter.since;
}

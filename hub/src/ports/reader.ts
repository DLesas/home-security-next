/** Reading the database (hub-design.md sections 3 and 6). */
import type { Result } from "neverthrow";
import type { AuditRecord } from "../core/model/audit.ts";
import type { ControlCommand } from "../core/model/control.ts";
import type { DurableSnapshot } from "../core/model/events.ts";
import type { StorageError } from "./writer.ts";

/** What `hsn log` asks for (section 9). */
export type LogQuery = Omit<Extract<ControlCommand, { readonly kind: "log" }>, "kind" | "follow">;

/**
 * Synchronous, on the writer's connection, after a flush, so it sees everything committed.
 * `snapshot` is read once at start for the boot event; `query` serves `hsn log` only, which a
 * person asked for. An error goes to the caller and is recorded.
 */
export interface Reader {
  snapshot(): Result<DurableSnapshot, StorageError>;
  query(query: LogQuery): Result<readonly AuditRecord[], StorageError>;
}

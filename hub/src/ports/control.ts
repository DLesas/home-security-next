/** The control socket (hub-design.md sections 3 and 9). */
import type { AuditRecord } from "../core/model/audit.ts";
import type { ControlReply } from "../core/model/control.ts";
import type { RequestId } from "../core/model/ids.ts";
import type { EventSink } from "./links.ts";

/** A client holding a `hsn log --follow` stream open. */
export type SubscriberId = number & { readonly __brand: "SubscriberId" };

/**
 * Emits `command` events. One request at a time per client connection. A malformed request is
 * answered with an error and recorded. Streamed records go in the order the core made them;
 * nothing here reads the database.
 */
export interface Control {
  listen(sink: EventSink): void;
  respond(request: RequestId, reply: ControlReply): void;
  stream(subscriber: SubscriberId, record: AuditRecord): void;
}

/**
 * The bench's `HubAction`s for the hub's records (hub-design.md section 11, lockstep with the
 * firmware's bench): the names the bench's timeline uses, from what the hub records.
 *
 * Most are a decision's kind. A packet's outcome is not a decision of its own (section 6): it is
 * the packet's `tx` row, kept as long as the packet it answers (D57). So a LoRa `tx` row gives
 * `transmit_result` when a gateway answered, and `too_late` when it missed its moment; a
 * heartbeat's reply (a Reply in `tx_routine`) also gives `reply`, and `reply_skipped` when it was
 * not sent for another reason. They come when the outcome does, where the bench names `reply` at
 * the hand-over: a lockstep check compares them by packet, not by instant.
 *
 * Firmware updates add four of the same kind (m3-updates-design section 8): every sent Update
 * offer gives `firmware_offer`, on any path, before any `transmit_result` of its own; a received
 * Update query `firmware_query` and an Update status `firmware_status`; and a packet under a
 * device's old key (`oldKey`, D141), never acted on, gives `old_key_packet` and nothing else.
 */
import { MessageType } from "@hsn/protocol";
import type { AuditRecord } from "./audit.ts";
import type { DecisionKind } from "./decisions.ts";
import { PacketPath, type RxRow, TxOutcome } from "./rows.ts";

/** Outcomes a gateway reported, as against the hub's own (no result, held back, …). */
const FROM_GATEWAY: ReadonlySet<number> = new Set([
  TxOutcome.Sent,
  TxOutcome.TooLate,
  TxOutcome.NoAirtime,
  TxOutcome.RadioBusy,
  TxOutcome.NotValid,
]);

/** A received packet's bench action, by its type; a packet under the old key is only that. */
function receivedActions(row: RxRow): readonly DecisionKind[] {
  if (row.oldKey) return ["old_key_packet"];
  if (row.type === MessageType.UpdateQuery) return ["firmware_query"];
  if (row.type === MessageType.UpdateStatus) return ["firmware_status"];
  return [];
}

export function benchActions(record: AuditRecord): readonly DecisionKind[] {
  if (record.kind === "decision") return [record.row.kind];
  if (record.kind === "rx") return receivedActions(record.row);
  if (record.kind !== "tx") return [];
  const { outcome, type } = record.row;
  const offer: readonly DecisionKind[] = type === MessageType.UpdateOffer ? ["firmware_offer"] : [];
  if (record.row.path !== PacketPath.Lora) return offer;
  const heartbeatReply = record.table === "routine" && type === MessageType.Reply;
  const actions: DecisionKind[] = heartbeatReply ? ["reply", ...offer] : [...offer];
  if (FROM_GATEWAY.has(outcome)) actions.push("transmit_result");
  if (outcome === TxOutcome.TooLate) actions.push("too_late");
  else if (heartbeatReply && outcome !== TxOutcome.Sent) actions.push("reply_skipped");
  return actions;
}

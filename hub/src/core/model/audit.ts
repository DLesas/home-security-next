/**
 * The audit record (hub-design.md section 6, D110): every packet received and sent, every
 * decision, device log entry, hub event, command and rejection count. Each is one row of an
 * audit table, carried by a `record` effect; every `record` effect is also what
 * `hsn log --follow` streams (section 9).
 */
import type {
  CommandRow,
  DecisionRow,
  DeviceLogRow,
  HubEventRow,
  RejectRow,
  RxRow,
  TxRow,
} from "./rows.ts";

/** Which of a packet table's two halves a row goes to: by retention class (section 6). */
export type PacketTable = "routine" | "event";

export type AuditRecord =
  /** `rx_routine`: heartbeats, regular siren reports and LoRa checks, gateway statuses; else `rx_event`. */
  | { readonly kind: "rx"; readonly table: PacketTable; readonly row: RxRow }
  /** `tx_routine`: link-check replies; else `tx_event`, one row per transmission. */
  | { readonly kind: "tx"; readonly table: PacketTable; readonly row: TxRow }
  | { readonly kind: "decision"; readonly row: DecisionRow }
  | { readonly kind: "deviceLog"; readonly row: DeviceLogRow }
  | { readonly kind: "hubEvent"; readonly row: HubEventRow }
  | { readonly kind: "command"; readonly row: CommandRow }
  /** A full-value upsert of the minute's count for one source and reason. */
  | { readonly kind: "reject"; readonly row: RejectRow };

/**
 * What each message type is to the intake (hub-design.md sections 5, 6 and 8; protocol.md §5):
 * the paths it may travel, the audit table its row goes to, and whether it is written at once.
 */
import { type Message, MessageType, SirenReportReason } from "@hsn/protocol";
import type { Arrival } from "../model/messages.ts";
import type { PacketTable } from "../model/audit.ts";
import type { Durability } from "../model/store.ts";

/** The paths each type to the hub may arrive on as a device packet (§5, "Paths"). */
const PATHS: Readonly<Record<number, readonly Arrival["path"][]>> = {
  [MessageType.Heartbeat]: ["lora"],
  [MessageType.DoorChanged]: ["lora"],
  [MessageType.CoverChanged]: ["lora"],
  [MessageType.Button]: ["lora"],
  [MessageType.Started]: ["lora", "wifi", "usb"],
  [MessageType.SirenReport]: ["lora", "wifi"],
  [MessageType.LogEntries]: ["lora", "wifi", "usb"],
  // A gateway's own packets travel on its link; inside a forwarded packet, or on a siren's
  // link, they are on a path they do not use (section 8).
};

/** True when `type` may arrive on `path` (§5): otherwise the packet is `wrongPath` (section 8). */
export function onItsPath(type: number, path: Arrival["path"]): boolean {
  return PATHS[type]?.includes(path) ?? false;
}

/** Door, cover, button and Started: written now, before their reply (section 5, D112). */
const EVENT_REPORTS: ReadonlySet<number> = new Set([
  MessageType.DoorChanged,
  MessageType.CoverChanged,
  MessageType.Button,
  MessageType.Started,
]);

/**
 * Whether an accepted packet's record, window and reading are written now (section 5): every
 * door, cover, button and Started report, and a siren report with reason 3, which raises a
 * warning; every other packet is routine.
 */
export function durabilityOf(message: Message): Durability {
  if (EVENT_REPORTS.has(message.type)) return "now";
  if (
    message.type === MessageType.SirenReport &&
    message.reason === SirenReportReason.WifiReportFailed
  ) {
    return "now";
  }
  return "routine";
}

/**
 * The packet table a received row goes to (section 6): heartbeats and regular siren reports and
 * LoRa checks are routine (30 days); everything else is an event (a year).
 */
export function rxTableOf(message: Message): PacketTable {
  if (message.type === MessageType.Heartbeat) return "routine";
  if (
    message.type === MessageType.SirenReport &&
    (message.reason === SirenReportReason.Regular || message.reason === SirenReportReason.LoraCheck)
  ) {
    return "routine";
  }
  return "event";
}

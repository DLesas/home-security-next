/**
 * What a person may see of history (m2-design.md section 7, "History"), one rule for the
 * `historyRead` filter the shell applies to a page and for the live `record` events `app` sends:
 * a row naming a device the person may view; a `commands` row whose actor ends in
 * ` (client <n>)` for one of the person's clients; a `notifications` row whose recipients hold the
 * person (and a read of one by their client); and, only with *manage system*, every row naming no
 * device. The console and the hub computer see every row.
 *
 * A record goes out as `hsn log --json` writes it (`recordJson`, bytes as lowercase hex), built
 * here as `shell/control/records.ts` builds it for the control socket.
 */
import { Role, toHex } from "@hsn/protocol";
import type { HistoryRow } from "@hsn/protocol/app";
import type { AuditRecord } from "../model/audit.ts";
import type { RecordJson } from "../model/control.ts";
import type { HistoryFilter } from "../model/effects.ts";
import { type ClientId, clientId, type DeviceId, deviceId } from "../model/ids.ts";
import type { Actor } from "../model/messages.ts";
import type { HubState } from "../model/state.ts";
import { clientsOf, hasGlobal, mayView, userManagementOn } from "../people/view.ts";
import { deviceById } from "../registry/view.ts";
import { visibleDevices } from "./objects.ts";

/** What the person may see of history, for `historyRead` (section 7). */
export function historyFilter(view: HubState, actor: Actor): HistoryFilter {
  if (actor.kind !== "person") return { devices: "all", person: null, clients: [], hub: true };
  return {
    devices: userManagementOn(view) ? visibleDevices(view, actor).map((row) => row.id) : "all",
    person: actor.person,
    clients: clientsOf(view, actor.person),
    hub: hasGlobal(view, actor, "manageSystem"),
  };
}

/** The device a record names, or null for one about the hub as a whole. */
function deviceOf(record: AuditRecord): DeviceId | null {
  switch (record.kind) {
    case "rx":
    case "tx":
    case "deviceLog":
      return record.row.deviceId;
    case "decision":
    case "notification":
      return record.row.deviceId;
    case "reject": {
      const via = /^device:(\d+)$/u.exec(record.row.via);
      return via?.[1] === undefined ? null : deviceId(Number(via[1]));
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

/** Whether the actor may see this record (the file's rule). */
export function maySeeRecord(view: HubState, actor: Actor, record: AuditRecord): boolean {
  if (actor.kind !== "person") return true;
  const device = deviceOf(record);
  if (device !== null) {
    const row = deviceById(view, device);
    if (row?.role !== Role.Sensor || mayView(view, actor, device)) return true;
  }
  const clients: ReadonlySet<ClientId> = new Set(clientsOf(view, actor.person));
  if (record.kind === "command") {
    const own = / \(client (\d+)\)$/u.exec(record.row.actor);
    if (own?.[1] !== undefined && clients.has(clientId(Number(own[1])))) return true;
  }
  if (record.kind === "notification" && recipientsHold(record.row.recipients, actor.person))
    return true;
  if (record.kind === "notificationRead" && clients.has(record.row.clientId)) return true;
  return device === null && hasGlobal(view, actor, "manageSystem");
}

/** One record as `hsn log --json` writes it. */
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
    case "notification":
      return {
        kind: "notification",
        row: {
          ...record.row,
          recipients: toHex(record.row.recipients),
          detail: record.row.detail === null ? null : toHex(record.row.detail),
        },
      };
    case "notificationRead":
      return { kind: "notificationRead", row: { ...record.row } };
  }
}

/** The `record` event's body for this actor, or undefined when they may not see it. */
export function recordFor(
  view: HubState,
  actor: Actor,
  record: AuditRecord,
): HistoryRow | undefined {
  if (!maySeeRecord(view, actor, record)) return undefined;
  const row = recordJson(record);
  return { kind: row.kind, row };
}

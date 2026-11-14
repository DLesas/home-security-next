/**
 * Hub events from the registry, setup and control modules (hub-design.md section 10, "How every
 * rejection and error reaches the audit record"; section 6, `hub_events`). Each takes its
 * sequence number from the step's record cursor and goes to the audit module as an
 * `auditRecord` message, which applies the warning cap and makes the `record` effect
 * (section 5). Records at warning level or above are written now, the rest are routine, unless
 * the caller says otherwise.
 */
import { toHex } from "@hsn/protocol";
import type { DeviceRow } from "../model/rows.ts";
import type { Result } from "neverthrow";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { Internal } from "../model/messages.ts";
import type { HubEventLevel } from "../model/rows.ts";
import type { Durability } from "../model/store.ts";

/** Levels written now (section 5, "Durability classes": every record at warning or above). */
const LEVELS_WRITTEN_NOW: ReadonlySet<HubEventLevel> = new Set(["warning", "critical"]);

/** One hub event, as the audit module's input. */
export interface HubEventSpec {
  readonly level: HubEventLevel;
  /** Where it arose: "core/setup". */
  readonly origin: string;
  /** A stable snake-case code a reader can search for. */
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
  /** "now" also for an info record that must not be lost: the automatic add (section 9). */
  readonly durability?: Durability;
}

/** The `auditRecord` message for one hub event. */
export function hubEventRecord(ctx: Context, spec: HubEventSpec): Result<Internal, CoreFault> {
  return ctx.records.take().map((seq): Internal => ({
    kind: "auditRecord",
    durability: spec.durability ?? (LEVELS_WRITTEN_NOW.has(spec.level) ? "now" : "routine"),
    record: {
      kind: "hubEvent",
      row: {
        seq,
        atMs: ctx.now.wall,
        clockOk: ctx.now.wallTrusted,
        level: spec.level,
        origin: spec.origin,
        code: spec.code,
        message: spec.message,
        detail: spec.detail ?? null,
      },
    },
  }));
}

/** A device state's name in records: `provisioning`, `paired`, `contacted`, `reset_by_owner`, `removed`, `left_behind`. */
export const DEVICE_STATE_NAMES: Readonly<Record<number, string>> = {
  0: "provisioning",
  1: "paired",
  2: "contacted",
  3: "reset_by_owner",
  4: "removed",
  5: "left_behind",
};

const ROLE_NAMES: Readonly<Record<number, string>> = { 1: "sensor", 2: "siren", 3: "gateway" };

/**
 * A device as the records name it (section 6, `hub_events.detail` of the `device_*` events): its
 * number, name, address, role, chip identifier (lowercase hex), firmware and state.
 */
export function deviceFields(row: DeviceRow): Readonly<Record<string, string | number | boolean>> {
  return {
    device: row.id,
    name: row.name,
    address: row.address,
    role: ROLE_NAMES[row.role] ?? String(row.role),
    chip: toHex(row.chipId),
    firmware: row.firmware,
    development: row.development,
    state: DEVICE_STATE_NAMES[row.state] ?? String(row.state),
  };
}

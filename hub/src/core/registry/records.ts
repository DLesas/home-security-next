/**
 * Hub events from the registry, setup and control modules (hub-design.md section 10, "How every
 * rejection and error reaches the audit record"; section 6, `hub_events`). Each takes its
 * sequence number from the step's record cursor and goes to the audit module as an
 * `auditRecord` message, which applies the warning cap and makes the `record` effect
 * (section 5). Records at warning level or above are written now, the rest are routine, unless
 * the caller says otherwise.
 */
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

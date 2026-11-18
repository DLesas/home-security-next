/**
 * firmware's rows, decisions and hub events (docs/m3-updates-design.md section 4, "Tables",
 * "Durability"). Every row is written now as a full value, but a `device_updates` row whose only
 * change is `bytes`, which is routine. Decisions at warning level (`firmware_refused`,
 * `firmware_rolled_back`, `rollout_paused`) are written now (HD 5); the info ones are routine and
 * reach the disk with the "now" row of the transition they record, which is in the same commit.
 *
 * Each decision's `device_id`, `value` and `detail`:
 *
 * | Kind | `device_id` | `value` | `detail` |
 * | --- | --- | --- | --- |
 * | `firmware_added`, `firmware_removed` | — | the image's row id | the actor, UTF-8 |
 * | `rollout_started`, `rollout_resumed`, `rollout_done`, `rollout_cancelled` | — | the rollout | the actor, UTF-8, when a person or `hsn` did it |
 * | `rollout_paused` | the device, when one caused it | the rollout | the device u32 LE (0 when none caused it: a damaged store) and the reason u8 (`paused_reason`), 5 bytes; none when a person paused it |
 * | `firmware_release_offered` | — | the version (major × 65,536 + minor × 256 + patch) | — |
 * | `firmware_held` | the device | `held`'s code | — |
 * | `firmware_device_offered` | the device | the method | — |
 * | `firmware_session_opened` | the device | — | the actor (its client), UTF-8 |
 * | `firmware_verified`, `firmware_installing`, `firmware_on_trial`, `firmware_confirmed` | the device | the rollout's version | — |
 * | `firmware_refused` | the device | the reason (1 to 17; 18 `noContact`) | — |
 * | `firmware_rolled_back` | the device | the failed version | — |
 * | `firmware_reminder` | the device | whole days it has been held armed | — |
 *
 * Hub events (detail JSON): `firmware_file_refused` `{reason, message}`, with `version` for a
 * fetched release; `firmware_store_damaged` `{image, problem, version}` (critical, now).
 */
import type { Result } from "neverthrow";
import type { DecisionKind } from "../model/decisions.ts";
import { M3M4_HUB_EVENTS } from "../model/decisions.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId, Seq } from "../model/ids.ts";
import type { Actor, Internal } from "../model/messages.ts";
import type { DeviceUpdateRow, FirmwareImageRow, RolloutRow } from "../model/rows.ts";
import type { Durability } from "../model/store.ts";
import { decision } from "../util/records.ts";
import { ORIGIN } from "./out.ts";

const encoder = new TextEncoder();

export function writeImage(row: FirmwareImageRow): Effect {
  return { kind: "write", durability: "now", op: { table: "firmware_images", op: "upsert", row } };
}

export function writeRollout(row: RolloutRow): Effect {
  return { kind: "write", durability: "now", op: { table: "rollouts", op: "upsert", row } };
}

/** A device's row: now for a transition, routine when only `bytes` moved. */
export function writeUpdate(row: DeviceUpdateRow, durability: Durability = "now"): Effect {
  return { kind: "write", durability, op: { table: "device_updates", op: "upsert", row } };
}

/** The decisions written now: the warnings (HD 5). */
const WARNINGS: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  "firmware_refused",
  "firmware_rolled_back",
  "rollout_paused",
]);

/** One of firmware's decisions; warnings now, the rest routine. */
export function firmwareDecision(
  ctx: Context,
  kind: DecisionKind,
  fields: {
    readonly device?: DeviceId;
    readonly value?: number;
    readonly detail?: Uint8Array | string;
    readonly cause?: Seq;
  },
): Result<Internal, CoreFault> {
  const detail =
    fields.detail === undefined
      ? null
      : typeof fields.detail === "string"
        ? encoder.encode(fields.detail)
        : fields.detail;
  return decision(ctx, WARNINGS.has(kind) ? "now" : "routine", {
    kind,
    device: fields.device ?? null,
    cause: fields.cause ?? null,
    value: fields.value ?? null,
    detail,
  }).map((decided) => decided.message);
}

/** `rollout_paused`'s detail: the device u32 LE, then the reason u8. */
export function pausedDetail(device: DeviceId, reason: number): Uint8Array {
  const bytes = new Uint8Array(5);
  new DataView(bytes.buffer).setUint32(0, device, true);
  bytes[4] = reason;
  return bytes;
}

/** `firmware_file_refused`, at the level and class `M3M4_HUB_EVENTS` gives it. */
export function fileRefused(
  ctx: Context,
  reason: string,
  message: string,
  version: string | undefined,
): Result<Internal, CoreFault> {
  const spec = M3M4_HUB_EVENTS.firmware_file_refused;
  const detail = version === undefined ? { reason, message } : { reason, message, version };
  return ctx.records.take().map((seq): Internal => ({
    kind: "auditRecord",
    durability: spec.durability,
    record: {
      kind: "hubEvent",
      row: {
        seq,
        atMs: ctx.now.wall,
        clockOk: ctx.now.wallTrusted,
        level: spec.level,
        origin: ORIGIN,
        code: "firmware_file_refused",
        message: `A firmware file was refused: ${reason}.`,
        detail: JSON.stringify(detail),
      },
    },
  }));
}

/** The actor's text, as records name it (AL8). */
export function actorText(actor: Actor): string {
  switch (actor.kind) {
    case "computer":
      return actor.name;
    case "console":
      return `hub computer (client ${actor.client})`;
    case "person":
    case "schedule":
      return actor.name;
  }
}

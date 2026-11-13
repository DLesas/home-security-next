/**
 * The audit records this module makes (hub-design.md sections 5, 6 and 8; D110): the gateway's
 * own packets received and sent, its log entries, and the decisions of sections 7 and 8. Each
 * goes to the audit module as an `auditRecord` message, which applies the warning cap and turns
 * it into a `record` effect (section 5). Forwarded packets and transmit requests make no rows
 * of their own (section 6): the packet inside is the row, written by the module that made it.
 */
import { err, ok, type Result } from "neverthrow";
import type { Message } from "@hsn/protocol";
import type { DecisionKind } from "../model/decisions.ts";
import type { CoreFault } from "../model/errors.ts";
import type { LinkKind } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId, Seq } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { PacketPath, type TxOutcome } from "../model/rows.ts";
import type { Durability } from "../model/store.ts";
import { safeEncodeMessage } from "../util/protocol-safe.ts";
import { asFault } from "./common.ts";

/** Device log levels at or above this are warnings: written now, within the cap (§6, section 5). */
export const WARNING_LEVEL = 2;

/** How a gateway's link travels, as the packet tables' `path` (section 6). */
export function linkPath(kind: LinkKind): PacketPath {
  return kind === "usb" ? PacketPath.Usb : PacketPath.Wifi;
}

/** The plaintext body after the type byte, as the packet tables keep it (section 6). */
export function bodyOf(ctx: Context, message: Message): Result<Uint8Array, CoreFault> {
  return safeEncodeMessage(message)
    .map((plaintext) => plaintext.slice(1))
    .mapErr((error) => asFault(ctx, error));
}

function take(ctx: Context): Result<Seq, CoreFault> {
  return ctx.records.take();
}

/** A packet received from the gateway itself: hello, status, interference, Started. */
export function received(
  ctx: Context,
  gateway: DeviceId,
  message: Message,
  counter: number,
  kind: LinkKind,
  table: "routine" | "event",
): Result<{ readonly seq: Seq; readonly record: Internal }, CoreFault> {
  return take(ctx).andThen((seq) =>
    bodyOf(ctx, message).map((body) => ({
      seq,
      record: {
        kind: "auditRecord" as const,
        durability: "routine" as const,
        record: {
          kind: "rx" as const,
          table,
          row: {
            seq,
            atMs: ctx.now.wall,
            clockOk: ctx.now.wallTrusted,
            deviceId: gateway,
            type: message.type,
            counter,
            path: linkPath(kind),
            gatewayId: null,
            gwUs: null,
            rssi: null,
            snrQ: null,
            rate: null,
            body,
          },
        },
      },
    })),
  );
}

/** A packet the hub sent to the gateway itself on its link: welcome, settings (section 6, `tx_event`). */
export function sent(
  ctx: Context,
  gateway: DeviceId,
  message: Message,
  counter: number,
  kind: LinkKind,
  outcome: TxOutcome,
): Result<Internal, CoreFault> {
  return take(ctx).andThen((seq) =>
    bodyOf(ctx, message).map((body): Internal => ({
      kind: "auditRecord",
      durability: "routine",
      record: {
        kind: "tx",
        table: "event",
        row: {
          seq,
          atMs: ctx.now.wall,
          clockOk: ctx.now.wallTrusted,
          deviceId: gateway,
          type: message.type,
          counter,
          path: linkPath(kind),
          gatewayId: null,
          requestCounter: null,
          rate: null,
          power: null,
          outcome,
          gwSentUs: null,
          body,
        },
      },
    })),
  );
}

/** What a decision record says (section 6, `decisions`). */
export interface DecisionArgs {
  readonly kind: DecisionKind;
  readonly device: DeviceId | null;
  readonly cause: Seq | null;
  readonly value: number | null;
  readonly detail: Uint8Array | null;
  /** "now" for warnings and worse (section 5), "routine" for the rest. */
  readonly durability: Durability;
}

/** A decision record (section 6, `decisions`). */
export function decision(ctx: Context, args: DecisionArgs): Result<Internal, CoreFault> {
  return take(ctx).map((seq): Internal => ({
    kind: "auditRecord",
    durability: args.durability,
    record: {
      kind: "decision",
      row: {
        seq,
        atMs: ctx.now.wall,
        clockOk: ctx.now.wallTrusted,
        kind: args.kind,
        deviceId: args.device,
        causeSeq: args.cause,
        value: args.value,
        detail: args.detail,
      },
    },
  }));
}

/** Milliseconds in one tenth of a second: a log entry's age unit (§6, Log entries). */
const MS_PER_TENTH = 100;

/**
 * One `device_log` row per entry of a gateway's log entries packet (section 7, "Gateway
 * connection"): warnings and worse now (within the cap), the rest routine. A gateway's entries
 * travel on its session, so they cannot be replayed and are never marked `repeat_of`.
 */
export function logEntries(
  ctx: Context,
  gateway: DeviceId,
  counter: number,
  entries: readonly {
    readonly ageTenths: number;
    readonly level: number;
    readonly code: number;
    readonly text: string;
  }[],
): Result<{ readonly first: Seq | undefined; readonly records: readonly Internal[] }, CoreFault> {
  const records: Internal[] = [];
  let first: Seq | undefined;
  for (const entry of entries) {
    const seq = take(ctx);
    if (seq.isErr()) return err(seq.error);
    first ??= seq.value;
    records.push({
      kind: "auditRecord",
      durability: entry.level >= WARNING_LEVEL ? "now" : "routine",
      record: {
        kind: "deviceLog",
        row: {
          seq: seq.value,
          atMs: ctx.now.wall,
          clockOk: ctx.now.wallTrusted,
          deviceId: gateway,
          counter,
          madeMs: ctx.now.wall - entry.ageTenths * MS_PER_TENTH,
          level: entry.level,
          code: entry.code,
          text: new TextEncoder().encode(entry.text),
          repeatOf: null,
        },
      },
    });
  }
  return ok({ first, records });
}

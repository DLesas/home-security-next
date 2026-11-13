/**
 * Building records (hub-design.md sections 2, 5 and 6; D110), shared by every module. A record
 * goes to the audit module as an `auditRecord` message, which applies the warning cap of section
 * 5 and stamps its time and trust from the clock (section 6, `at_ms` never decreases); its
 * sequence number is taken here, so a decision can name the packet or command that caused it
 * before either is written.
 */
import type { Result } from "neverthrow";
import type { AuditRecord } from "../model/audit.ts";
import type { DecisionKind } from "../model/decisions.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId, Seq } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import type { Durability } from "../model/store.ts";

/** A record for audit, with its durability (section 5). */
export function recordMessage(durability: Durability, record: AuditRecord): Internal {
  return { kind: "auditRecord", durability, record };
}

/** What a decision row says, besides its number and time (section 6, `decisions`). */
export interface DecisionFields {
  readonly kind: DecisionKind;
  readonly device: DeviceId | null | undefined;
  /** The record that caused it: a packet's `rx` row or a command's `commands` row. */
  readonly cause: Seq | null | undefined;
  readonly value?: number | null;
  /** Bytes for the row's `detail`, such as a command's actor as UTF-8 (AL8). */
  readonly detail?: Uint8Array | null;
}

/** A decision and the number it took, so later messages can name it as their cause. */
export interface Decided {
  readonly seq: Seq;
  readonly message: Internal;
}

/**
 * A decision record (D110). `durability` is "now" for decisions an event report causes and for
 * warnings and worse, "routine" otherwise (section 5); `decisions` has no level column.
 */
export function decision(
  ctx: Context,
  durability: Durability,
  fields: DecisionFields,
): Result<Decided, CoreFault> {
  return ctx.records.take().map((seq) => ({
    seq,
    message: recordMessage(durability, {
      kind: "decision",
      row: {
        seq,
        atMs: ctx.now.wall,
        clockOk: ctx.now.wallTrusted,
        kind: fields.kind,
        deviceId: fields.device ?? null,
        causeSeq: fields.cause ?? null,
        value: fields.value ?? null,
        detail: fields.detail ?? null,
      },
    }),
  }));
}

/** A command's actor, as a decision's detail (AL8: who or what caused it). */
export function actorDetail(actor: string): Uint8Array {
  return new TextEncoder().encode(actor);
}

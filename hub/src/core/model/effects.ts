/**
 * What a step asks the shell to do (hub-design.md section 2, "Effects"). The shell performs
 * them in the order of section 4: stage writes and records, flush if any is "now", then the
 * sends, closes and answers, each send through the send gate.
 */
import type { AuditRecord } from "./audit.ts";
import type { ControlReply } from "./control.ts";
import type { DeviceId, LinkId, RequestId, SendRef } from "./ids.ts";
import type { Durability, StoreOp } from "./store.ts";

/** One hub counter a send's bytes use, for the send gate (section 4). */
export interface CounterUse {
  readonly device: DeviceId;
  readonly counter: number;
}

/** How often the writer must commit: every second while a countdown or the alarm runs (D112, D113). */
export type CadenceMs = 1_000 | 300_000;

export type Effect =
  | { readonly kind: "write"; readonly durability: Durability; readonly op: StoreOp }
  | { readonly kind: "record"; readonly durability: Durability; readonly record: AuditRecord }
  /** A countdown or the alarm started or ended. */
  | { readonly kind: "cadence"; readonly everyMs: CadenceMs }
  | {
      readonly kind: "send";
      readonly link: LinkId;
      readonly bytes: Uint8Array;
      readonly ref: SendRef;
      /** Every hub counter in `bytes`: one on a siren's WebSocket, two in a transmit request. */
      readonly counters: readonly CounterUse[];
    }
  | { readonly kind: "close"; readonly link: LinkId; readonly reason: string }
  | { readonly kind: "respond"; readonly request: RequestId; readonly reply: ControlReply }
  /** Advertise the hub by mDNS with its identity (§10). */
  | { readonly kind: "advertise"; readonly identity: Uint8Array; readonly port: number };

/** Every effect kind; internal messages must use other kinds, so the dispatcher can tell them apart. */
export const EFFECT_KINDS = [
  "write",
  "record",
  "cadence",
  "send",
  "close",
  "respond",
  "advertise",
] as const satisfies readonly Effect["kind"][];

/** Compile-time proof that `EFFECT_KINDS` lists every effect kind. */
export type EffectKindsComplete =
  Exclude<Effect["kind"], (typeof EFFECT_KINDS)[number]> extends never ? true : never;
export const EFFECT_KINDS_COMPLETE: EffectKindsComplete = true;

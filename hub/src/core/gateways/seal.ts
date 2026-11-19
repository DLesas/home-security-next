/**
 * Sealing a packet to a gateway with the hub's counter for its key (hub-design.md section 4,
 * "Counters, precisely"; protocol.md §3, §4). Each packet takes the next counter; a counter that
 * is a multiple of 1,024 asks for its resume point to be written now, in the same step as the
 * send, so the shell's send gate lets the packet pass only after that commit.
 */
import { err, type Result } from "neverthrow";
import { Direction, MaxPacketLength, type Message, takeSendCounter } from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { KeyUsed } from "../model/cipher.ts";
import type { Context } from "../model/handler.ts";
import { failingCommitWrites, type KeyChanges, sealKeyOf } from "../intake/view.ts";
import { asFault, fault } from "./common.ts";
import type { GatewayEntry } from "./state.ts";

/** A packet sealed to a gateway, and what sealing it changed. */
export interface Sealed {
  readonly bytes: Uint8Array;
  /** The hub counter the packet uses. */
  readonly counter: number;
  /** The entry with its counter moved on. */
  readonly entry: GatewayEntry;
  /** The resume point's write, when this counter asked for one (section 4). */
  readonly writes: readonly Effect[];
}

/** The `write` of a gateway key's resume point: now, before the packet that needs it. */
export function resumePointWrite(entry: GatewayEntry): Effect {
  return {
    kind: "write",
    durability: "now",
    op: {
      table: "send_counters",
      op: "upsert",
      row: { deviceId: entry.device, resumePoint: entry.counter.resumePoint },
    },
  };
}

/**
 * Seals `message` to the gateway under `binding`, taking the next hub counter, under the key `keys`
 * names for it (D141: `next` once switched in this run), or `under` when given: a Key change's is
 * the key the hello it answers came under.
 */
export function sealToGateway(
  ctx: Context,
  entry: GatewayEntry,
  message: Message,
  binding: Uint8Array,
  keys: KeyChanges,
  under: KeyUsed = sealKeyOf(keys, entry.device),
): Result<Sealed, CoreFault> {
  const taken = takeSendCounter(entry.counter);
  if (!taken.ok) {
    return err(fault(ctx, "no hub counter left for this gateway", { gateway: entry.device }));
  }
  const { counter, state, saveResumePoint } = taken.value;
  const next: GatewayEntry = { ...entry, counter: state };
  return ctx.deps.cipher
    .seal(entry.device, message, {
      direction: Direction.FromHub,
      address: entry.address,
      counter,
      binding,
      maxLength: MaxPacketLength.Link,
      ...(under === "next" ? { key: under } : {}),
    })
    .mapErr((error) => asFault(ctx, error))
    .map((bytes) => ({
      bytes,
      counter,
      entry: next,
      writes:
        saveResumePoint === undefined
          ? failingCommitWrites(keys, entry.device, state)
          : [resumePointWrite(next)],
    }));
}

/**
 * What the gateways module sends a gateway besides its welcome, settings and transmit requests
 * (docs/m3-updates-design.md sections 4, 5 and 7): the Update offers firmware decides, inside the
 * session, and the Key change after a restore, in place of the welcome. The gateway's key is this
 * module's (HD 2), and its own packets never pass through intake, so the key change's rules are
 * applied here to its hellos:
 *
 * - **A hello under a key the hub held at the backup** is recorded (`rx_event`, flagged `oldKey`),
 *   opens no session and changes nothing else: neither the highest counter accepted from the
 *   gateway nor its silence. It is answered with a Key change bound to the hello's random value,
 *   in place of the welcome (§4, §6), sealed under the key the hello came under, at most one every
 *   10 s ‡ (`key_change_sent`, its counter). A row both of whose keys were held at the backup is
 *   settled by the first such hello, as intake settles a sensor's or siren's.
 * - **The first hello under the new key** switches the gateway: its key, its counter (from 1, its
 *   resume point at 1,024) and the highest counter accepted from it (from 0: a gateway's counters
 *   start again under a new key, §4) are written now (`key_changed`), and the hello is then
 *   welcomed as any other, under the new key. From then a packet under the old key fails, as a
 *   stranger's.
 * - **An Update offer** goes in the gateway's session: the live one, else the newest welcomed; with
 *   none, not at all (firmware offers again when the gateway is next on its link).
 */
import { err, ok, Result } from "neverthrow";
import type { MessageOf, MessageType, PacketHeader } from "@hsn/protocol";
import type { KeyUsed } from "../model/cipher.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { LinkKind } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import { type DeviceId, type LinkId, moduleSendRef } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { TxOutcome } from "../model/rows.ts";
import {
  afterSwitch,
  keyChangeAllowed,
  makeKeyChange,
  switchedCounter,
  switchWrites,
  withKeyChange,
} from "../intake/view.ts";
import { safeWelcomeBinding } from "../util/protocol-safe.ts";
import { asFault, done, type Outcome, withGateway } from "./common.ts";
import { bodyOf, decision, linkPath, sent } from "./records.ts";
import { sealToGateway } from "./seal.ts";
import type { GatewayEntry, GatewaysSlice, Session } from "./state.ts";

type Hello = MessageOf<typeof MessageType.Hello>;

/** The ref of the next send this module makes for itself. */
function ownRef(slice: GatewaysSlice) {
  return {
    slice: { ...slice, nextOwnRef: slice.nextOwnRef + 1 },
    ref: moduleSendRef("gateways", slice.nextOwnRef),
  };
}

/** The hello's `rx_event` row, flagged `oldKey` (D141), routine: nothing acted on it. */
function oldKeyRow(ctx: Context, gateway: DeviceId, hello: Hello, counter: number, kind: LinkKind) {
  return ctx.records.take().andThen((seq) =>
    bodyOf(ctx, hello).map((body) => ({
      seq,
      record: {
        kind: "auditRecord" as const,
        durability: "routine" as const,
        record: {
          kind: "rx" as const,
          table: "event" as const,
          row: {
            seq,
            atMs: ctx.now.wall,
            clockOk: ctx.now.wallTrusted,
            deviceId: gateway,
            type: hello.type,
            counter,
            path: linkPath(kind),
            gatewayId: null,
            gwUs: null,
            gwCounter: null,
            rssi: null,
            snrQ: null,
            rate: null,
            body,
            oldKey: true,
          },
        },
      },
    })),
  );
}

/** A hello under a key held at the backup (D141): recorded, and answered with a Key change. */
export function onOldKeyHello(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  link: LinkId,
  kind: LinkKind,
  header: PacketHeader,
  hello: Hello,
  keyUsed: KeyUsed,
  ctx: Context,
): Outcome {
  const row = oldKeyRow(ctx, entry.device, hello, header.counter, kind);
  if (row.isErr()) return err(row.error);
  const change = slice.keys.entries.get(entry.device);
  if (change === undefined || !keyChangeAllowed(change, ctx.now.mono, ctx.deps.rules)) {
    return done(slice, [row.value.record]);
  }
  const binding = safeWelcomeBinding(hello.gatewayRandom).mapErr((e) => asFault(ctx, e));
  if (binding.isErr()) return err(binding.error);
  return makeKeyChange(ctx, entry.device, change, keyUsed).andThen((made) =>
    sealToGateway(ctx, entry, made.message, binding.value, slice.keys, made.sealUnder).andThen(
      (sealed) => {
        const { slice: refd, ref } = ownRef(withGateway(slice, sealed.entry));
        const keyed = { ...refd, keys: withKeyChange(refd.keys, entry.device, made.entry) };
        return Result.combine([
          sent(ctx, entry.device, made.message, sealed.counter, kind, TxOutcome.HandedToLink),
          decision(ctx, {
            kind: "key_change_sent",
            device: entry.device,
            cause: row.value.seq,
            value: sealed.counter,
            detail: null,
            durability: "routine",
          }),
        ]).andThen((records) =>
          done(keyed, [
            row.value.record,
            ...made.writes,
            ...sealed.writes,
            {
              kind: "send",
              link,
              bytes: sealed.bytes,
              ref,
              counters: [{ device: entry.device, counter: sealed.counter }],
            },
            ...records,
          ]),
        );
      },
    ),
  );
}

/**
 * The gateway's first hello under its new key (D141): the switch, written now, before the hello is
 * welcomed (`handleHello`) as any other. Returns the slice and entry the welcome goes from.
 */
export function switchGateway(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  ctx: Context,
): Result<
  { readonly slice: GatewaysSlice; readonly entry: GatewayEntry; readonly out: readonly Effect[] },
  CoreFault
> {
  const writes = switchWrites(ctx, entry.device, slice.keys.entries.get(entry.device));
  if (writes.isErr()) return err(writes.error);
  const next: GatewayEntry = {
    ...entry,
    counter: switchedCounter(ctx.deps.rules),
    highestAccepted: 0,
  };
  return ok({
    slice: { ...withGateway(slice, next), keys: afterSwitch(slice.keys, entry.device) },
    entry: next,
    out: writes.value,
  });
}

/** The session an offer goes in: the live one, else the newest welcomed; none, none. */
function sessionFor(entry: GatewayEntry): Session | undefined {
  return entry.live ?? entry.candidates.at(-1);
}

/** Firmware's Update offer for a gateway, inside its session (m3-updates-design section 5). */
export function onUpdateOffer(
  slice: GatewaysSlice,
  message: Extract<Internal, { kind: "updateOffer" }>,
  ctx: Context,
): Outcome {
  const entry = slice.gateways.get(message.device);
  const session = entry === undefined ? undefined : sessionFor(entry);
  if (entry === undefined || session === undefined) return done(slice);
  return sealToGateway(ctx, entry, message.offer, session.binding, slice.keys).andThen((sealed) => {
    const { slice: refd, ref } = ownRef(withGateway(slice, sealed.entry));
    return sent(
      ctx,
      entry.device,
      message.offer,
      sealed.counter,
      session.linkKind,
      TxOutcome.HandedToLink,
    ).andThen((record) =>
      done(refd, [
        ...sealed.writes,
        {
          kind: "send",
          link: session.link,
          bytes: sealed.bytes,
          ref,
          counters: [{ device: entry.device, counter: sealed.counter }],
        },
        record,
      ]),
    );
  });
}

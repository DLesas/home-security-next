/**
 * The sirens module's handler (hub-design.md section 2, module 12; section 8, "What the siren
 * should do, and commands", "Silence" and "Which gateway a packet goes through"; §7 "Siren
 * command", "Siren reports" and "Hub restart"). It handles the boot, the sirens added and removed,
 * accepted siren packets, `sirenIntent` from the alarm module, settings requests and site
 * switches, gateways coming and going, links closing, the outcomes of what it sent, a failed
 * commit, and its timers. It emits sends on Wi-Fi, `radioOut` for LoRa, its rows written now and
 * its records.
 */
import { ok } from "neverthrow";
import { Role, SirenAction } from "@hsn/protocol";
import type { Context, Handler } from "../model/handler.ts";
import type { DomainMessage, Internal } from "../model/messages.ts";
import { TxOutcome } from "../model/rows.ts";
import { onBoot, onDeviceAdded, onSettingsRequest, onSiteMove } from "./devices.ts";
import { type Changing, each, secondsUntil, txRecord, unchanged } from "./out.ts";
import { onHeardCopy, onSirenPacket, reportNowIfOwed } from "./reports.ts";
import { command, resumePoints } from "./send.ts";
import type { SirensSlice } from "./state.ts";
import { onSirenTimer } from "./tick.ts";
import { withTimers } from "./timers.ts";

type Message<K extends DomainMessage["kind"]> = Extract<DomainMessage, { readonly kind: K }>;

/**
 * What the siren should do changed (section 8): sounding or testing for what is left, capped by
 * its longest sound, or off. The alarm module sends this only on a change, never for time running
 * out, so each change is one command.
 */
function onIntent(slice: SirensSlice, ctx: Context, intent: Message<"sirenIntent">): Changing {
  const { should, siren, cause } = intent;
  if (should.kind === "off") return command(slice, ctx, siren, SirenAction.Off, 0, cause);
  const seconds = secondsUntil(ctx.now.mono, should.until);
  if (seconds === 0) return unchanged(slice);
  const action = should.kind === "sound" ? SirenAction.SoundAlarm : SirenAction.Test;
  return command(slice, ctx, siren, action, seconds, cause);
}

/** A transmit result for a LoRa packet of this module: its `tx` row (section 6). */
function onRadioResult(slice: SirensSlice, ctx: Context, result: Message<"radioResult">): Changing {
  return recordOutcome(
    slice,
    ctx,
    result.ref,
    result.outcome,
    result.sentGatewayMicros,
    result.requestCounter,
    result.resultCounter,
  );
}

/**
 * A packet's outcome, for its `tx` row: a transmit result, or a send that did not leave (held back
 * by the send gate, or failed on its link). Repeats cover what did not go (section 4).
 */
function recordOutcome(
  slice: SirensSlice,
  ctx: Context,
  ref: Message<"radioResult">["ref"],
  outcome: TxOutcome,
  sentGatewayMicros: number | undefined,
  requestCounter: number | undefined,
  resultCounter: number | undefined,
): Changing {
  const packet = slice.sent.get(ref);
  if (packet === undefined) return unchanged(slice);
  const sent = new Map(slice.sent);
  sent.delete(ref);
  return txRecord(ctx, {
    deviceId: packet.siren,
    type: packet.type,
    counter: packet.counter,
    path: packet.path,
    gatewayId: packet.gateway ?? null,
    requestCounter: requestCounter ?? null,
    resultCounter: resultCounter ?? null,
    rate: packet.rate ?? null,
    power: packet.power ?? null,
    outcome,
    gwSentUs: sentGatewayMicros ?? null,
    body: packet.body,
  }).map((record) => ({ slice: { ...slice, sent }, out: [record] }));
}

function route(slice: SirensSlice, message: Internal, ctx: Context): Changing {
  switch (message.kind) {
    case "boot":
      return onBoot(slice, ctx, message);
    case "deviceAdded":
      return onDeviceAdded(slice, ctx, message);
    case "deviceRemoved": {
      if (!slice.sirens.has(message.device)) return unchanged(slice);
      const sirens = new Map(slice.sirens);
      sirens.delete(message.device);
      return unchanged({ ...slice, sirens });
    }
    case "accepted":
      return message.role === Role.Siren ? onSirenPacket(slice, ctx, message) : unchanged(slice);
    case "rejected":
      return message.copy === undefined
        ? unchanged(slice)
        : unchanged(onHeardCopy(slice, ctx, message.copy));
    case "sirenIntent":
      return onIntent(slice, ctx, message);
    case "sirenSettingsRequest":
      return onSettingsRequest(slice, ctx, message);
    case "siteMove":
      return onSiteMove(slice, ctx, message);
    case "gatewayUp": {
      const next = { ...slice, gateways: new Set(slice.gateways).add(message.gateway) };
      // A siren waiting for a path after the start is asked to report (section 7, step 4).
      return each(next, [...next.sirens.keys()], (s, siren) => reportNowIfOwed(s, ctx, siren));
    }
    case "gatewayDown": {
      if (!slice.gateways.has(message.gateway)) return unchanged(slice);
      const gateways = new Set(slice.gateways);
      gateways.delete(message.gateway);
      return unchanged({ ...slice, gateways });
    }
    case "linkClosed": {
      const closed = [...slice.sirens].filter(([, entry]) => entry.paths.sockets.has(message.link));
      if (closed.length === 0) return unchanged(slice);
      const sirens = new Map(slice.sirens);
      for (const [siren, entry] of closed) {
        const sockets = new Map(entry.paths.sockets);
        sockets.delete(message.link);
        sirens.set(siren, { ...entry, paths: { ...entry.paths, sockets } });
      }
      return unchanged({ ...slice, sirens });
    }
    case "radioResult":
      return onRadioResult(slice, ctx, message);
    case "sendFailed":
      return recordOutcome(
        slice,
        ctx,
        message.ref,
        message.error === "notDurable" ? TxOutcome.HeldBack : TxOutcome.SendFailed,
        undefined,
        undefined,
        undefined,
      );
    case "commit":
      // A failed commit may have lost a resume point: every key's is written again (section 4).
      return message.outcome.kind === "failed"
        ? ok({ slice, out: resumePoints(slice) })
        : unchanged(slice);
    case "timer":
      return message.key.module === "sirens"
        ? onSirenTimer(slice, ctx, message.key)
        : unchanged(slice);
    default:
      return unchanged(slice);
  }
}

/** The sirens module's handler (section 2, module 12). */
export const handleSirens: Handler<"sirens"> = (slice, message, ctx) =>
  route(slice, message, ctx).map((changed) =>
    changed.slice === slice
      ? changed
      : { slice: withTimers(changed.slice, ctx.deps.rules), out: changed.out },
  );

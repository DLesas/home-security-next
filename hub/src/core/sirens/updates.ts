/**
 * What the sirens module sends a siren besides commands and settings (docs/m3-updates-design.md
 * sections 4, 5 and 7): the Update offers firmware decides, and the Key changes after a restore. The
 * siren's key is this module's (HD 2): firmware decides, this module seals.
 *
 * - **An Update offer** (0x83) is sealed as settings are: no binding, the next counter, which the
 *   siren takes only when strictly higher (§4). So it is one packet at a time with them (§7, step
 *   5): while a command or settings packet waits for its confirmation, the offer waits, a newer one
 *   replacing it, since a higher counter sent meanwhile would make the siren drop the repeats of the
 *   one in flight. It goes once, not repeated: firmware offers again when the siren next asks. On
 *   the siren's Wi-Fi when it has a recent socket, otherwise through the gateway that heard it best;
 *   an offer to fetch (1, or 6 forced) only on Wi-Fi, where the siren pulls from, and not at all
 *   without a socket.
 * - **A Key change** (0x84), at most one every 10 s ‡ per siren, goes on both paths, as a command
 *   does, but once: in answer to a packet under a key held at the backup (`oldKeyPacket`), and at
 *   the hub's start in place of "report now", as soon as a path is up (§7 "Hub restart", D141). A
 *   siren both of whose keys were held at the backup gets none at the start (which key to seal it
 *   under is not known until it is heard) and no "report now" either: its next report, within 30 s
 *   on Wi-Fi, draws it. `key_change_sent` names its counter.
 * - **The switch** (`key_changed`): the counter starts again at 1, written now with the new key; a
 *   command or settings packet still in flight was sealed under the old key and is dropped, settings
 *   to go again and a command left to the correction rule, which the switching report itself
 *   answers (section 8).
 */
import { ok, Result } from "neverthrow";
import {
  Direction,
  MaxPacketLength,
  type Message,
  type MessageOf,
  type MessageType,
  NO_BINDING,
  takeSendCounter,
  TransmitPriority,
  UpdateAction,
} from "@hsn/protocol";
import type { KeyUsed } from "../model/cipher.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId, LinkId, Seq } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { PacketPath, TxOutcome } from "../model/rows.ts";
import {
  afterSwitch,
  failingCommitWrites,
  keyChangeAllowed,
  keyChangesFromSnapshot,
  lastOldKey,
  makeKeyChange,
  recordedBody,
  sealKeyOf,
  switchedCounter,
  switchWrites,
  withKeyChange,
} from "../intake/view.ts";
import { deviceById } from "../registry/view.ts";
import { safeEncodeMessage } from "../util/protocol-safe.ts";
import {
  type Changing,
  decide,
  fault,
  fromProtocolResult,
  txRecord,
  unchanged,
  writeNow,
} from "./out.ts";
import { bestGateway, recentSockets, remember } from "./send.ts";
import { commandRateFor } from "./settings.ts";
import type { SirenEntry, SirensSlice } from "./state.ts";

type Offer = MessageOf<typeof MessageType.UpdateOffer>;

function withEntry(slice: SirensSlice, siren: DeviceId, entry: SirenEntry): SirensSlice {
  return { ...slice, sirens: new Map(slice.sirens).set(siren, entry) };
}

/** Where one packet goes: these sockets, and through this gateway. */
interface Route {
  readonly sockets: readonly LinkId[];
  readonly gateway: DeviceId | undefined;
}

/**
 * Seals `message` to the siren with its next counter, no binding, under `under`, and sends it once
 * on `route`: a `send` per socket, recorded as handed to the link, and a `radioOut` whose `tx` row
 * comes with its result (section 6). Returns the counter it used.
 */
function sendOnce(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  message: Message,
  under: KeyUsed,
  route: Route,
): Result<
  {
    readonly slice: SirensSlice;
    readonly out: readonly (Internal | Effect)[];
    readonly counter: number;
  },
  CoreFault
> {
  const entry = slice.sirens.get(siren);
  const address = deviceById(ctx.view, siren)?.address;
  if (entry === undefined || address === undefined) return ok({ slice, out: [], counter: 0 });
  const rules = ctx.deps.rules;
  return fromProtocolResult(ctx, takeSendCounter(entry.counter)).andThen((taken) =>
    ctx.deps.cipher
      .seal(siren, message, {
        direction: Direction.FromHub,
        address,
        counter: taken.counter,
        binding: NO_BINDING,
        maxLength: MaxPacketLength.Radio,
        ...(under === "next" ? { key: under } : {}),
      })
      .andThen((packet) => safeEncodeMessage(message).map((plain) => ({ packet, plain })))
      .mapErr((error) => fault(ctx, error))
      .andThen(({ packet, plain }) => {
        const body = recordedBody(message.type, plain.subarray(1));
        const base = { siren, type: message.type, counter: taken.counter, body, at: ctx.now.mono };
        let current = withEntry(slice, siren, { ...entry, counter: taken.state });
        const effects: (Internal | Effect)[] =
          taken.saveResumePoint === undefined
            ? [...failingCommitWrites(slice.keys, siren, taken.state)]
            : [
                writeNow({
                  table: "send_counters",
                  op: "upsert",
                  row: { deviceId: siren, resumePoint: taken.saveResumePoint },
                }),
              ];
        const records: Result<Internal, CoreFault>[] = [];
        for (const link of route.sockets) {
          const kept = remember(current, {
            ...base,
            path: PacketPath.Wifi,
            gateway: undefined,
            rate: undefined,
            power: undefined,
          });
          current = kept.slice;
          effects.push({
            kind: "send",
            link,
            bytes: packet,
            ref: kept.ref,
            counters: [{ device: siren, counter: taken.counter }],
          });
          records.push(
            txRecord(ctx, {
              deviceId: siren,
              type: message.type,
              counter: taken.counter,
              path: PacketPath.Wifi,
              gatewayId: null,
              requestCounter: null,
              resultCounter: null,
              rate: null,
              power: null,
              outcome: TxOutcome.HandedToLink,
              gwSentUs: null,
              body,
            }),
          );
        }
        if (route.gateway !== undefined) {
          const dataRate = commandRateFor(entry.history, entry.settings, entry.reported?.version);
          const powerDbm = rules.powers.sirenTxPowerDbm;
          const kept = remember(current, {
            ...base,
            path: PacketPath.Lora,
            gateway: route.gateway,
            rate: dataRate,
            power: powerDbm,
          });
          current = kept.slice;
          effects.push({
            kind: "radioOut",
            ref: kept.ref,
            device: siren,
            packet,
            counter: taken.counter,
            gateway: route.gateway,
            timing: { kind: "asap", latest: undefined },
            dataRate,
            powerDbm,
            // Not urgent: an update never takes the airtime kept back for siren commands (§6).
            priority: TransmitPriority.Normal,
            purpose: "sirenSettings",
          });
        }
        return Result.combine(records).map((recorded) => ({
          slice: current,
          out: [...effects, ...recorded],
          counter: taken.counter,
        }));
      }),
  );
}

/** The actions that fetch on the link the offer came by: Wi-Fi only, for a siren. */
function fetchesOnLink(offer: Offer): boolean {
  return offer.action === UpdateAction.Fetch || offer.action === UpdateAction.ForcedFetch;
}

/** Sends a siren's offer now: on its Wi-Fi, else (not a fetch) by LoRa; with no path, not at all. */
function sendOffer(slice: SirensSlice, ctx: Context, siren: DeviceId, offer: Offer): Changing {
  const entry = slice.sirens.get(siren);
  if (entry === undefined) return unchanged(slice);
  const rules = ctx.deps.rules.sirens;
  const now = ctx.now.mono;
  const sockets = recentSockets(entry, now, rules.wifiSocketWindowMs);
  const gateway =
    sockets.length > 0 || fetchesOnLink(offer)
      ? undefined
      : bestGateway(slice, entry, now, rules.bestGatewayWindowMs);
  const cleared = withEntry(slice, siren, { ...entry, offer: undefined });
  if (sockets.length === 0 && gateway === undefined) return unchanged(cleared);
  return sendOnce(cleared, ctx, siren, offer, sealKeyOf(slice.keys, siren), {
    sockets,
    gateway,
  }).map(({ slice: sent, out }) => ({ slice: sent, out }));
}

/** Firmware's Update offer for a siren: now, or after the packet in flight (above). */
export function onUpdateOffer(
  slice: SirensSlice,
  ctx: Context,
  message: Extract<Internal, { kind: "updateOffer" }>,
): Changing {
  const entry = slice.sirens.get(message.device);
  if (entry === undefined) return unchanged(slice);
  if (entry.inFlight !== undefined) {
    return unchanged(withEntry(slice, message.device, { ...entry, offer: message.offer }));
  }
  return sendOffer(slice, ctx, message.device, message.offer);
}

/** Every waiting offer whose siren has nothing in flight any more, sent now. */
export function sendWaitingOffers(slice: SirensSlice, ctx: Context): Changing {
  let result = unchanged(slice);
  for (const [siren, entry] of slice.sirens) {
    const offer = entry.offer;
    if (offer === undefined || entry.inFlight !== undefined) continue;
    result = result.andThen((done) =>
      sendOffer(done.slice, ctx, siren, offer).map((sent) => ({
        slice: sent.slice,
        out: [...done.out, ...sent.out],
      })),
    );
  }
  return result;
}

/**
 * A Key change to the siren, on `route`'s paths, when one may go (at most one every 10 s ‡), with
 * `key_change_sent`; `under` is the key the packet it answers came under.
 */
function sendKeyChange(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  under: KeyUsed,
  cause: Seq | undefined,
  route: Route,
): Changing {
  const change = slice.keys.entries.get(siren);
  if (change === undefined || !keyChangeAllowed(change, ctx.now.mono, ctx.deps.rules)) {
    return unchanged(slice);
  }
  if (route.sockets.length === 0 && route.gateway === undefined) return unchanged(slice);
  return makeKeyChange(ctx, siren, change, under).andThen((made) =>
    sendOnce(slice, ctx, siren, made.message, made.sealUnder, route).andThen((sent) =>
      decide(ctx, "routine", "key_change_sent", siren, cause, sent.counter).map((decision) => {
        const owed = new Set(sent.slice.keyChangeOwed);
        owed.delete(siren);
        return {
          slice: {
            ...sent.slice,
            keys: withKeyChange(sent.slice.keys, siren, made.entry),
            keyChangeOwed: owed,
          },
          out: [...made.writes, ...sent.out, decision],
        };
      }),
    ),
  );
}

/** The siren's paths for a packet now: its recent sockets, and its best gateway. */
function bothPaths(slice: SirensSlice, ctx: Context, entry: SirenEntry): Route {
  const rules = ctx.deps.rules.sirens;
  const now = ctx.now.mono;
  return {
    sockets: recentSockets(entry, now, rules.wifiSocketWindowMs),
    gateway: bestGateway(slice, entry, now, rules.bestGatewayWindowMs),
  };
}

/** A siren's packet under a key held at the backup (D141): a Key change on both paths. */
export function onOldKeyPacket(
  slice: SirensSlice,
  ctx: Context,
  message: Extract<Internal, { kind: "oldKeyPacket" }>,
): Changing {
  const entry = slice.sirens.get(message.device);
  if (entry === undefined) return unchanged(slice);
  const paths = bothPaths(slice, ctx, entry);
  const arrival = message.arrival;
  // The way it came is a way back, though the packet keeps no path alive (it is not acted on).
  const route: Route =
    arrival.path === "lora"
      ? { sockets: paths.sockets, gateway: arrival.gateway }
      : arrival.path === "wifi"
        ? { sockets: [...new Set([...paths.sockets, arrival.link])], gateway: paths.gateway }
        : paths;
  const under = lastOldKey(ctx.view, message.device) ?? "current";
  return sendKeyChange(slice, ctx, message.device, under, message.record, route);
}

/** At the start, a path came up (`gatewayUp`): each siren owed a Key change gets it now. */
export function keyChangesOwed(slice: SirensSlice, ctx: Context): Changing {
  let result = unchanged(slice);
  for (const siren of slice.keyChangeOwed) {
    result = result.andThen((done) => {
      const entry = done.slice.sirens.get(siren);
      if (entry === undefined) return ok(done);
      return sendKeyChange(
        done.slice,
        ctx,
        siren,
        "current",
        undefined,
        bothPaths(done.slice, ctx, entry),
      ).map((sent) => ({ slice: sent.slice, out: [...done.out, ...sent.out] }));
    });
  }
  return result;
}

/**
 * The key changes found at the boot: the sirens marked are owed no "report now", and those whose
 * key was alone at the backup are owed a Key change in its place (above).
 */
export function keyChangesAtBoot(slice: SirensSlice, snapshot: DurableSnapshot): SirensSlice {
  const keys = keyChangesFromSnapshot(snapshot, (device) => slice.sirens.has(device));
  if (keys.entries.size === 0) return { ...slice, keys, keyChangeOwed: new Set() };
  const sirens = new Map(slice.sirens);
  const owed = new Set<DeviceId>();
  for (const [siren, change] of keys.entries) {
    const entry = sirens.get(siren);
    if (entry !== undefined) sirens.set(siren, { ...entry, reportNowWanted: false });
    if (!change.bothHeld) owed.add(siren);
  }
  return { ...slice, sirens, keys, keyChangeOwed: owed };
}

/** The siren's first packet under its new key (`key_changed`): key and counter start again. */
export function onKeyChanged(slice: SirensSlice, ctx: Context, siren: DeviceId): Changing {
  const entry = slice.sirens.get(siren);
  if (entry === undefined) return unchanged(slice);
  return switchWrites(ctx, siren, slice.keys.entries.get(siren)).map((writes) => {
    const flight = entry.inFlight;
    const next: SirenEntry = {
      ...entry,
      counter: switchedCounter(ctx.deps.rules),
      inFlight: undefined,
      settingsWanted: entry.settingsWanted || flight?.purpose === "sirenSettings",
      moveSettings: entry.moveSettings || flight?.moveSettings === true,
    };
    const owed = new Set(slice.keyChangeOwed);
    owed.delete(siren);
    return {
      slice: {
        ...withEntry(slice, siren, next),
        keys: afterSwitch(slice.keys, siren),
        keyChangeOwed: owed,
      },
      out: writes,
    };
  });
}

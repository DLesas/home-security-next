/**
 * Gateway sessions (hub-design.md section 8, "Gateway sessions"; section 7, "Gateway
 * connection"; protocol.md §4, §7):
 *
 * - A hello must carry a counter above any the hub has accepted from that gateway; one at or
 *   below it is a replay, counted as `tooOld`. Accepting one writes that counter now.
 * - The hub answers with a welcome bound to the hello's random and carrying its own, 8 bytes of
 *   the input's entropy, then with the settings, bound to the new session.
 * - A live session is kept for everything until the new one is proven by its first
 *   session-bound packet; the old link is then closed. A gateway sends Started only once per
 *   start-up, so one that reconnects (after a Wi-Fi drop or a hub restart) proves its session
 *   with its first status or forwarded packet: while another session is live, an unproven one
 *   is closed after the gateway's status interval and 10 s ‡; with none live, it is kept until
 *   it is proven or its link closes, and several may wait; the first proven wins.
 */
import { err, Result } from "neverthrow";
import {
  CONNECTION_RANDOM_LENGTH,
  type MessageOf,
  MessageType,
  type PacketHeader,
  Role,
  type StartedImage,
} from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { LinkKind } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import { type DeviceId, type LinkId, type SendRef, moduleSendRef } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { TxOutcome } from "../model/rows.ts";
import { monoAfterMs } from "../model/time.ts";

const MS_PER_SECOND = 1000;
import { rejection } from "../links/view.ts";
import { asFault, clearTimer, done, type Outcome, setTimer, then, withGateway } from "./common.ts";
import { EMPTY_CLOCK } from "./clock.ts";
import { deviceStateWrite } from "./persist.ts";
import { decision, received, sent } from "./records.ts";
import { sealToGateway } from "./seal.ts";
import { settingsMessage } from "./settings.ts";
import { resolveRequests } from "./transmit.ts";
import type { GatewayEntry, GatewaysSlice, Session } from "./state.ts";
import { safeSessionBinding, safeWelcomeBinding } from "../util/protocol-safe.ts";

type Hello = MessageOf<typeof MessageType.Hello>;
type Accepted = Extract<Internal, { readonly kind: "accepted" }>;

/** The ref of the next send this module makes for itself, and the slice that has used it. */
function ownRef(slice: GatewaysSlice): {
  readonly slice: GatewaysSlice;
  readonly ref: SendRef;
} {
  return {
    slice: { ...slice, nextOwnRef: slice.nextOwnRef + 1 },
    ref: moduleSendRef("gateways", slice.nextOwnRef),
  };
}

/**
 * A changed version sent at once (section 8, "Gateway sessions": on every change) on every
 * session the gateway may be using: the live one, and each welcomed but not yet proven. A
 * gateway that has sent only its hello is on one of those; one with no session gets the version
 * with its next welcome, and a status naming another version brings it again.
 */
export function sendSettingsNow(slice: GatewaysSlice, device: DeviceId, ctx: Context): Outcome {
  const entry = slice.gateways.get(device);
  if (entry === undefined) return done(slice);
  const live = entry.live;
  const sessions = [
    ...(live === undefined ? [] : [live]),
    ...entry.candidates.filter((c) => c.link !== live?.link),
  ];
  return sessions.reduce<Outcome>(
    (result, session) =>
      then(result, (s) => {
        const current = s.gateways.get(device);
        return current === undefined ? done(s) : sendSettings(s, current, session, ctx);
      }),
    done(slice),
  );
}

/**
 * Seals the gateway's settings on `session` and sends them, with their record and decision
 * (section 8: after every welcome, after a status naming another version, on every change).
 */
export function sendSettings(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  session: Session,
  ctx: Context,
): Outcome {
  const message = settingsMessage(entry.config, slice.site);
  return sealToGateway(ctx, entry, message, session.binding, slice.keys).andThen((sealed) => {
    const { slice: refd, ref } = ownRef(withGateway(slice, sealed.entry));
    const send: Effect = {
      kind: "send",
      link: session.link,
      bytes: sealed.bytes,
      ref,
      counters: [{ device: entry.device, counter: sealed.counter }],
    };
    return Result.combine([
      sent(ctx, entry.device, message, sealed.counter, session.linkKind, TxOutcome.HandedToLink),
      decision(ctx, {
        kind: "gateway_settings",
        device: entry.device,
        cause: null,
        value: entry.config.version,
        detail: null,
        durability: "routine",
      }),
    ]).andThen((records) => done(refd, [...sealed.writes, send, ...records]));
  });
}

/**
 * The `accepted` message for one of the gateway's own packets (hello, Started, status,
 * interference, log entries), so the modules that follow a device's packets (registry's
 * firmware and first contact, clock's downtime from a gateway's uptime) see gateways too. Its
 * session check stands in for the replay window, so it is always the newest.
 */
export function acceptedMessage(
  message: Accepted["message"],
  entry: GatewayEntry,
  link: LinkId,
  kind: LinkKind,
  record: Accepted["record"],
  counter: number,
  startedImage?: StartedImage,
): Internal {
  return {
    kind: "accepted",
    device: entry.device,
    role: Role.Gateway,
    counter,
    message,
    arrival: kind === "usb" ? { path: "usb", link } : { path: "wifi", link },
    record,
    newest: true,
    // A Started's M3 fields, for firmware (m3-updates-design section 5), as intake gives a device's.
    ...(startedImage === undefined ? {} : { startedImage }),
  };
}

/** A hello (§6, §7): refused as `tooOld`, or a new unproven session answered at once. */
export function handleHello(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  link: LinkId,
  kind: LinkKind,
  header: PacketHeader,
  hello: Hello,
  bytes: Uint8Array,
  ctx: Context,
): Outcome {
  if (header.counter <= entry.highestAccepted) {
    return done(slice, [rejection({ device: entry.device }, "tooOld", bytes, header.address)]);
  }
  const random = ctx.entropy.take(CONNECTION_RANDOM_LENGTH);
  if (random.isErr()) return err(random.error);
  const hubRandom = random.value;
  const bindings = Result.combine([
    safeWelcomeBinding(hello.gatewayRandom),
    safeSessionBinding(hello.gatewayRandom, hubRandom),
  ]).mapErr((error) => asFault(ctx, error));
  if (bindings.isErr()) return err(bindings.error);
  const [welcomeBinding, sessionValue] = bindings.value;
  const session: Session = {
    link,
    linkKind: kind,
    gatewayRandom: hello.gatewayRandom,
    hubRandom,
    binding: sessionValue,
    lastReceived: header.counter,
    openedAt: ctx.now.mono,
    clock: EMPTY_CLOCK,
  };
  const heard: GatewayEntry = {
    ...entry,
    highestAccepted: header.counter,
    candidates: [...entry.candidates.filter((c) => c.link !== link), session],
  };
  const welcome = { type: MessageType.Welcome, hubRandom } as const;
  return sealToGateway(ctx, heard, welcome, welcomeBinding, slice.keys).andThen((sealed) => {
    const { slice: refd, ref } = ownRef(withGateway(slice, sealed.entry));
    const timed = setTimer(refd, {
      at: monoAfterMs(
        ctx.now.mono,
        entry.config.statusIntervalS * MS_PER_SECOND + ctx.deps.rules.gateways.unprovenSessionMs,
      ),
      key: { module: "gateways", kind: "unprovenSession", link },
    });
    const hello_rx = received(ctx, entry.device, hello, header.counter, kind, "event");
    if (hello_rx.isErr()) return err(hello_rx.error);
    const rx = hello_rx.value;
    const made = Result.combine([
      sent(ctx, entry.device, welcome, sealed.counter, kind, TxOutcome.HandedToLink),
      decision(ctx, {
        kind: "gateway_welcomed",
        device: entry.device,
        cause: rx.seq,
        value: header.counter,
        detail: null,
        durability: "routine",
      }),
    ]);
    if (made.isErr()) return err(made.error);
    const welcomed: readonly (Internal | Effect)[] = [
      // The hello's counter is the gateway's highest: now, so a power cut cannot lose it (§4).
      ...deviceStateWrite(timed, sealed.entry, "now"),
      ...sealed.writes,
      {
        kind: "send",
        link,
        bytes: sealed.bytes,
        ref,
        counters: [{ device: entry.device, counter: sealed.counter }],
      },
      rx.record,
      acceptedMessage(hello, sealed.entry, link, kind, rx.seq, header.counter),
      ...made.value,
    ];
    return sendSettings(timed, sealed.entry, session, ctx).map((settings) => ({
      slice: settings.slice,
      out: [...welcomed, ...settings.out],
    }));
  });
}

/** Closes `link` unless a live session still uses it (section 8). */
function closeUnlessLive(slice: GatewaysSlice, link: LinkId, reason: string): readonly Effect[] {
  const used = [...slice.gateways.values()].some((g) => g.live?.link === link);
  return used ? [] : [{ kind: "close", link, reason }];
}

/**
 * The candidate on `session.link` has sent its first session-bound packet: it becomes the
 * session; the requests in flight on the old one get "no result", the old link and the other
 * candidates' links are closed, and `gatewayUp` lets the sirens waiting for a path send.
 */
export function prove(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  session: Session,
): {
  readonly slice: GatewaysSlice;
  readonly entry: GatewayEntry;
  readonly out: readonly (Internal | Effect)[];
} {
  const old = entry.live;
  const resolved = resolveRequests(slice, entry, () => true, TxOutcome.NoResult);
  const others = entry.candidates.filter((c) => c.link !== session.link);
  const proven: GatewayEntry = { ...resolved.entry, live: session, candidates: [] };
  let next = withGateway(resolved.slice, proven);
  for (const candidate of entry.candidates) {
    next = clearTimer(next, { module: "gateways", kind: "unprovenSession", link: candidate.link });
  }
  const closes: Effect[] = [];
  const stale = [
    ...(old !== undefined && old.link !== session.link ? [old.link] : []),
    ...others.map((c) => c.link),
  ];
  for (const link of new Set(stale)) {
    if (link !== session.link)
      closes.push(...closeUnlessLive(next, link, "gateway session replaced"));
  }
  return {
    slice: next,
    entry: proven,
    out: [
      ...resolved.out,
      ...closes,
      { kind: "gatewayUp", gateway: entry.device, link: session.link },
    ],
  };
}

/** A link closed (section 3): its sessions end, their requests get "no result". */
export function handleLinkClosed(slice: GatewaysSlice, link: LinkId): Outcome {
  let next = clearTimer(slice, { module: "gateways", kind: "unprovenSession", link });
  const out: Internal[] = [];
  for (const entry of slice.gateways.values()) {
    const live = entry.live?.link === link;
    const candidates = entry.candidates.filter((c) => c.link !== link);
    if (!live && candidates.length === entry.candidates.length) continue;
    let current: GatewayEntry = { ...entry, candidates };
    if (live) {
      const resolved = resolveRequests(next, current, () => true, TxOutcome.NoResult);
      out.push(...resolved.out, { kind: "gatewayDown", gateway: entry.device });
      next = resolved.slice;
      current = { ...resolved.entry, live: undefined };
    }
    next = withGateway(next, current);
  }
  return done(next, out);
}

/** `gateway_link_closed`'s value: why the hub closed a gateway's link (section 6). */
export const LINK_CLOSED_REPLACED = 0;
export const LINK_CLOSED_NOT_PROVEN = 1;

/**
 * A new session not proven while another is live, by the status interval and 10 s ‡ (section
 * 8): it is dropped and its link closed, and the close recorded.
 */
export function handleUnproven(slice: GatewaysSlice, link: LinkId, ctx: Context): Outcome {
  let next = clearTimer(slice, { module: "gateways", kind: "unprovenSession", link });
  let dropped: GatewayEntry | undefined;
  for (const entry of slice.gateways.values()) {
    // With no live session nothing competes: the candidate waits for its first status or
    // forwarded packet, which is all a reconnected gateway sends (no Started, FD 7).
    if (entry.live === undefined) continue;
    const candidates = entry.candidates.filter((c) => c.link !== link);
    if (candidates.length === entry.candidates.length) continue;
    dropped = entry;
    next = withGateway(next, { ...entry, candidates });
  }
  if (dropped === undefined) return done(next);
  const closes = closeUnlessLive(next, link, "gateway session not proven");
  if (closes.length === 0) return done(next);
  return decision(ctx, {
    kind: "gateway_link_closed",
    device: dropped.device,
    cause: null,
    value: LINK_CLOSED_NOT_PROVEN,
    detail: null,
    durability: "routine",
  }).andThen((record) => done(next, [...closes, record]));
}

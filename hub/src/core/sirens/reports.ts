/**
 * Packets from a siren (hub-design.md section 8, "What the siren should do, and commands",
 * "Silence" and "Accepting a device packet"; §7 "Siren command" and "Siren reports"; D52, D73,
 * D80). Every accepted packet keeps its path alive. A report confirms the packet in flight when it
 * names that packet's counter in its low 16 bits, whatever its own counter. Only the newest report
 * (the highest counter accepted) sets what the siren reported, and only it, with nothing in
 * flight, is answered: by the correction rule, else by the settings when its version is not the
 * hub's. A LoRa report with reason 3 loses the Wi-Fi path at once.
 */
import { ok } from "neverthrow";
import {
  MessageType,
  type MessageOf,
  SirenAction,
  SirenReportReason,
  SirenState,
  UpdateStage,
} from "@hsn/protocol";
import { sirenCorrectable, sirenShould } from "../alarm/view.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { Arrival, DomainMessage, HeardCopy } from "../model/messages.ts";
import { PacketPath } from "../model/rows.ts";
import { MICROS_PER_MILLISECOND, MILLISECONDS_PER_SECOND } from "../model/time.ts";
import { after, type Changing, decide, secondsUntil, then, unchanged } from "./out.ts";
import { bestGateway, command, counterLow, recentSockets, sendSettings } from "./send.ts";
import type { Commanded, InFlight, SirenEntry, SirenPaths, SirensSlice } from "./state.ts";

type Accepted = Extract<DomainMessage, { readonly kind: "accepted" }>;
type Report = MessageOf<typeof MessageType.SirenReport>;

function withEntry(slice: SirensSlice, siren: DeviceId, entry: SirenEntry): SirensSlice {
  return { ...slice, sirens: new Map(slice.sirens).set(siren, entry) };
}

/** The path a packet came by, as `siren_confirmed`'s value (section 6, `path`). */
function pathCode(arrival: Arrival): number {
  switch (arrival.path) {
    case "lora":
      return PacketPath.Lora;
    case "wifi":
      return PacketPath.Wifi;
    case "usb":
      return PacketPath.Usb;
  }
}

/** A packet on a path: the path is alive, its loss and the siren's silence cleared (section 8). */
function seenOn(paths: SirenPaths, arrival: Arrival, ctx: Context): SirenPaths {
  const now = ctx.now.mono;
  const rules = ctx.deps.rules.sirens;
  if (arrival.path === "lora") {
    const heard = [
      ...paths.heard.filter((copy) => after(copy.at, rules.bestGatewayWindowMs) >= now),
      { gateway: arrival.gateway, snrQuarterDb: arrival.snrQuarterDb, at: now },
    ];
    return { ...paths, loraAt: now, loraLost: false, heard, silent: false };
  }
  if (arrival.path === "wifi") {
    const sockets = new Map(
      [...paths.sockets].filter(([, at]) => after(at, rules.wifiSocketWindowMs) >= now),
    ).set(arrival.link, now);
    return { ...paths, wifiAt: now, wifiLost: false, sockets, silent: false };
  }
  return paths;
}

/** What a confirmed command leaves the siren doing (SR5: sounding ends by itself). */
/**
 * A duplicate copy of a siren's packet through another gateway: it still counts towards the
 * siren's best gateway (section 8), though intake did not accept it.
 */
export function onHeardCopy(slice: SirensSlice, ctx: Context, copy: HeardCopy): SirensSlice {
  const entry = slice.sirens.get(copy.device);
  if (entry === undefined) return slice;
  const now = ctx.now.mono;
  const window = ctx.deps.rules.sirens.bestGatewayWindowMs;
  const heard = [
    ...entry.paths.heard.filter((earlier) => after(earlier.at, window) >= now),
    { gateway: copy.gateway, snrQuarterDb: copy.snrQuarterDb, at: copy.at },
  ];
  return withEntry(slice, copy.device, { ...entry, paths: { ...entry.paths, heard } });
}

function commandedBy(flight: InFlight, previous: Commanded | undefined): Commanded | undefined {
  const until = after(flight.since, flight.seconds * MILLISECONDS_PER_SECOND);
  switch (flight.action) {
    case SirenAction.Off:
      return { kind: "off" };
    case SirenAction.SoundAlarm:
      return { kind: "sound", until };
    case SirenAction.Test:
      return { kind: "test", until };
    default:
      return previous;
  }
}

/** Any accepted packet from a siren this module knows. */
export function onSirenPacket(slice: SirensSlice, ctx: Context, accepted: Accepted): Changing {
  const siren = accepted.device;
  const entry = slice.sirens.get(siren);
  if (entry === undefined) return unchanged(slice);
  const { message, arrival } = accepted;
  const lostWifi =
    accepted.newest &&
    arrival.path === "lora" &&
    message.type === MessageType.SirenReport &&
    message.reason === SirenReportReason.WifiReportFailed &&
    !entry.paths.wifiLost;
  const paths = seenOn(entry.paths, arrival, ctx);
  const trial = message.type === MessageType.Started && accepted.startedImage?.flags.onTrial;
  const trialEnded =
    message.type === MessageType.Started ||
    (message.type === MessageType.UpdateStatus && message.stage === UpdateStage.Confirmed);
  const seen: SirenEntry = {
    ...entry,
    paths: lostWifi ? { ...paths, wifiLost: true } : paths,
    // A siren that started has forgotten nothing it was told, but its sounding may have stopped.
    commanded: message.type === MessageType.Started ? undefined : entry.commanded,
    reportNowWanted: trial
      ? "trial"
      : trialEnded && entry.reportNowWanted === "trial"
        ? false
        : entry.reportNowWanted,
  };
  const marked = withEntry(slice, siren, seen);
  const recorded = lostWifi
    ? decide(ctx, "now", "siren_wifi_lost", siren, accepted.record).map((m) => ({
        slice: marked,
        out: [m],
      }))
    : unchanged(marked);
  if (message.type === MessageType.SirenReport) {
    return then(recorded, (current) => onReport(current, ctx, accepted, message));
  }
  // A siren heard on Wi-Fi before it has reported since the start is asked to (section 7).
  return then(recorded, (current) => reportNowIfOwed(current, ctx, siren));
}

/**
 * "Report now" goes once a path is available and nothing is in flight. A trial image needs the
 * command even if it has already sent a report (m3-updates-design section 2).
 */
export function reportNowIfOwed(slice: SirensSlice, ctx: Context, siren: DeviceId): Changing {
  const entry = slice.sirens.get(siren);
  if (!entry?.reportNowWanted || entry.inFlight !== undefined) return unchanged(slice);
  if (entry.reportNowWanted === "trial") {
    const now = ctx.now.mono;
    const rules = ctx.deps.rules.sirens;
    if (
      recentSockets(entry, now, rules.wifiSocketWindowMs).length === 0 &&
      bestGateway(slice, entry, now, rules.bestGatewayWindowMs) === undefined
    ) {
      return unchanged(slice);
    }
    slice = withEntry(slice, siren, { ...entry, reportNowWanted: false });
  }
  return command(slice, ctx, siren, SirenAction.ReportNow, 0, undefined);
}

function onReport(slice: SirensSlice, ctx: Context, accepted: Accepted, report: Report): Changing {
  const siren = accepted.device;
  const entry = slice.sirens.get(siren);
  if (entry === undefined) return unchanged(slice);
  const flight = entry.inFlight;
  const confirmed =
    flight !== undefined && report.lastCommandCounterLow === counterLow(flight.counter);
  const now = ctx.now.mono;
  const graceOver =
    entry.paths.graceUntil !== undefined && report.settingsVersion === entry.settings.version;
  const next: SirenEntry = {
    ...entry,
    inFlight: confirmed ? undefined : flight,
    commanded: confirmed ? commandedBy(flight, entry.commanded) : entry.commanded,
    reported: accepted.newest
      ? {
          state: report.state,
          secondsLeft: report.soundingSecondsLeft,
          version: report.settingsVersion,
          at: now,
        }
      : entry.reported,
    reportNowWanted:
      accepted.newest && entry.reportNowWanted === "boot" ? false : entry.reportNowWanted,
    paths: graceOver ? { ...entry.paths, graceUntil: undefined } : entry.paths,
  };
  const updated = withEntry(slice, siren, next);
  const confirmation = confirmed
    ? decide(
        ctx,
        "routine",
        "siren_confirmed",
        siren,
        accepted.record,
        pathCode(accepted.arrival),
      ).map((m) => ({ slice: updated, out: [m] }))
    : unchanged(updated);
  if (accepted.newest) {
    return then(
      then(confirmation, (current) => answerReport(current, ctx, siren, accepted)),
      (current) => reportNowIfOwed(current, ctx, siren),
    );
  }
  // An older copy can release waiting settings or a trial nudge, but cannot correct the output.
  if (confirmed && next.settingsWanted) {
    return then(confirmation, (current) => sendSettings(current, ctx, siren, next.moveSettings));
  }
  return confirmed && next.reportNowWanted === "trial"
    ? then(confirmation, (current) => reportNowIfOwed(current, ctx, siren))
    : confirmation;
}

/**
 * With nothing in flight, the newest report is answered (section 8, "Correcting a siren"): a
 * siren that should sound with at least 10 s ‡ left and reports off is sounded for what is left; one
 * that should be off and reports sounding for an alarm is commanded off; a test the hub does not
 * expect is left to end. Failing that, settings when its version is not the hub's, or when they
 * waited for a command.
 */
function answerReport(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  accepted: Accepted,
): Changing {
  const entry = slice.sirens.get(siren);
  const reported = entry?.reported;
  if (entry === undefined || reported === undefined || entry.inFlight !== undefined) {
    return unchanged(slice);
  }
  const now = ctx.now.mono;
  const should = sirenShould(ctx.view, siren, now);
  const minLeft = ctx.deps.rules.sirens.correctionMinLeftMs * MICROS_PER_MILLISECOND;
  if (sirenCorrectable(ctx.view, siren)) {
    if (
      should.kind === "sound" &&
      reported.state === SirenState.Off &&
      should.until - now >= minLeft
    ) {
      return command(
        slice,
        ctx,
        siren,
        SirenAction.SoundAlarm,
        secondsUntil(now, should.until),
        accepted.record,
      );
    }
    if (should.kind === "off" && reported.state === SirenState.SoundingAlarm) {
      return command(slice, ctx, siren, SirenAction.Off, 0, accepted.record);
    }
  }
  if (entry.settingsWanted || reported.version !== entry.settings.version) {
    return sendSettings(slice, ctx, siren, entry.moveSettings);
  }
  return ok({ slice, out: [] });
}

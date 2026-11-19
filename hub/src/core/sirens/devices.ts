/**
 * The sirens this module knows and their settings (hub-design.md sections 5, 6, 7 "Hub restart",
 * 8 and 9; D80, D115): restored at boot, added with version 1, a settings change from `hsn siren
 * set`, and a site switch's new channel and rate. Every settings version is written now with the
 * change, before any packet carries it (section 5).
 */
import { ok, Result } from "neverthrow";
import { newSendCounter, ResumeStep, Role, SiteChannel } from "@hsn/protocol";
import { deviceById } from "../registry/view.ts";
import { siteRate, siteRow } from "../site/view.ts";
import type { HubEvent } from "../model/events.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { DomainMessage } from "../model/messages.ts";
import { DeviceState, DeviceUpdateState } from "../model/rows.ts";
import type { SirenSettings } from "../model/settings.ts";
import type { Mono } from "../model/time.ts";
import { safeResumeSendCounter } from "../util/protocol-safe.ts";
import { after, type Changing, each, fault, type Out, then, unchanged, writeNow } from "./out.ts";
import { sendSettings } from "./send.ts";
import {
  configRow,
  decodeHistory,
  firstSettings,
  nextVersion,
  paceMs,
  settingsOfRow,
  switchedSettings,
  withVersion,
} from "./settings.ts";
import type { SirenEntry, SirenPaths, SirensSlice, SiteRadio } from "./state.ts";

type Boot = Extract<HubEvent, { readonly kind: "boot" }>;
type Message<K extends DomainMessage["kind"]> = Extract<DomainMessage, { readonly kind: K }>;

/** Both paths as at a start: alive from now, nothing heard yet (section 8, silence counts from the start). */
function freshPaths(now: Mono): SirenPaths {
  return {
    wifiAt: now,
    wifiLost: false,
    sockets: new Map(),
    loraAt: now,
    loraLost: false,
    heard: [],
    silent: false,
    graceUntil: undefined,
  };
}

/**
 * The site's channel and sending rate now, from the site module's view (section 8, D115): the
 * site module runs before this one, so a switch or a `site set` of this step is already in it.
 */
export function siteRadioNow(ctx: Context): SiteRadio {
  return {
    channel: siteRow(ctx.view).channel ?? SiteChannel.Mhz868_3,
    rate: siteRate(ctx.view, ctx.deps.rules),
  };
}

/** An entry for a siren with these settings. */
function entryFor(
  ctx: Context,
  counter: SirenEntry["counter"],
  settings: SirenSettings,
  history: SirenEntry["history"],
  reportNowWanted: SirenEntry["reportNowWanted"],
): Result<SirenEntry, CoreFault> {
  return paceMs(ctx, settings).map((pace) => ({
    counter,
    settings,
    history,
    paceMs: pace,
    reported: undefined,
    commanded: undefined,
    inFlight: undefined,
    settingsWanted: false,
    moveSettings: false,
    reportNowWanted,
    paths: freshPaths(ctx.now.mono),
  }));
}

/**
 * The boot event: every paired siren with its settings and the hub's counter resumed from its
 * saved resume point (section 4). Each is owed "report now" within 120 s ‡ of the start, as its
 * path appears (section 7, "Hub restart"). A recorded trial still needs a command after that
 * window. Commands in flight, paths and reports start afresh (section 5: memory only).
 */
export function onBoot(slice: SirensSlice, ctx: Context, event: Boot): Changing {
  const { snapshot } = event;
  const site = siteRadioNow(ctx);
  const configs = new Map(snapshot.sirenConfig.map((row) => [row.deviceId, row]));
  const resumes = new Map(snapshot.sendCounters.map((row) => [row.deviceId, row.resumePoint]));
  const trials = new Set(
    snapshot.m3m4?.deviceUpdates
      .filter((row) => row.state === DeviceUpdateState.OnTrial)
      .map((row) => row.deviceId),
  );
  const sirens = snapshot.devices.filter(
    (device) => device.role === Role.Siren && device.state !== DeviceState.Removed,
  );
  const entries = sirens.map((device) => {
    const row = configs.get(device.id);
    const settings = row === undefined ? firstSettings(site, ctx.deps.rules) : settingsOfRow(row);
    const history =
      row === undefined ? withVersion([], settings) : decodeHistory(row.versionHistory, settings);
    const resume = resumes.get(device.id);
    // Pairing writes a resume point of 1,024 (section 9); a siren without one has used no counter.
    const counter =
      resume === undefined
        ? ok(newSendCounter(ResumeStep.Hub))
        : safeResumeSendCounter(ResumeStep.Hub, resume).mapErr((error) => fault(ctx, error));
    return counter
      .andThen((c) => entryFor(ctx, c, settings, history, trials.has(device.id) ? "trial" : "boot"))
      .map((entry) => [device.id, entry, row === undefined] as const);
  });
  return Result.combine(entries).map((restored) => ({
    slice: {
      ...slice,
      sirens: new Map(restored.map(([id, entry]) => [id, entry])),
      gateways: new Set(),
      reportNowUntil:
        restored.length === 0
          ? undefined
          : after(ctx.now.mono, ctx.deps.rules.sirens.reportNowWithinMs),
      sent: new Map(),
    },
    out: restored.filter(([, , missing]) => missing).map(([id, entry]) => configWrite(id, entry)),
  }));
}

function configWrite(siren: DeviceId, entry: SirenEntry): Out[number] {
  return writeNow({
    table: "siren_config",
    op: "upsert",
    row: configRow(siren, entry.settings, entry.history),
  });
}

/** A siren is being added: version 1 of its settings on the site's channel and rate (section 9). */
export function onDeviceAdded(
  slice: SirensSlice,
  ctx: Context,
  added: Message<"deviceAdded">,
): Changing {
  if (added.role !== Role.Siren) return unchanged(slice);
  // A siren added again (its owner reset it) starts above its last version (hub-design section 9),
  // whether its entry was kept from the start or it left this run.
  const last =
    slice.sirens.get(added.device)?.settings.version ?? slice.retiredVersions.get(added.device);
  const first = firstSettings(siteRadioNow(ctx), ctx.deps.rules);
  const settings = last === undefined ? first : { ...first, version: nextVersion(last) };
  return entryFor(
    ctx,
    newSendCounter(ResumeStep.Hub),
    settings,
    withVersion([], settings),
    false,
  ).map((entry) => ({
    slice: { ...slice, sirens: new Map(slice.sirens).set(added.device, entry) },
    out: [configWrite(added.device, entry)],
  }));
}

/** New settings for one siren: a new version, written now, then sent when nothing is in flight. */
function changeSettings(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  settings: SirenSettings,
  moveSettings: boolean,
): Changing {
  const entry = slice.sirens.get(siren);
  if (entry === undefined) return unchanged(slice);
  const history = withVersion(entry.history, settings);
  return paceMs(ctx, settings).andThen((pace) => {
    const graceUntil = moveSettings
      ? after(ctx.now.mono, ctx.deps.rules.siteMove.silenceGraceIntervals * pace)
      : entry.paths.graceUntil;
    const next: SirenEntry = {
      ...entry,
      settings,
      history,
      paceMs: pace,
      paths: { ...entry.paths, graceUntil },
    };
    const placed = { ...slice, sirens: new Map(slice.sirens).set(siren, next) };
    return then(ok({ slice: placed, out: [configWrite(siren, next)] }), (current) =>
      sendSettings(current, ctx, siren, moveSettings),
    );
  });
}

/** `hsn siren set <name> max=<s>` (section 9): a new version with the longest sound, answered. */
export function onSettingsRequest(
  slice: SirensSlice,
  ctx: Context,
  request: Message<"sirenSettingsRequest">,
): Changing {
  const entry = slice.sirens.get(request.siren);
  if (entry === undefined) {
    return ok({
      slice,
      out: [
        {
          kind: "answer",
          request: request.request,
          reply: { ok: false, error: { code: "unknownDevice", message: "not a siren" } },
        },
      ],
    });
  }
  const settings: SirenSettings = {
    ...entry.settings,
    version: nextVersion(entry.settings.version),
    maxSoundS: request.maxSoundS,
  };
  return then(changeSettings(slice, ctx, request.siren, settings, false), (current) =>
    ok({
      slice: current,
      out: [
        {
          kind: "answer",
          request: request.request,
          reply: {
            ok: true,
            result: {
              kind: "sirenSet",
              name: deviceById(ctx.view, request.siren)?.name ?? "",
              version: settings.version,
            },
          },
        },
      ],
    }),
  );
}

/**
 * A site move switched (section 8, D115): every siren gets a version with the new channel and
 * sending rate, written now in the switch's step, then sent after the gateways' settings (the
 * gateways module runs first). Its LoRa path and silence rules wait 4 of its paces † or until it
 * confirms. A siren already holding the target's settings is left alone, so a switch announced
 * again after a restart does not bump them twice.
 */
export function onSiteMove(slice: SirensSlice, ctx: Context, move: Message<"siteMove">): Changing {
  if (move.stage !== "switched") return unchanged(slice);
  // The move names its target; a field that stays is the site's as it is.
  const now = siteRadioNow(ctx);
  const site: SiteRadio = { channel: move.channel ?? now.channel, rate: move.rate ?? now.rate };
  const moving = [...slice.sirens].filter(
    ([, entry]) =>
      entry.settings.siteChannel !== site.channel || entry.settings.sendRate !== site.rate,
  );
  return each(slice, moving, (current, [siren, entry]) =>
    changeSettings(
      current,
      ctx,
      siren,
      switchedSettings(entry.settings, move.channel, move.rate, ctx.deps.rules),
      true,
    ),
  );
}

/**
 * The sirens module's timers firing (hub-design.md section 8; §7 "Siren command" step 4 and §8
 * "Siren command repeats"; D52, D73, D80, D115): a repeat on one path, the minute without a
 * confirmation, a site move's slow settings repeat, a path lost, a siren silent, and the end of
 * the window for "report now".
 */
import { anySensorArmed } from "../alarm/view.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import { MICROS_PER_MILLISECOND, type Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import { after, type Changing, decide, each, then, unchanged } from "./out.ts";
import { sendSettings, transmit } from "./send.ts";
import type { InFlight, SirenEntry, SirenPaths, SirensSlice } from "./state.ts";
import { pathDeadlines } from "./timers.ts";

function withEntry(slice: SirensSlice, siren: DeviceId, entry: SirenEntry): SirensSlice {
  return { ...slice, sirens: new Map(slice.sirens).set(siren, entry) };
}

function withFlight(
  slice: SirensSlice,
  siren: DeviceId,
  entry: SirenEntry,
  flight: InFlight | undefined,
): SirensSlice {
  return withEntry(slice, siren, { ...entry, inFlight: flight });
}

/**
 * The repeat after the one due at `due`, on its grid of `everyMs` and after `now`, or none once it
 * would reach the minute (§8). A step that ran late by a whole interval or more skips the repeats
 * it missed instead of leaving one at or before now, which would run at once, one turn after
 * another (hub-design.md section 2, "Timers").
 */
function nextRepeat(due: Mono, now: Mono, everyMs: number, flight: InFlight): Mono | undefined {
  const everyUs = everyMs * MICROS_PER_MILLISECOND;
  const intervals = now >= due ? Math.floor((now - due) / everyUs) + 1 : 1;
  const next = after(due, intervals * everyMs);
  return flight.giveUpAt !== undefined && next < flight.giveUpAt ? next : undefined;
}

/** A siren's timer is due. */
export function onSirenTimer(
  slice: SirensSlice,
  ctx: Context,
  key: TimerOf<"sirens">["key"],
): Changing {
  const now = ctx.now.mono;
  const rules = ctx.deps.rules;
  if (key.kind === "reportNowWindow") {
    if (slice.reportNowUntil === undefined || slice.reportNowUntil > now) return unchanged(slice);
    const sirens = new Map(
      [...slice.sirens].map(
        ([siren, entry]) => [siren, { ...entry, reportNowWanted: false }] as const,
      ),
    );
    return unchanged({ ...slice, sirens, reportNowUntil: undefined });
  }
  const siren = key.siren;
  const entry = slice.sirens.get(siren);
  if (entry === undefined) return unchanged(slice);
  const flight = entry.inFlight;
  switch (key.kind) {
    case "wifiRepeat":
      if (flight?.nextWifi === undefined || flight.nextWifi > now) return unchanged(slice);
      return transmit(
        withFlight(slice, siren, entry, {
          ...flight,
          nextWifi: nextRepeat(flight.nextWifi, now, rules.sirens.wifiRepeatMs, flight),
        }),
        ctx,
        siren,
        { wifi: true, lora: false },
      );
    case "loraRepeat":
      if (flight?.nextLora === undefined || flight.nextLora > now) return unchanged(slice);
      return transmit(
        withFlight(slice, siren, entry, {
          ...flight,
          nextLora: nextRepeat(flight.nextLora, now, rules.sirens.loraRepeatMs, flight),
        }),
        ctx,
        siren,
        { wifi: false, lora: true },
      );
    case "settingsRepeat":
      if (flight?.slowRepeatAt === undefined || flight.slowRepeatAt > now) return unchanged(slice);
      return transmit(
        withFlight(slice, siren, entry, {
          ...flight,
          slowRepeatAt: after(now, rules.siteMove.sirenSettingsRepeatMs),
        }),
        ctx,
        siren,
        { wifi: true, lora: true },
      );
    case "giveUp":
      return flight?.giveUpAt === undefined || flight.giveUpAt > now
        ? unchanged(slice)
        : giveUp(slice, ctx, siren, entry, flight);
    case "wifiPathLost":
    case "loraPathLost":
    case "silent":
      return pathRule(slice, ctx, siren, entry, key.kind);
  }
}

/**
 * A minute without a confirmation (§7 step 4): `siren_unreachable`, a warning. The correction
 * rule sends a command again when the siren is next heard; waiting settings go now. Settings of a
 * site move keep going every 60 s ‡ until confirmed instead (section 8, D115).
 */
function giveUp(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  entry: SirenEntry,
  flight: InFlight,
): Changing {
  const keep: InFlight | undefined = flight.moveSettings
    ? {
        ...flight,
        nextWifi: undefined,
        nextLora: undefined,
        giveUpAt: undefined,
        slowRepeatAt: after(ctx.now.mono, ctx.deps.rules.siteMove.sirenSettingsRepeatMs),
      }
    : undefined;
  const released = withFlight(slice, siren, entry, keep);
  const recorded = decide(ctx, "now", "siren_unreachable", siren, flight.cause).map((m) => ({
    slice: released,
    out: [m],
  }));
  return keep === undefined && entry.settingsWanted
    ? then(recorded, (current) => sendSettings(current, ctx, siren, entry.moveSettings))
    : recorded;
}

/**
 * A path rule's deadline (section 8, "Silence"): Wi-Fi lost after 70 s ‡ with nothing on it, LoRa
 * lost after 630 s ‡ with nothing on it while Wi-Fi works, each a warning; on LoRa alone, silent
 * after 2P + max(10 s, P ÷ 10) ‡, critical while any sensor is armed (D52).
 */
function pathRule(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  entry: SirenEntry,
  rule: "wifiPathLost" | "loraPathLost" | "silent",
): Changing {
  const due = pathDeadlines(entry, ctx.deps.rules);
  const now = ctx.now.mono;
  const at =
    rule === "wifiPathLost" ? due.wifiLost : rule === "loraPathLost" ? due.loraLost : due.silent;
  if (at === undefined || at > now) return unchanged(slice);
  const paths: SirenPaths =
    rule === "wifiPathLost"
      ? { ...entry.paths, wifiLost: true }
      : rule === "loraPathLost"
        ? { ...entry.paths, loraLost: true }
        : { ...entry.paths, silent: true };
  const kind =
    rule === "wifiPathLost"
      ? "siren_wifi_lost"
      : rule === "loraPathLost"
        ? "siren_lora_lost"
        : "siren_silent";
  // `siren_silent`'s value: 1 when it is critical, a sensor being armed (D52).
  const value = rule === "silent" && anySensorArmed(ctx.view) ? 1 : undefined;
  return decide(ctx, "now", kind, siren, undefined, value).map((m) => ({
    slice: withEntry(slice, siren, { ...entry, paths }),
    out: [m],
  }));
}

/** The first of a siren's path rules whose deadline is at or before `now`, if any. */
function dueRule(
  entry: SirenEntry,
  ctx: Context,
): "wifiPathLost" | "loraPathLost" | "silent" | undefined {
  const due = pathDeadlines(entry, ctx.deps.rules);
  const now = ctx.now.mono;
  if (due.wifiLost !== undefined && due.wifiLost <= now) return "wifiPathLost";
  if (due.loraLost !== undefined && due.loraLost <= now) return "loraPathLost";
  if (due.silent !== undefined && due.silent <= now) return "silent";
  return undefined;
}

function settleSiren(slice: SirensSlice, ctx: Context, siren: DeviceId): Changing {
  const entry = slice.sirens.get(siren);
  const rule = entry === undefined ? undefined : dueRule(entry, ctx);
  if (entry === undefined || rule === undefined) return unchanged(slice);
  // Each rule sets the flag that ends its own deadline, so this ends after three at most.
  return then(pathRule(slice, ctx, siren, entry, rule), (next) => settleSiren(next, ctx, siren));
}

/**
 * Every path rule that a change of this step made due at or before now is decided now, in this
 * step (hub-design.md section 2, "Timers": a deadline left at or before the step's time would run
 * again at once). The path rules' deadlines follow from each siren's paths, so one rule can make
 * the next due at once: Wi-Fi lost on a siren that LoRa has not heard from for as long makes it
 * silent (D52), and Wi-Fi back on a siren whose LoRa has been quiet past 630 s ‡ makes LoRa lost
 * (D73). Each is the same decision its timer would have made one turn later.
 */
export function settlePaths(slice: SirensSlice, ctx: Context): Changing {
  return each(slice, [...slice.sirens.keys()], (current, siren) =>
    settleSiren(current, ctx, siren),
  );
}

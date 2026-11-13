/**
 * Read-only selectors over the sirens module's slice that other modules may use (hub-design.md
 * section 2): the alarm module for which sirens to sound and their longest sound, the site module
 * for whether a siren has followed a move (D115), and the control module for `hsn status` and
 * answers (section 9).
 */
import type { DeviceId } from "../model/ids.ts";
import type { SirenSettings } from "../model/settings.ts";
import type { HubState } from "../model/state.ts";
import { deviceById } from "../registry/view.ts";
import type { Mono } from "../model/time.ts";
import type { Commanded, Reported } from "./state.ts";

/** Every siren the hub knows: with no groups in M1a every sensor sounds every siren (D74). */
export function sirenIds(view: HubState): readonly DeviceId[] {
  return [...view.sirens.sirens.keys()];
}

/** A siren's name, for answers: the registry's (it owns names). */
export function sirenName(view: HubState, siren: DeviceId): string | undefined {
  return view.sirens.sirens.has(siren) ? deviceById(view, siren)?.name : undefined;
}

/** A siren's current settings (§6), for `hsn device show`. */
export function sirenSettings(view: HubState, siren: DeviceId): SirenSettings | undefined {
  return view.sirens.sirens.get(siren)?.settings;
}

/** The longest a command may make a siren sound, from its current settings (§6). */
export function sirenMaxSoundS(view: HubState, siren: DeviceId): number | undefined {
  return view.sirens.sirens.get(siren)?.settings.maxSoundS;
}

/** The hub's current settings version for a siren. */
export function sirenSettingsVersion(view: HubState, siren: DeviceId): number | undefined {
  return view.sirens.sirens.get(siren)?.settings.version;
}

/** The settings version the siren's newest report held: a move's follow (D115). */
export function sirenReportedVersion(view: HubState, siren: DeviceId): number | undefined {
  return view.sirens.sirens.get(siren)?.reported?.version;
}

/** A siren's line of `hsn status` (section 9), besides what it should do (the alarm's view). */
export function sirenSummary(
  view: HubState,
  siren: DeviceId,
  now: Mono,
):
  | {
      readonly commanded: Commanded | undefined;
      readonly reported: Reported | undefined;
      readonly wifi: "up" | "lost" | "none";
      readonly lora: "up" | "lost" | "none";
      readonly silent: boolean;
      readonly inFlight: boolean;
    }
  | undefined {
  const entry = view.sirens.sirens.get(siren);
  if (entry === undefined) return undefined;
  const { paths } = entry;
  const commanded =
    entry.commanded !== undefined && entry.commanded.kind !== "off" && entry.commanded.until <= now
      ? { kind: "off" as const }
      : entry.commanded;
  return {
    commanded,
    reported: entry.reported,
    wifi: paths.wifiLost ? "lost" : paths.sockets.size > 0 ? "up" : "none",
    lora: paths.loraLost ? "lost" : paths.heard.length > 0 ? "up" : "none",
    silent: paths.silent,
    inFlight: entry.inFlight !== undefined,
  };
}

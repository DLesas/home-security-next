/**
 * The sirens module's timers as its sirens imply them (hub-design.md section 2, "Timers"; section
 * 8, "Silence" and "What the siren should do, and commands"): a command's repeats on each path and
 * its minute, a site move's slow settings repeat, each path's loss and silence on LoRa alone, and
 * the end of the "report now" window after a start.
 */
import type { DeviceId } from "../model/ids.ts";
import type { HubRules } from "../model/rules.ts";
import { type Mono, mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import { after } from "./out.ts";
import { silenceMs } from "./settings.ts";
import type { SirenEntry, SirensSlice } from "./state.ts";

/** `at`, held back to the end of a site switch's grace when there is one (D115). */
function graced(at: Mono, entry: SirenEntry): Mono {
  const grace = entry.paths.graceUntil;
  return grace === undefined ? at : mono(Math.max(at, grace));
}

/** When each path rule next fires for a siren (section 8, "Silence"; D52, D73). */
export function pathDeadlines(
  entry: SirenEntry,
  rules: HubRules,
): {
  readonly wifiLost: Mono | undefined;
  readonly loraLost: Mono | undefined;
  readonly silent: Mono | undefined;
} {
  const { paths } = entry;
  const lastAny = mono(Math.max(paths.wifiAt, paths.loraAt));
  return {
    wifiLost: paths.wifiLost ? undefined : after(paths.wifiAt, rules.sirens.wifiPathLostMs),
    // LoRa's own loss is judged only while Wi-Fi works; with Wi-Fi lost, silence is.
    loraLost:
      paths.loraLost || paths.wifiLost
        ? undefined
        : graced(after(paths.loraAt, rules.sirens.loraPathLostMs), entry),
    silent:
      paths.wifiLost && !paths.silent
        ? graced(after(lastAny, silenceMs(entry.paceMs, rules)), entry)
        : undefined,
  };
}

/** The timers that belong to one siren. */
type SirenTimerKind = Exclude<TimerOf<"sirens">["key"]["kind"], "reportNowWindow">;

function sirenTimers(siren: DeviceId, entry: SirenEntry, rules: HubRules): TimerOf<"sirens">[] {
  const timers: TimerOf<"sirens">[] = [];
  const add = (at: Mono | undefined, kind: SirenTimerKind): void => {
    if (at !== undefined) timers.push({ at, key: { module: "sirens", kind, siren } });
  };
  const flight = entry.inFlight;
  add(flight?.nextWifi, "wifiRepeat");
  add(flight?.nextLora, "loraRepeat");
  add(flight?.giveUpAt, "giveUp");
  add(flight?.slowRepeatAt, "settingsRepeat");
  const paths = pathDeadlines(entry, rules);
  add(paths.wifiLost, "wifiPathLost");
  add(paths.loraLost, "loraPathLost");
  add(paths.silent, "silent");
  return timers;
}

/** The slice with its timers recomputed. */
export function withTimers(slice: SirensSlice, rules: HubRules): SirensSlice {
  const timers = [...slice.sirens].flatMap(([siren, entry]) => sirenTimers(siren, entry, rules));
  if (slice.reportNowUntil !== undefined) {
    timers.push({ at: slice.reportNowUntil, key: { module: "sirens", kind: "reportNowWindow" } });
  }
  return { ...slice, timers };
}

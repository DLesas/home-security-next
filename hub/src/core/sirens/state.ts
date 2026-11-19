/**
 * The sirens module's slice (hub-design.md section 2, module 12; section 8, "What the siren should
 * do, and commands" and "Silence"): for each siren its settings and versions, the hub's sending
 * counter to it, what it was last commanded and last reported, the command in flight, and its two
 * paths: the Wi-Fi sockets that carried its packets and the gateways that heard it. What each siren
 * should do is the alarm module's, read through its view.
 *
 * Its timers are data in `timers` (section 2), kept equal to what the sirens imply by `withTimers`.
 */
import type { MessageOf, MessageType, SendCounter } from "@hsn/protocol";
import { type KeyChanges, NO_KEY_CHANGES } from "../intake/view.ts";
import type { DeviceId, LinkId, Seq, SendRef } from "../model/ids.ts";
import type { RadioPurpose } from "../model/messages.ts";
import type { PacketPath } from "../model/rows.ts";
import type { SirenSettings } from "../model/settings.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** One settings version's rates, for the rate a siren listens at (section 8, "The reply rate"). */
export interface VersionRates {
  readonly version: number;
  readonly sendRate: number;
  readonly commandRate: number;
}

/** What a siren was commanded to do; sounding and testing end by themselves at `until` (SR5). */
export type Commanded =
  { readonly kind: "off" } | { readonly kind: "sound" | "test"; readonly until: Mono };

/** The newest report accepted from a siren (§6, Siren report). */
export interface Reported {
  /** A `SirenState`, as sent: a value this version does not list is kept and acted on by nobody. */
  readonly state: number;
  readonly secondsLeft: number;
  readonly version: number;
  readonly at: Mono;
}

/** A command or settings packet waiting for a report to confirm it (§7, steps 4 and 5). */
export interface InFlight {
  readonly purpose: Extract<RadioPurpose, "sirenCommand" | "sirenSettings">;
  /** A `SirenAction` and its seconds, for a command; the settings version, for settings. */
  readonly action: number | undefined;
  readonly seconds: number;
  readonly version: number | undefined;
  readonly counter: number;
  /** The sealed packet: the same bytes on every path and every repeat (section 4). */
  readonly packet: Uint8Array;
  /** Its message type and decrypted body, for the `tx` records (section 6). */
  readonly type: number;
  readonly body: Uint8Array;
  readonly since: Mono;
  readonly nextWifi: Mono | undefined;
  readonly nextLora: Mono | undefined;
  /** A minute after it was first sent: `siren_unreachable` (§7). */
  readonly giveUpAt: Mono | undefined;
  /** Settings of a site move keep going every 60 s ‡ after the first minute (D115). */
  readonly slowRepeatAt: Mono | undefined;
  readonly moveSettings: boolean;
  readonly cause: Seq | undefined;
}

/** A gateway that heard a siren, for the best gateway (section 8). */
export interface Heard {
  readonly gateway: DeviceId;
  readonly snrQuarterDb: number;
  readonly at: Mono;
}

/** A siren's two paths and their silence state (section 8, "Silence"; D52, D73). */
export interface SirenPaths {
  /** The last packet on Wi-Fi, or the start: nothing for 70 s ‡ loses the path. */
  readonly wifiAt: Mono;
  readonly wifiLost: boolean;
  /** Open sockets that carried an accepted packet from the siren, with the last one's time. */
  readonly sockets: ReadonlyMap<LinkId, Mono>;
  readonly loraAt: Mono;
  readonly loraLost: boolean;
  /** Its LoRa copies in the last 15 minutes ‡. */
  readonly heard: readonly Heard[];
  /** Silent on LoRa alone (D52). */
  readonly silent: boolean;
  /** After a site switch, LoRa path and silence wait until the new version is confirmed or this (D115). */
  readonly graceUntil: Mono | undefined;
}

/** One siren as this module keeps it. */
export interface SirenEntry {
  /** The hub's counter to this siren (section 4); this module owns the key (section 2). */
  readonly counter: SendCounter;
  /** The current settings version (written now with every change, section 5). */
  readonly settings: SirenSettings;
  /** The last 16 versions' rates, newest first. */
  readonly history: readonly VersionRates[];
  /** P of section 8: the report pace on LoRa alone, milliseconds, at the current sending rate. */
  readonly paceMs: number;
  readonly reported: Reported | undefined;
  /** Undefined until commanded in this run: after a start it is not known (section 5). */
  readonly commanded: Commanded | undefined;
  readonly inFlight: InFlight | undefined;
  /** Settings wait for the command in flight (§7, step 5). */
  readonly settingsWanted: boolean;
  /** The settings waiting are those of a site switch (D115). */
  readonly moveSettings: boolean;
  /** "Report now" is owed after a hub start (§7) or to prove a trial image (D134). */
  readonly reportNowWanted: "boot" | "trial" | false;
  readonly paths: SirenPaths;
  /**
   * An Update offer firmware made while a command or settings packet was in flight: it waits, as
   * settings do, and goes once nothing is (m3-updates-design section 4; §7 step 5). A newer one
   * replaces it.
   */
  readonly offer?: MessageOf<typeof MessageType.UpdateOffer> | undefined;
}

/** A packet handed to a path, kept until its outcome is known, for its `tx` row (section 6). */
export interface SentPacket {
  readonly siren: DeviceId;
  readonly type: number;
  readonly counter: number;
  readonly body: Uint8Array;
  readonly path: PacketPath;
  readonly gateway: DeviceId | undefined;
  readonly rate: number | undefined;
  readonly power: number | undefined;
  readonly at: Mono;
}

/** The site's channel and sending rate, as new siren settings carry them (section 8, D115). */
export interface SiteRadio {
  readonly channel: number;
  readonly rate: number;
}

/** The sirens module's slice (section 2, module 12). */
export interface SirensSlice {
  readonly timers: readonly TimerOf<"sirens">[];
  readonly sirens: ReadonlyMap<DeviceId, SirenEntry>;
  /** Gateways with a proven session (`gatewayUp`, `gatewayDown`). */
  readonly gateways: ReadonlySet<DeviceId>;
  /** "Report now" goes to each siren as its path appears, until then (section 7, D80). */
  readonly reportNowUntil: Mono | undefined;
  /** The next of this module's send references. */
  readonly nextRef: number;
  readonly sent: ReadonlyMap<SendRef, SentPacket>;
  /** The key changes after a restore of the sirens (D141), and those switched in this run. */
  readonly keys: KeyChanges;
  /**
   * Sirens owed a Key change at this start, in place of "report now" (§7 "Hub restart", D141): each
   * gets it on both paths as soon as one is up, or in answer to its first packet.
   */
  readonly keyChangeOwed: ReadonlySet<DeviceId>;
  /**
   * The last settings version of each siren that left this run (removed, or reset by its owner),
   * so one added again starts above it (hub-design section 9, from M3): memory only, since at a
   * start a reset siren's entry is restored with its version.
   */
  readonly retiredVersions: ReadonlyMap<DeviceId, number>;
}

/** The slice before the boot event. */
export const EMPTY_SIRENS_SLICE: SirensSlice = {
  timers: [],
  sirens: new Map(),
  gateways: new Set(),
  reportNowUntil: undefined,
  nextRef: 0,
  sent: new Map(),
  keys: NO_KEY_CHANGES,
  keyChangeOwed: new Set(),
  retiredVersions: new Map(),
};

/**
 * The core's own settings of each device, as one settings version holds them (hub-design.md
 * section 8; protocol.md §6 Reply, Siren settings, Gateway settings). A settings version covers
 * every field here (D72), so a change to any of them bumps it. Includes the site move of D115
 * (section 8, "Changing the site's channel or rate"; protocol.md §7).
 */
import type { MessageOf, MessageType } from "@hsn/protocol";

/** What a sensor's reply carries for one settings version, besides the per-packet fields. */
export interface SensorSettings {
  readonly version: number;
  readonly armed: boolean;
  readonly countdownS: number;
  readonly heartbeatUnits: number;
  readonly linkCheckEvery: number;
  readonly sendRate: number;
  readonly replyRate: number;
  /** Units of 10 ppm (§6). */
  readonly correctionUnits: number;
  /** The channel the site is moving to; undefined when it stays as it is (0xFF on the wire, §6). */
  readonly nextChannel: number | undefined;
  /** The sending rate the site is moving to; undefined when it stays. Both undefined: no move. */
  readonly nextRate: number | undefined;
}

export interface SirenSettings {
  readonly version: number;
  readonly wifiIntervalS: number;
  readonly loraCheckUnits: number;
  readonly maxSoundS: number;
  readonly sendRate: number;
  readonly commandRate: number;
  /** The site channel to send on (D115; protocol.md §6, Siren settings). */
  readonly siteChannel: number;
}

export interface GatewaySettings {
  readonly version: number;
  readonly channel: number;
  readonly listenRateMask: number;
  readonly statusIntervalS: number;
  readonly interferenceDb: number;
  readonly interferenceS: number;
  readonly defaultPowerDbm: number;
  readonly sirenPowerDbm: number;
}

/**
 * The one place the core reads Reply's and Siren settings' fields from `@hsn/protocol`: every
 * settings field of each message, mapped to the core's field above. A field the package adds
 * fails the type check here until it is mapped, so the two cannot drift apart. The D115 fields
 * (`nextSiteChannel`, `nextSendDataRate`, `siteChannel`) follow the protocol pass that added them.
 */
type ReplySettingsFields = Exclude<
  keyof MessageOf<typeof MessageType.Reply>,
  "type" | "flags" | "countdownRemainingSeconds" | "nextHeartbeatTenths"
>;
type SirenSettingsFields = Exclude<keyof MessageOf<typeof MessageType.SirenSettings>, "type">;

/** The package's field names for each of the core's settings fields. */
const REPLY_FIELDS = {
  settingsVersion: "version",
  countdownSeconds: "countdownS",
  heartbeatIntervalUnits: "heartbeatUnits",
  linkCheckEvery: "linkCheckEvery",
  sendDataRate: "sendRate",
  replyDataRate: "replyRate",
  clockCorrectionTenPpm: "correctionUnits",
  nextSiteChannel: "nextChannel",
  nextSendDataRate: "nextRate",
} as const satisfies Record<ReplySettingsFields, keyof SensorSettings>;

const SIREN_SETTINGS_FIELDS = {
  settingsVersion: "version",
  wifiReportIntervalSeconds: "wifiIntervalS",
  loraCheckIntervalUnits: "loraCheckUnits",
  maxSoundSeconds: "maxSoundS",
  sendDataRate: "sendRate",
  commandDataRate: "commandRate",
  siteChannel: "siteChannel",
} as const satisfies Record<SirenSettingsFields, keyof SirenSettings>;

/** Which core settings field each Reply and Siren settings field is filled from. */
export const PACKAGE_SETTINGS_FIELDS = {
  reply: REPLY_FIELDS,
  sirenSettings: SIREN_SETTINGS_FIELDS,
} as const;

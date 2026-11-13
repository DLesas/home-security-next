/**
 * The gateways module's own constants (hub-design.md sections 7 and 8), each with its source.
 * Everything a measurement may change is in `HubRules`; these are fixed by the protocol or are
 * bookkeeping limits of this module.
 */
import { SiteChannel } from "@hsn/protocol";

/** A gateway's status interval, seconds: protocol.md §6 Gateway settings and §8 (GW6). */
export const STATUS_INTERVAL_S = 30;

/** Seconds the interference level must last before the gateway alerts: §6 and §8 (30 †, D82). */
export const INTERFERENCE_ALERT_S = 30;

/**
 * The channel gateway settings carry until the site has one (section 8, "Site channel and data
 * rate": on a tie the survey takes 868.3 MHz). SPEC-QUESTION: the design does not say what a
 * gateway connected before any channel is chosen is told; this is the survey's tie-breaker.
 */
export const DEFAULT_SITE_CHANNEL: number = SiteChannel.Mhz868_3;

/** The gateway's microsecond clock is 32 bits on the wire (§6, Forwarded packet). */
export const GATEWAY_CLOCK_WRAP = 2 ** 32;

/**
 * "As soon as possible" with this latest moment means "no limit" (§6, Transmit request). A real
 * limit that lands on it is sent one microsecond earlier, at the largest gateway time.
 */
export const NO_LIMIT = 0;
/** The largest gateway time: what a latest moment that lands on 0 is sent as. */
export const LAST_GATEWAY_MICROS = GATEWAY_CLOCK_WRAP - 1;

/**
 * Settings versions run from 1 to 255; 0 in a hello means the gateway holds none (§6, Hello).
 * SPEC-QUESTION: §6 does not say how a version wraps; 255 is followed by 1.
 */
export const FIRST_SETTINGS_VERSION = 1;
/** The last settings version before it wraps to the first. */
export const LAST_SETTINGS_VERSION = 255;

/**
 * At most this many copies of one siren's packets are kept for the best-gateway rule (section
 * 8, 15 minutes ‡): a siren on LoRa alone reports every 30 s, so 15 minutes through two
 * gateways is 60 copies; the bound only keeps a misbehaving siren from growing the state.
 */
export const SIREN_COPIES_KEPT = 64;

/** Where this module's faults and records say they arose (section 10). */
export const ORIGIN = "core/gateways";

/** The format byte of a gateway's `device_state.estimates` (section 6: own layouts start with one). */
export const ESTIMATES_FORMAT = 1;

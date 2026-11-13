/**
 * The gateways module's slice (hub-design.md section 2, module 6): for each gateway its
 * sessions, the hub's sending counter to it, its settings, each session's clock mapping, the
 * transmit requests in flight, its last status, its noise baseline and its silence; and for the
 * routing rules of section 8 which gateways heard which devices.
 */
import type { SendCounter } from "@hsn/protocol";
import type { LinkKind } from "../model/events.ts";
import type { BootId, DeviceId, LinkId, SendRef, RequestId } from "../model/ids.ts";
import type { RadioPurpose } from "../model/messages.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/**
 * The hub's clock mapping for one session (section 8, "Heartbeat slots"): the offset is the
 * smallest (hub time of the frame − unwrapped gateway time) of the last 64 forwarded packets,
 * which removes network delay; the 32-bit gateway clock is unwrapped against the hub's.
 */
export interface ClockMapping {
  /** hub mono − unwrapped gateway microseconds, newest last, at most the rule's count. */
  readonly samples: readonly number[];
  /** The smallest of `samples`; undefined before the first forwarded packet. */
  readonly offset: number | undefined;
}

/** One connection from a gateway (§4, §7 "Gateway connection"). */
export interface Session {
  readonly link: LinkId;
  readonly linkKind: LinkKind;
  readonly gatewayRandom: Uint8Array;
  readonly hubRandom: Uint8Array;
  /** The session value: gateway random followed by hub random (§4, "Bindings"). */
  readonly binding: Uint8Array;
  /** The last counter accepted on this connection: the next must be higher (§4). */
  readonly lastReceived: number;
  readonly openedAt: Mono;
  readonly clock: ClockMapping;
}

/** A transmit request waiting for its result (§6, "Every request gets exactly one result"). */
export interface TransmitInFlight {
  /** The `radioOut`'s ref, which the request's `send` effect also carries. */
  readonly ref: SendRef;
  /** The device the packet inside is for. */
  readonly device: DeviceId;
  /** The hub counter of the transmit request: the result names it. */
  readonly requestCounter: number;
  readonly link: LinkId;
  readonly purpose: RadioPurpose;
  /** When it becomes "no result" (section 7, "A busy gateway"). */
  readonly deadline: Mono;
}

/** The settings of `gateway_config` (section 6); the channel and rates are the site's. */
export interface GatewayConfig {
  readonly version: number;
  readonly statusIntervalS: number;
  readonly interferenceDb: number;
  readonly interferenceS: number;
  readonly defaultPowerDbm: number;
  readonly sirenPowerDbm: number;
}

/** The figures of the last status (§6, Gateway status). */
export interface StatusReading {
  readonly at: Mono;
  readonly settingsVersion: number;
  readonly uptimeSeconds: number;
  readonly airtimeHundredthsPercent: number;
  readonly noiseMedianDbm: number;
  readonly noiseHighestDbm: number;
  readonly normalNoiseDbm: number;
  readonly packetsReceived: number;
  readonly packetsCrcFailed: number;
  /** The status body as received, for `device_state.reading`. */
  readonly body: Uint8Array;
}

/** The hub's own judgement of a gateway's noise (section 8, D82, §14). */
export interface NoiseState {
  /** B, dBm: the slow average of the statuses' medians; undefined during the first hour. */
  readonly baseline: number | undefined;
  /** When B was last moved; the average's weight grows with the time since. */
  readonly baselineAt: Mono | undefined;
  /** The first hour's medians, from which B starts. */
  readonly firstMedians: readonly number[];
  readonly firstStartedAt: Mono | undefined;
  /** Consecutive statuses with the median at least B + the alert level. */
  readonly above: number;
  /** Consecutive statuses below B + the level − 3 dB while the hub judges interference. */
  readonly below: number;
  readonly interference: boolean;
  /** The gateway's learned normal level is at least B + the alert level (§14). */
  readonly learnedAsNormal: boolean;
  /** The last statuses' packet counts, newest last, for the damaged-packets rule. */
  readonly packets: readonly { readonly received: number; readonly failed: number }[];
  readonly damaged: boolean;
}

/** One gateway as the hub keeps it. */
export interface GatewayEntry {
  readonly device: DeviceId;
  readonly address: number;
  readonly config: GatewayConfig;
  /** The hub's sending counter for this gateway's key (§4). */
  readonly counter: SendCounter;
  /** The highest counter accepted from this gateway, on any connection (§4). */
  readonly highestAccepted: number;
  /** The session everything uses; it changes only when a newer one is proven (section 8). */
  readonly live: Session | undefined;
  /** Sessions answered with a welcome and not yet proven. */
  readonly candidates: readonly Session[];
  readonly requests: readonly TransmitInFlight[];
  readonly lastHeardAt: Mono | undefined;
  readonly lastHeardMs: number | undefined;
  readonly lastHeardTrusted: boolean;
  /** Silent for 60 s (§7, D97): no route goes through it until it is heard again. */
  readonly offline: boolean;
  readonly status: StatusReading | undefined;
  /** The uptime saved with the last commit, before this boot's first status (section 5). */
  readonly uptimeS: number | undefined;
  readonly noise: NoiseState;
  /** The gateway's own interference report (0x24) says it is going on. */
  readonly reportedInterference: boolean;
}

/** The site's radio settings that every gateway's settings carry (§6, Gateway settings). */
export interface SiteRadio {
  readonly channel: number;
  readonly rateMask: number;
  readonly replyPowerDbm: number;
  readonly sirenPowerDbm: number;
  /** The site move whose switch the gateways' settings already carry (D115). */
  readonly appliedMove: number;
}

/** A channel survey in progress (section 8, "Site channel and data rate"). */
export interface Survey {
  /** The `hsn site survey` request it answers. */
  readonly request: RequestId;
  /** The gateway whose statuses it reads: the first connected. */
  readonly gateway: DeviceId;
  /** The channel being measured, as an index into the three. */
  readonly index: number;
  /** Statuses discarded on this channel so far. */
  readonly discarded: number;
  readonly medians: readonly number[];
  readonly highest: readonly number[];
  /** Each channel measured: its averaged median and its highest reading. */
  readonly results: readonly {
    readonly channel: number;
    readonly medianDbm: number;
    readonly highestDbm: number;
  }[];
}

/** One authentic copy of a siren's packet through a gateway (section 8). */
export interface SirenCopy {
  readonly gateway: DeviceId;
  readonly at: Mono;
  readonly snrQuarterDb: number;
}

/** The gateways module's slice (section 2, module 6). */
export interface GatewaysSlice {
  readonly timers: readonly TimerOf<"gateways">[];
  readonly boot: BootId | undefined;
  readonly site: SiteRadio;
  readonly gateways: ReadonlyMap<DeviceId, GatewayEntry>;
  /** For each device, when each gateway last delivered an authentic copy of its packets. */
  readonly heard: ReadonlyMap<DeviceId, ReadonlyMap<DeviceId, Mono>>;
  /** Each siren's authentic copies in the best-gateway window, oldest first. */
  readonly sirenCopies: ReadonlyMap<DeviceId, readonly SirenCopy[]>;
  /** The next ref of a send this module makes for itself (welcome, settings). */
  readonly nextOwnRef: number;
  /** A channel survey in progress, or none. */
  readonly survey: Survey | undefined;
}

/** A noise judgement with nothing learned yet. */
export const EMPTY_NOISE: NoiseState = {
  baseline: undefined,
  baselineAt: undefined,
  firstMedians: [],
  firstStartedAt: undefined,
  above: 0,
  below: 0,
  interference: false,
  learnedAsNormal: false,
  packets: [],
  damaged: false,
};

/** The slice before the boot event. */
export const EMPTY_GATEWAYS_SLICE: GatewaysSlice = {
  timers: [],
  boot: undefined,
  site: { channel: 0, rateMask: 0, replyPowerDbm: 0, sirenPowerDbm: 0, appliedMove: 0 },
  gateways: new Map(),
  heard: new Map(),
  sirenCopies: new Map(),
  nextOwnRef: 0,
  survey: undefined,
};

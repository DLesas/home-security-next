/**
 * The relay's rule values (docs/m4-design.md section 3), in one place: the presence clock
 * (D64, D96) and D142's layer 1, "what the program does itself". Every value marked ‡ is the
 * design's provisional choice, set first from a measurement of memory and processor time per
 * connection on the chosen host, then from running costs (D55). Passing a limit is answered,
 * never silent: `limit` to a hub or relay, 4429 to a phone, `limited` for a push. Frozen by the
 * joint step 0: changed only through the step 0 owner.
 *
 * The values the hub and the phone share with the relay (frame sizes, pings, back-off) are
 * `RELAY_LIMITS` in `@hsn/protocol/relay`; those named again here are the same values.
 */
import { RELAY_LIMITS } from "@hsn/protocol/relay";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KIB = 1024;

/** The presence clock (section 3, "Presence"). */
export const PRESENCE_RULES = {
  /** No frame for this long closes the hub's link: `quiet` ‡. */
  silentCloseMs: RELAY_LIMITS.silentLinkMs,
  /** This long after the last contact, past the grace end, `unreachable` goes: `alerted` (D96). */
  alertAfterMs: 180 * SECOND,
  /** An announced restart's grace, at most ‡: grace end = now + min(`withinMs`, this). */
  graceMaxMs: RELAY_LIMITS.maxRestartWithinMs,
} as const;

/** How long the relay keeps what it stores (section 3, "What the relay stores"; D142). */
export const RETENTION_RULES = {
  /** An established hub's row, and its targets, after its last contact ‡. */
  establishedHubMs: 90 * DAY,
  /** An identity that has not connected on `settledAfterDays` different days ‡. */
  unsettledHubMs: 7 * DAY,
  /** An identity is established once it has connected on this many different days. */
  settledAfterDays: 3,
} as const;

/** D142, layer 1: what the relay program does itself, row by row. */
export const PROTECTION_LIMITS = {
  /** An address: an IPv4 address, or an IPv6 /64 ‡. */
  ipv6PrefixBits: 64,
  /** Before any state is kept: checked at the HTTP upgrade; refused with 429 or 503, nothing kept. */
  beforeState: {
    hubAndRelayUpgradesPerMinutePerAddress: 10,
    phoneOpensPerMinutePerAddress: 30,
    handshakesPerSecondInAll: 500,
  },
  /** Unauthenticated links (an XN handshake not finished): 4429, or 4408 on timeout. */
  unauthenticated: {
    perAddress: 4,
    inAll: 2000,
    message3WithinMs: RELAY_LIMITS.handshakeMs,
    queuedMessages: 1,
  },
  /** Authenticated hub links: new ones refused with 4429; an established link is never closed for room. */
  hubLinks: { perAddress: 8, inAll: 20_000 },
  /** Phone streams: 4429. */
  phoneStreams: { perHub: 16, openPerAddress: 8, inAll: 40_000 },
  /** New hub identities: `limit {what: "newIdentity"}`; at the stored cap the operator is alerted. */
  newIdentities: { perDayPerAddress: 3, perHourInAll: 500, storedMax: 200_000 },
  /** Memory per connection: a reader too slow to take its data is closed with 4429. */
  memory: {
    phoneMessageBytes: RELAY_LIMITS.maxPhoneMessageBytes,
    phoneMessagesInHand: 1,
    pendingToPhoneBytes: 256 * KIB,
    pendingToHubLinkBytes: 4 * KIB * KIB,
    rosterBytes: RELAY_LIMITS.maxRosterBytes,
    /** The rate tables' addresses; the oldest dropped, and when full every unknown address shares one strict bucket. */
    rateTableAddresses: 200_000,
  },
  /** Slow clients: closed. */
  slowClients: {
    idlePhoneStreamMs: RELAY_LIMITS.streamIdleMs,
    silentHubLinkMs: RELAY_LIMITS.silentLinkMs,
    unfinishedHandshakeMs: RELAY_LIMITS.handshakeMs,
  },
  /** Traffic through the relay: new streams refused until midnight UTC. */
  traffic: { streamBytesPerHubPerDay: 500_000_000 },
  /**
   * Pushes, counted per relay key and hub identity together: `limited`. The whole service's
   * ceiling is set below Apple's and Google's quotas once they are known ‡, alerting the operator
   * at `operatorAlertFraction` of it.
   */
  pushes: {
    perHubPerWindow: 60,
    windowMs: 10 * MINUTE,
    perHubPerDay: 1000,
    perRelayKeyPerDay: 10_000,
    operatorAlertFraction: 0.8,
  },
  /** Releases (bandwidth costs money): only on authenticated links; `release.error {reason: "limit"}`. */
  releases: {
    downloadsPerFilePerIdentityPerDay: 3,
    wholeFilesPerAddressPerDay: 3,
    filesPerRelayKeyPerDay: 10,
    dailyEgressBytes: 100_000_000_000,
  },
  /** Names (when built): `name.error`. */
  names: { perEstablishedIdentity: 1, updatesPerDay: 20 },
} as const;

/** The phone's pseudonym (section 3, "The peer"). */
export const PSEUDONYM_RULES = {
  /** Bytes of HMAC-SHA256 of the phone's address, in hex after `relay-`. */
  bytes: 8,
  /** The secret is made at start and replaced this often ‡, never stored. */
  secretLifetimeMs: DAY,
} as const;

/** The releases role (section 6). */
export const RELEASES_RULES = {
  /** The folder is read again this often ‡. */
  refreshMs: 10 * MINUTE,
} as const;

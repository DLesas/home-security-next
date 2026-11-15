/**
 * The app channel's fixed values (docs/m2-design.md sections 5 and 6), in one place. Values
 * marked ‡ are the design's own choices, each to be confirmed by a measurement or in review;
 * change them here and nowhere else. The core's rule values (section 7) are in the hub's
 * `HubRules`; the shell's and the installer's in `hub/src/shell/m2-values.ts`.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The channel's version (section 5, "Versions"): this design is version 1. */
export const APP_PROTO_VERSION = 1;

/** The three listeners (section 5, "Listeners"). */
export const LISTENER_PORTS = {
  /** Devices: plain WebSocket, `/device`, on every address ‡. */
  devices: 8443,
  /** Apps on the home network: HTTPS with the hub's own certificate, on every address ‡. */
  lan: 8444,
  /** The hub computer's console: plain HTTP on 127.0.0.1 only ‡. */
  console: 8445,
} as const;

/** The WebSocket path of the app channel on the two app listeners. */
export const APP_PATH = "/app";

/**
 * The WebSocket path of each handshake (section 5, "Admitting a session" and "Linking"): a path
 * each, no trial reading. Both ends import these.
 */
export const APP_PATHS = {
  /** A session (IK). */
  session: APP_PATH,
  /** Linking (XXpsk3, the link prologue). */
  link: `${APP_PATH}/link`,
  /** A restore (XXpsk3, the restore prologue). */
  restore: `${APP_PATH}/restore`,
} as const;

/** The mDNS text field that names the apps' port (§10 gains it ‡). */
export const MDNS_APP_PORT_FIELD = "app";

/** The hub's certificate (section 5, "The certificate"). */
export const CERTIFICATE = {
  /** Valid this long ‡. */
  validityMs: 800 * DAY,
  /** Renewed at this age ‡. */
  renewAfterMs: 700 * DAY,
} as const;

/** Noise framing (section 5, "Framing"). */
export const NOISE_LIMITS = {
  /** The longest Noise message. */
  maxMessageBytes: 65_535,
  /** The longest plaintext in one transport message: the message less the 16-byte tag. */
  maxPlaintextBytes: 65_519,
  /** The length of a Noise authentication tag. */
  tagBytes: 16,
  /** An X25519 public key, and so a static or ephemeral key on the wire. */
  keyBytes: 32,
} as const;

/** Session admission and liveness (section 5, "Admitting a session"). */
export const SESSION_LIMITS = {
  /** Handshakes open at once ‡. */
  maxOpenHandshakes: 16,
  /** A handshake whose first transport message has not come in this long is closed ‡. */
  handshakeTimeoutMs: 5 * SECOND,
  /** Sessions per client ‡; a fifth closes the client's oldest ‡. */
  maxSessionsPerClient: 4,
  /** Sessions in all ‡; past it, new handshakes are refused until one closes. */
  maxSessions: 64,
  /** The hub sends `ping` to a session quiet for this long ‡. */
  pingAfterQuietMs: 20 * SECOND,
  /** A session with nothing authenticated from the client for this long is closed ‡. */
  livenessMs: 60 * SECOND,
  /** A session lasts at most this long; the client opens a new one ‡. */
  lifetimeMs: 24 * HOUR,
  /** Handshakes a second from one address ‡, refused before any X25519. */
  handshakesPerSecondPerAddress: 10,
  /** Handshakes a second in all ‡. */
  handshakesPerSecond: 100,
  /** `client_refused` becomes a warning after this many in an hour from one address ‡. */
  refusedWarningPerHour: 10,
} as const;

/** Requests and replies (section 5, "Requests, replies and events"). */
export const REQUEST_LIMITS = {
  /** A request's `id`: 1 to 2³² − 1. */
  maxId: 2 ** 32 - 1,
  /** A change's `seq`: 1 to 2⁵³ − 1. */
  maxSeq: Number.MAX_SAFE_INTEGER,
  /** Replies kept per client for a retried `seq` ‡ (section 3). */
  storedReplies: 16,
} as const;

/** Linking (section 5, "Linking"). */
export const LINKING = {
  /** A 128-bit secret: 16 random bytes (QR codes, link addresses, console and restore tokens). */
  secretBytes: 16,
  /** A lookup: the first 4 bytes of SHA-256, written as 8 hex digits. */
  lookupBytes: 4,
  /** A typed code: 4 + 7 + 1 characters of Crockford base32, shown as XXXX-XXXX-XXXX ‡. */
  typedTokenIdChars: 4,
  typedSecretChars: 7,
  /** The typed code's secret as the pre-shared key's input: 5 bytes, big-endian, top 5 bits zero. */
  typedSecretBytes: 5,
  /** A typed code is void after this many failed tries ‡. */
  typedMaxFailures: 5,
  /** Link failures become a warning after this many in an hour from one address ‡. */
  failureWarningPerHour: 10,
  /** Codes made in an app expire after this ‡. */
  appCodeExpiryMs: 10 * MINUTE,
  /** Invites for someone not present expire after this (D99). */
  inviteExpiryMs: 24 * HOUR,
  /** The installer's first code expires after this, or its first use ‡ (D62). */
  installerCodeExpiryMs: 7 * DAY,
  /** The console's one-time token, from `hsn open` ‡. */
  consoleTokenExpiryMs: 2 * MINUTE,
  /** The console token an installer's first opening asks for (section 9, D62) ‡. */
  installerConsoleTokenExpiryMs: 10 * MINUTE,
  /** A restore token, never stored, expires after this or its first use ‡ (section 9). */
  restoreTokenExpiryMs: 10 * MINUTE,
  /** The QR code's URL scheme and path. */
  qrPrefix: "hsn://link/1",
  /** A restore token's QR code (section 9): the same fields as a link's, naming the new hub. */
  restoreQrPrefix: "hsn://restore/1",
  /** A link address's fragment key: `https://<address>:8444/#link=<identity>.<secret>`. */
  linkFragment: "link",
  /** The console's fragment key: `http://127.0.0.1:8445/#console=<secret>`. */
  consoleFragment: "console",
} as const;

/** Files over the channel (section 6). */
export const FILE_CHUNKS = {
  /**
   * A chunk's data, at most 48 KB ‡ (48,000 bytes): as base64url, 64,000 characters, so a chunk's
   * event fits one Noise message (65,519 bytes of plaintext, section 5) and its control line the
   * 64 KiB limit (section 6).
   */
  maxChunkBytes: 48_000,
  /** An upload, kept by the shell in the data folder's `uploads/`, at most ‡. */
  maxUploadBytes: 256 * 1024 * 1024,
} as const;

/** Retention a person with manage system may set (section 7, "History"; HB24) ‡, in days. */
export const RETENTION_DAYS = {
  routine: { min: 1, max: 90 },
  event: { min: 30, max: 730 },
} as const;

/** History and notifications over the channel (sections 6 and 7). */
export const APP_LISTS = {
  /** `history.query`'s `limit`, at most ‡. */
  maxHistoryRows: 500,
  /** `notifications.list`'s `limit`, at most ‡ (section 6 sets none: the history page's). */
  maxNotifications: 500,
  /** Readings are sent at most once a minute per device ‡. */
  readingEventEveryMs: MINUTE,
} as const;

/** Reconnection in the app (section 8, "Connection") ‡: 1, 2, 4, then every 10 s. */
export const APP_RECONNECT_MS = [1 * SECOND, 2 * SECOND, 4 * SECOND, 10 * SECOND] as const;

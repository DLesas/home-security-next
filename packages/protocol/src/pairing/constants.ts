/**
 * Pairing over Bluetooth (docs/m3-design.md section 5, D133): the fixed values both ends share.
 * Frozen by the joint step 0 (m3-design section 10, item 4); the implementations are P3's (the
 * code and the board's QR code, then SRP6a and security 2), the board's side F1's.
 *
 * Values read from ESP-IDF v6.1.1's own sources on this Mac (`~/esp/esp-idf`, 2026-11-18) say so;
 * values marked † are the design's or this step's own choices, each to be pinned with the
 * firmware owner in wave 2b. Nothing here is a secret.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * The board's QR code (m3-design section 5, "The display"):
 * `hsn://pair/1?c=<code without its dash, percent-encoded>&d=<chip id, 12 lowercase hex>`. The
 * scheme is the protocol's, `hsn`, never the product's name (D128): boards in houses cannot change it.
 */
export const PAIR_QR = {
  prefix: "hsn://pair/1",
  /** The pairing code, its 8 characters without the dash. */
  codeParam: "c",
  /** The chip id (§10's Identity), 6 bytes as 12 lowercase hex digits. */
  chipParam: "d",
} as const;

/**
 * The pairing code (PR6, D85): 8 characters of Crockford base32, shown `XXXX-XXXX`: 7 of secret
 * (35 bits) and a check character, made and read as the linking code's (m2-design section 5: the
 * value mod 37, Crockford's alphabet then `*~$=U`; case, spaces, dashes, `I` and `L` as `1`, `O`
 * as `0` forgiven). Provisional until S9 shows a person can type it from the e-paper (†).
 */
export const PAIRING_CODE = {
  secretChars: 7,
  secretBits: 35,
  checkChars: 1,
  /** Shown as two groups of four. */
  groups: [4, 4],
  /** Wrong codes in one window before the board stops listening. */
  maxTries: 5,
  /** The pairing window (DS7). */
  windowMs: 2 * MINUTE,
} as const;

/**
 * Protocomm over BLE (m3-design section 5, layer 1): one GATT service, one characteristic per
 * endpoint, a request written and its answer read back. Pairing uses protocomm directly, not
 * ESP-IDF's provisioning manager, so the endpoint names are ours. A characteristic's 128-bit UUID
 * is the service's with bytes 12 and 13 (of its little-endian array) replaced by the endpoint's
 * 16-bit value (read in `protocomm_nimble.c`).
 */
export const PROTOCOMM = {
  /** The pairing service's UUID †, in the advertisement while a pairing window is open. */
  serviceUuid: "3b50aa44-5e8a-4831-ba12-b8b12a8b0c8f",
  endpoints: {
    /** Read in the clear before the session: `PairVersion` (pairing/types.ts). */
    protoVersion: { name: "proto-ver", uuid16: 0xff53 },
    /** The security 2 handshake (`Sec2Payload` messages). */
    session: { name: "prov-session", uuid16: 0xff51 },
    /** §10's setup messages, one per request, inside the session. */
    setup: { name: "hsn-setup", uuid16: 0xff60 },
  },
} as const;

/** What `proto-ver` answers, in the clear: the pairing protocol's label †. */
export const PAIR_PROTOCOL_LABEL = "hsn-pair/1";

/**
 * Protocomm security 2 (read in ESP-IDF v6.1.1's `protocomm/src/security/security2.c` and
 * `src/crypto/srp6a/esp_srp.c`): SRP6a over RFC 5054's 3,072-bit group with SHA-512, then
 * AES-256-GCM with the first 32 bytes of the SRP session key, a 12-byte nonce (an 8-byte session
 * id from the board, then a 32-bit big-endian counter starting at 1, one step per message) and a
 * 16-byte tag. The messages are protobuf `Sec2Payload` (`proto/sec2.proto`).
 */
export const PAIRING_SECURITY = {
  /** Protocomm's security version. */
  version: 2,
  srpGroupBits: 3072,
  srpHash: "SHA-512",
  /**
   * The SRP user name the phone sends and the board's verifier is made with: fixed †. The
   * password is the pairing code's 8 characters, upper case, without the dash, as ASCII.
   */
  username: "hsn",
  aesKeyBytes: 32,
  nonceBytes: 12,
  sessionIdBytes: 8,
  tagBytes: 16,
  firstCounter: 1,
} as const;

/** The pairing scan response. The advertisement carries only flags and the service UUID. */
export const PAIR_ADVERT = {
  namePrefix: "hsn-pair-",
  nameHexDigits: 4,
} as const;

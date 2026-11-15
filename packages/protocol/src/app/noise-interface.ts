/**
 * The Noise state machine's interface (docs/m2-design.md section 5, "The channel: Noise"), not
 * its implementation: owner A1 writes it in `noise.ts` and checks it against the published Noise
 * vectors and ours. Both patterns use X25519, ChaCha20-Poly1305 and SHA-256 (`@noble/*`).
 */

export const NOISE_PATTERNS = {
  session: "Noise_IK_25519_ChaChaPoly_SHA256",
  link: "Noise_XXpsk3_25519_ChaChaPoly_SHA256",
} as const;
export type NoisePattern = (typeof NOISE_PATTERNS)[keyof typeof NOISE_PATTERNS];

/** Why a handshake or a transport message failed. Any failure ends the session (section 5, "Failure"). */
export type NoiseError =
  /** A Diffie-Hellman result was all zero: a low-order public key. */
  | "allZeroDh"
  /** A message too short or too long for the state it arrived in. */
  | "badMessage"
  /** A tag that did not verify. */
  | "decryptFailed"
  /** A call out of turn: writing when it is the other side's turn, splitting early. */
  | "wrongState"
  /** A message past 65,535 bytes. */
  | "tooLong"
  /** The 2⁶⁴ − 1 nonces are used up (a session never lives that long, section 5). */
  | "nonceExhausted";

export type NoiseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: NoiseError };

/**
 * A static key whose Diffie-Hellman is a function, so the same code serves a browser's
 * non-extractable Web Crypto key, the hub's key and the phone's (section 5). Asynchronous,
 * because Web Crypto's `deriveBits` is.
 */
export interface StaticKey {
  readonly publicKey: Uint8Array;
  dh(theirPublic: Uint8Array): Promise<Uint8Array>;
}

/** An ephemeral key pair, made by the implementation; vectors give fixed ones. */
export interface EphemeralKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

export interface HandshakeOptions {
  readonly pattern: NoisePattern;
  readonly initiator: boolean;
  readonly prologue: Uint8Array;
  readonly staticKey: StaticKey;
  /** The responder's static key, known to an IK initiator from linking. */
  readonly remoteStatic?: Uint8Array;
  /**
   * XXpsk3's pre-shared key, 32 bytes: the initiator's. The responder is made without one and
   * given it by `setPsk` after reading message 1, whose payload names the token (section 5).
   */
  readonly psk?: Uint8Array;
  /** Fixed ephemeral keys, for the vectors only. */
  readonly ephemeral?: EphemeralKeyPair;
}

/** One side of a handshake. */
export interface Handshake {
  /** Writes the next handshake message with `payload`. */
  writeMessage(payload: Uint8Array): Promise<NoiseResult<Uint8Array>>;
  /** Reads the next handshake message, returning its payload. */
  readMessage(message: Uint8Array): Promise<NoiseResult<Uint8Array>>;
  /**
   * XXpsk3's responder only, after reading message 1 and before message 3: the pre-shared key of
   * the token message 1 named. Reading message 3 without one is `wrongState`, as is a second call
   * or one on an initiator or an IK side.
   */
  setPsk(psk: Uint8Array): NoiseResult<void>;
  /** True once every message of the pattern is through. */
  readonly complete: boolean;
  /** The other side's static key, once a message has carried it. */
  remoteStatic(): Uint8Array | undefined;
  /** The handshake hash, for the vectors. */
  handshakeHash(): Uint8Array;
  /** The transport session, once complete. */
  split(): NoiseResult<TransportSession>;
}

/** The two cipher states after the handshake, each with its own nonce. */
export interface TransportSession {
  encrypt(plaintext: Uint8Array): NoiseResult<Uint8Array>;
  decrypt(message: Uint8Array): NoiseResult<Uint8Array>;
}

/** What `noise.ts` exports: one function that starts either side of either pattern. */
export type StartHandshake = (options: HandshakeOptions) => NoiseResult<Handshake>;

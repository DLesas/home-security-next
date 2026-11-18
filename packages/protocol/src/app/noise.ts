/**
 * The Noise state machine (docs/m2-design.md section 5, "The channel: Noise"), behind the frozen
 * `noise-interface.ts`: `Noise_IK_25519_ChaChaPoly_SHA256` for sessions,
 * `Noise_XXpsk3_25519_ChaChaPoly_SHA256` for linking and restore, and
 * `Noise_XN_25519_ChaChaPoly_SHA256` for the relay's links (docs/m4-design.md section 3, D125),
 * whose responder has no static key: it is given `NO_STATIC_KEY`.
 *
 * Every step follows the Noise Protocol Framework, revision 34 (noiseprotocol.org/noise.html),
 * section by section: the CipherState (5.1), the SymmetricState (5.2), the HandshakeState (5.3),
 * HKDF (4.3), pre-shared keys (9: `e` also mixes into the key, `psk` is MixKeyAndHash), the 25519,
 * ChaChaPoly and SHA256 functions (12.1, 12.3, 12.5). The primitives are `@noble/curves`,
 * `@noble/ciphers` and `@noble/hashes` (stack.md); nothing else here is cryptography.
 *
 * Two things the design adds to Noise, both allowed by it:
 * - Every Diffie-Hellman result that is all zero, which a low-order public key produces, ends the
 *   handshake (section 5; Noise 12.1 allows signalling an error). `@noble/curves` already refuses
 *   such keys by throwing, and Web Crypto's `deriveBits` rejects them; both count as `allZeroDh`.
 * - Any failure ends the handshake or the session (section 5, "Failure"): after one, every call
 *   answers `wrongState`, and the keys it held are wiped.
 *
 * No key and no plaintext is ever logged; errors carry only their code.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { NOISE_LIMITS } from "./constants.ts";
import {
  type EphemeralKeyPair,
  type Handshake,
  type HandshakeOptions,
  NOISE_PATTERNS,
  type NoiseError,
  type NoisePattern,
  type NoiseResult,
  type StartHandshake,
  type StaticKey,
  type TransportSession,
} from "./noise-interface.ts";

const DHLEN = NOISE_LIMITS.keyBytes;
const HASHLEN = 32;
const TAGLEN = NOISE_LIMITS.tagBytes;
const PSKLEN = 32;
/** 2⁶⁴ − 1 is reserved (Noise 5.1): a CipherState whose n reaches it refuses to go on. */
const MAX_NONCE = 2n ** 64n - 1n;
const EMPTY = new Uint8Array(0);

function ok<T>(value: T): NoiseResult<T> {
  return { ok: true, value };
}

function fail<T = never>(error: NoiseError): NoiseResult<T> {
  return { ok: false, error };
}

/** Overwrites every buffer with zeros. */
export function wipe(...buffers: readonly (Uint8Array | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** True when every byte is zero, in time that depends only on the length. */
export function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const byte of bytes) acc |= byte;
  return acc === 0;
}

/** Equal bytes, in time that depends only on the length. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ----- Hash functions (Noise 4.3, 12.5) -----

/** HKDF(chaining_key, input_key_material, num_outputs), exactly as Noise 4.3 defines it. */
export function hkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tempKey = hmac(sha256, chainingKey, ikm);
  const output1 = hmac(sha256, tempKey, Uint8Array.of(0x01));
  const input2 = concat(output1, Uint8Array.of(0x02));
  const output2 = hmac(sha256, tempKey, input2);
  wipe(input2);
  if (outputs === 2) {
    wipe(tempKey);
    return [output1, output2];
  }
  const input3 = concat(output2, Uint8Array.of(0x03));
  const output3 = hmac(sha256, tempKey, input3);
  wipe(input3, tempKey);
  return [output1, output2, output3];
}

// ----- The CipherState (Noise 5.1, 12.3) -----

/** ChaChaPoly's nonce (Noise 12.3): 32 bits of zeros, then n as 64 bits little-endian. */
export function chachaNonce(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, n, true);
  return nonce;
}

export class CipherState {
  private k: Uint8Array | undefined = undefined;
  private n = 0n;

  /** InitializeKey(key): takes ownership of `key`, wiping the key it held. */
  initializeKey(key: Uint8Array | undefined): void {
    wipe(this.k);
    this.k = key;
    this.n = 0n;
  }

  hasKey(): boolean {
    return this.k !== undefined;
  }

  /** SetNonce(nonce) (Noise 5.1). Used here only by tests of nonce exhaustion. */
  setNonce(nonce: bigint): void {
    this.n = nonce;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): NoiseResult<Uint8Array> {
    if (this.k === undefined) return ok(plaintext.slice());
    if (this.n >= MAX_NONCE) return fail("nonceExhausted");
    let sealed: Uint8Array;
    try {
      sealed = chacha20poly1305(this.k, chachaNonce(this.n), ad).encrypt(plaintext);
    } catch {
      return fail("wrongState");
    }
    this.n += 1n;
    return ok(sealed);
  }

  /** On an authentication failure n is not incremented (Noise 5.1). */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): NoiseResult<Uint8Array> {
    if (this.k === undefined) return ok(ciphertext.slice());
    if (this.n >= MAX_NONCE) return fail("nonceExhausted");
    if (ciphertext.length < TAGLEN) return fail("badMessage");
    let opened: Uint8Array;
    try {
      opened = chacha20poly1305(this.k, chachaNonce(this.n), ad).decrypt(ciphertext);
    } catch {
      return fail("decryptFailed");
    }
    this.n += 1n;
    return ok(opened);
  }

  wipe(): void {
    this.initializeKey(undefined);
  }

  /** The key it holds, for tests that check wiping. */
  heldKey(): Uint8Array | undefined {
    return this.k;
  }
}

// ----- The SymmetricState (Noise 5.2) -----

export class SymmetricState {
  readonly cipher = new CipherState();
  private ck: Uint8Array;
  private h: Uint8Array;

  /** InitializeSymmetric(protocol_name). */
  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = sha256(name);
    }
    this.ck = this.h.slice();
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = hkdf(this.ck, ikm, 2);
    wipe(this.ck);
    this.ck = ck ?? new Uint8Array(HASHLEN);
    this.cipher.initializeKey(tempK);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, tempK] = hkdf(this.ck, ikm, 3);
    wipe(this.ck);
    this.ck = ck ?? new Uint8Array(HASHLEN);
    this.mixHash(tempH ?? EMPTY);
    wipe(tempH);
    this.cipher.initializeKey(tempK);
  }

  handshakeHash(): Uint8Array {
    return this.h.slice();
  }

  encryptAndHash(plaintext: Uint8Array): NoiseResult<Uint8Array> {
    const sealed = this.cipher.encryptWithAd(this.h, plaintext);
    if (sealed.ok) this.mixHash(sealed.value);
    return sealed;
  }

  decryptAndHash(ciphertext: Uint8Array): NoiseResult<Uint8Array> {
    const opened = this.cipher.decryptWithAd(this.h, ciphertext);
    if (opened.ok) this.mixHash(ciphertext);
    return opened;
  }

  /** Split(): the two CipherStates, initiator to responder first. Wipes the chaining key. */
  split(): readonly [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2);
    const c1 = new CipherState();
    const c2 = new CipherState();
    c1.initializeKey(k1);
    c2.initializeKey(k2);
    this.wipe();
    return [c1, c2];
  }

  /** Wipes the chaining key and the handshake's cipher key; `h` is kept (Noise 5). */
  wipe(): void {
    wipe(this.ck);
    this.cipher.wipe();
  }

  /** The secrets it holds, for tests that check wiping. */
  heldSecrets(): readonly Uint8Array[] {
    const key = this.cipher.heldKey();
    return key === undefined ? [this.ck] : [this.ck, key];
  }
}

// ----- The two patterns (Noise 7.5, 9.4) -----

export type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";

interface PatternDefinition {
  /** `<- s` before the messages: the responder's static key is known to the initiator. */
  readonly responderStaticPremessage: boolean;
  /** A PSK pattern: every `e` is also MixKey(e.public_key) (Noise 9.2). */
  readonly psk: boolean;
  readonly messages: readonly (readonly Token[])[];
}

/**
 * IK:              XXpsk3:            XN (Noise 7.4):
 *   <- s             -> e               -> e
 *   ...              <- e, ee, s, es    <- e, ee
 *   -> e, es, s, ss  -> s, se, psk      -> s, se
 *   <- e, ee, se
 */
export const PATTERNS: Readonly<Partial<Record<NoisePattern, PatternDefinition>>> = {
  [NOISE_PATTERNS.session]: {
    responderStaticPremessage: true,
    psk: false,
    messages: [
      ["e", "es", "s", "ss"],
      ["e", "ee", "se"],
    ],
  },
  [NOISE_PATTERNS.link]: {
    responderStaticPremessage: false,
    psk: true,
    messages: [["e"], ["e", "ee", "s", "es"], ["s", "se", "psk"]],
  },
  [NOISE_PATTERNS.relay]: {
    responderStaticPremessage: false,
    psk: false,
    messages: [["e"], ["e", "ee"], ["s", "se"]],
  },
};

/**
 * Whether a side of a pattern holds a static key: the responder of a `<- s` pre-message, or a side
 * that sends `s` in one of its messages. Every side of IK and XXpsk3 does; XN's responder does not.
 */
export function holdsStaticKey(definition: PatternDefinition, initiator: boolean): boolean {
  if (definition.responderStaticPremessage && !initiator) return true;
  return definition.messages.some(
    (tokens, index) => (index % 2 === 0) === initiator && tokens.includes("s"),
  );
}

/**
 * The static key of a side that has none (XN's responder, the relay or the push service): an empty
 * public key, and a Diffie-Hellman that gives nothing, which `checkedDh` would refuse as
 * `allZeroDh`. The pattern never calls it; `startHandshake` refuses any other key for such a side,
 * and this one for a side that holds a static key.
 */
export const NO_STATIC_KEY: StaticKey = Object.freeze({
  publicKey: new Uint8Array(0),
  dh: () => Promise.resolve(new Uint8Array(0)),
});

/**
 * The length of a handshake message with `payloadBytes` of payload, given whether the cipher has
 * a key when the message starts: every DH and `psk` token sets one, as does `e` in a PSK pattern.
 */
export function handshakeMessageLength(
  tokens: readonly Token[],
  psk: boolean,
  keyedAtStart: boolean,
  payloadBytes: number,
): number {
  let keyed = keyedAtStart;
  let length = 0;
  for (const token of tokens) {
    if (token === "e") {
      length += DHLEN;
      if (psk) keyed = true;
    } else if (token === "s") {
      length += DHLEN + (keyed ? TAGLEN : 0);
    } else {
      keyed = true;
    }
  }
  return length + payloadBytes + (keyed ? TAGLEN : 0);
}

// ----- Diffie-Hellman (Noise 12.1) -----

/** X25519 with a local private key; a refused or all-zero result is `allZeroDh`. */
function ephemeralDh(privateKey: Uint8Array, theirPublic: Uint8Array): NoiseResult<Uint8Array> {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(privateKey, theirPublic);
  } catch {
    return fail("allZeroDh");
  }
  return checkedDh(shared);
}

function checkedDh(shared: Uint8Array): NoiseResult<Uint8Array> {
  if (shared.length !== DHLEN || isAllZero(shared)) {
    wipe(shared);
    return fail("allZeroDh");
  }
  return ok(shared);
}

/** A static key's Diffie-Hellman, a function that may run elsewhere (Web Crypto). */
async function staticDh(key: StaticKey, theirPublic: Uint8Array): Promise<NoiseResult<Uint8Array>> {
  let shared: Uint8Array;
  try {
    shared = await key.dh(theirPublic.slice());
  } catch {
    // Web Crypto's deriveBits rejects an all-zero result; @noble/curves throws on a low-order key.
    return fail("allZeroDh");
  }
  return checkedDh(shared);
}

/** A static key held in memory as its 32-byte X25519 private key (the hub's, the phone's). */
export function x25519StaticKey(privateKey: Uint8Array): NoiseResult<StaticKey> {
  if (privateKey.length !== DHLEN) return fail("wrongState");
  const secret = privateKey.slice();
  const publicKey = x25519.getPublicKey(secret);
  return ok({
    publicKey,
    dh: (theirPublic: Uint8Array) =>
      Promise.resolve().then(() => x25519.getSharedSecret(secret, theirPublic)),
  });
}

/** True when `remoteStatic` hashes to `identity`, the hub's app identity's 16 bytes (section 5). */
export function matchesIdentity(remoteStatic: Uint8Array, identity: Uint8Array): boolean {
  return constantTimeEqual(sha256(remoteStatic).slice(0, identity.length), identity);
}

// ----- The HandshakeState (Noise 5.3) -----

interface LocalEphemeral {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

function isKey(bytes: Uint8Array | undefined): bytes is Uint8Array {
  return bytes?.length === DHLEN;
}

function copyEphemeral(pair: EphemeralKeyPair): LocalEphemeral | undefined {
  if (!isKey(pair.privateKey) || !isKey(pair.publicKey)) return undefined;
  const privateKey = pair.privateKey.slice();
  if (!constantTimeEqual(x25519.getPublicKey(privateKey), pair.publicKey)) {
    wipe(privateKey);
    return undefined;
  }
  return { publicKey: pair.publicKey.slice(), privateKey };
}

export class NoiseHandshake implements Handshake {
  private readonly symmetric: SymmetricState;
  private readonly definition: PatternDefinition;
  private e: LocalEphemeral | undefined = undefined;
  private rs: Uint8Array | undefined;
  private re: Uint8Array | undefined = undefined;
  private psk: Uint8Array | undefined;
  private fixedEphemeral: LocalEphemeral | undefined;
  private index = 0;
  private failed = false;
  private busy = false;
  private splitDone = false;

  constructor(
    private readonly options: HandshakeOptions,
    definition: PatternDefinition,
    fixedEphemeral: LocalEphemeral | undefined,
  ) {
    this.definition = definition;
    this.symmetric = new SymmetricState(options.pattern);
    this.psk = options.psk?.slice();
    this.fixedEphemeral = fixedEphemeral;
    this.rs = options.remoteStatic?.slice();
    this.symmetric.mixHash(options.prologue);
    if (this.definition.responderStaticPremessage) {
      const responderStatic = options.initiator ? this.rs : options.staticKey.publicKey;
      this.symmetric.mixHash(responderStatic ?? EMPTY);
    }
  }

  get complete(): boolean {
    return !this.failed && this.index === this.definition.messages.length;
  }

  /**
   * XXpsk3's responder, after reading message 1 (whose payload names the token) and before reading
   * message 3, the only message that uses it (m2-design.md sections 5 and 11). Anything else is
   * `wrongState` and ends the handshake: an initiator or an IK side, a second call, a call before
   * message 1 or after message 3, a key that is not 32 bytes.
   */
  setPsk(psk: Uint8Array): NoiseResult<void> {
    const allowed =
      this.definition.psk &&
      !this.options.initiator &&
      !this.failed &&
      !this.busy &&
      this.psk === undefined &&
      this.index >= 1 &&
      this.index < this.definition.messages.length &&
      psk.length === PSKLEN;
    if (!allowed) return this.end("wrongState");
    this.psk = psk.slice();
    return ok(undefined);
  }

  /** An XXpsk3 responder still waiting for `setPsk`. */
  needsPsk(): boolean {
    return this.definition.psk && !this.options.initiator && this.psk === undefined;
  }

  remoteStatic(): Uint8Array | undefined {
    return this.rs?.slice();
  }

  handshakeHash(): Uint8Array {
    return this.symmetric.handshakeHash();
  }

  async writeMessage(payload: Uint8Array): Promise<NoiseResult<Uint8Array>> {
    if (!this.mayProcess(true)) return this.end("wrongState");
    this.busy = true;
    const written = await this.write(payload);
    this.busy = false;
    return written.ok ? written : this.end(written.error);
  }

  async readMessage(message: Uint8Array): Promise<NoiseResult<Uint8Array>> {
    if (!this.mayProcess(false)) return this.end("wrongState");
    this.busy = true;
    const read = await this.read(message);
    this.busy = false;
    return read.ok ? read : this.end(read.error);
  }

  split(): NoiseResult<TransportSession> {
    if (this.failed || this.busy || this.splitDone || !this.complete) return this.end("wrongState");
    const [c1, c2] = this.symmetric.split();
    this.splitDone = true;
    this.wipeSecrets();
    return ok(this.options.initiator ? new NoiseTransport(c1, c2) : new NoiseTransport(c2, c1));
  }

  /** The secrets it still holds, for tests that check wiping. */
  heldSecrets(): readonly Uint8Array[] {
    return [
      ...this.symmetric.heldSecrets(),
      ...(this.e === undefined ? [] : [this.e.privateKey]),
      ...(this.fixedEphemeral === undefined ? [] : [this.fixedEphemeral.privateKey]),
      ...(this.psk === undefined ? [] : [this.psk]),
    ];
  }

  private writerIsInitiator(): boolean {
    return this.index % 2 === 0;
  }

  private mayProcess(writing: boolean): boolean {
    if (this.failed || this.busy || this.index >= this.definition.messages.length) return false;
    return (this.writerIsInitiator() === this.options.initiator) === writing;
  }

  private end<T>(error: NoiseError): NoiseResult<T> {
    this.failed = true;
    this.wipeSecrets();
    return fail(error);
  }

  private wipeSecrets(): void {
    this.symmetric.wipe();
    wipe(this.e?.privateKey, this.fixedEphemeral?.privateKey, this.psk);
    this.e = undefined;
    this.fixedEphemeral = undefined;
  }

  private tokens(): readonly Token[] {
    return this.definition.messages[this.index] ?? [];
  }

  private async write(payload: Uint8Array): Promise<NoiseResult<Uint8Array>> {
    const tokens = this.tokens();
    const length = handshakeMessageLength(
      tokens,
      this.definition.psk,
      this.symmetric.cipher.hasKey(),
      payload.length,
    );
    if (length > NOISE_LIMITS.maxMessageBytes) return fail("tooLong");
    const parts: Uint8Array[] = [];
    for (const token of tokens) {
      if (token === "e") {
        const e = this.newEphemeral();
        this.e = e;
        parts.push(e.publicKey);
        this.mixEphemeral(e.publicKey);
      } else if (token === "s") {
        const sealed = this.symmetric.encryptAndHash(this.options.staticKey.publicKey);
        if (!sealed.ok) return sealed;
        parts.push(sealed.value);
      } else {
        const mixed = await this.mixToken(token);
        if (!mixed.ok) return mixed;
      }
      if (this.failed) return fail("wrongState");
    }
    const sealed = this.symmetric.encryptAndHash(payload);
    if (!sealed.ok) return sealed;
    parts.push(sealed.value);
    this.index += 1;
    return ok(concat(...parts));
  }

  private async read(message: Uint8Array): Promise<NoiseResult<Uint8Array>> {
    if (message.length > NOISE_LIMITS.maxMessageBytes) return fail("tooLong");
    const tokens = this.tokens();
    const shortest = handshakeMessageLength(
      tokens,
      this.definition.psk,
      this.symmetric.cipher.hasKey(),
      0,
    );
    if (message.length < shortest) return fail("badMessage");
    // A message with the `psk` token read before `setPsk`: nothing is computed.
    if (tokens.includes("psk") && this.psk === undefined) return fail("wrongState");
    let at = 0;
    for (const token of tokens) {
      if (token === "e") {
        const re = message.slice(at, at + DHLEN);
        at += DHLEN;
        this.re = re;
        this.mixEphemeral(re);
      } else if (token === "s") {
        const length = DHLEN + (this.symmetric.cipher.hasKey() ? TAGLEN : 0);
        const opened = this.symmetric.decryptAndHash(message.slice(at, at + length));
        at += length;
        if (!opened.ok) return opened;
        this.rs = opened.value;
      } else {
        const mixed = await this.mixToken(token);
        if (!mixed.ok) return mixed;
      }
      if (this.failed) return fail("wrongState");
    }
    const opened = this.symmetric.decryptAndHash(message.slice(at));
    if (!opened.ok) return opened;
    this.index += 1;
    return opened;
  }

  /** `e`: MixHash(e.public_key), and in a PSK pattern MixKey(e.public_key) too (Noise 9.2). */
  private mixEphemeral(publicKey: Uint8Array): void {
    this.symmetric.mixHash(publicKey);
    if (this.definition.psk) this.symmetric.mixKey(publicKey);
  }

  private newEphemeral(): LocalEphemeral {
    const fixed = this.fixedEphemeral;
    if (fixed !== undefined) {
      this.fixedEphemeral = undefined;
      return fixed;
    }
    const privateKey = x25519.utils.randomSecretKey();
    return { publicKey: x25519.getPublicKey(privateKey), privateKey };
  }

  /** The DH tokens and `psk` (Noise 5.3, 9.2). */
  private async mixToken(token: Exclude<Token, "e" | "s">): Promise<NoiseResult<true>> {
    if (token === "psk") {
      if (this.psk === undefined) return fail("wrongState");
      this.symmetric.mixKeyAndHash(this.psk);
      return ok(true);
    }
    const initiator = this.options.initiator;
    // Which local key meets which remote key (Noise 5.3): `es` is e with rs for the initiator, s
    // with re for the responder; `se` the other way round.
    const localEphemeral =
      token === "ee" || (token === "es" && initiator) || (token === "se" && !initiator);
    const remoteEphemeral =
      token === "ee" || (token === "es" && !initiator) || (token === "se" && initiator);
    const remote = remoteEphemeral ? this.re : this.rs;
    if (remote === undefined) return fail("wrongState");
    let shared: NoiseResult<Uint8Array>;
    if (localEphemeral) {
      if (this.e === undefined) return fail("wrongState");
      shared = ephemeralDh(this.e.privateKey, remote);
    } else {
      shared = await staticDh(this.options.staticKey, remote);
    }
    if (!shared.ok) return shared;
    this.symmetric.mixKey(shared.value);
    wipe(shared.value);
    return ok(true);
  }
}

// ----- Transport (Noise 5, section 5's "Order", "Failure") -----

export class NoiseTransport implements TransportSession {
  private ended = false;

  constructor(
    private readonly sending: CipherState,
    private readonly receiving: CipherState,
  ) {}

  encrypt(plaintext: Uint8Array): NoiseResult<Uint8Array> {
    if (this.ended) return fail("wrongState");
    if (plaintext.length > NOISE_LIMITS.maxPlaintextBytes) return this.end("tooLong");
    const sealed = this.sending.encryptWithAd(EMPTY, plaintext);
    return sealed.ok ? sealed : this.end(sealed.error);
  }

  /** In order only: a message out of order, repeated or altered fails, and ends the session. */
  decrypt(message: Uint8Array): NoiseResult<Uint8Array> {
    if (this.ended) return fail("wrongState");
    if (message.length > NOISE_LIMITS.maxMessageBytes) return this.end("tooLong");
    // Shorter than a tag is `badMessage`, from decryptWithAd.
    const opened = this.receiving.decryptWithAd(EMPTY, message);
    return opened.ok ? opened : this.end(opened.error);
  }

  /** The keys it still holds, for tests that check wiping. */
  heldKeys(): readonly Uint8Array[] {
    return [this.sending.heldKey(), this.receiving.heldKey()].filter(
      (key): key is Uint8Array => key !== undefined,
    );
  }

  private end<T>(error: NoiseError): NoiseResult<T> {
    this.ended = true;
    this.sending.wipe();
    this.receiving.wipe();
    return fail(error);
  }
}

// ----- Starting a handshake -----

/**
 * Starts either side of any of the three patterns. Options the pattern cannot use are refused as
 * `wrongState`: an IK initiator without the hub's static key, a responder or an XXpsk3 or XN side
 * given one, an XXpsk3 initiator without a 32-byte pre-shared key, an XXpsk3 responder or an IK
 * or XN side with one (the responder's comes later, by `setPsk`), keys of the wrong length, an XN
 * responder given any static key but `NO_STATIC_KEY` (one with an empty public key) and any other
 * side given that one, a fixed ephemeral whose public key is not its private key's.
 */
export const startHandshake: StartHandshake = (options) => {
  const definition = Object.hasOwn(PATTERNS, options.pattern)
    ? PATTERNS[options.pattern]
    : undefined;
  if (definition === undefined) return fail("wrongState");
  const staticKeyFits = holdsStaticKey(definition, options.initiator)
    ? isKey(options.staticKey.publicKey)
    : options.staticKey.publicKey.length === 0;
  if (!staticKeyFits) return fail("wrongState");
  const wantsRemoteStatic = definition.responderStaticPremessage && options.initiator;
  if (wantsRemoteStatic !== (options.remoteStatic !== undefined)) return fail("wrongState");
  if (options.remoteStatic !== undefined && !isKey(options.remoteStatic)) {
    return fail("wrongState");
  }
  // XXpsk3: the initiator is given its key here, the responder by `setPsk` after message 1.
  const wantsPsk = definition.psk && options.initiator;
  if (wantsPsk !== (options.psk !== undefined)) return fail("wrongState");
  if (options.psk !== undefined && options.psk.length !== PSKLEN) return fail("wrongState");
  let fixed: LocalEphemeral | undefined;
  if (options.ephemeral !== undefined) {
    fixed = copyEphemeral(options.ephemeral);
    if (fixed === undefined) return fail("wrongState");
  }
  return ok(new NoiseHandshake(options, definition, fixed));
};

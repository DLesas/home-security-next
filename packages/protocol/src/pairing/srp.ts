/**
 * SRP6a as protocomm security 2 runs it, the phone's side, over BigInt and noble's SHA-512. Built
 * to what ESP-IDF v6.1.1's `components/protocomm/src/crypto/srp6a/esp_srp.c` computes (P3's report
 * lists where it differs from RFC 5054 and from the design), and checked against vectors made by
 * that code (`vectors/pairing-srp.json`):
 *
 *   N, g = RFC 5054's 3,072-bit group, g = 5; H = SHA-512; PAD(n) = n as 384 bytes, big-endian
 *   k    = H(N | PAD(g))
 *   x    = H(salt | H(username ":" password))
 *   A    = g^a mod N, sent as 384 bytes; a is 32 random bytes
 *   u    = H(PAD(A) | PAD(B))
 *   S    = (B - k g^x)^(a + u x) mod N
 *   K    = H(S), over S's minimal big-endian bytes (esp_srp.c's `esp_mpi_to_bin`)
 *   M    = H((H(N) xor H(PAD(g))) | H(username) | salt | A | B | K), A and B exactly as sent
 *   AMK  = H(A | M | K): the board's proof
 *
 * The board's checks are mirrored: B is refused when it is 0 mod N or not below N (RFC 5054 2.5.4),
 * u when it is 0 (2.5.3), and so is a salt other than security2.c's 16 bytes. The board's proof is
 * compared in constant time.
 *
 * Timing. The password is always a pairing code's 8 ASCII characters, so its length is fixed and
 * nothing here depends on it. The exponentiations run a Montgomery ladder over a fixed number of
 * bits (256 for a, 512 for x, 1,032 for a + u x), one multiplication and one squaring a bit,
 * whatever the bit, with values kept between N and 2N so every product is of the same size, and
 * the bit applied by masks rather than a branch. What this cannot do: JavaScript's BigInt
 * arithmetic makes no constant-time promise, its multiplication and remainder may take longer or
 * shorter by value, and an engine may optimise them differently; the leak, if any, is of x, the
 * code's hash, through the phone's own CPU, to someone who can time it there. K = H(S) over S's
 * minimal bytes takes one block less when S's top byte is zero; that is protocomm's own rule, the
 * board does the same, and it says nothing about the code.
 */
import { sha512 } from "@noble/hashes/sha2.js";
import { concatBytes, toHex } from "../bytes.ts";

/** RFC 5054's 3,072-bit prime, as esp_srp.c's `N_3072`. */
const N_HEX =
  "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404dd" +
  "ef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7ed" +
  "ee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f" +
  "83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3b" +
  "e39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa0510" +
  "15728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7" +
  "abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200c" +
  "bbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a93ad2caffffffffffffffff";

const N = BigInt(`0x${N_HEX}`);
const G = 5n;

/** Security 2's sizes (security2.c: PUBLIC_KEY_LEN, SALT_LEN, CLIENT_PROOF_LEN). */
export const SRP = {
  /** Every public value and PAD() is this many bytes. */
  groupBytes: 384,
  saltBytes: 16,
  privateBytes: 32,
  hashBytes: 64,
} as const;

/** Bits the ladder runs for each exponent: a, x, and a + u x (below 2^256 + 2^1024). */
const BITS = { a: 8 * SRP.privateBytes, x: 8 * SRP.hashBytes, s: 1032 } as const;

const encoder = new TextEncoder();

function toBig(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${toHex(bytes)}`);
}

/** n as `length` bytes, big-endian; n must fit. */
function toPadded(n: bigint, length: number): Uint8Array {
  const hex = n.toString(16).padStart(2 * length, "0");
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** n's minimal big-endian bytes (none for 0), as Mbed TLS writes `mbedtls_mpi_size(n)` bytes. */
function toMinimal(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  return toPadded(n, Math.ceil(hex.length / 2));
}

const H = (...parts: readonly Uint8Array[]): Uint8Array => sha512(concatBytes(...parts));

const N_BYTES = toPadded(N, SRP.groupBytes);
const PAD_G = toPadded(G, SRP.groupBytes);
const K_MULTIPLIER = toBig(H(N_BYTES, PAD_G));
const HN_XOR_HG = ((hn: Uint8Array, hg: Uint8Array) => hn.map((b, i) => b ^ (hg[i] ?? 0)))(
  H(N_BYTES),
  H(PAD_G),
);

/**
 * base^exponent mod N by a Montgomery ladder over `bits` bits (the exponent must be below 2^bits).
 * Both registers stay in [N, 2N) and every step multiplies and squares, so the work does not
 * follow the exponent's bits or its length; see the file's header for what BigInt still leaks.
 */
function ladder(base: bigint, exponent: bigint, bits: number): bigint {
  let r0 = 1n + N;
  let r1 = (base % N) + N;
  for (let i = bits - 1; i >= 0; i--) {
    const mask = -((exponent >> BigInt(i)) & 1n);
    let t = mask & (r0 ^ r1);
    r0 ^= t;
    r1 ^= t;
    r1 = ((r0 * r1) % N) + N;
    r0 = ((r0 * r0) % N) + N;
    t = mask & (r0 ^ r1);
    r0 ^= t;
    r1 ^= t;
  }
  return r0 % N;
}

/** x = H(salt | H(username ":" password)). */
function privateX(username: Uint8Array, password: Uint8Array, salt: Uint8Array): bigint {
  return toBig(H(salt, H(username, encoder.encode(":"), password)));
}

/**
 * The verifier a board keeps, g^x mod N, in its minimal bytes as `esp_srp_gen_salt_verifier`
 * returns it (383 bytes when the top byte is zero). For the scripted boards and the vectors; a
 * real board makes its own from its code and never sends it.
 */
export function srpVerifier(
  username: Uint8Array,
  password: Uint8Array,
  salt: Uint8Array,
): Uint8Array {
  return toMinimal(ladder(G, privateX(username, password, salt), BITS.x));
}

/** A = g^a mod N, as the 384 bytes security 2 sends; undefined for an `a` not of 32 bytes or 0. */
export function srpClientPublic(clientPrivate: Uint8Array): Uint8Array | undefined {
  const a = toBig(clientPrivate);
  if (clientPrivate.length !== SRP.privateBytes || a === 0n) return undefined;
  return toPadded(ladder(G, a, BITS.a), SRP.groupBytes);
}

/** Why the phone refuses the board's response 0. */
export type SrpRefusal =
  /** The salt is not 16 bytes. */
  | "badSalt"
  /** B is empty, longer than 384 bytes, 0 mod N, or not below N. */
  | "badPublic"
  /** u = 0. */
  | "badScrambler";

export interface SrpProof {
  readonly u: Uint8Array;
  /** K = H(S), 64 bytes; security 2's AES key is its first 32. Never logged. */
  readonly sessionKey: Uint8Array;
  /** M, sent in command 1. */
  readonly clientProof: Uint8Array;
  /** AMK, which the board's proof must equal. */
  readonly deviceProof: Uint8Array;
}

export interface SrpProofInput {
  readonly username: Uint8Array;
  readonly password: Uint8Array;
  readonly salt: Uint8Array;
  readonly clientPrivate: Uint8Array;
  /** A as sent: the 384 bytes `srpClientPublic` gave. */
  readonly clientPublic: Uint8Array;
  /** B exactly as the board sent it. */
  readonly devicePublic: Uint8Array;
}

/**
 * The phone's proof and the session key, from the board's response 0, or why it is refused.
 * `hash` is SHA-512; a test gives another to reach the u = 0 refusal, which SHA-512 never gives.
 */
export function srpClientProof(
  input: SrpProofInput,
  hash: (data: Uint8Array) => Uint8Array = sha512,
):
  | { readonly ok: true; readonly value: SrpProof }
  | { readonly ok: false; readonly error: SrpRefusal } {
  const { username, password, salt, clientPrivate, clientPublic, devicePublic } = input;
  if (salt.length !== SRP.saltBytes) return { ok: false, error: "badSalt" };
  if (devicePublic.length === 0 || devicePublic.length > SRP.groupBytes)
    return { ok: false, error: "badPublic" };
  const B = toBig(devicePublic);
  if (B >= N || B === 0n) return { ok: false, error: "badPublic" };
  const h = (...parts: readonly Uint8Array[]): Uint8Array => hash(concatBytes(...parts));
  const uBytes = h(clientPublic, toPadded(B, SRP.groupBytes));
  const u = toBig(uBytes);
  if (u === 0n) return { ok: false, error: "badScrambler" };
  const x = toBig(h(salt, h(username, encoder.encode(":"), password)));
  const a = toBig(clientPrivate);
  const base = (((B - ((K_MULTIPLIER * ladder(G, x, BITS.x)) % N)) % N) + N) % N;
  // Only a board that does not know the verifier can make B = k g^x; nothing honest gives S = 0.
  if (base === 0n) return { ok: false, error: "badPublic" };
  const S = ladder(base, a + u * x, BITS.s);
  const sessionKey = h(toMinimal(S));
  const clientProof = h(HN_XOR_HG, h(username), salt, clientPublic, devicePublic, sessionKey);
  const deviceProof = h(clientPublic, clientProof, sessionKey);
  return { ok: true, value: { u: uBytes, sessionKey, clientProof, deviceProof } };
}

/**
 * The board's proof checked against AMK without stopping at the first difference (as
 * `crypto/ccm.ts`'s constantTimeEqual, which is not imported: that module reaches `node:crypto`).
 * The lengths are public.
 */
export function srpDeviceProofMatches(expected: Uint8Array, received: Uint8Array): boolean {
  if (expected.length !== received.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= (expected[i] ?? 0) ^ (received[i] ?? 0);
  return difference === 0;
}

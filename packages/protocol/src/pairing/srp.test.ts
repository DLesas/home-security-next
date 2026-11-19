/**
 * SRP6a (srp.ts) against every case ESP-IDF's esp_srp.c computed (`pairing-srp.json`), and each
 * of the board's checks mirrored on the phone, at its edge.
 */
import { describe, expect, test } from "bun:test";
import { sha512 } from "@noble/hashes/sha2.js";
import { fromHex, toHex } from "../bytes.ts";
import {
  SRP,
  srpClientProof,
  srpClientPublic,
  srpDeviceProofMatches,
  srpVerifier,
  type SrpProofInput,
} from "./srp.ts";
import { espIdfVectors } from "./vectors/esp-idf-vectors.ts";

const { srp } = espIdfVectors();
const encoder = new TextEncoder();
const N = BigInt(
  "0xffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404dd" +
    "ef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7ed" +
    "ee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f" +
    "83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3b" +
    "e39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa0510" +
    "15728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7" +
    "abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200c" +
    "bbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a93ad2caffffffffffffffff",
);
const big = (bytes: Uint8Array): bigint => (bytes.length === 0 ? 0n : BigInt(`0x${toHex(bytes)}`));
const padded = (n: bigint, length = 384): Uint8Array =>
  fromHex(n.toString(16).padStart(2 * length, "0"));
/** Square and multiply, plainly: the reference the ladder must equal. */
function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = base % N;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % N;
    b = (b * b) % N;
    e >>= 1n;
  }
  return result;
}

function inputOf(c: (typeof srp.cases)[number]): SrpProofInput {
  return {
    username: encoder.encode(c.username),
    password: encoder.encode(c.password),
    salt: fromHex(c.salt),
    clientPrivate: fromHex(c.clientPrivate),
    clientPublic: fromHex(c.clientPublic),
    devicePublic: fromHex(c.devicePublic),
  };
}

// The format requires at least one case.
const siren = srp.cases[0];

describe("SRP6a against ESP-IDF's esp_srp.c", () => {
  test("the file is ESP-IDF v6.1.1's, and covers the edges it names", () => {
    expect(srp.source).toContain(
      "ESP-IDF v6.1.1 (commit 051e4c4eb20346e043cdd47bc388fde75ff8af63)",
    );
    expect(srp.cases.map((c) => c.name)).toEqual([
      "a siren's code",
      "a sensor's code",
      "B with a leading zero byte, sent as 383 bytes",
      "S with a leading zero byte, so K hashes 383 bytes",
      "A with a leading zero byte, still sent as 384",
      "a verifier of 383 bytes",
      "ESP-IDF's own published salt and verifier (test_apps/main/test_srp.c: wifiprov, abcd1234)",
    ]);
    const lengths = srp.cases.map((c) => [
      c.devicePublic.length / 2,
      c.verifier.length / 2,
      c.clientPublic.slice(0, 2),
    ]);
    expect(lengths[2]?.[0]).toBe(383);
    expect(lengths[4]?.[2]).toBe("00");
    expect(lengths[5]?.[1]).toBe(383);
  });

  for (const c of srp.cases)
    test(`every value: ${c.name}`, () => {
      const input = inputOf(c);
      expect(toHex(srpVerifier(input.username, input.password, input.salt))).toBe(c.verifier);
      expect(toHex(srpClientPublic(input.clientPrivate) ?? new Uint8Array())).toBe(c.clientPublic);
      const proof = srpClientProof(input);
      expect(proof.ok).toBe(true);
      if (!proof.ok) return;
      expect(toHex(proof.value.u)).toBe(c.u);
      expect(toHex(proof.value.sessionKey)).toBe(c.sessionKey);
      expect(toHex(proof.value.clientProof)).toBe(c.clientProof);
      expect(toHex(proof.value.deviceProof)).toBe(c.deviceProof);
      // The board's side, from b: B = k v + g^b, and the same S.
      const k = big(sha512(new Uint8Array([...padded(N), ...padded(5n)])));
      const v = big(fromHex(c.verifier));
      const B = (k * v + modPow(5n, big(fromHex(c.devicePrivate)))) % N;
      expect(B).toBe(big(fromHex(c.devicePublic)));
    });

  test("the S case hashes 383 bytes: K = H(S) without S's leading zero", () => {
    const c = srp.cases[3];
    if (c === undefined) return;
    const A = big(fromHex(c.clientPublic));
    const v = big(fromHex(c.verifier));
    const S = modPow((A * modPow(v, big(fromHex(c.u)))) % N, big(fromHex(c.devicePrivate)));
    expect(S < 1n << (383n * 8n)).toBe(true);
    expect(toHex(sha512(padded(S, 383)))).toBe(c.sessionKey);
    expect(toHex(sha512(padded(S, 384)))).not.toBe(c.sessionKey);
  });

  test("the published case: ESP-IDF's own salt and verifier for wifiprov and abcd1234", () => {
    const c = srp.cases[6];
    expect(c?.username).toBe("wifiprov");
    expect(c?.salt).toBe("036ee0c7bcb9eda84c9eac97d93decf4");
    expect(c?.verifier.slice(0, 16)).toBe("7c7c85476508946d");
  });

  test("the ladder equals plain exponentiation at the exponent's edges", () => {
    for (const a of [1n, 2n, (1n << 255n) + 1n, (1n << 256n) - 1n]) {
      const bytes = padded(a, 32);
      expect(big(srpClientPublic(bytes) ?? new Uint8Array())).toBe(modPow(5n, a));
    }
  });
});

describe("the board's checks, mirrored", () => {
  const input = inputOf(siren);
  const refused = (change: Partial<SrpProofInput>) => {
    const r = srpClientProof({ ...input, ...change });
    return r.ok ? "accepted" : r.error;
  };

  test("B: 0, N, N + 1, above N, empty, 385 bytes; N - 1 and 1 are numbers it takes", () => {
    expect(refused({ devicePublic: new Uint8Array(384) })).toBe("badPublic");
    expect(refused({ devicePublic: new Uint8Array(1) })).toBe("badPublic");
    expect(refused({ devicePublic: padded(N) })).toBe("badPublic");
    expect(refused({ devicePublic: padded(N + 1n) })).toBe("badPublic");
    expect(refused({ devicePublic: new Uint8Array(384).fill(0xff) })).toBe("badPublic");
    expect(refused({ devicePublic: new Uint8Array(0) })).toBe("badPublic");
    expect(refused({ devicePublic: Uint8Array.of(0, ...padded(5n)) })).toBe("badPublic");
    expect(refused({ devicePublic: padded(N - 1n) })).toBe("accepted");
    expect(refused({ devicePublic: Uint8Array.of(1) })).toBe("accepted");
  });

  test("B = k g^x, which gives S = 0, is refused", () => {
    const k = big(sha512(new Uint8Array([...padded(N), ...padded(5n)])));
    const v = big(fromHex(siren.verifier));
    expect(refused({ devicePublic: padded((k * v) % N) })).toBe("badPublic");
    expect(refused({ devicePublic: padded(((k * v) % N) + 1n) })).toBe("accepted");
  });

  test("the salt: security2.c's 16 bytes, not 15 or 17", () => {
    expect(refused({ salt: input.salt.slice(1) })).toBe("badSalt");
    expect(refused({ salt: Uint8Array.of(...input.salt, 0) })).toBe("badSalt");
    expect(refused({ salt: new Uint8Array(0) })).toBe("badSalt");
  });

  test("u = 0 (RFC 5054 2.5.3), reached with a hash that gives zero for H(PAD(A) | PAD(B))", () => {
    const zeroU = (data: Uint8Array): Uint8Array =>
      data.length === 2 * SRP.groupBytes ? new Uint8Array(64) : sha512(data);
    const r = srpClientProof(input, zeroU);
    expect(r.ok ? "accepted" : r.error).toBe("badScrambler");
    // One bit of u set is enough.
    const oneU = (data: Uint8Array): Uint8Array =>
      data.length === 2 * SRP.groupBytes ? Uint8Array.of(...new Uint8Array(63), 1) : sha512(data);
    expect(srpClientProof(input, oneU).ok).toBe(true);
  });

  test("a: 32 bytes and not zero", () => {
    expect(srpClientPublic(new Uint8Array(32))).toBeUndefined();
    expect(srpClientPublic(new Uint8Array(31).fill(1))).toBeUndefined();
    expect(srpClientPublic(new Uint8Array(33).fill(1))).toBeUndefined();
    expect(srpClientPublic(padded(1n, 32))).toBeDefined();
  });

  test("a wrong password changes every value after B", () => {
    const wrong = srpClientProof({ ...input, password: encoder.encode("X42SA94W") });
    expect(wrong.ok).toBe(true);
    if (!wrong.ok) return;
    expect(toHex(wrong.value.u)).toBe(siren.u);
    expect(toHex(wrong.value.sessionKey)).not.toBe(siren.sessionKey);
    expect(toHex(wrong.value.clientProof)).not.toBe(siren.clientProof);
  });

  test("the board's proof: equal in full, any byte different is not", () => {
    const amk = fromHex(siren.deviceProof);
    expect(srpDeviceProofMatches(amk, amk.slice())).toBe(true);
    for (let i = 0; i < amk.length; i++) {
      const other = amk.slice();
      other[i] = (other[i] ?? 0) ^ 0x80;
      expect(srpDeviceProofMatches(amk, other)).toBe(false);
    }
    expect(srpDeviceProofMatches(amk, amk.slice(0, 63))).toBe(false);
  });
});

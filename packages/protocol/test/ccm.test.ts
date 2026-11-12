import { describe, expect, test } from "bun:test";
import { constantTimeEqual, createAesCcm, fromHex, toHex } from "../src/index.ts";
import { rfc3610Vectors } from "./fixtures/rfc3610.ts";

describe("AES-CCM against RFC 3610", () => {
  test.each(rfc3610Vectors.map((v) => [v.vector, v] as const))("packet vector #%i", (_, v) => {
    const tagLength = (v.ciphertextAndTag.length - v.plaintext.length) / 2;
    const ccm = createAesCcm(fromHex(v.key), tagLength);
    const nonce = fromHex(v.nonce);
    const aad = fromHex(v.aad);
    expect(toHex(ccm.seal(nonce, aad, fromHex(v.plaintext)))).toBe(v.ciphertextAndTag);
    const opened = ccm.open(nonce, aad, fromHex(v.ciphertextAndTag));
    expect(opened && toHex(opened)).toBe(v.plaintext);
  });
});

describe("AES-CCM tamper resistance", () => {
  const v = rfc3610Vectors[0];
  const ccm = createAesCcm(fromHex(v.key), 8);
  const nonce = fromHex(v.nonce);
  const aad = fromHex(v.aad);
  const sealed = fromHex(v.ciphertextAndTag);

  function flipped(bytes: Uint8Array, index: number, bit: number): Uint8Array {
    const copy = bytes.slice();
    copy[index] = (copy[index] ?? 0) ^ (1 << bit);
    return copy;
  }

  test("every flipped bit of ciphertext or tag is rejected", () => {
    for (let index = 0; index < sealed.length; index++) {
      for (let bit = 0; bit < 8; bit++) {
        expect(ccm.open(nonce, aad, flipped(sealed, index, bit))).toBeUndefined();
      }
    }
  });

  test("every flipped bit of nonce or associated data is rejected", () => {
    for (let index = 0; index < nonce.length; index++) {
      for (let bit = 0; bit < 8; bit++) {
        expect(ccm.open(flipped(nonce, index, bit), aad, sealed)).toBeUndefined();
      }
    }
    for (let index = 0; index < aad.length; index++) {
      for (let bit = 0; bit < 8; bit++) {
        expect(ccm.open(nonce, flipped(aad, index, bit), sealed)).toBeUndefined();
      }
    }
  });

  test("dropped, added or missing associated data is rejected", () => {
    expect(ccm.open(nonce, aad.subarray(1), sealed)).toBeUndefined();
    expect(ccm.open(nonce, new Uint8Array(0), sealed)).toBeUndefined();
    expect(ccm.open(nonce, fromHex(v.aad + "00"), sealed)).toBeUndefined();
  });

  test("input shorter than the tag, or cut short, is rejected without throwing", () => {
    for (let length = 0; length < sealed.length; length++) {
      expect(ccm.open(nonce, aad, sealed.subarray(0, length))).toBeUndefined();
    }
  });

  test("an empty plaintext with and without associated data round-trips", () => {
    for (const data of [new Uint8Array(0), aad]) {
      const out = ccm.seal(nonce, data, new Uint8Array(0));
      expect(out.length).toBe(8);
      expect(ccm.open(nonce, data, out)).toEqual(new Uint8Array(0));
    }
  });

  test("plaintexts across block boundaries round-trip", () => {
    for (const length of [1, 15, 16, 17, 31, 32, 33, 255, 1024]) {
      const plaintext = Uint8Array.from({ length }, (_, i) => i & 0xff);
      expect(ccm.open(nonce, aad, ccm.seal(nonce, aad, plaintext))).toEqual(plaintext);
    }
  });
});

describe("AES-CCM parameters", () => {
  const key = new Uint8Array(16);
  test.each([0, 2, 3, 5, 18])("tag length %i is refused", (tagLength) => {
    expect(() => createAesCcm(key, tagLength)).toThrow(RangeError);
  });

  test("keys other than 16 bytes are refused", () => {
    expect(() => createAesCcm(new Uint8Array(15), 8)).toThrow(RangeError);
    expect(() => createAesCcm(new Uint8Array(32), 8)).toThrow(RangeError);
  });

  test("nonces other than 13 bytes are refused", () => {
    const ccm = createAesCcm(key, 8);
    expect(() => ccm.seal(new Uint8Array(12), new Uint8Array(0), new Uint8Array(0))).toThrow(
      RangeError,
    );
    expect(() => ccm.open(new Uint8Array(14), new Uint8Array(0), new Uint8Array(8))).toThrow(
      RangeError,
    );
  });

  test("oversized plaintext and associated data are refused", () => {
    const ccm = createAesCcm(key, 8);
    const nonce = new Uint8Array(13);
    expect(() => ccm.seal(nonce, new Uint8Array(0), new Uint8Array(0x10000))).toThrow(RangeError);
    expect(() => ccm.seal(nonce, new Uint8Array(0xff00), new Uint8Array(0))).toThrow(RangeError);
  });

  test("the block cipher can be supplied, keeping the runtime part swappable", () => {
    let calls = 0;
    const ccm = createAesCcm(key, 8, () => ({
      encryptBlock(block) {
        calls++;
        return block.slice();
      },
    }));
    ccm.seal(new Uint8Array(13), new Uint8Array(0), new Uint8Array(1));
    expect(calls).toBeGreaterThan(0);
  });
});

describe("constantTimeEqual", () => {
  test("compares contents and lengths", () => {
    expect(constantTimeEqual(fromHex("0102"), fromHex("0102"))).toBe(true);
    expect(constantTimeEqual(fromHex("0102"), fromHex("0103"))).toBe(false);
    expect(constantTimeEqual(fromHex("0102"), fromHex("01"))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

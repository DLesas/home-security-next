/**
 * AES-CCM (RFC 3610) on top of an AES block cipher, because Bun has no built-in CCM (D94).
 * Fixed to the 13-byte nonce the protocol uses, which leaves a 2-byte length field.
 */
import { AES_BLOCK_LENGTH, type BlockCipherFactory, nodeAes128 } from "./blockCipher.ts";

export const CCM_NONCE_LENGTH = 13;
const LENGTH_FIELD_SIZE = 15 - CCM_NONCE_LENGTH;
const MAX_PLAINTEXT_LENGTH = 0xffff;
/** Longest associated data with RFC 3610's two-byte length prefix. */
const MAX_AAD_LENGTH = 0xfeff;
const FLAG_AAD_PRESENT = 0x40;

/** Sealing and opening under one key with one tag length. */
export interface AesCcm {
  /** Returns the ciphertext followed by the tag. */
  seal(nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /**
   * Returns the plaintext only if the tag verifies, and `undefined` otherwise. Never throws on
   * the `sealed` bytes; a wrong nonce or associated data size is a programmer error.
   */
  open(nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array | undefined;
}

/** Valid RFC 3610 tag lengths are 4 to 16 bytes, even. */
export function createAesCcm(
  key: Uint8Array,
  tagLength: number,
  blockCipher: BlockCipherFactory = nodeAes128,
): AesCcm {
  if (!Number.isInteger(tagLength) || tagLength < 4 || tagLength > 16 || tagLength % 2 !== 0) {
    throw new RangeError("CCM tag length must be an even number from 4 to 16");
  }
  const cipher = blockCipher(key);
  const encrypt = (block: Uint8Array): Uint8Array => cipher.encryptBlock(block);

  /** A_i in RFC 3610: the counter block that is encrypted to give key stream block i. */
  function keyStreamBlock(nonce: Uint8Array, index: number): Uint8Array {
    const block = new Uint8Array(AES_BLOCK_LENGTH);
    block[0] = LENGTH_FIELD_SIZE - 1;
    block.set(nonce, 1);
    writeBigEndian(block, index);
    return encrypt(block);
  }

  /** Counter-mode encryption from block 1; block 0 is kept for the tag. */
  function applyKeyStream(nonce: Uint8Array, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    for (let start = 0; start < data.length; start += AES_BLOCK_LENGTH) {
      const stream = keyStreamBlock(nonce, start / AES_BLOCK_LENGTH + 1);
      for (let i = start; i < Math.min(start + AES_BLOCK_LENGTH, data.length); i++) {
        out[i] = (data[i] ?? 0) ^ (stream[i - start] ?? 0);
      }
    }
    return out;
  }

  /** The CBC-MAC over B_0, the length-prefixed associated data and the plaintext, masked by S_0. */
  function tag(nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const b0 = new Uint8Array(AES_BLOCK_LENGTH);
    b0[0] =
      (aad.length > 0 ? FLAG_AAD_PRESENT : 0) |
      (((tagLength - 2) / 2) << 3) |
      (LENGTH_FIELD_SIZE - 1);
    b0.set(nonce, 1);
    writeBigEndian(b0, plaintext.length);

    let mac = encrypt(b0);
    if (aad.length > 0) {
      const prefixed = new Uint8Array(2 + aad.length);
      writeBigEndian(prefixed.subarray(0, 2), aad.length);
      prefixed.set(aad, 2);
      mac = cbcMacAbsorb(encrypt, mac, prefixed);
    }
    mac = cbcMacAbsorb(encrypt, mac, plaintext);
    return xorBytes(mac.subarray(0, tagLength), keyStreamBlock(nonce, 0));
  }

  function checkSizes(nonce: Uint8Array, aad: Uint8Array): void {
    if (nonce.length !== CCM_NONCE_LENGTH) throw new RangeError("CCM nonce must be 13 bytes");
    if (aad.length > MAX_AAD_LENGTH) throw new RangeError("CCM associated data too long");
  }

  return {
    seal(nonce, aad, plaintext) {
      checkSizes(nonce, aad);
      if (plaintext.length > MAX_PLAINTEXT_LENGTH) throw new RangeError("CCM plaintext too long");
      const sealed = new Uint8Array(plaintext.length + tagLength);
      sealed.set(applyKeyStream(nonce, plaintext));
      sealed.set(tag(nonce, aad, plaintext), plaintext.length);
      return sealed;
    },

    open(nonce, aad, sealed) {
      checkSizes(nonce, aad);
      const plaintextLength = sealed.length - tagLength;
      if (plaintextLength < 0 || plaintextLength > MAX_PLAINTEXT_LENGTH) return undefined;
      const plaintext = applyKeyStream(nonce, sealed.subarray(0, plaintextLength));
      const verified = constantTimeEqual(
        tag(nonce, aad, plaintext),
        sealed.subarray(plaintextLength),
      );
      if (verified) return plaintext;
      plaintext.fill(0);
      return undefined;
    },
  };
}

/** Feeds `data`, zero-padded to whole blocks, through CBC-MAC starting from `mac`. */
function cbcMacAbsorb(
  encrypt: (block: Uint8Array) => Uint8Array,
  mac: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  let state = mac;
  for (let start = 0; start < data.length; start += AES_BLOCK_LENGTH) {
    const block = new Uint8Array(AES_BLOCK_LENGTH);
    block.set(data.subarray(start, start + AES_BLOCK_LENGTH));
    state = encrypt(xorBytes(state, block));
  }
  return state;
}

/** Writes `value` big-endian into the last two bytes of `target`, as CCM's length fields are. */
function writeBigEndian(target: Uint8Array, value: number): void {
  target[target.length - 2] = (value >>> 8) & 0xff;
  target[target.length - 1] = value & 0xff;
}

/** XOR of `a` with the first `a.length` bytes of `b`. */
function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  return a.map((byte, i) => byte ^ (b[i] ?? 0));
}

/** Compares without stopping at the first difference, so timing does not reveal where it is. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

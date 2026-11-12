// AES-CCM (RFC 3610) built on the AES block cipher alone, for runtimes whose crypto lacks CCM.
import crypto from "node:crypto";

function blockCipher(key: Uint8Array) {
  const c = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  c.setAutoPadding(false);
  return (block: Uint8Array): Buffer => c.update(block);
}

function ccmCore(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, tagLen: number) {
  const L = 15 - nonce.length;
  if (L < 2 || L > 8) throw new Error("nonce must be 7 to 13 bytes");
  if (tagLen < 4 || tagLen > 16 || tagLen % 2) throw new Error("bad tag length");
  if (aad.length >= 0xff00) throw new Error("associated data too long for this implementation");
  const E = blockCipher(key);

  // CBC-MAC over B0, the length-prefixed associated data, and the message
  const b0 = Buffer.alloc(16);
  b0[0] = (aad.length ? 0x40 : 0) | (((tagLen - 2) / 2) << 3) | (L - 1);
  b0.set(nonce, 1);
  let len = plaintext.length;
  for (let i = 15; i > 15 - L; i--) { b0[i] = len & 0xff; len = Math.floor(len / 256); }
  const parts: Buffer[] = [b0];
  if (aad.length) {
    const a = Buffer.alloc(Math.ceil((2 + aad.length) / 16) * 16);
    a.writeUInt16BE(aad.length, 0); a.set(aad, 2);
    parts.push(a);
  }
  const m = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16);
  m.set(plaintext, 0);
  parts.push(m);
  const macInput = Buffer.concat(parts);
  let x: Buffer = Buffer.alloc(16);
  for (let i = 0; i < macInput.length; i += 16) {
    const blk = Buffer.alloc(16);
    for (let j = 0; j < 16; j++) blk[j] = x[j] ^ macInput[i + j];
    x = Buffer.from(E(blk));
  }

  // Counter mode: block 0 masks the tag, blocks 1.. mask the message
  const counterBlock = (i: number) => {
    const a = Buffer.alloc(16);
    a[0] = L - 1; a.set(nonce, 1);
    for (let k = 15; k > 15 - L; k--) { a[k] = i & 0xff; i = Math.floor(i / 256); }
    return Buffer.from(E(a));
  };
  const s0 = counterBlock(0);
  const tag = Buffer.alloc(tagLen);
  for (let j = 0; j < tagLen; j++) tag[j] = x[j] ^ s0[j];
  const stream = Buffer.alloc(m.length);
  for (let i = 0; i < m.length / 16; i++) stream.set(counterBlock(i + 1), i * 16);
  return { tag, stream };
}

export function ccmEncrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, tagLen: number) {
  const { tag, stream } = ccmCore(key, nonce, aad, plaintext, tagLen);
  const ciphertext = Buffer.alloc(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) ciphertext[i] = plaintext[i] ^ stream[i];
  return { ciphertext, tag };
}

export function ccmDecrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array): Buffer | null {
  // The key stream does not depend on the message, so derive it first, then check the tag over the plaintext.
  const { stream } = ccmCore(key, nonce, aad, new Uint8Array(ciphertext.length), tag.length);
  const plaintext = Buffer.alloc(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) plaintext[i] = ciphertext[i] ^ stream[i];
  const expected = ccmCore(key, nonce, aad, plaintext, tag.length).tag;
  return crypto.timingSafeEqual(expected, Buffer.from(tag)) ? plaintext : null;
}

import { createCipheriv } from "node:crypto";

export const AES_BLOCK_LENGTH = 16;
export const AES_128_KEY_LENGTH = 16;

/**
 * The AES block cipher in the encrypt direction, keyed once. This is the only part of the
 * device encryption that depends on the runtime (D94): swap the factory to move runtimes.
 */
export interface BlockCipher {
  /** Encrypts exactly one 16-byte block. */
  encryptBlock(block: Uint8Array): Uint8Array;
}

export type BlockCipherFactory = (key: Uint8Array) => BlockCipher;

/** AES-128 on the runtime's `node:crypto`, which Bun and Node both provide. */
export const nodeAes128: BlockCipherFactory = (key) => {
  if (key.length !== AES_128_KEY_LENGTH) throw new RangeError("AES-128 key must be 16 bytes");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return {
    encryptBlock(block) {
      if (block.length !== AES_BLOCK_LENGTH) throw new RangeError("AES block must be 16 bytes");
      // With padding off, ECB returns each whole block as soon as it is given.
      return new Uint8Array(cipher.update(block));
    },
  };
};

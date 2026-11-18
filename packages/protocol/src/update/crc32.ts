/**
 * CRC-32 of a transfer frame's data (m3-updates-design.md section 5): the reflected polynomial
 * 0xEDB88320, initial value and final XOR 0xFFFFFFFF (the CRC of zlib and of Ethernet). The check
 * value of the ASCII bytes "123456789" is 0xCBF43926.
 */

const POLYNOMIAL = 0xedb88320;

const TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? POLYNOMIAL ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** The CRC-32 of `bytes`, as an unsigned 32-bit integer. Never throws. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

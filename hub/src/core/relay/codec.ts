/**
 * The content's size as the shell seals it (docs/m4-design.md section 5): its JSON in UTF-8. The
 * key id and key are read with the protocol's own `parsePushKeyId` and `parsePushKey`.
 */

const encoder = new TextEncoder();

/** The length of `value`'s JSON in UTF-8, as the shell seals it. */
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

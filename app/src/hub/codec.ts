/** JSON in Noise payloads (m2-design.md section 5): UTF-8, one object each. Never throws. */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

/** The JSON in some bytes, or undefined when they are not UTF-8 JSON. */
export function decodeJson(bytes: Uint8Array): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(decoder.decode(bytes)) as unknown };
  } catch {
    return undefined;
  }
}

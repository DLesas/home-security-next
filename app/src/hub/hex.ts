/** Bytes as lower-case hex: a lookup, a hash shown or compared (m2-design.md section 5). */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

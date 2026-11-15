/**
 * The device protocol's decoder for the browser (wave 2's ruling: `@hsn/protocol/messages`, whose
 * import graph holds no `node:` module), and hex read without throwing.
 */
import { fromHex } from "@hsn/protocol/messages";

export { decodeMessage, MessageType } from "@hsn/protocol/messages";

/** Bytes from lowercase hex; undefined when it is not hex (`fromHex` throws on that). */
export function fromHexSafe(hex: string): Uint8Array | undefined {
  if (!/^(?:[0-9a-f]{2})*$/u.test(hex)) return undefined;
  try {
    return fromHex(hex);
  } catch {
    return undefined;
  }
}

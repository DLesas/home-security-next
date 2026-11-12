import { createHash } from "node:crypto";

/**
 * SHA-256, the second runtime-specific piece of the device protocol beside the block cipher
 * (D94): swap the function to move runtimes.
 */
export type Sha256 = (data: Uint8Array) => Uint8Array;

/** SHA-256 on the runtime's `node:crypto`, which Bun and Node both provide. */
export const nodeSha256: Sha256 = (data) =>
  new Uint8Array(createHash("sha256").update(data).digest());

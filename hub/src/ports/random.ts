/** Randomness for the shell (hub-design.md sections 2 and 3). */
import type { Result } from "neverthrow";
import type { HubError } from "../core/model/errors.ts";

/**
 * `bytes(length)` from `crypto.getRandomValues`: every input's 32 bytes. Never blocks. A failure
 * is fatal: the hub stops (section 10), because it cannot make keys or welcomes.
 */
export interface Random {
  bytes(length: number): Result<Uint8Array, HubError & { readonly kind: "random" }>;
}

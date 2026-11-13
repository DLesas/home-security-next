/**
 * Web Crypto behind results (hub-design.md section 10): `crypto.getRandomValues` for every
 * input's entropy (the `Random` port, section 3) and `crypto.subtle` for the hub's signing key
 * pair (section 9). A failure of the first is fatal to the hub (section 10).
 */
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { errorFrom } from "./thrown.ts";

/** `length` bytes from the system's secure generator. */
export function randomBytes(
  length: number,
  origin: string,
): Result<Uint8Array, HubError & { readonly kind: "random" }> {
  try {
    return ok(crypto.getRandomValues(new Uint8Array(length)));
  } catch (thrown) {
    return err(errorFrom("random", origin, `draw ${length} random bytes`, thrown));
  }
}

/**
 * Runs one `crypto.subtle` call; a rejection or a throw is an error of kind "crypto". A test may
 * give another `SubtleCrypto` in `provider`.
 */
export function subtle<T>(
  origin: string,
  what: string,
  run: (subtle: SubtleCrypto) => Promise<T>,
  provider: SubtleCrypto = crypto.subtle,
): ResultAsync<T, HubError & { readonly kind: "crypto" }> {
  return ResultAsync.fromThrowable(
    () => run(provider),
    (thrown) => errorFrom("crypto", origin, what, thrown),
  )();
}

/** One synchronous call that may throw (a key's hash, for example), as an error of kind "crypto". */
export function cryptoCall<T>(
  origin: string,
  what: string,
  run: () => T,
): Result<T, HubError & { readonly kind: "crypto" }> {
  try {
    return ok(run());
  } catch (thrown) {
    return err(errorFrom("crypto", origin, what, thrown));
  }
}

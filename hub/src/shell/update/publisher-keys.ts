/**
 * The publisher's Ed25519 public keys this hub trusts for a release (m2-design.md section 9, "Hub
 * updates"; D84): compiled in and reviewed like any code, at most two, the current and the next,
 * so a release signed with the current key can bring a program that trusts the next one. Nothing
 * on a running hub adds a key; a lost or leaked one is replaced only by a package installed by
 * hand.
 *
 * Open (reported): the product owner holds the private key and has not given its public half, so
 * the list is empty and every release is refused `badSignature` until it is filled in (a build
 * says so). A release build (`hub/packaging/shared/build-program.ts`) refuses to compile a list
 * that holds more than two keys, or the test key below.
 */

/** The keys a release must be signed by one of, 32 bytes each. */
export const PUBLISHER_KEYS: readonly Uint8Array[] = [];

/**
 * The tests' key: the public half of 32 bytes of 7 (`hub/test/unit/shell-update/`). Public, and
 * worthless as a secret: a release build refuses to embed it.
 */
export const TEST_PUBLISHER_KEY = Uint8Array.from(
  Buffer.from("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c", "hex"),
);

/** At most two keys (section 9). */
export const MAX_PUBLISHER_KEYS = 2;

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Why a key list may not go into a release build, or undefined when it may. */
export function releaseKeysProblem(keys: readonly Uint8Array[]): string | undefined {
  if (keys.length > MAX_PUBLISHER_KEYS)
    return `${keys.length} publisher keys: at most ${MAX_PUBLISHER_KEYS}`;
  if (keys.some((key) => key.length !== 32)) return "a publisher key is not 32 bytes";
  if (keys.some((key) => same(key, TEST_PUBLISHER_KEY)))
    return "the test key is among the publisher keys";
  return undefined;
}

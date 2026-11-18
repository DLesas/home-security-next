/**
 * The types of `random.ts`'s pair, and the one rule both platforms share (m3-design.md section 2,
 * "The JavaScript engine: wave 0's checks"): the app, `@hsn/protocol`'s Noise and `@noble/curves`
 * take their random bytes from `crypto.getRandomValues`. A browser has it; React Native 0.88.1's
 * Hermes does not (docs/spikes/P0-phone-build.md), so the phone puts expo-crypto's, which reads the
 * system's secure generator (`SecRandomCopyBytes` on iOS, `SecureRandom` on Android), in its
 * place at the entry, before anything asks for a random byte.
 */

/** The integer typed arrays Web Crypto's `getRandomValues` and expo-crypto's both fill. */
export type IntegerArray =
  Int8Array | Int16Array | Int32Array | Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array;

/** Fills `array` with secure random values in place and returns it, as `getRandomValues` does. */
export type FillRandom = <T extends IntegerArray>(array: T) => T;

/** Where `crypto.getRandomValues` is looked for and put: `globalThis`, or a stand-in in tests. */
export interface RandomScope {
  crypto?: { getRandomValues?: unknown };
}

/**
 * Where `crypto.getRandomValues` comes from once installed: the engine's own (a browser, or a
 * later Hermes that has one, which is never replaced), the platform's put in its place (a phone),
 * or nowhere (a browser without Web Crypto, where nothing that needs a random byte can work).
 */
export type RandomInstalled = "engine" | "platform" | "missing";

export interface RandomStart {
  /** Makes `crypto.getRandomValues` available on `scope` (by default `globalThis`); once, at the entry. */
  readonly installRandom: (scope?: RandomScope) => RandomInstalled;
}

/** The scope the app runs in. */
export function globalScope(): RandomScope {
  return globalThis;
}

/**
 * Puts `fill` on `scope` as `crypto.getRandomValues` unless the engine has its own: on the
 * existing `crypto` object (whose other members stay), or on a new one.
 */
export function installRandomOn(scope: RandomScope, fill: FillRandom): RandomInstalled {
  const existing = scope.crypto;
  if (typeof existing?.getRandomValues === "function") return "engine";
  if (existing === undefined) scope.crypto = { getRandomValues: fill };
  else existing.getRandomValues = fill;
  return "platform";
}

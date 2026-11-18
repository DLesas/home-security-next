/**
 * The browser's random source, the web build's side of `random.ts`: Web Crypto's own
 * `crypto.getRandomValues`, never replaced. A browser without it has no other secure source.
 */
import { globalScope, type RandomStart } from "./random-types";

export const installRandom: RandomStart["installRandom"] = (scope = globalScope()) =>
  typeof scope.crypto?.getRandomValues === "function" ? "engine" : "missing";

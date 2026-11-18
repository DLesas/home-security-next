/**
 * The phone's random source, the phone's side of `random.ts`: expo-crypto's `getRandomValues`
 * (the system's secure generator) as `crypto.getRandomValues`, which Hermes lacks
 * (docs/spikes/P0-phone-build.md). The keys themselves are P2's (`keys.native.ts`, wave 1).
 */
import { getRandomValues } from "expo-crypto";
import { globalScope, installRandomOn, type RandomStart } from "./random-types";

export const installRandom: RandomStart["installRandom"] = (scope = globalScope()) =>
  installRandomOn(scope, getRandomValues);

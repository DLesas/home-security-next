/**
 * Where `crypto.getRandomValues` comes from, per platform (m3-design.md section 2, "The
 * JavaScript engine: wave 0's checks"): `random.web.ts` keeps the browser's own;
 * `random.native.ts` puts expo-crypto's in place, which Hermes lacks. `random-start.ts` installs
 * it first thing at the entry. Metro loads one of them in place of this file; tsc and Bun's
 * tests read this one, which binds the web build's (`split.ts`).
 */
import type { RandomStart } from "./random-types";
import type { Split } from "./split";
import type * as phone from "./random.native";
import * as web from "./random.web";

export type { FillRandom, RandomInstalled, RandomScope, RandomStart } from "./random-types";

/** Both platforms' files export `RandomStart`. */
export type Platforms = Split<RandomStart, typeof web, typeof phone>;

export const { installRandom }: RandomStart = web;

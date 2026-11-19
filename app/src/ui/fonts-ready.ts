/**
 * Whether the app's faces are loaded (`fonts.ts`), per platform: `fonts-ready.web.ts` (the
 * browser loads them from `global.css`'s `@font-face` rules as text needs them) and
 * `fonts-ready.native.ts` (expo-font, at start). Metro loads one of them in place of this file;
 * tsc and Bun's tests read this one, which binds the web build's (`platform/split.ts`).
 */
import type { Split } from "../platform/split";
import type { FontsReady } from "./fonts";
import type * as phone from "./fonts-ready.native";
import * as web from "./fonts-ready.web";

/** Both platforms' files export `FontsReady`. */
export type Platforms = Split<FontsReady, typeof web, typeof phone>;

export const { useFontsReady }: FontsReady = web;

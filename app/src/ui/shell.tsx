/**
 * The frame around every screen, per platform (m3-design.md section 2; the root layout's split):
 * `shell.web.tsx` is the browser's, as M2 built it; `shell.native.tsx` the phone's, with the
 * screen's insets, the status bar, Android's back button, the keyboard and the phone's link pages
 * (docs/app-design.md, "On a phone"). Metro loads one of them in place of this file; tsc and Bun's
 * tests read this one, which binds the web build's (`platform/split.ts`).
 */
import type { Split } from "../platform/split";
import type * as phone from "./shell.native";
import type { Shells } from "./shell-types";
import * as web from "./shell.web";

/** Both platforms' files export `Shells`. */
export type Platforms = Split<Shells, typeof web, typeof phone>;

export const { Shell }: Shells = web;

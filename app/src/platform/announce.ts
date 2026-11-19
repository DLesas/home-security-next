/**
 * Saying something to a screen reader at once (docs/app-design.md, "On a phone", rule 6): a
 * countdown or an alarm, an urgent notification. `announce.web.ts` does nothing, the assertive
 * live region being read; `announce.native.ts` tells iOS, which needs it. Metro loads one of them
 * in place of this file; tsc and Bun's tests read this one, which binds the web build's
 * (`split.ts`).
 */
import type { Announce } from "./announce-types";
import type { Split } from "./split";
import type * as phone from "./announce.native";
import * as web from "./announce.web";

export type { Announce } from "./announce-types";

/** Both platforms' files export `Announce`. */
export type Platforms = Split<Announce, typeof web, typeof phone>;

export const { announce }: Announce = web;

/**
 * What the engine's `Intl` lacks, put in place per platform (`intl-types.ts` says what and why):
 * `intl.web.ts` changes nothing, a browser having all the app uses; `intl.native.ts` puts an
 * English `Intl.ListFormat` where Hermes has none. The root layout installs it before anything
 * renders. Metro loads one of them in place of this file; tsc and Bun's tests read this one,
 * which binds the web build's (`split.ts`).
 */
import type { IntlStart } from "./intl-types";
import type { Split } from "./split";
import type * as phone from "./intl.native";
import * as web from "./intl.web";

/** Both platforms' files export `IntlStart`. */
export type Platforms = Split<IntlStart, typeof web, typeof phone>;

export const { installIntl }: IntlStart = web;

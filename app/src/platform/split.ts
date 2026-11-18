/**
 * How a piece of the app is chosen per platform (m3-design.md section 2, "Choosing a file per
 * platform"). A pair is three files:
 *
 * - `x.ts`, the interface. tsc and Bun's test runner read it: they choose no platform, so it also
 *   binds the interface's names to the web build's file, typed by the interface, for them.
 * - `x.web.ts`, which Metro loads in the web build in place of `x.ts`.
 * - `x.native.ts`, which Metro loads on iOS and Android in place of `x.ts`.
 *
 * Shared code imports `./x` and so runs on whichever file its platform loads. `x.ts` names both
 * platform files' modules in a `Split` (or two `Implements`), so tsc checks that each exports the
 * whole interface. The pair's types live in a file of their own (`x-types.ts`, or a shared module
 * such as `client-key.ts`), which the platform files and shared code import: a platform file
 * never imports `./x`, since on its platform that import would be itself.
 *
 * tsc checks the app twice: `tsconfig.json` as the web build and the tests see it (each `./x` is
 * the plain file, so the web's), and `tsconfig.native.json` as a phone sees it (each `./x` is
 * `x.native.ts`, with the phone's `PlatformSecret`), so shared code is checked against both.
 *
 * Until wave 1 builds the phone's side (m3-design.md section 10), each `x.native.ts` compiles and
 * refuses: every function answers `notBuilt`, or the nearest failure its interface has, and does
 * nothing on the phone.
 */

/** `T`, which tsc checks implements `I`: a platform file's module against its interface. */
export type Implements<I, T extends I> = T;

/** The two platform files of a pair, each checked against the interface `I`. */
export type Split<I, Web extends I, Phone extends I> = readonly [Web, Phone];

/** A phone file's answer while its piece is not built (m3-design.md section 10, wave 1). */
export interface NotBuilt {
  readonly ok: false;
  readonly fault: "notBuilt";
}

export const NOT_BUILT: NotBuilt = { ok: false, fault: "notBuilt" };

/** The reason a phone file gives where its interface has no failure to answer with. */
export const NOT_BUILT_MESSAGE = "Not built for the phone yet (m3-design.md section 10, wave 1).";

/** A result: the value, or why there is none. */
export type Outcome<T, F> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: F };

/**
 * The types of `shell.tsx`'s pair, apart from it: in the phone's type check
 * (`tsconfig.native.json`) `./shell` is the phone's file.
 */
import type { JSX } from "react";

export interface Shells {
  /**
   * Every screen around the routes: the navigation, the content column, the alarm and the notices
   * over it, or the link screen in their place while the app is not linked.
   */
  readonly Shell: () => JSX.Element;
}

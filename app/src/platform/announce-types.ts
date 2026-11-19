/**
 * The types of `announce.ts`'s pair, apart from it: in the phone's type check
 * (`tsconfig.native.json`) `./announce` is the phone's file.
 */

export interface Announce {
  /**
   * Says `text` to a screen reader at once (docs/app-design.md, "On a phone", rule 6). Where the
   * platform reads an assertive live region by itself (a browser, Android), the region says it
   * and this does nothing, so nothing is said twice.
   */
  readonly announce: (text: string) => void;
}

/** What the phone's announcer needs from React Native: the platform, and iOS's announcement. */
export interface AnnounceDeps {
  readonly os: string;
  readonly announceForAccessibility: (text: string) => void;
}

/**
 * The phone's rule: iOS reads no live region, so it is told (`AccessibilityInfo`); Android reads
 * the live region the alarm and notices already carry.
 */
export function phoneAnnouncer(deps: AnnounceDeps): Announce["announce"] {
  return (text) => {
    if (deps.os === "ios" && text !== "") deps.announceForAccessibility(text);
  };
}

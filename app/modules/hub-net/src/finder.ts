/**
 * `hub-net`'s face to the app: the frozen `HubFinder` (`src/platform/finder.ts`) over the browse,
 * with the browse's watch, diagnostics and local network permission beside it. Pure: `index.ts`
 * binds it to the native module and a real timer; the tests to a stand-in.
 */
import type { FinderFault, HubFinder } from "../../../src/platform/finder";
import { type After, type HubBrowser, type HubNetFault, hubBrowser } from "./browser";
import type { HubNetNative } from "./contract";

/**
 * The finder's fault for a browse's. `wifiOff` has no word of its own in the frozen `FinderFault`
 * yet: it is `failed`, whose words tell the person to check the home Wi-Fi; `diagnostics` keeps
 * the reason.
 */
export function finderFault(fault: HubNetFault): FinderFault {
  return fault === "wifiOff" ? "failed" : fault;
}

/** The `HubFinder` over a browser: its hubs, or its fault in the finder's words. */
export function finderOf(browser: HubBrowser): HubFinder {
  return {
    browse: (ms) =>
      browser
        .browse(ms)
        .then((found) => (found.ok ? found : { ok: false, fault: finderFault(found.fault) })),
  };
}

/** What `hub-net` gives the app. */
export interface HubNet {
  readonly finder: HubFinder;
  readonly watch: HubBrowser["watch"];
  readonly diagnostics: HubBrowser["diagnostics"];
  readonly localNetwork: HubBrowser["localNetwork"];
}

/** `hub-net` over a native module (the real one, or a test's stand-in) and a timer. */
export function hubNetOver(native: HubNetNative | null, timers: After): HubNet {
  const browser = hubBrowser(native, timers);
  return {
    finder: finderOf(browser),
    watch: browser.watch,
    diagnostics: browser.diagnostics,
    localNetwork: browser.localNetwork,
  };
}

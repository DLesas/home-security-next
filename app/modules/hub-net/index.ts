/**
 * `hub-net`: finding the hub on the home network from a phone (m3-design.md section 2, "Reaching
 * the hub at home", "Our module, `hub-net`"; section 10, P1 step 1). A browse for the hub's
 * `_hsn-hub._tcp` record on the system's own service discovery, resolved to addresses, its apps'
 * port and its app identity: on iOS the Network framework's `NWBrowser`, with dns_sd's resolve for
 * the addresses; on Android `NsdManager`. Only the browse: React Native's own WebSocket reaches
 * the hub (docs/spikes/P0-phone-build.md), so the socket half the design allowed for is not built.
 *
 * - `finder`: the frozen `HubFinder` (`src/platform/finder.ts`) the phone's client takes.
 * - `watch`: found, updated and lost hubs, for as long as a page wants them.
 * - `diagnostics`: what the last browse saw, the records left out counted.
 * - `localNetwork`: the local network permission, read; asked only when a page calls `ask`
 *   (Android's `ACCESS_LOCAL_NETWORK`; iOS asks by itself at the first browse or connection).
 *
 * The browse trusts the record only to choose where to try; the phone proves the hub by its Noise
 * key. Every failure is an answer, never a throw.
 */
import type { After } from "./src/browser";
import { type HubNet, hubNetOver } from "./src/finder";
import { nativeHubNet } from "./src/native";

export type { BrowseDiagnostics, BrowsedHub, HubChange, HubNetFault } from "./src/browser";
export type { HubNet } from "./src/finder";

const realTimer: After = {
  after: (ms, run) => {
    const handle = setTimeout(run, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

let made: HubNet | undefined;

/** The phone's one `hub-net`, made at first use over the native module. */
export function hubNet(): HubNet {
  made ??= hubNetOver(nativeHubNet(), realTimer);
  return made;
}

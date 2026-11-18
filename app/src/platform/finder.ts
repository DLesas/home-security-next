/**
 * Finding hubs on the home network (m3-design.md section 2, "Reaching the hub at home"; section
 * 3, typed codes). Types only, frozen by step 0: the phone's browse is `hub-net`'s (P1, Network's
 * browser on iOS, NsdManager on Android), the order of addresses P2's (wave 1). A browser cannot
 * browse.
 */
import type { NotBuilt, Outcome } from "./split";

/**
 * A hub an mDNS browse for `_hsn-hub._tcp` found, with the TXT keys `app` and `aid` H1 adds. Both
 * are unauthenticated and only choose where to try: the handshake proves the hub.
 */
export interface FoundHub {
  /** `aid`: the hub's app identity, 26 characters of base32. */
  readonly identity: string;
  /** The addresses the record resolved to. */
  readonly addresses: readonly string[];
  /** `app`: the apps' port. */
  readonly appsPort: number;
}

/** Why a browse found nothing to try: the system refused the local network, or there is no browse here. */
export type FinderFault = "localNetworkDenied" | "unsupported" | "failed" | NotBuilt["fault"];

export interface HubFinder {
  /**
   * Browses for `ms` milliseconds (2 s †) and answers every hub that advertised both keys, each
   * once. A record without them is left out.
   */
  browse(ms: number): Promise<Outcome<readonly FoundHub[], FinderFault>>;
}

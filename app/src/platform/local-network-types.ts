/**
 * The types of `local-network.ts`'s pair, and the phone's rule apart from React Native so it can
 * be tested (m3-design.md section 2, "The phone's own permissions"; docs/app-design.md, "On a
 * phone", rule 7).
 *
 * - **Android 17 (API 37)** has `ACCESS_LOCAL_NETWORK`, in the Nearby devices group, which the app
 *   needs to reach its hub at home. React Native asks for it only in debug builds, for Metro
 *   (docs/spikes/P0-phone-build.md, section 6); a release build must ask itself, at the moment it
 *   first reaches the hub. Older Android has no such permission: granted.
 * - **iOS** asks its own question at the app's first connection to a home-network address, and
 *   gives no way to ask or to read the answer (Apple TN3179 ‡). So before the first link the page
 *   explains (`undetermined`), and its button goes on to the connection, whose refusal the
 *   connection reports (`localNetworkDenied`).
 * - A browser reaches its own origin: granted.
 */
import type { Permission } from "./scanner";

export interface LocalNetwork {
  /** The permission as it stands, without asking. */
  readonly permission: () => Promise<Permission>;
  /** Asks the system's question, after the page has said what and why. */
  readonly ask: () => Promise<Permission>;
}

/** Android's answers to a request, as React Native gives them. */
export type AndroidAnswer = "granted" | "denied" | "never_ask_again";

export interface LocalNetworkDeps {
  readonly os: string;
  /** Android's API level (`Platform.Version`); iOS's version string elsewhere. */
  readonly version: number | string;
  readonly check: () => Promise<boolean>;
  readonly request: () => Promise<AndroidAnswer>;
}

/** The first Android API level with `ACCESS_LOCAL_NETWORK`. */
export const LOCAL_NETWORK_API = 37;

const GRANTED: Permission = { state: "granted", canAskAgain: true };
const UNDETERMINED: Permission = { state: "undetermined", canAskAgain: true };

export function phoneLocalNetwork(deps: LocalNetworkDeps): LocalNetwork {
  const android = deps.os === "android";
  const enforced = android && typeof deps.version === "number" && deps.version >= LOCAL_NETWORK_API;
  return {
    permission: () => {
      if (deps.os === "ios") return Promise.resolve(UNDETERMINED);
      if (!enforced) return Promise.resolve(GRANTED);
      return deps.check().then(
        (granted) => (granted ? GRANTED : UNDETERMINED),
        () => UNDETERMINED,
      );
    },
    ask: () => {
      // iOS asks at the connection itself: the page's button goes on to it.
      if (!enforced) return Promise.resolve(GRANTED);
      return deps.request().then(
        (answer): Permission =>
          answer === "granted" ? GRANTED : { state: "denied", canAskAgain: answer === "denied" },
        (): Permission => ({ state: "denied", canAskAgain: true }),
      );
    },
  };
}

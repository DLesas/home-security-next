/**
 * The types of `start.ts`'s pair (m3-design.md section 2), apart from it: in the phone's type
 * check (`tsconfig.native.json`) `./start` is the phone's file, so the pair's files and the root
 * layout take these from here.
 */
import type { HubClient } from "./client";
import type { ArrivedCode as AddressCode } from "./fragment";

/**
 * A code the app was given from outside: in a browser, from the address (`fragment.ts`); on a
 * phone, a link opened in the app (`hsn://link/1?…`, `hsn://restore/1?…`, `hsn://pair/1?…`), as
 * its text, which the phone reads and shows before it does anything with it (m3-design.md
 * section 3, "Deep links").
 */
export type ArrivedCode = AddressCode | { readonly from: "deepLink"; readonly text: string };

export interface StartedClient {
  readonly client: HubClient;
}

export interface ClientStart {
  /** Builds the platform's hub client and starts it; the root layout calls it once. */
  readonly startClient: () => StartedClient;
  /**
   * The code the app was opened with, once: after this the secret is held only by the linking
   * call. A browser takes it out of the address when this file loads, before the router does.
   */
  readonly claimArrivedCode: () => ArrivedCode | undefined;
  /**
   * Codes that arrive while the app runs: on a phone, a link opened in it; never in a browser,
   * where a code comes only with the page. Returns the unsubscribe.
   */
  readonly onArrivedCode: (listener: (code: ArrivedCode) => void) => () => void;
}

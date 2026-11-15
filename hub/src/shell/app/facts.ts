/**
 * What the session layer reads of the core, and what it tells the core before the listeners open
 * (m2-design.md sections 2 and 5).
 *
 * - `HubHello` (IK message 2) names the boot, the live revision and the client's person, which
 *   only the core knows; the shell reads them from the core's state through the modules' views,
 *   as `main.ts` reads the registry for `hsn log --device`, between turns and never inside one.
 * - The core is given `hubFacts` (the version, the addresses, the apps' listener's real port, the
 *   certificate's SHA-256) and `timeZone` before it takes any client's input, so a client never
 *   sees them empty (section 11, "Step 1's questions": `hub.info.timeZone`).
 */
import { LISTENER_PORTS } from "@hsn/protocol/app";
import { liveRevision } from "../../core/app/view.ts";
import { bootOf } from "../../core/clock/view.ts";
import type { HubEvent } from "../../core/model/events.ts";
import type { ClientId } from "../../core/model/ids.ts";
import type { HubState } from "../../core/model/state.ts";
import { liveClient } from "../../core/people/view.ts";
import { HUB_VERSION } from "../hub-facts.ts";

/** What `HubHello` needs of the core: undefined before the boot event or for no linked client. */
export interface CoreView {
  hello(
    client: ClientId,
  ): { readonly boot: number; readonly rev: number; readonly person: number | null } | undefined;
  /** The live revision, for the shell's own `ping` events (section 5). */
  rev(): number;
}

/** The core's view over its state as the loop holds it. */
export function coreView(state: () => HubState): CoreView {
  return {
    hello: (client) => {
      const view = state();
      const boot = bootOf(view);
      const row = liveClient(view, client);
      if (boot === undefined || row === undefined) return undefined;
      return { boot, rev: liveRevision(view), person: row.personId };
    },
    rev: () => liveRevision(state()),
  };
}

/** The hub computer's time zone, as its system says (`timeZone`, section 2); UTC if it says none. */
export function systemTimeZone(): string {
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === "" ? "UTC" : zone;
}

/**
 * The hub's facts with the apps' port its listener really opened (`AppListeners.lanPort`), never
 * an assumed one: with `--app-ports`, or a port the system chose (0), the link address and the QR
 * code must lead to the listener that is there.
 */
export function factsInput(
  addresses: readonly string[],
  certificateSha256: Uint8Array,
  appsPort: number,
  // Step 0 owner, wave 2: the console listener's real port (`hubFacts.consolePort`, frozen).
  consolePort: number = LISTENER_PORTS.console,
): Extract<HubEvent, { readonly kind: "hubFacts" }> {
  return {
    kind: "hubFacts",
    version: HUB_VERSION,
    addresses,
    appsPort,
    consolePort,
    certificateSha256: certificateSha256.slice(),
  };
}

/**
 * The inputs that follow `boot` (section 2): the hub's facts, with the certificate's SHA-256 and
 * the apps' listener's real port, then the time zone. The listeners are opened first and these
 * enqueued in the same synchronous run, before the loop takes any input, so no client's event can
 * come before them while the ports they name are the ones the listeners hold.
 */
export function startupInputs(
  addresses: readonly string[],
  certificateSha256: Uint8Array,
  zone: string,
  // Step 0 owner, wave 2: `app-wiring.ts` passes both listeners' real ports, once they are open.
  appsPort: number = LISTENER_PORTS.lan,
  consolePort: number = LISTENER_PORTS.console,
): readonly HubEvent[] {
  return [
    factsInput(addresses, certificateSha256, appsPort, consolePort),
    { kind: "timeZone", zone },
  ];
}

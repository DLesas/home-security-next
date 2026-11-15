/**
 * The hub's facts for the core (m2-design.md section 2, the `hubFacts` input): the hub's version,
 * the computer's addresses on the home network, the apps' port and the TLS certificate's SHA-256.
 * Sent after `boot`, and again whenever one changes: the addresses are looked at every minute ‡.
 */
import { networkInterfaces } from "node:os";
import { LISTENER_PORTS } from "@hsn/protocol/app";
import type { HubEvent } from "../core/model/events.ts";

/** The hub's own version, as its package names it. */
export const HUB_VERSION = "0.1.0";

/** How often the shell looks at the computer's addresses ‡ (section 2). */
export const ADDRESS_CHECK_MS = 60_000;

/** Every address of the computer that is not its loopback, in a stable order. */
export function homeAddresses(): readonly string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((info) => !info.internal)
    .map((info) => info.address)
    .toSorted();
}

/**
 * The `hubFacts` input, with the certificate's SHA-256 (`app/facts.ts`'s `startupInputs` gives the
 * real one, again at each renewal; empty only where no certificate is made, in tests) and the ports
 * the listeners really opened (the usual ones only where none is open, in tests).
 */
export function hubFacts(
  addresses: readonly string[],
  certificateSha256: Uint8Array = new Uint8Array(0),
  ports: { readonly apps: number; readonly console: number } = {
    apps: LISTENER_PORTS.lan,
    console: LISTENER_PORTS.console,
  },
): Extract<HubEvent, { readonly kind: "hubFacts" }> {
  return {
    kind: "hubFacts",
    version: HUB_VERSION,
    addresses,
    appsPort: ports.apps,
    consolePort: ports.console,
    certificateSha256,
  };
}

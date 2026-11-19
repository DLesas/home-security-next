/** The desk page's adapter to the protocol package's real protocomm Security 2 opener. */
import {
  type PairingAttempts,
  type PairingLink,
  setupSessionOpener,
} from "../../../packages/protocol/src/pairing/setup-session.ts";
import type { PairingCodeText } from "../../../packages/protocol/src/pairing/types.ts";
import { realClock } from "../src/clock.ts";

/** Waits for a GATT operation's deadline on the page's clock. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const clock = { now: () => realClock.now(), sleep: wait };

/** Opens a setup session using the attempt count for the selected board. */
export function openDeskSession(
  link: PairingLink,
  code: PairingCodeText,
  attempts: PairingAttempts,
) {
  return setupSessionOpener({ clock, attempts })(link, code);
}

/**
 * The Chrome desk page (m3-design.md section 5, "A real board without a phone"): served by the
 * bench at `http://127.0.0.1:<port>/desk`, it runs pairing's exchange against a **real**
 * development board through Chrome's Web Bluetooth on this Mac, so the protocol can be tried
 * before any phone: the code read as the app reads it, Chrome's chooser for a board advertising
 * pairing's service, the connection, `proto-ver` read and checked against the frozen
 * `PairVersion`, the security 2 session (`desk-security.ts`), Identify, and a
 * Provision pasted from the hub, with its result. It is a tool, never part of the web app (D93).
 *
 * With no board, or no Web Bluetooth, it loads and refuses cleanly: it says what is missing and
 * sends nothing.
 */
import { readPairingCode } from "../../../packages/protocol/src/pairing/code.ts";
import { PROTOCOMM } from "../../../packages/protocol/src/pairing/constants.ts";
import { pairingAttempts } from "../../../packages/protocol/src/pairing/setup-session.ts";
import {
  decodeSetupMessage,
  encodeSetupMessage,
  SetupType,
} from "../../../packages/protocol/src/usb/setup.ts";
import { fromHex, toHex } from "../src/bridge/wire.ts";
import { openDeskSession } from "./desk-security.ts";
import { webBluetoothCentral } from "./safe/web-bluetooth.ts";

const page = document.getElementById("page");
const central = webBluetoothCentral(PROTOCOMM.serviceUuid);
const boardAttempts = new Map<string, ReturnType<typeof pairingAttempts>>();

/** Makes a page element with optional text. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.textContent = text;
  return made;
}

const steps = element("ol");
/** Adds a result to the pairing log. */
function say(text: string, good: boolean): void {
  const item = element("li", text);
  item.className = good ? "ok" : "no";
  steps.append(item);
}

const code = element("input");
code.placeholder = "XXXX-XXXX";
code.autocomplete = "off";
const provision = element("textarea");
provision.placeholder = "Provision from the hub, hex (optional)";
provision.rows = 3;
const go = element("button", "Choose a board and pair");

page?.append(
  element("h1", "Pairing desk"),
  element(
    "p",
    "Pairs a development board running ESP-IDF's protocomm, through this Mac's Bluetooth. Type the code on the board's display, then choose the board in Chrome's list.",
  ),
  code,
  element("p"),
  provision,
  element("p"),
  go,
  element("p", "If no board appears, hold its button for 5 seconds to open setup, then try again."),
  steps,
);

const state = await central.state();
if (state !== "on") {
  say(
    state === "unsupported"
      ? "This browser has no Web Bluetooth. Open this page in Chrome on the Mac."
      : "Bluetooth is off on this Mac. Turn it on and reload.",
    false,
  );
  go.disabled = true;
}

let stopScan: (() => void) | undefined;
go.addEventListener("click", () => {
  const typed = readPairingCode(code.value);
  if (typed === undefined) {
    say("That is not a pairing code: 8 characters, as on the board's display.", false);
    return;
  }
  // Chrome's chooser must open from the click itself and cancellation gives us no callback.
  stopScan?.();
  stopScan = central.scan(PROTOCOMM.serviceUuid, (advert) => {
    stopScan?.();
    stopScan = undefined;
    go.disabled = true;
    void pair(advert.id, typed).finally(() => {
      go.disabled = false;
    });
  });
});

/** Connects to the chosen board and runs Identify and any pasted Provision. */
async function pair(
  id: string,
  typed: NonNullable<ReturnType<typeof readPairingCode>>,
): Promise<void> {
  const connected = await central.connect(id, 517);
  say(connected.ok ? "Connected." : `Could not connect: ${connected.fault}.`, connected.ok);
  if (!connected.ok) return;
  const attempts = boardAttempts.get(id) ?? pairingAttempts();
  boardAttempts.set(id, attempts);
  const session = await openDeskSession(connected.value, typed, attempts);
  if (!session.ok) {
    if (session.fault === "tooManyTries") {
      // The board enforces the lockout, so allow a fresh count when it can be chosen again.
      boardAttempts.delete(id);
      say(
        "The board stopped listening after five wrong codes. Hold its button for 5 seconds to open setup again.",
        false,
      );
    } else {
      say(
        session.fault === "wrongCode"
          ? "That is not this board's code."
          : `The session did not open: ${session.fault}.`,
        false,
      );
    }
    return;
  }
  boardAttempts.delete(id);
  const version = session.value.version;
  say(
    `proto-ver: ${version.v}, role ${String(version.role)}, chip ${version.chip}, firmware ${version.firmware}, security ${String(version.sec)}.`,
    true,
  );
  say("Security 2 session opened.", true);
  const identity = await session.value.exchange(encodeSetupMessage({ type: SetupType.Identify }));
  const decoded = identity.ok ? decodeSetupMessage(identity.value) : undefined;
  say(
    decoded?.ok === true && decoded.value.type === SetupType.Identity
      ? `Identity: role ${String(decoded.value.role)}, chip ${toHex(decoded.value.chipId)}, paired ${String(decoded.value.paired)}.`
      : "Identify had no Identity for an answer.",
    decoded?.ok === true,
  );
  const message = fromHex(provision.value.trim().toLowerCase());
  if (message !== undefined && message.length > 0) {
    const result = await session.value.exchange(message);
    say(
      result.ok
        ? `Provision result: ${String(result.value[2] ?? "none")} (0 accepted, 1 refused, 2 not valid).`
        : `Provision: ${result.fault}.`,
      result.ok && result.value[2] === 0,
    );
  }
  session.value.close();
}

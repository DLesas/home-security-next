/**
 * A phone's stream through the relay (docs/m4-design.md section 3, "Phones"): the WebSocket
 * addresses the two ends open, the request the relay reads, and what the relay may carry.
 *
 * The relay carries binary messages one for one, each one Noise message of 1 to 65,535 bytes,
 * into a kind 1 frame and back. It refuses a text message (closing with 1003), a message over
 * 65,535 bytes (1009) and an empty message (1003: no Noise message is empty, and a kind 1 frame
 * cannot carry one).
 *
 * The addresses are built and read as text, without `URL`, whose setters React Native lacks.
 * Nothing here throws.
 */
import { PHONE_CLOSE, RELAY_LIMITS, RELAY_PATHS } from "./constants.ts";
import { formatPhonePath, parsePhonePath, type PhonePath } from "./phone-path.ts";

/** Why the relay cannot carry a phone's message. */
export type PhoneMessageError = "textMessage" | "empty" | "tooLarge";

export type PhoneMessageResult =
  | { readonly ok: true; readonly value: Uint8Array }
  | { readonly ok: false; readonly error: PhoneMessageError };

/** Whether a message from a phone (or to it) can be carried: binary, 1 to 65,535 bytes. */
export function checkPhoneMessage(message: string | Uint8Array): PhoneMessageResult {
  if (typeof message === "string") return { ok: false, error: "textMessage" };
  if (message.length === 0) return { ok: false, error: "empty" };
  if (message.length > RELAY_LIMITS.maxPhoneMessageBytes) return { ok: false, error: "tooLarge" };
  return { ok: true, value: message };
}

/** The close code the relay sends a phone for a message it cannot carry. */
export function phoneCloseFor(error: PhoneMessageError): number {
  return error === "tooLarge" ? PHONE_CLOSE.tooLarge : PHONE_CLOSE.textMessage;
}

/** An absolute URL's scheme and authority, then its path, query and fragment as written. */
const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]*(?<rest>[^\s]*)$/u;

/**
 * Reads the URL of a phone's upgrade request as the relay receives it (absolute, as `Request.url`
 * gives it): its path must be exactly `/v1/phone/<identity>/<path>`, with no query, no fragment,
 * no dot segments and no percent-encoding (`parsePhonePath` takes exactly the path's two parts,
 * so a `?` or `#` anywhere refuses it). Undefined for anything else, which the relay closes with
 * 4400.
 */
export function readPhoneRequest(url: string): PhonePath | undefined {
  const path = ABSOLUTE.exec(url)?.groups?.rest;
  return path === undefined ? undefined : parsePhonePath(path);
}

/**
 * A relay's base URL, as `relay.set`, `hub.info`, `r=` or `DEPLOYMENT` give it: `ws://` or
 * `wss://`, a host with no credentials, an optional path, no query or fragment. Its path, if any,
 * is kept, without trailing slashes, and the link's path is appended to it.
 */
const RELAY_BASE = /^(?<origin>wss?:\/\/[^/?#@\s]+)(?<path>\/[^?#\s]*)?$/u;

function joined(base: string, path: string): string | undefined {
  const match = RELAY_BASE.exec(base);
  const origin = match?.groups?.origin;
  if (origin === undefined) return undefined;
  const prefix = (match?.groups?.path ?? "").replace(/\/+$/u, "");
  return `${origin}${prefix}${path}`;
}

/** A hub's link: `<relay url>/v1/hub`. */
export function hubLinkUrl(relayUrl: string): string | undefined {
  return joined(relayUrl, RELAY_PATHS.hub);
}

/** A relay's link to the push service: `<push url>/v1/relay`. */
export function relayLinkUrl(pushUrl: string): string | undefined {
  return joined(pushUrl, RELAY_PATHS.relay);
}

/** A phone's stream: `<relay url>/v1/phone/<identity>/<session | link | restore>`. */
export function phoneStreamUrl(relayUrl: string, phone: PhonePath): string | undefined {
  const path = formatPhonePath(phone);
  return path === undefined ? undefined : joined(relayUrl, path);
}

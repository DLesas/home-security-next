/**
 * A phone's path on the relay (docs/m4-design.md section 3, "Phones"):
 *
 *   <relay url>/v1/phone/<identity>/<session | link | restore>
 *
 * The identity is the hub's app identity as `formatIdentity` writes it: 26 characters of
 * lowercase base32. The relay checks only the form; the hub's session layer proves everything
 * else. A malformed path or identity is closed with 4400 (`PHONE_CLOSE.badPath`).
 */
import { PHONE_PATHS, type PhonePathName, RELAY_PATHS } from "./constants.ts";

/** An app identity's form, as `formatIdentity` writes it and `parseIdentity` reads it. */
export const IDENTITY_TEXT = /^[a-z2-7]{26}$/u;

/** A phone path's two parts. */
export interface PhonePath {
  readonly identity: string;
  readonly path: PhonePathName;
}

/** The path a phone opens, or undefined when the identity is not of the right form. */
export function formatPhonePath(phone: PhonePath): string | undefined {
  if (!IDENTITY_TEXT.test(phone.identity) || !PHONE_PATHS.includes(phone.path)) return undefined;
  return `${RELAY_PATHS.phonePrefix}/${phone.identity}/${phone.path}`;
}

/**
 * Reads a request's path (without query or fragment, which the relay refuses): exactly
 * `/v1/phone/<identity>/<path>`, nothing before or after. Undefined for anything else, which the
 * relay answers with 4400.
 */
export function parsePhonePath(text: string): PhonePath | undefined {
  const prefix = `${RELAY_PATHS.phonePrefix}/`;
  if (!text.startsWith(prefix)) return undefined;
  const parts = text.slice(prefix.length).split("/");
  if (parts.length !== 2) return undefined;
  const [identity, path] = parts;
  if (identity === undefined || path === undefined || !IDENTITY_TEXT.test(identity))
    return undefined;
  const name = PHONE_PATHS.find((candidate) => candidate === path);
  return name === undefined ? undefined : { identity, path: name };
}

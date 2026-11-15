/**
 * Codes that arrive in the page's address (m2-design.md section 5, "Linking"): a link address,
 * `https://<address>:8444/#link=<identity>.<secret>`, and the console's,
 * `http://127.0.0.1:8445/#console=<secret>`. The fragment never reaches a server; the web app
 * reads it, **removes it from the address bar and the history at once**, before anything else is
 * done with it, and starts the handshake. The secret then lives only in the linking call's memory.
 *
 * A browser's own history of visited pages may still hold the address it was opened with; a page
 * cannot change that (section 13 should say so).
 */
import {
  LINKING,
  parseConsoleFragment,
  parseLinkFragment,
  parseLinkQr,
  parseTypedCode,
} from "@hsn/protocol/app";
import type { LinkSecret } from "./handshake";

/** Where a code came from: the console's link is a console client (kind 0), the others a browser's. */
export type ArrivedCode =
  | { readonly from: "console"; readonly secret: LinkSecret }
  | { readonly from: "linkAddress"; readonly secret: LinkSecret }
  /** A fragment that named a code but could not be read: shown in words, never kept. */
  | { readonly from: "unreadable" };

export interface PageAddress {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

export interface PageHistory {
  replaceState(data: unknown, unused: string, url?: string): void;
}

/**
 * Reads a code from the address and removes it, from the address bar and the current history
 * entry, before returning. Undefined when the address carries none (and then nothing is changed).
 */
export function takeCodeFromAddress(
  location: PageAddress,
  history: PageHistory,
): ArrivedCode | undefined {
  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const isConsole = fragment.startsWith(`${LINKING.consoleFragment}=`);
  const isLink = fragment.startsWith(`${LINKING.linkFragment}=`);
  if (!isConsole && !isLink) return undefined;
  // First, before anything can fail: the secret leaves the address bar and the history.
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (isConsole) {
    const secret = parseConsoleFragment(fragment);
    return secret === undefined
      ? { from: "unreadable" }
      : { from: "console", secret: { kind: "secret", secret, identity: undefined } };
  }
  const link = parseLinkFragment(fragment);
  return link === undefined
    ? { from: "unreadable" }
    : {
        from: "linkAddress",
        secret: { kind: "secret", secret: link.secret, identity: link.identity },
      };
}

/** A code a person typed (`XXXX-XXXX-XXXX`), or undefined when its check character is wrong. */
export function typedSecret(text: string): LinkSecret | undefined {
  const code = parseTypedCode(text);
  return code === undefined ? undefined : { kind: "typed", code };
}

/**
 * A QR code's text, scanned in this browser: its identity and secret. The browser links on its own
 * origin, the only one the content security policy lets it reach, whatever addresses it names.
 */
export function qrSecret(text: string): LinkSecret | undefined {
  const qr = parseLinkQr(text);
  return qr === undefined
    ? undefined
    : { kind: "secret", secret: qr.secret, identity: qr.identity };
}

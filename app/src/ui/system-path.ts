/**
 * What the router is given of a link the system opened the app with (Expo Router's
 * `+native-intent`): never a secret. A code link (`hsn://link/1?…`, `hsn://restore/1?…`,
 * `hsn://pair/1?…`) carries its one-time secret in its query, and the router took any link it was
 * given as a route, so an unmatched one showed the whole link on screen. The initial code link
 * seeds Home. Later codes reach the phone client through `hub/start.native.ts` without dispatching
 * a navigation action while the link screen is up. A normal route keeps only its path.
 */

/** A code link, with or without its scheme: `link`, `restore` or `pair`, version 1. */
const CODE_LINK = /^(?:[a-z][a-z0-9+.-]*:)?\/{0,3}(?:link|restore|pair)\/1(?:[/?#]|$)/iu;

/** Resolves an initial code link to Home and leaves the current route in place for later codes. */
export function systemPath(link: string, initial = true): string | null {
  const text = link.trim();
  if (CODE_LINK.test(text)) return initial ? "/" : null;
  const path = text
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/iu, "")
    .replace(/^[a-z][a-z0-9+.-]*:/iu, "")
    .split(/[?#]/u)[0];
  if (path === undefined || path === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

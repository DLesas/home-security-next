/**
 * What the router is given of a link the system opened the app with (Expo Router's
 * `+native-intent`): never a secret. A code link (`hsn://link/1?…`, `hsn://restore/1?…`,
 * `hsn://pair/1?…`) carries its one-time secret in its query, and the router took any link it was
 * given as a route, so an unmatched one showed the whole link on screen. Now a code link becomes
 * Home (the code itself reaches the client by its own path: `hub/start.native.ts`'s links, read by
 * `hub/finder.ts`'s `readCode`, shown first by the link page), and any other link keeps only its
 * path, without query or fragment. Pure, so it is tested.
 */

/** A code link, with or without its scheme: `link`, `restore` or `pair`, version 1. */
const CODE_LINK = /^(?:[a-z][a-z0-9+.-]*:)?\/{0,3}(?:link|restore|pair)\/1(?:[/?#]|$)/iu;

/** The route a system link leads to: Home for a code link, else its path alone. */
export function systemPath(link: string): string {
  const text = link.trim();
  if (CODE_LINK.test(text)) return "/";
  const path = text
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/iu, "")
    .replace(/^[a-z][a-z0-9+.-]*:/iu, "")
    .split(/[?#]/u)[0];
  if (path === undefined || path === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

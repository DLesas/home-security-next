/**
 * The content security policy of the apps' and the console's listeners (docs/m2-design.md
 * section 5, "Styles under the policy") ‡: scripts, styles, fonts and images only from the hub,
 * connections only to the hub, no frames, no inline script except what the build hashes. The web
 * build's last step writes the SHA-256 of every inline `<style>` and `<script>` of `index.html`,
 * with the empty string's for React Native Web's own `<style>` element, into `web/csp.json`; the
 * hub's listeners and the test harness read it and build the header with `contentSecurityPolicy`.
 */
import { z } from "zod";

/** The file the web build writes beside `index.html`. */
export const CSP_FILE = "csp.json";

/** A CSP hash source: `'sha256-<base64>'`. */
const hashSource = z.string().regex(/^'sha256-[A-Za-z0-9+/]{43}='$/u, "'sha256-<base64>'");

/** `web/csp.json`. */
export const webCspFile = z
  .strictObject({
    /** The inline `<style>` elements' hashes, the empty string's among them. */
    styles: z.array(hashSource).readonly(),
    /** The inline `<script>` elements' hashes, if the build has any. */
    scripts: z.array(hashSource).readonly(),
  })
  .readonly();

export type WebCspFile = z.infer<typeof webCspFile>;

/**
 * The SHA-256 of the empty string, for the empty `<style>` React Native Web adds at run time and
 * fills through `insertRule`, which the policy does not govern.
 */
export const EMPTY_STYLE_HASH = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='";

/**
 * Whether `style-src` takes `'unsafe-inline'`, for styles only: if a browser of the list still
 * refuses React Native Web's styles under the hashes (section 5), this becomes true, without asking
 * again, and section 13 says so.
 */
export const STYLE_UNSAFE_INLINE = false as boolean;

/** The header's value, from the build's hashes. */
export function contentSecurityPolicy(file: WebCspFile): string {
  const styles = STYLE_UNSAFE_INLINE ? ["'unsafe-inline'"] : file.styles;
  return [
    "default-src 'self'",
    ["script-src 'self'", ...file.scripts].join(" "),
    ["style-src 'self'", ...styles].join(" "),
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

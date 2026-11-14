/**
 * The web build's hashing step (m2-design.md section 5, "Styles under the policy"): every inline
 * `<style>` and `<script>` of `index.html` is hashed, the empty string's hash is always there for
 * React Native Web's own element, scripts loaded by `src` are not, and the policy carries them.
 */
import { describe, expect, test } from "bun:test";
import { contentSecurityPolicy, EMPTY_STYLE_HASH } from "@hsn/protocol/app";
import { cspOf } from "../scripts/csp.ts";

describe("csp.json", () => {
  test("hashes inline styles and scripts, with the empty string's, and not scripts by src", () => {
    const html =
      '<style id="expo-reset">body{}</style><script src="/a.js" defer></script><script>x()</script>';
    const csp = cspOf(html);
    expect(csp.styles).toContain(EMPTY_STYLE_HASH);
    expect(csp.styles).toHaveLength(2);
    expect(csp.scripts).toHaveLength(1);
    const policy = contentSecurityPolicy(csp);
    expect(policy).toContain(`style-src 'self' ${csp.styles.join(" ")}`);
    expect(policy).toContain(`script-src 'self' ${csp.scripts.join(" ")}`);
    expect(policy).not.toContain("unsafe-inline");
  });

  test("the empty string's hash is SHA-256 of nothing", () => {
    expect(cspOf("").styles).toEqual([EMPTY_STYLE_HASH]);
    expect(EMPTY_STYLE_HASH).toBe(
      `'sha256-${new Bun.CryptoHasher("sha256").update("").digest("base64")}'`,
    );
  });
});

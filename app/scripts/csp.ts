/**
 * The web build's last step (m2-design.md section 5, "Styles under the policy"): the SHA-256 of
 * every inline `<style>` and `<script>` of the exported `index.html`, with the empty string's for
 * React Native Web's own `<style>`, written to `<build>/csp.json`, which the hub's listeners and
 * the test harness read to build the content security policy. Run as `bun scripts/csp.ts dist`.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CSP_FILE, EMPTY_STYLE_HASH, type WebCspFile, webCspFile } from "@hsn/protocol/app";

/** `'sha256-<base64>'` of an element's text, as the browser hashes it. */
function hashOf(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** The text of every inline element `tag` (one without `src`), in order. */
function inlineTexts(html: string, tag: "style" | "script"): readonly string[] {
  const pattern = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gu");
  return [...html.matchAll(pattern)]
    .filter((m) => !/\ssrc\s*=/u.test(m[1] ?? ""))
    .map((m) => m[2] ?? "");
}

/** The hashes of a build's `index.html`. */
export function cspOf(html: string): WebCspFile {
  const styles = [...new Set([...inlineTexts(html, "style").map(hashOf), EMPTY_STYLE_HASH])];
  const scripts = [...new Set(inlineTexts(html, "script").map(hashOf))];
  return webCspFile.parse({ styles, scripts });
}

if (import.meta.main) {
  const build = process.argv[2] ?? "dist";
  const csp = cspOf(readFileSync(join(build, "index.html"), "utf8"));
  writeFileSync(join(build, CSP_FILE), `${JSON.stringify(csp, null, 2)}\n`);
  console.log(`${CSP_FILE}: ${csp.styles.length} style and ${csp.scripts.length} script hashes`);
}

/**
 * Breaks at run time, so each important assertion can be shown to fail without editing the app,
 * the hub or the tests: `HSN_E2E_BREAK=<name>` (one name, or several joined by commas). The
 * bench's own (`siren-deaf`, `gateway-no-forward`, `noise-flat`) are read by `bench.ts`; these
 * act in the browser:
 *
 * - `csp-style`: a style element whose hash the policy does not hold is added to every page once
 *   it has loaded, as an inline style the build did not hash would be; the policy refuses it, the
 *   app still runs, and only the refusal tells.
 * - `axe-image`: an image with no text alternative is added to every page once it has loaded.
 */
import type { BrowserContext } from "@playwright/test";

export function breaking(name: string): boolean {
  return (process.env.HSN_E2E_BREAK ?? "").split(",").includes(name);
}

export async function applyBreaks(context: BrowserContext): Promise<void> {
  if (breaking("csp-style")) {
    await context.addInitScript(() => {
      window.addEventListener("load", () => {
        const style = document.createElement("style");
        style.textContent = "body { outline: 0 }";
        document.head.append(style);
      });
    });
  }
  if (breaking("axe-image")) {
    await context.addInitScript(() => {
      window.addEventListener("load", () => {
        const image = document.createElement("img");
        image.src = "/favicon.ico";
        document.body.append(image);
      });
    });
  }
}

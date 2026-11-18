/**
 * The browser tests (m2-design.md section 10, "The app"): the exported web build against a real
 * hub on a temporary data folder, with axe on every screen. Step 0's harness; the end-to-end
 * tests and the "done when" are owner A9's (`app/e2e/`).
 *
 * Test files are `*.e2e.ts`, not `*.spec.ts`: the root's `bun test` runs every `*.spec.*` file,
 * and these run in Playwright only. Browsers: Chromium by default; `HSN_E2E_BROWSERS` lists
 * others (`chromium,webkit,firefox`); `HSN_E2E_CHANNEL=chrome` or `msedge` uses the installed browser.
 */
import { defineConfig, devices } from "@playwright/test";

const browsers = (process.env.HSN_E2E_BROWSERS ?? "chromium").split(",");
const channel = process.env.HSN_E2E_CHANNEL;
const ENGINE: Readonly<Record<string, keyof typeof devices>> = {
  chromium: "Desktop Chrome",
  webkit: "Desktop Safari",
  firefox: "Desktop Firefox",
};

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  projects: browsers.map((name) => ({
    name,
    use: {
      ...devices[
        name === "chromium" && channel === "msedge"
          ? "Desktop Edge"
          : (ENGINE[name] ?? "Desktop Chrome")
      ],
      ...(name === "chromium" && channel !== undefined ? { channel } : {}),
    },
  })),
});

/**
 * Every route of the web build loads from the hub's own console listener (m2-design.md sections 5
 * and 8): its title shows, no script or style of the export is refused or missing, nothing is
 * refused under the content security policy, and axe finds nothing on it. Opened by address, as
 * a person following a link or reloading does, in a browser linked once through the console.
 */
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type Harness, startHarness } from "./support/harness.ts";

/** Each route and its title (`app/locales/en/common.json`, `screens`); Home's is its state. */
const ROUTES: readonly (readonly [path: string, title: string])[] = [
  ["/", "Disarmed"],
  ["/devices", "Devices"],
  ["/groups", "Groups"],
  ["/modes", "Modes"],
  ["/history", "History"],
  ["/notifications", "Notifications"],
  ["/settings", "Settings"],
  ["/people", "People"],
  ["/schedules", "Schedules"],
  ["/site", "This home"],
  ["/backup", "Backup and restore"],
  ["/updates", "Updates"],
  ["/link", "Link a device"],
  ["/status", "Hub status"],
  ["/setup", "First-time setup"],
];

test.describe.configure({ mode: "serial" });

let harness: Harness;
let context: BrowserContext;
let page: Page;
/** What went wrong while a route loaded: page errors, refused or missing files, policy refusals. */
let problems: string[] = [];

test.beforeAll(async ({ browser }) => {
  harness = await startHarness();
  context = await browser.newContext();
  page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(`${String(response.status())} ${response.url()}`);
  });
});
test.afterAll(async () => {
  await context.close();
  await harness.close();
});

async function load(path: string, title: string, timeout = 20_000): Promise<void> {
  problems = [];
  await page.goto(`${harness.url}${path}`);
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible({
    timeout,
  });
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  expect(problems).toEqual([]);
}

test("the console's link, so every route opens linked", async () => {
  await page.goto(await harness.consoleAddress());
  await expect(page.getByTestId("field-surface")).toBeVisible({ timeout: 20_000 });
});

for (const [path, title] of ROUTES) {
  test(`${path} loads from the hub: ${title}`, async () => {
    await load(path, title);
  });
}

test("/device/<id> loads from the hub: its script, named with `[id]`, is served", async () => {
  // The export names the device route's script `_expo/static/js/web/[id]-<hash>.js`, for
  // `app/src/app/device/[id].tsx`: the hub serves the real files under the web root.
  await load("/device/1", "Device", 5000);
});

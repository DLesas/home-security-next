/**
 * The harness works (m2-design.md section 10): the exported web build loads under the design's
 * content security policy, shows its texts from the locale, passes axe, and a real hub answers
 * beside it. Owner A9 builds the end-to-end tests on it.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { type Harness, startHarness } from "./support/harness.ts";

let harness: Harness;
test.beforeAll(async () => {
  harness = await startHarness();
});
test.afterAll(async () => {
  await harness.close();
});

test("an unlinked browser is asked to link, under the policy, with its text from the locale, and axe finds nothing", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy")) {
      violations.push(message.text());
    }
  });
  await page.goto(harness.url);
  // The screens are built (A7): a browser that holds no key for this hub is asked to link first.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Link this browser");
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  // The policy refuses nothing, a style as a script (section 5): the build's hashes cover
  // Expo's reset and React Native Web's empty <style>.
  expect(violations).toEqual([]);
});

test("a real hub answers beside it, on its control socket", async () => {
  const reply = (await harness.control({ kind: "status" })) as { reply?: { ok?: boolean } };
  expect(reply.reply?.ok).toBe(true);
});

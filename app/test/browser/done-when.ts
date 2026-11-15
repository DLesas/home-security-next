/**
 * M2's "done when" in a real browser against the real hub (the second pass; m2-design.md section
 * 8's screens): the hub process serving the exported build on its own listeners, under its own
 * content security policy. From `hsn open`'s code on the console to the house switched to Away;
 * then every other screen; a second browser on the home network linked by a link address, and a
 * third by a typed code for a new person (the hub asks the name). axe on every screen; any refusal
 * by the policy, or any other console error, fails.
 *
 *   bun run app:export && bun app/test/browser/done-when.ts
 *   HSN_CHECK_BROWSER=<path> bun app/test/browser/done-when.ts
 *
 * What it cannot do: add sensors and sirens. The real hub adds boards over USB, and no scripted
 * board on a pseudo-terminal exists yet (section 10 gives them to the end-to-end tests, A9); so
 * the countdown, the alarm and the confirmation of an open door are checked against the test hub
 * end, in `check.ts`.
 */
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "@playwright/test";
import { startRealHub, stopAllHubs } from "../support/real-hub";

const results: { readonly name: string; readonly ok: boolean; readonly detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`);
}

const hub = await startRealHub();
const browser = await chromium.launch(
  process.env.HSN_CHECK_BROWSER === undefined
    ? { channel: "chrome" }
    : { executablePath: process.env.HSN_CHECK_BROWSER },
);
const errors: string[] = [];
function watch(page: Page): void {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${m.text()} (${m.location().url})`);
  });
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) console.log("HTTP", r.status(), r.url());
  });
}
async function axe(page: Page, screen: string): Promise<void> {
  const report = await new AxeBuilder({ page }).analyze();
  check(
    `axe: ${screen}`,
    report.violations.length === 0,
    report.violations.map((v) => `${v.id} (${String(v.nodes.length)})`).join(", "),
  );
}

try {
  // ----- The hub computer's browser: hsn open's code, setup, Away -----
  const consoleContext = await browser.newContext({ acceptDownloads: true });
  const page = await consoleContext.newPage();
  watch(page);
  await page.goto(await hub.consoleCode());
  check(
    "the console's code leaves the address at once",
    !(await page.evaluate(() => location.href)).includes("#"),
  );
  await page.getByRole("heading", { level: 1, name: "Home" }).waitFor({ timeout: 20_000 });
  await page.getByTestId("setup-prompt").waitFor();
  await axe(page, "home, before setup");
  await page.getByRole("link", { name: "Continue setup" }).click();
  await page.getByRole("heading", { level: 1, name: "First-time setup" }).waitFor();
  await axe(page, "setup");
  await page.getByTestId("setup-person").fill("Anna");
  await page.getByRole("button", { name: "Save my name" }).click();
  await page.getByText("People: Anna.").waitFor();
  check("the first person made", true);
  await page.getByRole("button", { name: "Choose the quietest channel" }).click();
  await page.getByText("No gateway is connected. Plug one in first.").waitFor();
  check("a survey with no gateway is refused, in words", true);
  await page.getByRole("radio", { name: "DR3" }).click();
  await page.getByText("Data rate DR3 saved.").waitFor();
  await page.getByTestId("setup-wifi-name").fill("home-net");
  await page.getByTestId("setup-wifi-password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Save the Wi-Fi details" }).click();
  await page.getByText("Wi-Fi details saved.").waitFor();
  await page.getByText("Network now: home-net").waitFor();
  await page.getByRole("button", { name: "Look again" }).click();
  await page.getByText("No board is plugged in.").waitFor();
  check("the hub's USB ports listed: none plugged in", true);
  await axe(page, "setup, done as far as boards");
  await page.getByRole("link", { name: "Home" }).first().click();
  await page.getByRole("button", { name: "Switch to Away" }).waitFor();
  await page.getByRole("button", { name: "Switch to Away" }).focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("switch-result").waitFor();
  check(
    "switched to Away by keyboard: the hub's answer shown",
    (await page.getByTestId("switch-result").innerText()).startsWith("Done."),
  );
  const now = await page.getByTestId("current-mode").innerText();
  check("the current mode reads Away (an arming event from the hub)", now === "Now: Away", now);
  await axe(page, "home, switched");

  // ----- Every other screen, on the real hub -----
  const visit = async (path: string, heading: string) => {
    await page.goto(`${hub.consoleOrigin}${path}`);
    await page.getByRole("heading", { level: 1, name: heading }).waitFor({ timeout: 20_000 });
    await axe(page, heading);
  };
  await visit("/schedules", "Schedules");
  await page.getByRole("button", { name: "Add a schedule entry" }).click();
  await page.getByTestId("schedule-name").fill("Bedtime");
  await page.getByRole("radio", { name: "Away" }).click();
  await page.getByTestId("schedule-at").fill("22:30");
  await page.getByTestId("schedule-save").click();
  await page.getByText("Switches to Away at 22:30 · Every day").waitFor();
  check(
    "a schedule entry made, with its next run",
    (await page.getByText(/^Next: /u).count()) === 1,
  );
  await visit("/groups", "Groups");
  await page.getByRole("button", { name: "Add a group" }).click();
  await page.getByTestId("group-name").fill("Downstairs");
  await page.getByTestId("group-save").click();
  await page.getByText("Sounds every siren.", { exact: true }).waitFor();
  check("a group made", true);
  await visit("/modes", "Modes");
  await page.getByRole("button", { name: "Add a mode" }).click();
  await page.getByTestId("mode-name").fill("Night");
  await page.getByRole("checkbox", { name: "Downstairs" }).click();
  await page.getByTestId("mode-save").click();
  await page.getByText("Arms: Downstairs.").waitFor();
  check("a mode made from the group", true);
  await visit("/history", "History");
  await visit("/people", "People");
  await visit("/notifications", "Notifications");
  await visit("/site", "Site settings");
  await page.getByTestId("site-routine-days").fill("40");
  await page.getByRole("button", { name: "Save" }).last().click();
  await page.getByText("Routine records are kept 40 days").waitFor();
  check("retention set", true);
  await visit("/backup", "Backup and restore");
  const download = page.waitForEvent("download");
  await page.getByTestId("backup-export").click();
  check(
    "a backup export saved by the browser",
    (await download).suggestedFilename() === "hsn-backup.hsnb",
  );
  await page.getByRole("radio", { name: "The history" }).click();
  const history = page.waitForEvent("download");
  await page.getByTestId("backup-export").click();
  check(
    "a history export saved, named as one",
    (await history).suggestedFilename() === "hsn-history.jsonl",
  );
  await page
    .getByText("Exported: the browser saved the history file. It is not encrypted.")
    .waitFor();
  await visit("/updates", "Updates");
  await visit("/status", "Hub status");
  await visit("/devices", "Devices");

  // ----- A browser on the home network, by a link address -----
  if (hub.lanOrigin === undefined) {
    check("a second browser on the home network", false, "this computer has no network address");
  } else {
    await visit("/link", "Link a device");
    await page.getByRole("radio", { name: "A new person" }).click();
    await page.getByLabel("Their name", { exact: true }).fill("Cara");
    await page.getByTestId("link-make").click();
    // The hub names its usual port (8444) in the address whatever `--app-ports` said: this test's
    // hub listens on a free one (reported: hub-facts.ts's appsPort).
    const address = (await page.getByTestId("link-url").innerText()).replace(
      /:\d+\//u,
      `:${String(hub.lanPort)}/`,
    );
    await axe(page, "Link a device, an address made");
    const lan = await browser.newContext({ ignoreHTTPSErrors: true });
    const cara = await lan.newPage();
    watch(cara);
    await cara.goto(address);
    check(
      "the link address's code leaves the address at once",
      !(await cara.evaluate(() => location.href)).includes("#"),
    );
    await cara.getByRole("heading", { level: 1, name: "Home" }).waitFor({ timeout: 20_000 });
    check("linked by a link address, over HTTPS, as a new person", true);
    await axe(cara, "home, a person's browser");

    // ----- A third, by a typed code for a person not named: the hub asks -----
    await page.getByRole("radio", { name: "A code to type" }).click();
    await page.getByLabel("Their name", { exact: true }).fill("");
    await page.getByTestId("link-make").click();
    await page.getByTestId("link-code-made").waitFor();
    const code = await page.getByTestId("link-code-made").innerText();
    const third = await lan.newPage();
    watch(third);
    await third.context().clearCookies();
    const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
    const ben = await fresh.newPage();
    watch(ben);
    await ben.goto(hub.lanOrigin);
    await ben
      .getByRole("heading", { level: 1, name: "Link this browser" })
      .waitFor({ timeout: 20_000 });
    await axe(ben, "link this browser");
    // A mistyped code is caught by its check character, before anything is sent.
    await ben
      .getByTestId("link-code")
      .fill(`${code.slice(0, -1)}${code.endsWith("A") ? "B" : "A"}`);
    await ben.getByTestId("link-submit").click();
    await ben.getByText("That code is not right: check it and type it again.").first().waitFor();
    check("a mistyped code is caught before sending", true);
    await ben.getByTestId("link-code").fill(code);
    await ben.getByTestId("link-submit").click();
    await ben
      .getByTestId("link-person-name")
      .waitFor({ timeout: 25_000 })
      .catch(async () => {
        throw new Error(
          `no name asked; the page says: ${(await ben.locator("body").innerText()).replaceAll("\n", " / ").slice(0, 400)}; code ${code}`,
        );
      });
    await axe(ben, "the hub asks the name");
    await ben.getByTestId("link-person-name").fill("Ben");
    await ben.getByTestId("link-person-submit").click();
    await ben.getByRole("heading", { level: 1, name: "Home" }).waitFor({ timeout: 20_000 });
    check("linked by a typed code, the name asked by the hub", true);
    await page.goto(`${hub.consoleOrigin}/people`);
    await page.getByText("Ben", { exact: true }).first().waitFor();
    check(
      "the people the links made are listed",
      (await page.getByText("Cara", { exact: true }).count()) > 0,
    );
    await third.close();
  }

  const csp = errors.filter((e) => e.includes("Content Security Policy") || e.includes("Refused"));
  check("the content security policy refused nothing", csp.length === 0, csp.join(" | "));
  check(
    "no other console error",
    errors.length === csp.length,
    errors.filter((e) => !csp.includes(e)).join(" | "),
  );
} catch (error) {
  check(
    "the run reached its end",
    false,
    error instanceof Error ? error.message.replaceAll("\n", " / ").slice(0, 400) : String(error),
  );
} finally {
  const version = browser.version();
  await browser.close();
  await stopAllHubs();
  const failed = results.filter((r) => !r.ok);
  console.log(
    `${String(results.length - failed.length)} of ${String(results.length)} checks passed against the real hub (${version})`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

/**
 * M2's "done when" in the browser (docs/build-plan.md, M2; m2-design.md section 10, "The app"):
 * "an empty data folder, the console linked, setup, the gateway added on its own, a sensor and a
 * siren added over USB (scripted boards on pseudo-terminals), Away, a door opening, the countdown
 * banner, a disarm; and again with the alarm". Against a real hub process serving the web build
 * on its own listeners (`support/harness.ts`), with the scripted boards of `support/bench.ts`.
 *
 * One flow, in order, as a person goes through it on the hub computer's browser; each test is a
 * step of it and starts where the one before ended (serial: one failing stops the rest):
 *
 * 1. The console's first link: the address `hsn open` opens (a one-time console token).
 * 2. Setup: the first person's name; the gateway, added on its own when plugged in (D100); the
 *    radio (the channel by survey, the data rate); the Wi-Fi details for devices; a short entry
 *    countdown; the sensor and the siren added over USB and named (PR5); the device list.
 * 3. A group (the door and the siren it sounds), and a mode that arms it.
 * 4. Away, the door opening, the countdown, a disarm inside it: the siren never commanded.
 * 5. The mode, the door opening, the countdown, the alarm with the siren commanded and sounding
 *    (the scripted siren acted on a sound command), a disarm: the siren commanded off.
 * 6. The history showing it; a schedule entry.
 * 7. A second browser on the home network linked by a typed code, then removed: its session
 *    closes and it says it was removed.
 * 8. The hub's own records (as `hsn log --json` reads them), and a clean stop.
 * 9. No refusal under the content security policy in either browser (section 5), and axe on
 *    every screen the flow passed through (section 8).
 *
 * A fault found in someone else's code is a `test.fail` naming it, asserting what the design
 * says: it passes while the fault is there, and fails, to be removed, once it is fixed.
 */
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { applyBreaks } from "./support/breaks.ts";
import { type BoardsHarness, startBoardsHarness } from "./support/harness.ts";

const PERSON = "Ada";
const GUEST = "Bo";
const SENSOR = "front-door";
const SIREN = "hall-siren";
const GROUP = "Ground floor";
const MODE = "Night";
const SCHEDULE = "Nightly";
/** The entry countdown for these runs: long enough to see it and disarm, short to wait out. */
const COUNTDOWN_S = 10;
/** The scripted siren's output (`SirenState`, protocol.md §6). */
const SIREN_OFF = 0;
const SOUNDING_ALARM = 1;
/** What a door report takes to reach the browser: the radio, the gateway, the hub, the channel. */
const REPORT_MS = 20_000;

/**
 * axe's findings that are faults already reported, by screen (none now): the last test fails on
 * any other, and on one of these going away (remove it from here then).
 */
const KNOWN_AXE: Readonly<Record<string, readonly string[]>> = {};

test.describe.configure({ mode: "serial" });

let harness: BoardsHarness;
let context: BrowserContext;
let page: Page;
const refusals: string[] = [];
const axeFound = new Map<string, readonly string[]>();

/** Every refusal under the content security policy a page logs, from its first load on. */
function watchPolicy(watched: Page): void {
  watched.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy")) {
      refusals.push(message.text());
    }
  });
}

test.beforeAll(async ({ browser }) => {
  harness = await startBoardsHarness();
  context = await browser.newContext();
  await applyBreaks(context);
  page = await context.newPage();
  watchPolicy(page);
});
test.afterAll(async () => {
  await context.close();
  await harness.close();
});

/**
 * axe on the screen as it is now, kept by screen for the last test. It waits for the state
 * field's fade between looks (400 ms, docs/app-design.md "Motion") to end, so that colours are
 * measured as they stay, not halfway.
 */
async function axeOn(on: Page, screen: string): Promise<void> {
  await on.waitForFunction(() => document.getAnimations().length === 0);
  const result = await new AxeBuilder({ page: on }).analyze();
  axeFound.set(
    screen,
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  );
}

function mainNav(on: Page) {
  return on.getByRole("navigation", { name: "Main" });
}

function title(on: Page, name: string) {
  return on.getByRole("heading", { level: 1, name, exact: true });
}

async function goTo(destination: "Home" | "Devices" | "Activity" | "Settings"): Promise<void> {
  await mainNav(page).getByRole("link", { name: destination, exact: true }).click();
}

/** A page of Settings, from its index (docs/app-design.md "Layout"). */
async function openSettingsPage(name: string): Promise<void> {
  await goTo("Settings");
  await expect(title(page, "Settings")).toBeVisible();
  await page
    .getByRole("list", { name: "Settings" })
    .getByRole("link", { name: new RegExp(`^${name} `, "u") })
    .click();
}

/** A page of Devices, from the row of links above its title. */
async function openDevicesPage(name: "Groups" | "Modes"): Promise<void> {
  await goTo("Devices");
  await page
    .getByRole("navigation", { name: "Pages in Devices" })
    .getByRole("link", { name, exact: true })
    .click();
  await expect(title(page, name)).toBeVisible();
}

/** Home's state sentence: the level-1 heading in the state field. */
function stateSentence(on: Page) {
  return on.getByTestId("field-surface").getByRole("heading", { level: 1 });
}

function doorRow() {
  return page
    .getByRole("region", { name: "Doors" })
    .getByRole("listitem")
    .filter({ hasText: SENSOR });
}

function rowWithHeading(name: string) {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
}

test("the console's first link: the address hsn open opens links this browser", async () => {
  await page.goto(await harness.consoleAddress());
  await expect(page.getByTestId("field-surface")).toBeVisible({ timeout: 20_000 });
  // The token is taken out of the address before anything else reads it (section 5).
  expect(page.url()).not.toContain("console=");
  await expect(stateSentence(page)).toHaveText("Disarmed");
  await expect(page.getByText("First-time setup is not finished.")).toBeVisible();
  await axeOn(page, "home, before setup");
});

test("setup: the first person's name", async () => {
  await page.getByRole("link", { name: "Continue setup" }).click();
  await expect(title(page, "First-time setup")).toBeVisible();
  await axeOn(page, "setup");
  await page.getByRole("textbox", { name: "Your name" }).fill(PERSON);
  await page.getByRole("button", { name: "Save my name" }).click();
  await expect(page.getByText(`People: ${PERSON}.`)).toBeVisible();
});

test("setup: the gateway, plugged in, is added on its own (D100)", async () => {
  await expect(page.getByText("No gateway yet.")).toBeVisible();
  harness.bench.plug("gateway");
  const news = page.getByRole("region", { name: "New" });
  await expect(news.getByText(/^Gateway gateway-[0-9a-f]+ was added on its own\.$/u)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/^Gateways: gateway-[0-9a-f]+$/u)).toBeVisible();
  await axeOn(page, "setup, the gateway added");
});

test("setup: the radio, the channel by survey and the data rate", async () => {
  test.setTimeout(120_000);
  await page.getByRole("button", { name: "Choose the quietest channel" }).click();
  // The bench's gateway hears 868.5 MHz quietest (`NOISE_DBM`), not the tie-breaker's 868.3.
  await expect(page.getByText("The quietest channel is 868.5 MHz.")).toBeVisible({
    timeout: 90_000,
  });
  // The step says the channel the hub now holds, on this screen at once: the survey's answer is
  // followed by a `config {site}` event (m2-design.md section 5, "Live updates"), no reload.
  await expect(page.getByText("Channel: 868.5 MHz")).toBeVisible({ timeout: 3000 });
  await page
    .getByRole("radiogroup", { name: "Data rate" })
    .getByRole("radio", { name: "DR5", exact: true })
    .click();
  await expect(page.getByText("Data rate DR5 saved.")).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "Data rate" }).getByRole("radio", { name: "DR5" }),
  ).toHaveAttribute("aria-checked", "true");
});

test("setup: the Wi-Fi details for devices", async () => {
  await page.getByRole("textbox", { name: "Network name" }).fill("home-net");
  await page.getByRole("textbox", { name: "Network password" }).fill("not-a-real-password");
  await page.getByRole("button", { name: "Save the Wi-Fi details" }).click();
  await expect(page.getByText("Wi-Fi details saved.")).toBeVisible();
  await expect(page.getByText("Network now: home-net")).toBeVisible();
  await axeOn(page, "setup, the radio and the Wi-Fi");
});

test("setup: a short entry countdown for the doors to come, on This home", async () => {
  // The site's countdown is what a sensor added from now on is given (`countdown_default_s`).
  await openSettingsPage("This home");
  await expect(title(page, "This home")).toBeVisible();
  await axeOn(page, "this home");
  await page
    .getByRole("textbox", { name: "Countdown for sensors added from now on, in seconds" })
    .fill(String(COUNTDOWN_S));
  await page.getByRole("button", { name: "Save timings" }).click();
  await expect(
    page.getByText(
      new RegExp(
        `^Now: sensors added from now on start with a countdown of ${String(COUNTDOWN_S)} s;`,
        "u",
      ),
    ),
  ).toBeVisible();
});

test("setup: the sensor and the siren added over USB and named (PR5)", async () => {
  await openSettingsPage("Setup");
  await expect(title(page, "First-time setup")).toBeVisible();
  const ports = harness.bench.ports;
  for (const [port, name, role] of [
    [ports.sensor, SENSOR, "Sensor"],
    [ports.siren, SIREN, "Siren"],
  ] as const) {
    const board = rowWithHeading(`Port ${port}`);
    await expect(board.getByText(new RegExp(`^${role}, not paired, `, "u"))).toBeVisible();
    await board.getByRole("textbox", { name: `Name for the board on ${port}` }).fill(name);
    await board.getByRole("button", { name: `Add the board on ${port}` }).click();
    await expect(board.getByText(`${name} was added.`)).toBeVisible({ timeout: 20_000 });
  }
  const news = page.getByRole("region", { name: "New" });
  await expect(
    news.getByText(
      `Sensor ${SENSOR} was added. It is disarmed until the next switch to a mode that holds it.`,
    ),
  ).toBeVisible();
  await expect(news.getByText(`Siren ${SIREN} was added.`)).toBeVisible();
  await axeOn(page, "setup, the devices added");
});

test("the device list shows each device with its health (AP4)", async () => {
  await goTo("Devices");
  await expect(title(page, "Devices")).toBeVisible();
  const devices = page.getByRole("region", { name: "Paired devices" });
  // A device's row is one link: its name, its kind and battery, its state.
  for (const [name, kind] of [
    [SENSOR, "Sensor"],
    [SIREN, "Siren"],
    ["gateway-[0-9a-f]+", "Gateway"],
  ] as const) {
    await expect(
      devices.getByRole("link", {
        name: new RegExp(`^${name} ${kind}, (no battery reading|battery \\d+%) No problems$`, "u"),
      }),
    ).toBeVisible({ timeout: REPORT_MS });
  }
  await axeOn(page, "devices");
});

test("a group (the door, and the siren it sounds) and a mode that arms it", async () => {
  await openDevicesPage("Groups");
  await axeOn(page, "groups, none yet");
  await page.getByRole("button", { name: "Add a group" }).click();
  const editor = page.getByRole("region", { name: "New group" });
  await editor.getByRole("textbox", { name: "Group name" }).fill(GROUP);
  await editor
    .getByRole("group", { name: "Sensors in the group" })
    .getByRole("checkbox", { name: SENSOR })
    .click();
  await editor
    .getByRole("radiogroup", { name: "Sirens it sounds" })
    .getByRole("radio", { name: "Chosen sirens" })
    .click();
  await editor
    .getByRole("group", { name: "Which sirens" })
    .getByRole("checkbox", { name: SIREN })
    .click();
  await axeOn(page, "groups, editing");
  await editor.getByRole("button", { name: "Save changes" }).click();
  const group = rowWithHeading(GROUP);
  await expect(group.getByText(`Sensors: ${SENSOR}.`)).toBeVisible();
  // Which sirens sound for it, in one sentence under its name (D144).
  await expect(group.getByText(`${SIREN} sounds for this group.`)).toBeVisible();

  await openDevicesPage("Modes");
  await axeOn(page, "modes");
  await page.getByRole("button", { name: "Add a mode" }).click();
  const modeEditor = page.getByRole("region", { name: "New mode" });
  await modeEditor.getByRole("textbox", { name: "Mode name" }).fill(MODE);
  await modeEditor
    .getByRole("group", { name: "Groups it arms" })
    .getByRole("checkbox", { name: GROUP })
    .click();
  await modeEditor.getByRole("button", { name: "Save changes" }).click();
  await expect(rowWithHeading(MODE).getByText(`Arms: ${GROUP}.`)).toBeVisible();
});

test("removing the group's only siren asks first, naming the group; cancelling keeps it (D144)", async () => {
  await goTo("Devices");
  await page
    .getByRole("region", { name: "Paired devices" })
    .getByRole("link", { name: new RegExp(`^${SIREN} Siren`, "u") })
    .click();
  await page.getByRole("button", { name: `Delete ${SIREN}` }).click();
  const dialog = page.getByRole("alertdialog", {
    name: `Remove ${SIREN}? It must be paired again to come back.`,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      `${GROUP} will then have none of its own sirens left, so every siren will sound for it.`,
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove the siren" })).toBeVisible();
  await axeOn(page, "removing a siren, asked first");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // Nothing changed: the siren is still the group's.
  await openDevicesPage("Groups");
  await expect(rowWithHeading(GROUP).getByText(`${SIREN} sounds for this group.`)).toBeVisible();
});

test("home: the door opened and shut once, so the hub knows it shut", async () => {
  await goTo("Home");
  await expect(stateSentence(page)).toHaveText("Disarmed");
  // A sensor's Started says nothing of its door: its first door report does.
  harness.bench.door(true);
  await expect(doorRow()).toContainText("Open, disarmed", { timeout: REPORT_MS });
  harness.bench.door(false);
  await expect(doorRow()).toContainText("Closed, disarmed", { timeout: REPORT_MS });
  await expect(page.getByTestId("field-surface")).toContainText("Every door is closed.");
  await axeOn(page, "home, disarmed");
});

test("Away; the door opens; the countdown; Disarm inside it: no siren is told to sound", async () => {
  test.setTimeout(90_000);
  await page.getByRole("button", { name: "Arm away" }).click();
  await expect(stateSentence(page)).toHaveText("Armed, away");
  await expect(page.getByText(`Armed: ${SENSOR}.`)).toBeVisible();
  await expect(doorRow()).toContainText("Closed, armed");
  await axeOn(page, "home, armed away");
  harness.bench.door(true);
  await expect(stateSentence(page)).toHaveText("Countdown", { timeout: REPORT_MS });
  const field = page.getByTestId("field-surface");
  await expect(field.getByText(`${SENSOR} opened while armed.`)).toBeVisible();
  await expect(field.getByTestId("countdown-left")).toHaveText(/^\d+ seconds? left$/u);
  // The time left is said politely to a screen reader, the countdown at once (section 8).
  await expect(field.getByRole("status")).toHaveText(/^\d+ seconds? left$/u);
  await expect(field.getByRole("alert")).toContainText("Countdown");
  await axeOn(page, "home, countdown");
  await field.getByRole("button", { name: "Disarm", exact: true }).click();
  await expect(page.getByText(`Disarmed: ${SENSOR}.`)).toBeVisible();
  await expect(doorRow()).toContainText("Open, disarmed");
  // The countdown's end passes, and no siren was told to sound.
  await page.waitForTimeout((COUNTDOWN_S + 3) * 1000);
  await expect(stateSentence(page)).not.toHaveText("Alarm");
  const quiet = await harness.bench.state();
  expect(quiet.siren.soundCommands).toBe(0);
  expect(quiet.siren.output).toBe(SIREN_OFF);
  harness.bench.door(false);
  await expect(doorRow()).toContainText("Closed, disarmed", { timeout: REPORT_MS });
});

test("after Disarm in the countdown the state sentence says Disarmed", async () => {
  // docs/app-design.md "Wording": every sensor is disarmed, so the house reads Disarmed, though
  // the mode (Away, changed by hand) has not been switched.
  await expect(stateSentence(page)).toHaveText("Disarmed", { timeout: 3000 });
});

test("the mode; the door opens; the countdown; the alarm sounds the group's siren; Disarm stops it", async () => {
  test.setTimeout(120_000);
  await page.getByRole("button", { name: `Switch to ${MODE}` }).click();
  await expect(stateSentence(page)).toHaveText(`Armed, ${MODE}`);
  await expect(page.getByText(`Switched to ${MODE}.`)).toBeVisible();
  await expect(doorRow()).toContainText("Closed, armed");
  harness.bench.door(true);
  await expect(stateSentence(page)).toHaveText("Countdown", { timeout: REPORT_MS });
  await expect(stateSentence(page)).toHaveText("Alarm", { timeout: (COUNTDOWN_S + 10) * 1000 });
  const field = page.getByTestId("field-surface");
  await expect(field.getByRole("alert")).toContainText("Alarm");
  await expect(field.getByText(`Set off by ${SENSOR}.`)).toBeVisible();
  await expect(field.getByText(`Sirens sounding: ${SIREN}.`)).toBeVisible();
  await axeOn(page, "home, alarm");
  // The siren itself acted on a command to sound, and sounds.
  await expect
    .poll(async () => (await harness.bench.state()).siren.output, { timeout: 10_000 })
    .toBe(SOUNDING_ALARM);
  expect((await harness.bench.state()).siren.soundCommands).toBeGreaterThanOrEqual(1);
  await field.getByRole("button", { name: "Disarm", exact: true }).click();
  await expect(page.getByText("Disarmed. The alarm has stopped.")).toBeVisible();
  await expect(stateSentence(page)).not.toHaveText("Alarm");
  await expect
    .poll(async () => (await harness.bench.state()).siren.output, { timeout: 10_000 })
    .toBe(SIREN_OFF);
  expect((await harness.bench.state()).siren.offCommands).toBeGreaterThanOrEqual(1);
  harness.bench.door(false);
  await expect(doorRow()).toContainText("Closed, disarmed", { timeout: REPORT_MS });
});

test("once the alarm has ended, Home no longer says Countdown or Alarm", async () => {
  // m2-design.md section 5, "Live updates", and section 6: a countdown's end is told (`ended`
  // when it ran into the alarm), so no countdown is left on Home, with no reload.
  await expect(stateSentence(page)).not.toHaveText(/^(Alarm|Countdown)$/u, { timeout: 3000 });
});

test("the history shows the countdown, the alarm, the siren and the disarm", async () => {
  await goTo("Activity");
  await expect(title(page, "History")).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "Kind of record" })
    .getByRole("radio", { name: "The hub's decisions" })
    .click();
  await expect(page.getByRole("heading", { level: 2, name: "Records" })).toBeVisible();
  const records = page.getByRole("main").getByRole("list").getByRole("listitem");
  await expect(records.filter({ hasText: `Alarm: ${SENSOR}` })).toHaveCount(1);
  // Newest first: the alarm's run, as it happened, from the switch to the alarm's end.
  const run = [
    "Mode switched",
    `Armed: ${SENSOR}`,
    `Countdown started: ${SENSOR}`,
    `Alarm: ${SENSOR}`,
    `Siren commanded: ${SIREN}`,
    `Siren confirmed: ${SIREN}`,
    `Disarmed: ${SENSOR}`,
    "Alarm ended",
    `Siren commanded: ${SIREN}`,
  ];
  const shown = (await records.allTextContents()).toReversed();
  const order = run.reduce<number[]>((at, what) => {
    const from = (at.at(-1) ?? -1) + 1;
    const found = shown.findIndex((text, i) => i >= from && text.endsWith(what));
    return [...at, found];
  }, []);
  expect(order, `in order: ${run.join(" > ")}`).not.toContain(-1);
  await axeOn(page, "history");
});

test("a schedule entry: switch to the mode every day at 22:30", async () => {
  await openSettingsPage("Schedules");
  await expect(title(page, "Schedules")).toBeVisible();
  await axeOn(page, "schedules, none yet");
  await page.getByRole("button", { name: "Add a schedule entry" }).click();
  const editor = page.getByRole("region", { name: "New schedule entry" });
  await editor.getByRole("textbox", { name: "Entry name" }).fill(SCHEDULE);
  await editor
    .getByRole("radiogroup", { name: "What it does" })
    .getByRole("radio", { name: "Switch to a mode" })
    .click();
  await editor
    .getByRole("radiogroup", { name: "Which mode" })
    .getByRole("radio", { name: MODE })
    .click();
  await editor.getByRole("textbox", { name: "Time" }).fill("22:30");
  await editor
    .getByRole("radiogroup", { name: "On which days" })
    .getByRole("radio", { name: "Every day" })
    .click();
  await axeOn(page, "schedules, editing");
  await editor.getByRole("button", { name: "Save changes" }).click();
  const entry = rowWithHeading(SCHEDULE);
  await expect(entry.getByText(`Switches to ${MODE} at 22:30`)).toBeVisible();
  await expect(entry.getByText("Every day")).toBeVisible();
  // The hub works out the next run (the app does no calendar arithmetic, section 8), shown in
  // the hub's time zone.
  await expect(entry.getByText(/^Next: .*(22:30|10:30\sPM)$/u)).toBeVisible();
});

test("a second browser on the home network, linked by a typed code, then removed", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const lanUrl = harness.lanUrl;
  expect(lanUrl, "this computer has a home-network address for the apps' listener").toBeDefined();
  await openSettingsPage("Link a device");
  await expect(title(page, "Link a device")).toBeVisible();
  // The console's browser belongs to no one: it makes a code for a new person only, and says so.
  await expect(page.getByTestId("link-new-person-only")).toHaveText(
    "This is the hub computer's browser, which belongs to no one, so it can make a code only for a new person.",
  );
  await expect(page.getByRole("radiogroup", { name: "For whom" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Their name" }).fill(GUEST);
  await page
    .getByRole("radiogroup", { name: "As" })
    .getByRole("radio", { name: "A code to type" })
    .click();
  await page.getByRole("button", { name: "Make the code" }).click();
  const code = page.getByTestId("link-code-made");
  // Crockford's characters, the last a check character, which may also be one of `*~$=`.
  await expect(code).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{3}[0-9A-Z*~$=]$/u);
  await axeOn(page, "link a device, a code made");
  const typed = (await code.textContent()) ?? "";

  // Another browser, on the apps' listener: HTTPS with the hub's own certificate (section 5).
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  await applyBreaks(other);
  const second = await other.newPage();
  watchPolicy(second);
  await second.goto(lanUrl ?? "about:blank");
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("Link this browser");
  await axeOn(second, "second browser, link");
  await second.getByRole("textbox", { name: "Linking code" }).fill(typed);
  await second.getByRole("button", { name: "Link this browser" }).click();
  await expect(second.getByTestId("field-surface")).toBeVisible({ timeout: 20_000 });
  await expect(stateSentence(second)).not.toHaveText("");
  await axeOn(second, "second browser, home");

  await openSettingsPage("People");
  await expect(title(page, "People")).toBeVisible();
  await axeOn(page, "people");
  const guest = page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 2, name: GUEST, exact: true }) });
  await expect(
    guest.getByRole("heading", { level: 3, name: "Web browser", exact: true }),
  ).toBeVisible();
  await guest.getByRole("button", { name: "Remove Web browser" }).click();
  await guest.getByRole("button", { name: "Yes, remove" }).click();
  await expect(guest.getByText("No linked devices.")).toBeVisible();
  // The note of the removal, above the list, stays where a person sees it.
  await expect(page.getByTestId("people-removed")).toContainText("removed");
  // Its session is closed, and it says so.
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("This browser was removed", {
    timeout: 20_000,
  });
  await axeOn(second, "second browser, removed");
  await other.close();
});

test("the hub's records hold the flow, and it stops cleanly", async () => {
  const decisions = (await harness.records("decision")).map((r) => r.row.kind);
  for (const kind of [
    "person_added",
    "armed",
    "countdown_started",
    "alarm",
    "siren_command",
    "siren_confirmed",
    "alarm_ended",
    "disarmed",
    "mode_switched",
    "client_linked",
    "client_removed",
  ]) {
    expect(decisions, `the hub's decisions hold ${kind}`).toContain(kind);
  }
  expect(await harness.stop(), "the hub's exit code on SIGTERM").toBe(0);
});

test("no refusal under the content security policy, in either browser (section 5)", () => {
  expect(refusals).toEqual([]);
});

test("axe finds nothing on any screen the flow passed through", () => {
  const found = Object.fromEntries(
    [...axeFound.entries()]
      .map(([screen, ids]) => [screen, ids.map((id) => id.split(":")[0] ?? id)] as const)
      .filter(([, ids]) => ids.length > 0),
  );
  expect(axeFound.size).toBeGreaterThan(15);
  expect(found).toEqual(KNOWN_AXE);
});

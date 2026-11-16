/**
 * The web build in a real browser against the test hub end (the second pass: only for what the
 * real hub cannot be made to do on demand). The real hub adds sensors and sirens only over USB,
 * and no scripted board on a pseudo-terminal exists yet, so what needs devices runs here: the
 * gateway shown as added, boards added over USB, a confirmation for an open door, the countdown
 * and alarm banners and their Disarm, the device screens with readings, a critical notification.
 * Everything else, the "done when" as far as it goes without boards included, runs against the
 * real hub in `done-when.ts`. Run after `bun run app:export`:
 *
 *   bun app/test/browser/check.ts
 *   HSN_CHECK_BROWSER=<path> bun app/test/browser/check.ts
 *
 * It serves `dist/` under the policy built from the build's own `csp.json`, and fails on any
 * refusal; axe on every screen; the main controls by keyboard.
 */
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "@playwright/test";
import {
  contentSecurityPolicy,
  CSP_FILE,
  formatConsoleAddress,
  type DeviceObject,
  webCspFile,
} from "@hsn/protocol/app";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";
import { HubEnd } from "../support/hub-end";
import type { ChannelPath, Wire } from "../../src/hub/wire";

const DIST = join(import.meta.dir, "..", "..", "dist");
const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
};

const results: { readonly name: string; readonly ok: boolean; readonly detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`);
}

function device(id: number, name: string, role: DeviceObject["role"]): DeviceObject {
  return {
    id,
    name,
    role,
    state: "paired",
    firmware: "1.0.0",
    batteryPercent: role === "gateway" ? null : 87,
    signal: role === "gateway" ? null : { rssiDbm: -71, snrQuarterDb: 30 },
    temperatureC: 21,
    lastSeenMs: Date.UTC(2026, 10, 15, 9, 30),
    heardBy: role === "gateway" ? null : 1,
    health: { silent: false, batteryLow: false, tamperOpen: false, poorLink: false },
  };
}

// ----- The hub end, with what the "done when" asks of it -----
const hub = new HubEnd();
const sensorsArmed = new Map<number, "armed" | "disarmed" | "waitsForDoorToClose">();
let doorOpen = true;
let people: { id: number; name: string }[] = [];
hub.handle("people.list", () => ({
  ok: true,
  body: {
    userManagement: false,
    people: people.map((p) => ({
      ...p,
      manageUsers: true,
      manageSystem: true,
      devices: [],
      revision: 0,
    })),
    clients: [],
  },
}));
hub.handle("person.create", (body) => {
  people = [...people, { id: people.length + 1, name: body.name }];
  hub.emit("people", {
    person: {
      id: people.length,
      name: body.name,
      manageUsers: true,
      manageSystem: true,
      devices: [],
      revision: 0,
    },
  });
  return {
    ok: true,
    body: {
      id: people.length,
      name: body.name,
      manageUsers: true,
      manageSystem: true,
      devices: [],
      revision: 0,
    },
  };
});
hub.handle("site.survey", () => {
  hub.snapshot = { ...hub.snapshot, site: { ...hub.snapshot.site, channel: 1 } };
  hub.emit("config", { site: hub.snapshot.site });
  return { ok: true, body: { channel: 1, rate: hub.snapshot.site.rate } };
});
hub.handle("site.set", (body) => {
  hub.snapshot = {
    ...hub.snapshot,
    site: { ...hub.snapshot.site, rate: body.rate ?? hub.snapshot.site.rate },
  };
  hub.emit("config", { site: hub.snapshot.site });
  return { ok: true, body: hub.snapshot.site };
});
hub.handle("site.wifi", (body, client) => {
  if (client.kind !== "console") return { ok: false, error: { code: "consoleOnly", detail: {} } };
  hub.snapshot = { ...hub.snapshot, site: { ...hub.snapshot.site, wifiName: body.name } };
  hub.emit("config", { site: hub.snapshot.site });
  return { ok: true, body: hub.snapshot.site };
});
const ports = [
  {
    port: "usb-1",
    identity: {
      role: "sensor" as const,
      chipId: "a1b2",
      firmware: "1.0.0",
      paired: "no" as const,
      development: true,
    },
  },
  {
    port: "usb-2",
    identity: {
      role: null,
      chipId: "c3d4",
      firmware: "1.0.0",
      paired: "no" as const,
      development: true,
    },
  },
];
hub.handle("usb.list", () => ({ ok: true, body: { ports } }));
let nextDevice = 2;
hub.handle("usb.add", (body) => {
  const role = body.role ?? ports.find((p) => p.port === body.port)?.identity.role ?? "sensor";
  const added = device(nextDevice++, body.name, role);
  hub.snapshot = { ...hub.snapshot, devices: [...hub.snapshot.devices, added] };
  if (role === "sensor") sensorsArmed.set(added.id, "disarmed");
  hub.emit("device", { what: "added", device: added });
  return { ok: true, body: added };
});
hub.handle("mode.switch", (body) => {
  const sensors = [...sensorsArmed.keys()];
  if (body.mode === 1 && doorOpen && body.confirm?.openDoors !== true)
    return {
      ok: false,
      error: { code: "needsConfirmation", detail: { openDoors: sensors, lowBattery: [] } },
    };
  const arm = body.mode === 1 ? (doorOpen ? "waitsForDoorToClose" : "armed") : "disarmed";
  for (const s of sensors) sensorsArmed.set(s, arm);
  hub.emit("arming", {
    sensors: sensors.map((sensor) => ({ sensor, arm })),
    mode: { mode: body.mode, modified: false },
  });
  return {
    ok: true,
    body: {
      armed: arm === "armed" ? sensors : [],
      disarmed: arm === "disarmed" ? sensors : [],
      waiting: arm === "waitsForDoorToClose" ? sensors : [],
      lowBattery: [],
      heldBack: [],
    },
  };
});
hub.handle("disarm", () => {
  const sensors = [...sensorsArmed.keys()];
  for (const s of sensors) sensorsArmed.set(s, "disarmed");
  const alarmed = hub.snapshot.alarm !== null;
  hub.snapshot = { ...hub.snapshot, alarm: null };
  hub.emit("arming", {
    sensors: sensors.map((sensor) => ({ sensor, arm: "disarmed" as const })),
    mode: { mode: 2, modified: false },
  });
  for (const sensor of sensors)
    hub.emit("countdown", { sensor, what: "cancelled", secondsLeft: 0, trigger: null });
  if (alarmed) hub.emit("alarm", { what: "ended", alarm: null, sirens: [], ended: "disarmed" });
  return { ok: true, body: { disarmed: sensors, heldBack: [], alarmEnded: alarmed } };
});

// ----- The web build under its policy, and the channel on /app -----
if (!existsSync(join(DIST, CSP_FILE)))
  throw new Error("no web build: run `bun run app:export` first");
const policy = contentSecurityPolicy(
  webCspFile.parse(JSON.parse(readFileSync(join(DIST, CSP_FILE), "utf8"))),
);
const wires = new Map<ServerWebSocket<{ readonly path: ChannelPath }>, Promise<Wire | undefined>>();
const server = Bun.serve<{ readonly path: ChannelPath }>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, srv) {
    const url = new URL(request.url);
    const channel: ChannelPath | undefined =
      url.pathname === "/app" ? "session" : url.pathname === "/app/link" ? "link" : undefined;
    if (channel !== undefined) {
      return srv.upgrade(request, { data: { path: channel } })
        ? undefined
        : new Response("no", { status: 400 });
    }
    const path = normalize(decodeURIComponent(url.pathname));
    const file = join(DIST, path);
    const found = file.startsWith(DIST) && existsSync(file) && extname(file) !== "";
    return new Response(Bun.file(found ? file : join(DIST, "index.html")), {
      headers: {
        "content-type": TYPES[extname(found ? file : "x.html")] ?? "application/octet-stream",
        "content-security-policy": policy,
      },
    });
  },
  websocket: {
    open(ws) {
      wires.set(
        ws,
        hub.connect(ws.data.path, {
          message: (data) => ws.sendBinary(data),
          closed: (code) => {
            ws.close(code);
          },
        }),
      );
    },
    message(ws, data) {
      if (typeof data === "string") {
        ws.close(1003);
        return;
      }
      void wires.get(ws)?.then((wire) => wire?.send(new Uint8Array(data)));
    },
    close(ws) {
      void wires.get(ws)?.then((wire) => wire?.close(1000));
      wires.delete(ws);
    },
  },
});
const ORIGIN = `http://127.0.0.1:${String(server.port)}`;

// ----- The browser -----
const browser = await chromium.launch(
  process.env.HSN_CHECK_BROWSER === undefined
    ? { channel: "chrome" }
    : { executablePath: process.env.HSN_CHECK_BROWSER },
);
const context = await browser.newContext();
const refusals: string[] = [];
const watch = (page: Page) => {
  page.on("console", (m) => {
    if (m.type() === "error") refusals.push(m.text());
  });
  page.on("pageerror", (e) => refusals.push(`page error: ${e.message}`));
};

/** The state field's colour, as the browser paints it. */
async function fieldColour(page: Page): Promise<string> {
  return page
    .getByTestId("field-surface")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
}
const DAY = "rgb(227, 235, 229)";
const NIGHT = "rgb(23, 56, 58)";
const ALARM = "rgb(179, 38, 30)";

/**
 * With A7_SHOTS set to a folder: the page at 390 px and 1280 px wide, as tall as its content (the
 * app scrolls inside its own view, so a "full page" shot would stop at the window).
 */
const SHOTS = process.env.A7_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(500);
    const tall = await page.evaluate(() =>
      Math.max(...[...document.querySelectorAll("div")].map((d) => d.scrollHeight)),
    );
    await page.setViewportSize({ width, height: Math.max(800, tall + 120) });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${String(width)}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function axe(page: Page, screen: string): Promise<void> {
  const report = await new AxeBuilder({ page }).analyze();
  check(
    `axe: ${screen}`,
    report.violations.length === 0,
    report.violations.map((v) => `${v.id} (${String(v.nodes.length)})`).join(", "),
  );
}

const page = await context.newPage();
watch(page);
const secret = hub.tokenWithSecret("console");
await page.goto(formatConsoleAddress(server.port ?? 0, secret));
const addressAfter = await page.evaluate(() => location.href);
check(
  "the console's code leaves the address at once",
  !addressAfter.includes("#") && !addressAfter.includes("console="),
  addressAfter,
);
await page.getByTestId("state-field").waitFor({ timeout: 15_000 });
check(
  "linked as the console, a session open",
  [...hub.clients.values()].some((c) => c.kind === "console") && hub.openSessions === 1,
);
await page.getByTestId("setup-prompt").waitFor();
await axe(page, "home, before setup");

// Setup.
await page.getByRole("link", { name: "Continue setup" }).click();
await page.getByRole("heading", { level: 1, name: "First-time setup" }).waitFor();
await axe(page, "setup");
await page.getByTestId("setup-person").fill("Anna");
await page.getByRole("button", { name: "Save my name" }).click();
await page.getByText("People: Anna.").waitFor();
check("the first person made", people.length === 1);
await page.getByRole("button", { name: "Choose the quietest channel" }).click();
await page.getByText("The quietest channel is 868.3 MHz.").waitFor();
await page.getByTestId("setup-channel").getByText("Channel: 868.3 MHz").waitFor();
await page.getByRole("radio", { name: "DR3" }).click();
await page.getByText("Data rate DR3 saved.").waitFor();
await page.getByTestId("setup-wifi-name").fill("home-net");
await page.getByTestId("setup-wifi-password").fill("not-a-real-password");
await page.getByRole("button", { name: "Save the Wi-Fi details" }).click();
await page.getByText("Wi-Fi details saved.").waitFor();
check(
  "the Wi-Fi password is not kept in the page after saving",
  (await page.getByTestId("setup-wifi-password").inputValue()) === "",
);
// The gateway, plugged in, is added on its own (D100).
const gateway = device(1, "gateway-1", "gateway");
hub.snapshot = {
  ...hub.snapshot,
  devices: [gateway],
  gateways: [{ id: 1, session: true, offline: false, lastStatusMs: null }],
};
hub.emit("device", { what: "added", device: gateway });
await page.getByText("Gateway gateway-1 was added on its own.").waitFor();
await page.getByRole("button", { name: "Look again" }).click();
await page.getByTestId("usb-name-usb-1").fill("front-door");
await page.getByRole("button", { name: "Add the board on usb-1" }).click();
await page.getByText("front-door was added.").first().waitFor();
await page.getByRole("radio", { name: "Siren" }).last().click();
await page.getByTestId("usb-name-usb-2").fill("hall-siren");
await page.getByRole("button", { name: "Add the board on usb-2" }).click();
await page.getByText("hall-siren was added.").first().waitFor();
check(
  "a sensor and a siren added over USB",
  hub.seen
    .filter((r) => r.op === "usb.add")
    .map((r) => JSON.stringify(r.body))
    .join(" ") ===
    '{"port":"usb-1","name":"front-door"} {"port":"usb-2","name":"hall-siren","role":"siren"}',
);
await axe(page, "setup, with devices added");

// Devices.
await page.getByRole("link", { name: "Devices" }).first().click();
await page.getByRole("heading", { level: 1, name: "Devices" }).waitFor();
await page.getByTestId("device-2").getByText("Battery 87%", { exact: false }).waitFor();
await axe(page, "devices");
await shot(page, "devices");

// Home: the modes (by config events), Away with the door open confirmed, by keyboard.
hub.emit("config", { mode: { id: 1, name: "Away", fixed: "away", groups: [], revision: 0 } });
hub.emit("config", {
  mode: { id: 2, name: "Disarmed", fixed: "disarmed", groups: [], revision: 0 },
});
await page.getByRole("link", { name: "Home" }).first().click();
await page.getByRole("heading", { level: 1, name: "Disarmed" }).waitFor();
check(
  "by day, the state field is sage",
  (await fieldColour(page)) === DAY,
  await fieldColour(page),
);
await shot(page, "home-day");
await page.getByRole("heading", { level: 2, name: "New" }).waitFor();
await shot(page, "home-new-list");
await page.getByRole("button", { name: "Arm away" }).waitFor();
await page.getByRole("button", { name: "Arm away" }).focus();
await page.keyboard.press("Enter");
await page.getByRole("alertdialog", { name: "Confirm first" }).waitFor();
check(
  "Enter on a focused button sends",
  hub.seen.some((r) => r.op === "mode.switch"),
);
const focusedInDialog = await page.evaluate(() => document.activeElement?.getAttribute("role"));
check(
  "the confirmation takes the focus",
  focusedInDialog === "alertdialog",
  String(focusedInDialog),
);
await axe(page, "home, asking to confirm");
await page.getByRole("button", { name: "Arm anyway" }).click();
await page.getByText("front-door will arm when its door closes.").waitFor();
const confirmed = hub.seen.filter((r) => r.op === "mode.switch").at(-1);
check(
  "the confirmation is sent with the switch",
  JSON.stringify(confirmed?.body) === '{"mode":1,"confirm":{"openDoors":true,"lowBattery":false}}',
  JSON.stringify(confirmed?.body),
);
doorOpen = false;
hub.emit("arming", { sensors: [{ sensor: 2, arm: "armed" }], mode: { mode: 1, modified: false } });
await page.getByTestId("sensor-2").getByText("Not known yet, armed").waitFor();
check("each door's state in words, not colour", true);
await page.getByRole("heading", { level: 1, name: "Armed, away" }).waitFor();
await page.waitForTimeout(600); // The colour's 400 ms fade.
check(
  "armed, the state field is night",
  (await fieldColour(page)) === NIGHT,
  await fieldColour(page),
);
await axe(page, "home, night");
await shot(page, "home-night");

// The countdown and its banner, announced at once; then a disarm.
hub.emit("door", { sensor: 2, open: true, atMs: Date.now() });
hub.emit("countdown", { sensor: 2, what: "started", secondsLeft: 30, trigger: 1 });
await page.getByRole("alert").getByText("front-door opened while armed.").waitFor();
check(
  "the countdown's sentence is one word, with no typed name in it",
  (await page.getByRole("heading", { level: 1 }).innerText()) === "Countdown",
);
check(
  "news waits while a countdown runs",
  (await page.getByRole("heading", { name: "New" }).count()) === 0,
);
const live = await page.getByRole("alert").first().getAttribute("aria-live");
check("the countdown is in an assertive live region", live === "assertive", String(live));
await axe(page, "home, countdown");
check("a countdown is night", (await fieldColour(page)) === NIGHT, await fieldColour(page));
await shot(page, "home-countdown");
await page.getByTestId("banner-disarm").click();
await page.getByText("Disarmed: front-door.", { exact: true }).waitFor();
await page.getByRole("heading", { level: 1, name: "Disarmed" }).waitFor();
check(
  "the countdown is gone from the state field after the disarm",
  (await page.getByTestId("countdown-left").count()) === 0,
);

// The alarm.
hub.snapshot = { ...hub.snapshot, alarm: { startedMs: Date.now(), triggers: [2], sirens: [3] } };
hub.emit("alarm", {
  what: "started",
  alarm: { startedMs: Date.now(), triggers: [2], sirens: [3] },
  sirens: [],
  ended: null,
});
await page.getByRole("alert").getByText("Set off by front-door.").waitFor();
check(
  "the alarm's sentence is the one word Alarm",
  (await page.getByRole("heading", { level: 1 }).innerText()) === "Alarm",
);
await axe(page, "home, alarm");
check("the alarm is signal red", (await fieldColour(page)) === ALARM, await fieldColour(page));
await shot(page, "home-alarm");
await page.getByTestId("banner-disarm").click();
await page.getByText("Disarmed. The alarm has stopped.").waitFor();

// Reduced motion (the browser's own emulation): the field changes look at once, without the fade.
const fadeOf = async () =>
  page
    .getByTestId("field-surface")
    .first()
    .evaluate((el) => getComputedStyle(el).transitionProperty);
check(
  "normally the field's colour fades",
  (await fadeOf()).includes("background-color"),
  await fadeOf(),
);
await page.emulateMedia({ reducedMotion: "reduce" });
check("with reduced motion it has no fade", (await fadeOf()) === "none", await fadeOf());
hub.emit("arming", { sensors: [{ sensor: 2, arm: "armed" }], mode: { mode: 1, modified: false } });
await page.getByRole("heading", { level: 1, name: "Armed, away", exact: true }).waitFor();
const atOnce = await fieldColour(page);
check("with reduced motion it turns night at once", atOnce === NIGHT, atOnce);
await page.emulateMedia({ reducedMotion: "no-preference" });

// A reload keeps the key; a second tab shares the one session.
const before = hub.connections;
await page.reload();
await page.getByTestId("state-field").waitFor();
check(
  "after a reload, still linked with the same key: a new session, no new link",
  hub.connections === before + 1 && hub.clients.size === 1,
);
const second = await context.newPage();
watch(second);
await second.goto(`${ORIGIN}/devices`);
await second.getByRole("heading", { level: 1, name: "Devices" }).waitFor();
await second.getByTestId("device-2").waitFor();
check("two tabs, one session", hub.openSessions === 1, `${String(hub.openSessions)} sessions`);

// ----- Step 3's screens: each one, by its route, with axe; a few flows on them -----
let userManagement = false;
// A browser of Anna's that the person will remove: the note must outlive its row.
let oldLaptop = true;
hub.handle("client.remove", (body) => {
  if (body.client === 99) oldLaptop = false;
  hub.emit("people", { clientRemoved: body.client });
  return { ok: true, body: {} };
});
hub.handle("people.list", () => ({
  ok: true,
  body: {
    userManagement,
    people: people.map((p) => ({
      ...p,
      manageUsers: !userManagement,
      manageSystem: !userManagement,
      devices: [],
      revision: 0,
    })),
    clients: [
      ...[...hub.clients.values()].map((c) => ({
        id: c.id,
        person: c.person,
        kind: c.kind,
        name: c.name,
        createdMs: Date.now() - 1000,
        lastSeenMs: null,
        linkedBy: null,
      })),
      ...(oldLaptop && people.length > 0
        ? [
            {
              id: 99,
              person: 1,
              kind: "web" as const,
              name: "old-laptop",
              createdMs: Date.now() - 1000,
              lastSeenMs: null,
              linkedBy: null,
            },
          ]
        : []),
    ],
  },
}));
hub.handle("userManagement.set", (body) => {
  userManagement = body.on;
  hub.emit("people", { userManagement: body.on });
  return { ok: true, body: {} };
});
let nextGroup = 10;
hub.handle("group.create", (body) => {
  const group = { id: nextGroup++, ...body, revision: 0 };
  hub.emit("config", { group });
  return { ok: true, body: group };
});
hub.handle("schedule.create", (body) => {
  const entry = { id: 20, ...body, nextMs: Date.now() + 3_600_000, missed: null, revision: 0 };
  hub.emit("config", { schedule: entry });
  return { ok: true, body: entry };
});
hub.handle("history.query", () => ({
  ok: true,
  body: {
    rows: [
      {
        kind: "decision",
        row: {
          kind: "decision",
          row: {
            seq: 5,
            atMs: Date.now(),
            clockOk: true,
            kind: "mode_switched",
            deviceId: null,
            causeSeq: null,
            value: 1,
            detail: null,
          },
        },
      },
      {
        kind: "command",
        row: {
          kind: "command",
          row: {
            seq: 4,
            atMs: Date.now(),
            clockOk: true,
            actor: "Anna (client 1)",
            kind: "mode.switch",
            args: "{}",
            outcome: "ok",
            detail: null,
          },
        },
      },
    ],
  },
}));
const critical = {
  seq: 77,
  atMs: Date.now(),
  clockOk: true,
  kind: "tamper_opened",
  category: "tamper" as const,
  critical: true,
  device: 2,
  cause: null,
  read: false,
  delayed: false,
};
hub.handle("notifications.list", () => ({ ok: true, body: { notifications: [critical] } }));
hub.handle("notifications.read", () => ({ ok: true, body: {} }));
hub.handle("link.create", (body) => ({
  ok: true,
  body: {
    token: 3,
    ...(body.form === "code" ? { code: "ABCD-EFGH-JKM0" } : { url: `${ORIGIN}/#link=x.y` }),
    expiresInMs: 600_000,
  },
}));
hub.handle("backup.status", () => ({
  ok: true,
  body: { folder: null, hour: 3, keep: 20, newestMs: null, due: true, lastResult: "never" },
}));
hub.handle("update.status", () => ({
  ok: true,
  body: {
    staged: null,
    approvedBy: null,
    switching: false,
    lastResult: "none",
    lastResultMs: null,
  },
}));
hub.handle("hub.info", () => ({ ok: true, body: hub.snapshot.hub }));
hub.handle("hub.status", () => ({
  ok: true,
  body: {
    lastCommitMs: Date.now(),
    stagedItems: 3,
    databaseBytes: 12_000_000,
    historyShortened: false,
    missingAfterRestartMs: null,
  },
}));
hub.handle("device.show", (body) => {
  const found = hub.snapshot.devices.find((d) => d.id === body.device);
  return found === undefined
    ? { ok: false, error: { code: "notFound", detail: { what: "device", id: body.device } } }
    : { ok: true, body: { device: found, settings: { max: 180, version: 1 } } };
});

async function visit(path: string, heading: string, state = "day"): Promise<void> {
  await second.goto(`${ORIGIN}${path}`);
  await second.getByRole("heading", { level: 1, name: heading }).waitFor();
  await axe(second, `${heading} (${path}, ${state})`);
}
await visit("/settings", "Settings");
await shot(second, "settings-index");
await second.getByRole("link", { name: /^Schedules Arm, disarm/ }).click();
await second.getByRole("heading", { level: 1, name: "Schedules" }).waitFor();
check(
  "a Settings page has its link back to the index",
  (await second.getByTestId("back-to-index").getAttribute("href")) === "/settings",
);
await visit("/groups", "Groups");
await shot(second, "groups-empty");
await second.getByRole("button", { name: "Add a group" }).click();
await second.getByTestId("group-name").fill("Downstairs");
const sensorBox = second.getByRole("checkbox", { name: "front-door" });
await sensorBox.focus();
await second.keyboard.press("Space");
check("a checkbox by keyboard", (await sensorBox.getAttribute("aria-checked")) === "true");
await second.getByTestId("group-save").click();
await second.getByText("Sensors: front-door.").waitFor();
check(
  "a group made, its sensors in words",
  JSON.stringify(hub.seen.filter((r) => r.op === "group.create").at(-1)?.body) ===
    '{"name":"Downstairs","sensors":[2],"sirens":"all"}',
);
await axe(second, "Groups, with one");
await visit("/modes", "Modes");
// The reload's new snapshot forgot the modes (the stand-in: the snapshot carries none yet).
hub.emit("config", { mode: { id: 1, name: "Away", fixed: "away", groups: [], revision: 0 } });
await visit("/schedules", "Schedules");
await second.getByRole("button", { name: "Add a schedule entry" }).click();
await second.getByTestId("schedule-name").fill("Bedtime");
await second.getByRole("radio", { name: "Away" }).click();
await second.getByTestId("schedule-at").fill("22:30");
await shot(second, "schedules-form");
await second.getByTestId("schedule-save").click();
await second.getByText("Switches to Away at 22:30", { exact: true }).waitFor();
await second.getByText("Every day", { exact: true }).waitFor();
await axe(second, "Schedules, with one");
await visit("/history", "History");
await second.getByText("Mode switched").waitFor();
await visit("/people", "People");
check(
  "permissions hidden while user management is off",
  (await second.getByText("What Anna may do").count()) === 0,
);
await second
  .getByRole("checkbox", { name: "Let each person do only what their permissions allow" })
  .click();
await second.getByText("On: each person may do what their permissions allow.").waitFor();
await second.getByText("No access yet: give this person permissions below.").waitFor();
await axe(second, "People, user management on");
await second.getByTestId("remove-client-99").click();
await second.getByTestId("remove-client-99-yes").click();
await second.getByTestId("people-removed").getByText("old-laptop was removed.").waitFor();
check(
  "a removal is confirmed where it outlives the removed row",
  (await second.getByTestId("client-99").count()) === 0,
);
await visit("/link", "Link a device");
await second.getByRole("radio", { name: "A code to type" }).click();
await second.getByTestId("link-make").click();
await second.getByTestId("link-code-made").getByText("ABCD-EFGH-JKM0").waitFor();
await axe(second, "Link a device, a code made");
await shot(second, "link-code");
hub.emit("notification", critical);
await second.getByRole("alert").getByText("Cover opened: front-door").first().waitFor();
await visit("/notifications", "Notifications");
await axe(second, "Notifications, a critical one");
await visit("/site", "This home");
await visit("/backup", "Backup and restore");
await visit("/updates", "Updates");
await visit("/status", "Hub status");
await visit("/device/2", "Device");
await second.getByText("Countdown and heartbeat").waitFor();

// Every screen again, armed (night: a quiet page, as by day) and with the alarm sounding (the
// band over each): the accessibility check on each.
const SCREENS: readonly (readonly [string, string])[] = [
  ["/settings", "Settings"],
  ["/devices", "Devices"],
  ["/groups", "Groups"],
  ["/modes", "Modes"],
  ["/history", "History"],
  ["/notifications", "Notifications"],
  ["/people", "People"],
  ["/schedules", "Schedules"],
  ["/site", "This home"],
  ["/backup", "Backup and restore"],
  ["/updates", "Updates"],
  ["/link", "Link a device"],
  ["/status", "Hub status"],
  ["/setup", "First-time setup"],
  ["/device/2", "Device"],
];
// Events, not the snapshot: the first tab holds the session and does not read it again.
hub.emit("arming", { sensors: [{ sensor: 2, arm: "armed" }], mode: { mode: 1, modified: false } });
for (const [path, heading] of SCREENS) await visit(path, heading, "armed");
await second.goto(ORIGIN);
await second.getByRole("heading", { level: 1, name: "Armed, away", exact: true }).waitFor();
await axe(second, "home, armed after a reload");
hub.snapshot = { ...hub.snapshot, alarm: { startedMs: Date.now(), triggers: [2], sirens: [3] } };
hub.emit("alarm", {
  what: "started",
  alarm: { startedMs: Date.now(), triggers: [2], sirens: [3] },
  sirens: [],
  ended: null,
});
for (const [path, heading] of SCREENS) {
  await visit(path, heading, "alarm");
  await second.getByTestId("alarm-banner").waitFor();
}
await shot(second, "device-alarm-band");

const csp = refusals.filter((r) => r.includes("Content Security Policy") || r.includes("Refused"));
check("the content security policy refused nothing", csp.length === 0, csp.join(" | "));
check(
  "no other console error",
  refusals.length === csp.length,
  refusals.filter((r) => !csp.includes(r)).join(" | "),
);

const version = browser.version();
await browser.close();
await server.stop(true);
const failed = results.filter((r) => !r.ok);
console.log(
  `${String(results.length - failed.length)} of ${String(results.length)} browser checks passed (${version})`,
);
process.exitCode = failed.length === 0 ? 0 : 1;

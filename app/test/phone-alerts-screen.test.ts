/** Delivery status and permission controls on the actual Notifications screen. */
import "./support/render";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import type { AppOpName } from "@hsn/protocol/app";
import type { RequestOutcome } from "../src/hub/channel";
import type { Version2Channel } from "../src/hub/client";
import { pushLifecycle, type PushSession } from "../src/hub/push";
import { fakeAlertPermission } from "../src/platform/alert-permission.fake";
import type { AlertPermissionAnswer } from "../src/platform/alert-permission-types";
import { fakePush } from "../src/platform/push-device.fake";
import { clientScreen, screenAct } from "./support/client-screen";
import { screenWorld, textOf } from "./support/screens";
import { manualTimers } from "./support/timers";

const { NotificationsScreen } = await import("../src/ui/notifications");
const { phoneAlertStatus } = await import("../src/ui/phone-alerts");

const valid = { registered: true, valid: true };
const invalid = { registered: true, valid: false };
const unregistered = { registered: false, valid: false };

const ready = "Alerts from this home reach this phone.";
const permission = "This phone has not allowed notifications.";
const off = "Alerts from this home are turned off on this phone.";
const retry = "This phone could not set up alerts from this home yet and will try again.";
const unavailable = "This build of the app cannot receive alerts while it is closed.";
const section = "Alerts on this phone";
const toggle = "Alerts from this home on this phone";
const denied =
  "You will miss alerts while the app is closed, and you can still see them when the app is open.";

const cases = [
  ["confirmed locally and by the hub", {}, "ready"],
  ["no confirmed local key", { stored: false }, "retry"],
  ["the hub's target is invalid", { target: invalid }, "retry"],
  ["the hub has never registered this phone", { target: unregistered }, "retry"],
  [
    "the hub reports valid without registered",
    { target: { registered: false, valid: true } },
    "retry",
  ],
  ["the hub reports no target", { target: null }, "retry"],
  ["no local key or hub target", { stored: false, target: null }, "retry"],
  [
    "an unavailable build takes precedence over a previously valid registration",
    { available: false },
    "unavailable",
  ],
  [
    "an unavailable build takes precedence over an incomplete registration",
    { available: false, stored: false, target: null },
    "unavailable",
  ],
  ["not asked takes precedence over a valid target", { permission: "notAsked" }, "permission"],
  [
    "denied takes precedence over an incomplete registration",
    { permission: "denied", stored: false, target: invalid },
    "permission",
  ],
  [
    "permission takes precedence over an unavailable build",
    { permission: "denied", available: false },
    "permission",
  ],
  ["off takes precedence over a valid registration", { enabled: false }, "off"],
  [
    "off takes precedence over not asked, an unavailable build and no target",
    { enabled: false, permission: "notAsked", available: false, stored: false, target: null },
    "off",
  ],
  [
    "off takes precedence over an incomplete registration",
    { enabled: false, stored: false, target: invalid },
    "off",
  ],
] as const satisfies readonly (readonly [
  string,
  Partial<Parameters<typeof phoneAlertStatus>[0]>,
  ReturnType<typeof phoneAlertStatus>,
])[];

test.each(cases)("status picks %s", (_case, overrides, expected) => {
  expect(
    phoneAlertStatus({
      permission: "granted",
      available: true,
      enabled: true,
      stored: true,
      target: valid,
      ...overrides,
    }),
  ).toBe(expected);
});

let mounted: { screen: ReturnType<typeof clientScreen>; stop: () => void } | undefined;
afterEach(async () => {
  if (!mounted) return;
  // TanStack delivers its query notifications from a timer, while the test DOM still exists.
  await screenAct(() => Bun.sleep(5));
  mounted.stop();
  await mounted.screen.close();
  mounted = undefined;
});

/** Renders the real Notifications screen on a chosen phone with scripted system and hub answers. */
async function mount(
  options: {
    readonly answer?: AlertPermissionAnswer;
    readonly kind?: "phone" | "web";
    readonly version?: 1 | 2;
    readonly channelVersion?: 1 | 2;
    readonly deviceAvailable?: boolean;
    readonly android?: boolean;
    readonly acceptsRegistration?: boolean;
  } = {},
) {
  const fake = fakeAlertPermission(options.answer, options.android);
  const device = fakePush();
  if (options.deviceAvailable !== false)
    device.token({ platform: "fcm", environment: "production", token: "screen-fixture" });
  const push = pushLifecycle(device.storage, device.tokens, manualTimers(), fake.permission);
  const identity = "fixture";
  const session = { hub: "1.0.0", client: 7, boot: 1, person: 2, kind: options.kind ?? "phone" };
  const calls = { registered: 0, unregistered: 0, enabled: true, reachable: true };
  const selected: PushSession = {
    ...session,
    hub: identity,
    /** Saves the test home's choice. */
    alertChoice: (enabled) => {
      calls.enabled = enabled ?? calls.enabled;
      return Promise.resolve({ ok: true, value: calls.enabled });
    },
    /** Counts a registration without recording its sensitive fields. */
    register: () => {
      calls.registered++;
      return Promise.resolve({ ok: options.acceptsRegistration ?? true });
    },
    /** Counts an unregister and lets the test simulate a lost connection. */
    unregister: () => {
      calls.unregistered++;
      return Promise.resolve({ ok: calls.reachable });
    },
  };
  await push.start(() => Promise.resolve([]));
  await push.snapshot(selected, unregistered, []);
  const world = await screenWorld({
    session,
    hub: {
      hub: "1.0.0",
      proto: options.version ?? 2,
      identity,
      fingerprint: "fixture",
      timeZone: "Europe/London",
      clockTrusted: true,
      boot: 1,
    },
  });
  const v2: Version2Channel = {
    forward: () => Promise.resolve({ ok: false, local: "offline" }),
    onNewEvent: () => () => undefined,
  };
  const client = {
    ...world.client,
    ...(options.version === 1 && options.channelVersion !== 2 ? {} : { v2 }),
    phoneAlerts: push.alerts,
    /** Supplies the empty list without a retrying query. */
    request: <N extends AppOpName>() =>
      Promise.resolve({
        ok: true,
        body: { notifications: [] },
        repeat: false,
      } as RequestOutcome<N>),
  };
  const screen = clientScreen();
  mounted = { screen, stop: push.stop.bind(push) };
  await screen.render(world.wrap(createElement(NotificationsScreen), client));
  return {
    screen,
    fake,
    calls,
    /** Reads the rendered screen as text. */
    text: () => textOf(screen.html()),
    /** Reads the switch's accessibility state. */
    enabled: () =>
      /<[^>]*data-testid="phone-alert-switch"[^>]*>/u
        .exec(screen.html())?.[0]
        ?.includes('aria-checked="true"') === true,
  };
}

test("renders the explanation without asking, then asks once and registers after Allow notifications", async () => {
  const { screen, fake, calls, text } = await mount();
  expect(text()).toContain(section);
  expect(text()).toContain(permission);
  expect(text()).toContain(
    "Your phone will ask to allow notifications so alerts can reach you when the app is closed.",
  );
  expect(text()).not.toContain("Open settings");
  expect(text().indexOf(section)).toBeLessThan(text().indexOf("Test alert"));
  expect(fake.state.asked).toBe(0);
  expect(calls.registered).toBe(0);
  expect(await screen.press("Allow notifications")).toBe(true);
  expect(fake.state.asked).toBe(1);
  expect(calls.registered).toBe(1);
  expect(text()).toContain(ready);
  expect(text()).not.toContain(permission);
  expect(text()).not.toContain("Allow notifications");
});

test("a refusal explains closed-app delivery, opens settings, and a grant on return starts registration", async () => {
  const { screen, fake, calls, text } = await mount();
  fake.state.next = "denied";
  expect(await screen.press("Allow notifications")).toBe(true);
  expect(fake.state.asked).toBe(1);
  expect(text()).toContain(permission);
  expect(text()).toContain(denied);
  expect(calls.registered).toBe(0);
  expect(await screen.press("Allow notifications")).toBe(false);
  expect(await screen.press("Open settings")).toBe(true);
  expect(fake.state.settings).toBe(1);
  await screenAct(() => {
    fake.returnFromSettings("granted");
  });
  expect(calls.registered).toBe(1);
  expect(text()).toContain(ready);
});

test("a previous refusal goes straight to settings, and an unconfigured build says so after a grant", async () => {
  const { fake, calls, text } = await mount({ answer: "denied", deviceAvailable: false });
  expect(text()).toContain(denied);
  expect(text()).toContain("Open settings");
  expect(fake.state.asked).toBe(0);
  await screenAct(() => {
    fake.returnFromSettings("granted");
  });
  expect(text()).toContain(unavailable);
  expect(text()).not.toContain(permission);
  expect(calls.registered).toBe(0);
});

test("a phone with no confirmed registration shows the retry sentence", async () => {
  const { text, calls } = await mount({ answer: "granted", acceptsRegistration: false });
  expect(calls.registered).toBe(1);
  expect(text()).toContain(retry);
  expect(text()).not.toContain(ready);
});

test("Android explains loud alerts and opens app notification settings", async () => {
  const { screen, fake, text } = await mount({ answer: "granted" });
  expect(text()).toContain(
    "Alarms and countdowns can sound through Do Not Disturb if you allow them in your phone's settings.",
  );
  expect(await screen.press("Open notification settings")).toBe(true);
  expect(fake.state.notificationSettings).toBe(1);
  expect(fake.state.settings).toBe(0);
});

test("a phone without Android notification settings omits the loud alerts action", async () => {
  const { text } = await mount({ android: false });
  expect(text()).toContain(section);
  expect(text()).not.toContain("Do Not Disturb");
  expect(text()).not.toContain("Open notification settings");
});

test("an unreachable home leaves the switch on and explains the failure", async () => {
  const { screen, calls, text, enabled } = await mount({ answer: "granted" });
  calls.reachable = false;
  expect(await screen.press(toggle, "checkbox")).toBe(true);
  expect(calls.unregistered).toBe(1);
  expect(calls.enabled).toBe(true);
  expect(enabled()).toBe(true);
  expect(text()).toContain("Could not reach this home to change alerts.");
  expect(text()).toContain(ready);
});

test("the switch shows off after success and immediately starts registration when turned back on", async () => {
  const { screen, calls, text, enabled } = await mount({ answer: "granted" });
  expect(await screen.press(toggle, "checkbox")).toBe(true);
  expect(text()).toContain(off);
  expect(enabled()).toBe(false);
  expect(await screen.press(toggle, "checkbox")).toBe(true);
  expect(calls.unregistered).toBe(1);
  expect(calls.registered).toBe(2);
  expect(enabled()).toBe(true);
  expect(text()).toContain(ready);
});

test.each([
  ["a browser session", { kind: "web" }],
  ["a version 1 client", { version: 1 }],
  ["a negotiated version 1 session", { version: 1, channelVersion: 2 }],
] as const)("hides phone controls in %s", async (_case, options) => {
  const { fake, text } = await mount(options);
  expect(text()).not.toContain(section);
  expect(text()).not.toContain(toggle);
  expect(fake.state.asked).toBe(0);
});

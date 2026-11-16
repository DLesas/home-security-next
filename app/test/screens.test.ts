/**
 * The "done when" screens' parts, rendered as the web build renders them (m2-design.md section 8,
 * "Accessibility and translation"): the alarm and countdown announced at once, the time left
 * politely; every state in words as well as by any colour; Disarm always offered (the hub
 * decides); controls with roles and labels; each failure in words.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { DeviceObject } from "@hsn/protocol/app";
import { renderWith, textOf } from "./support/screens";

const banners = await import("../src/ui/banners");
const arming = await import("../src/ui/arming");
const field = await import("../src/ui/state-field");
const devicesUi = await import("../src/ui/devices");
const gate = await import("../src/ui/link-gate");
const parts = await import("../src/ui/parts");

function device(
  id: number,
  name: string,
  role: DeviceObject["role"],
  health: Partial<DeviceObject["health"]> = {},
): DeviceObject {
  return {
    id,
    name,
    role,
    state: "paired",
    firmware: "1.2.0",
    batteryPercent: 64,
    signal: { rssiDbm: -80, snrQuarterDb: 20 },
    temperatureC: 19,
    lastSeenMs: null,
    heardBy: null,
    health: { silent: false, batteryLow: false, tamperOpen: false, poorLink: false, ...health },
  };
}
const FRONT = device(4, "front-door", "sensor");
const SIREN = device(9, "hall-siren", "siren");

describe("the countdown and alarm banner", () => {
  test("the alarm: announced at once, naming its triggers and sirens, with Disarm", async () => {
    const html = await renderWith(createElement(banners.AlarmBanner), {
      devices: { 4: FRONT, 9: SIREN },
      alarm: { startedMs: 1, triggers: [4], sirens: [9] },
    });
    expect(html).toMatch(
      /role="alert"[^>]*aria-live="assertive"|aria-live="assertive"[^>]*role="alert"/u,
    );
    // One word for the sentence; what set it off, and the sirens, as detail.
    expect(textOf(html)).toContain("Alarm Set off by front-door.");
    expect(textOf(html)).toContain("Sirens sounding: hall-siren.");
    expect(html).toMatch(
      /role="button"[^>]*aria-label="Disarm"|aria-label="Disarm"[^>]*role="button"/u,
    );
    // Offered whoever looks: the hub decides what it disarms (D76).
    const disarmTag = /<button[^>]*aria-label="Disarm"[^>]*>/u.exec(html)?.[0] ?? "";
    expect(disarmTag).not.toBe("");
    expect(disarmTag).not.toContain("disabled");
  });

  test("a countdown: announced at once; the time left said politely; the visible count hidden from readers", async () => {
    const now = Date.now();
    const html = await renderWith(createElement(banners.AlarmBanner), {
      devices: { 4: FRONT },
      countdowns: { 4: { secondsLeft: 27, toldAtMs: now } },
    });
    expect(textOf(html)).toContain("Countdown front-door opened while armed.");
    expect(html).toContain('aria-live="assertive"');
    expect(html).toMatch(/aria-live="polite"[^>]*>(<[^>]+>)*30 seconds left/u);
    expect(html).toMatch(/aria-hidden="true"[^>]*>27 seconds left|27 seconds left/u);
  });

  test("nothing running: no banner", async () => {
    expect(await renderWith(createElement(banners.AlarmBanner), {})).toBe("");
  });

  test("out of touch: why, and when it tries again, said politely", async () => {
    const html = await renderWith(createElement(banners.ConnectionNotice), {
      connection: {
        kind: "waiting",
        failure: "refused",
        retryInMs: 4000,
        attempt: 2,
        mayBeRemoved: false,
      },
    });
    expect(html).toContain('aria-live="polite"');
    expect(textOf(html)).toContain("Out of touch with the hub");
    expect(textOf(html)).toContain("The hub did not accept this browser.");
    expect(textOf(html)).toContain("Trying again in 4 seconds.");
  });
});

describe("the home screen", () => {
  test("each door: its state and its arming in words, a row in a list", async () => {
    const html = await renderWith(createElement(arming.Doors), {
      devices: { 4: FRONT },
      sensors: {
        4: { id: 4, arm: "waitsForDoorToClose", door: "open", countdownSecondsLeft: null },
      },
    });
    expect(textOf(html)).toContain("front-door Open, arms when it closes");
    expect(html).toContain('role="list"');
    expect(html).toContain('role="listitem"');
  });

  test("during a countdown the door's row does not repeat the time left (the field shows it once)", async () => {
    const html = await renderWith(createElement(arming.Doors), {
      devices: { 4: FRONT },
      sensors: { 4: { id: 4, arm: "armed", door: "open", countdownSecondsLeft: 27 } },
      countdowns: { 4: { secondsLeft: 27, toldAtMs: Date.now() } },
    });
    expect(textOf(html)).toContain("front-door Open, armed");
    expect(textOf(html)).not.toContain("seconds left");
  });

  test("no doors: says what belongs there and offers to add one", async () => {
    const html = await renderWith(createElement(arming.Doors), {});
    expect(textOf(html)).toContain("No doors yet.");
    expect(html).toMatch(/<a[^>]*href="\/setup"[^>]*>Add a door<\/a>/u);
  });

  test("needs attention: only when a device has something wrong, said in words", async () => {
    expect(await renderWith(createElement(arming.NeedsAttention), { devices: { 4: FRONT } })).toBe(
      "",
    );
    const html = await renderWith(createElement(arming.NeedsAttention), {
      devices: { 4: device(4, "front-door", "sensor", { batteryLow: true, tamperOpen: true }) },
    });
    expect(textOf(html)).toContain("Needs attention");
    expect(textOf(html)).toContain("front-door Battery low, Cover open");
  });

  test("by day: Disarmed in words, Arm away first, every other mode offered", async () => {
    const html = await renderWith(createElement(field.StateField), {
      devices: { 4: FRONT },
      sensors: { 4: { id: 4, arm: "disarmed", door: "closed", countdownSecondsLeft: null } },
      mode: { mode: 2, modified: false },
      modes: {
        3: { id: 3, name: "Night", fixed: "no", groups: [], revision: 0 },
        2: { id: 2, name: "Disarmed", fixed: "disarmed", groups: [], revision: 0 },
        1: { id: 1, name: "Away", fixed: "away", groups: [], revision: 0 },
      },
    });
    expect(html).toMatch(/<h1[^>]*aria-level="1"[^>]*>Disarmed</u);
    expect(textOf(html)).toContain("Every door is closed.");
    const order = [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/gu)].map((m) => m[1]);
    expect(order).toEqual(["Arm away", "Switch to Night"]);
  });

  test("by night: the action's name kept (Arm away, Armed, away), Disarm first", async () => {
    const html = await renderWith(createElement(field.StateField), {
      devices: { 4: FRONT },
      sensors: { 4: { id: 4, arm: "armed", door: "open", countdownSecondsLeft: null } },
      mode: { mode: 1, modified: true },
      modes: {
        3: { id: 3, name: "Night", fixed: "no", groups: [], revision: 0 },
        2: { id: 2, name: "Disarmed", fixed: "disarmed", groups: [], revision: 0 },
        1: { id: 1, name: "Away", fixed: "away", groups: [], revision: 0 },
      },
    });
    expect(textOf(html)).toContain("Armed, away");
    expect(textOf(html)).toContain("front-door is open.");
    const order = [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/gu)].map((m) => m[1]);
    expect(order).toEqual(["Disarm", "Arm away", "Switch to Night", "Disarm what I manage"]);
  });

  test("after Disarm in a countdown: Disarmed, though the mode is still Away and the hub has not yet said the countdown ended", async () => {
    const html = await renderWith(createElement(field.StateField), {
      devices: { 4: FRONT },
      sensors: { 4: { id: 4, arm: "disarmed", door: "open", countdownSecondsLeft: 20 } },
      countdowns: { 4: { secondsLeft: 20, toldAtMs: Date.now() } },
      mode: { mode: 1, modified: false },
      modes: { 1: { id: 1, name: "Away", fixed: "away", groups: [], revision: 0 } },
    });
    expect(html).toMatch(/<h1[^>]*>Disarmed</u);
    expect(textOf(html)).not.toContain("Countdown");
  });

  test("after the hub says the countdown ended too: still Disarmed", async () => {
    const html = await renderWith(createElement(field.StateField), {
      devices: { 4: FRONT },
      sensors: { 4: { id: 4, arm: "disarmed", door: "open", countdownSecondsLeft: null } },
      mode: { mode: 1, modified: false },
      modes: { 1: { id: 1, name: "Away", fixed: "away", groups: [], revision: 0 } },
    });
    expect(html).toMatch(/<h1[^>]*>Disarmed</u);
  });

  test("one state field during a countdown", async () => {
    const html = await renderWith(createElement(field.StateField), {
      devices: { 4: FRONT },
      sensors: { 4: { id: 4, arm: "armed", door: "open", countdownSecondsLeft: 20 } },
      countdowns: { 4: { secondsLeft: 20, toldAtMs: Date.now() } },
    });
    expect([...html.matchAll(/data-testid="state-field"/gu)]).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Countdown</u);
  });

  test("no modes known: said so, not guessed", async () => {
    const html = await renderWith(createElement(field.StateField), {
      mode: { mode: 1, modified: false },
    });
    expect(textOf(html)).toContain("The hub has not said which modes it has yet");
    expect(html).not.toContain("Switch to");
    expect(html).not.toContain("Arm away");
  });
});

describe("the device list", () => {
  test("a row each: name, kind and battery, health in words; the whole row opens the device", async () => {
    const html = await renderWith(createElement(devicesUi.DeviceList), {
      devices: {
        4: device(4, "front-door", "sensor", { batteryLow: true, tamperOpen: true }),
        9: SIREN,
      },
    });
    const text = textOf(html);
    expect(text).toContain("front-door Sensor, battery 64% Battery low and Cover open");
    expect(text).toContain("hall-siren Siren, battery 64% No problems");
    expect(html).toContain('href="/device/4"');
    // The whole row is the link, named by its words: name, kind and battery, state.
    const row = /<a[^>]*href="\/device\/4"[^>]*>(.*?)<\/a>/su.exec(html)?.[1] ?? "";
    expect(textOf(row)).toBe("front-door Sensor, battery 64% Battery low and Cover open");
  });

  test("the device's page: signal, temperature, firmware, when last heard (moved from the list)", async () => {
    const html = await renderWith(
      createElement(devicesUi.DeviceItemFacts, {
        device: device(4, "front-door", "sensor", { batteryLow: true, tamperOpen: true }),
      }),
      {},
    );
    const text = textOf(html);
    expect(text).toContain("Battery low and Cover open");
    expect(text).toContain("Sensor Paired Battery 64% Signal -80 dBm 19 °C Firmware 1.2.0");
    expect(text).toContain("Not heard yet");
  });
});

describe("news and the settings index", () => {
  test("a device just added is news: a plain row under New, with Dismiss at the right, no box", async () => {
    const html = await renderWith(createElement(devicesUi.NewList), {
      devices: { 9: SIREN },
      added: [9],
    });
    expect(textOf(html)).toContain("New Siren hall-siren was added. Dismiss");
    expect(html).toContain('role="listitem"');
    expect(html).toContain('aria-label="Dismiss: Siren hall-siren was added."');
    expect(html).not.toContain('role="status"');
  });

  test("Settings opens a list of its eight pages, each a whole-row link with what it is for", async () => {
    const route = await import("../src/app/settings");
    const html = await renderWith(createElement(route.default), {});
    const hrefs = [...html.matchAll(/href="([^"]+)"/gu)].map((m) => m[1]);
    expect(hrefs).toEqual([
      "/people",
      "/schedules",
      "/site",
      "/backup",
      "/updates",
      "/link",
      "/status",
      "/setup",
    ]);
    expect(textOf(html)).toContain("Schedules Arm, disarm or switch mode at times you set.");
  });
});

describe("the link screen", () => {
  test("a removed browser is told so, and offered to link again", async () => {
    const html = await renderWith(createElement(gate.LinkGate), {
      connection: { kind: "removed" },
    });
    expect(textOf(html)).toContain("This browser was removed from the hub");
    expect(html).toContain('aria-label="Link this browser again"');
  });

  test("a browser that cannot keep a key is told it cannot be linked", async () => {
    const html = await renderWith(createElement(gate.LinkGate), {
      connection: { kind: "noStorage" },
    });
    expect(textOf(html)).toContain("cannot be linked");
  });

  test("each link failure in words; the console's says what to do", async () => {
    for (const failure of [
      "unreachable",
      "refused",
      "wrongHub",
      "notAccepted",
      "protocol",
      "timeout",
      "noWebCrypto",
      "extractable",
      "failed",
      "storage",
      "unreadable",
      "badCode",
    ] as const) {
      const html = await renderWith(
        createElement(gate.LinkGate),
        { connection: { kind: "notLinked" } },
        { kind: "failed", from: "console", failure },
      );
      const text = textOf(html);
      expect(text).not.toContain("link.failure");
      expect(text).toContain("Run hsn open on the hub computer again");
    }
  });

  test("the code field is labelled and its hint tied to it", async () => {
    const html = await renderWith(createElement(gate.LinkGate), {
      connection: { kind: "notLinked" },
    });
    expect(html).toMatch(/<input[^>]*aria-label="Linking code"/u);
    expect(html).toMatch(/<input[^>]*aria-describedby="[^"]+-hint"/u);
  });
});

describe("failures", () => {
  test("a refusal naming sensors names them", async () => {
    const html = await renderWith(
      createElement(parts.Failure, {
        outcome: { ok: false, error: { code: "unauthorized", detail: { devices: [4, 9] } } },
      }),
      {
        devices: { 4: FRONT, 9: SIREN },
      },
    );
    expect(textOf(html)).toContain(
      "You are not allowed to manage front-door and hall-siren, so nothing was changed.",
    );
    expect(html).toContain('aria-live="polite"');
  });
});

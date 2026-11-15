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
    expect(textOf(html)).toContain("Alarm: front-door");
    expect(textOf(html)).toContain("Sirens sounding: hall-siren");
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
    expect(textOf(html)).toContain("Countdown: front-door opened while armed");
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
  test("each sensor's arming and door in words", async () => {
    const html = await renderWith(createElement(arming.SensorPanel), {
      devices: { 4: FRONT },
      sensors: {
        4: { id: 4, arm: "waitsForDoorToClose", door: "open", countdownSecondsLeft: null },
      },
    });
    expect(textOf(html)).toContain("front-door Armed when the door closes · Door open");
    expect(html).toContain('role="list"');
    expect(html).toContain('role="listitem"');
  });

  test("the modes this browser knows, Away and Disarmed first, each a labelled button; the mode in words", async () => {
    const html = await renderWith(createElement(arming.ModePanel), {
      mode: { mode: 1, modified: true },
      modes: {
        3: { id: 3, name: "Night", fixed: "no", groups: [], revision: 0 },
        2: { id: 2, name: "Disarmed", fixed: "disarmed", groups: [], revision: 0 },
        1: { id: 1, name: "Away", fixed: "away", groups: [], revision: 0 },
      },
    });
    expect(textOf(html)).toContain("Now: Away, changed");
    const order = [...html.matchAll(/aria-label="Switch to ([^"]+)"/gu)].map((m) => m[1]);
    expect(order).toEqual(["Away", "Disarmed", "Night"]);
    expect(textOf(html)).toContain("Disarm everything I may manage");
  });

  test("no modes known: said so, not guessed", async () => {
    const html = await renderWith(createElement(arming.ModePanel), {
      mode: { mode: 1, modified: false },
    });
    expect(textOf(html)).toContain("The hub has not told this browser which modes it has");
    expect(textOf(html)).toContain("Now: a mode this browser does not know yet");
    expect(html).not.toContain("Switch to");
  });
});

describe("the device list", () => {
  test("health in words: battery, signal, silence, cover, poor link", async () => {
    const html = await renderWith(createElement(devicesUi.DeviceList), {
      devices: {
        4: device(4, "front-door", "sensor", { batteryLow: true, tamperOpen: true }),
        9: SIREN,
      },
    });
    const text = textOf(html);
    expect(text).toContain(
      "Sensor · Paired · Battery 64% · Signal -80 dBm · 19 °C · Firmware 1.2.0",
    );
    expect(text).toContain("Battery low · Cover open");
    expect(text).toContain("No problems");
    expect(text).toContain("Not heard yet");
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

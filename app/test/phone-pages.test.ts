/**
 * The phone's own pages (m3-design.md sections 2 to 4, P5 steps 3 and 4; docs/app-design.md, "On
 * a phone", rules 7 and 8), rendered as the tests render every screen (React Native Web), each in
 * its states: the camera screen and its permission pages, linking this phone (the first page, the
 * typed code, a code from another app, the local network's page, the failures in words, removed),
 * restoring a hub, and the shared screens' phone words. The pages take the phone's parts from a
 * context, given here as stand-ins.
 */
import "./support/render";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Permission, Scanner } from "../src/platform/scanner";
import type { PhoneParts } from "../src/ui/phone-parts";
import type { ScanState } from "../src/ui/scan";
import type { VaultStatus } from "../src/platform/vault";
import type { ReachState } from "../src/hub/phone-client";
import { createStore } from "zustand/vanilla";
import type { checkBluetooth as checkNativeBluetooth } from "../src/platform/ble.native";
import { renderWith, textOf } from "./support/screens";
import { clientScreen, screenAct } from "./support/client-screen";
import { ManualClock } from "../../tools/ble-bench/src/clock";

const { PhoneProvider } = await import("../src/ui/phone-parts");
const { Doors } = await import("../src/ui/arming");
const scan = await import("../src/ui/scan");
const link = await import("../src/ui/phone-link");
const restore = await import("../src/ui/phone-restore");
const words = await import("../src/ui/phone-words");
const { LINK_FAILURE_KEYS } = await import("../src/state/words");
const { i18n, startI18n } = await import("../src/i18n");
const { FileInput } = await import("../src/ui/file-input.native");
const { systemPath } = await import("../src/ui/system-path");
const { PhoneNotices } = await import("../src/ui/phone-notices");
if (!i18n.isInitialized) await startI18n();

const english = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "locales", "en", "common.json"), "utf8"),
) as Record<string, unknown>;

function has(key: string): boolean {
  let at: unknown = english;
  for (const part of key.split(".")) {
    if (typeof at !== "object" || at === null || !(part in at)) return false;
    at = (at as Record<string, unknown>)[part];
  }
  return typeof at === "string" && at !== "";
}

const UNDETERMINED: Permission = { state: "undetermined", canAskAgain: true };

function scanner(available: boolean, permission: Permission = UNDETERMINED): Scanner {
  return {
    available: () => Promise.resolve(available),
    permission: () => Promise.resolve(permission),
    ask: () => Promise.resolve(permission),
    View: () => null,
  };
}

function phoneParts(overrides: Partial<PhoneParts> = {}): PhoneParts {
  return {
    scanner: scanner(false),
    localNetwork: {
      permission: () => Promise.resolve(UNDETERMINED),
      ask: () => Promise.resolve(UNDETERMINED),
    },
    openSettings: () => undefined,
    linker: { link: () => Promise.resolve(), reachFault: () => undefined },
    restorer: { run: () => Promise.resolve({ ok: false, fault: "unreachable" }) },
    holdsBackupKey: () => Promise.resolve(false),
    arrived: { claim: () => undefined, subscribe: () => () => undefined },
    vault: createStore<VaultStatus>()(() => ({ fault: null, identity: null })),
    reach: createStore<ReachState>()(() => ({ localNetworkDenied: false, browse: null })),
    os: "ios",
    ...overrides,
  };
}

function onPhone(element: ReactElement, overrides: Partial<PhoneParts> = {}): ReactElement {
  return createElement(PhoneProvider, { parts: phoneParts(overrides), children: element });
}

const { formatLinkQr } = await import("@hsn/protocol/app");
const linkQr = (purpose: "link" | "restore") =>
  formatLinkQr(
    {
      identity: "abcdefghijklmnopqrstuvwxya",
      secret: new Uint8Array(16).fill(5),
      addresses: ["192.168.1.20"],
      port: 8444,
      fingerprint: new Uint8Array(32).fill(1),
    },
    purpose,
  );
const QR = linkQr("link");

describe("the camera screen (rule 8) and the camera's permission (rule 7)", () => {
  const render = (initial: ScanState) =>
    renderWith(
      createElement(scan.ScanScreen, {
        scanner: scanner(true),
        point: "Point the camera at the QR code on the hub computer or the other phone.",
        onCode: () => null,
        instead: { label: "Type the code instead", onPress: () => undefined },
        onOpenSettings: () => undefined,
        initial,
      }),
      {},
    );

  test("the state from the camera and its permission", () => {
    expect(scan.scanState(false, { state: "granted", canAskAgain: true })).toEqual({
      kind: "noCamera",
    });
    expect(scan.scanState(true, { state: "granted", canAskAgain: true })).toEqual({ kind: "view" });
    expect(scan.scanState(true, UNDETERMINED)).toEqual({ kind: "ask" });
    expect(scan.scanState(true, { state: "denied", canAskAgain: true })).toEqual({ kind: "ask" });
    expect(scan.scanState(true, { state: "denied", canAskAgain: false })).toEqual({
      kind: "refused",
    });
  });

  test("before the system's question: the sentence it will ask with, and one button naming it", async () => {
    const text = textOf(await render({ kind: "ask" }));
    expect(text).toContain("Scan the code");
    expect(text).toContain(
      "The camera reads the QR codes that link this phone, restore a hub and add devices.",
    );
    expect(text).toContain("Allow the camera");
    expect(text).not.toContain("Open settings");
  });

  test("after a no: what will not work, Open settings, and the way with no camera", async () => {
    const text = textOf(await render({ kind: "refused" }));
    expect(text).toContain("Without the camera, this phone cannot scan a code.");
    expect(text).toContain("Open settings");
    expect(text).toContain("Type the code instead");
    expect(text).not.toContain("Allow the camera");
  });

  test("the view: what to point at, the square, Type the code instead and the light, nothing over it", async () => {
    const html = await render({ kind: "view" });
    const text = textOf(html);
    expect(text).toContain("Point the camera at the QR code");
    expect(text).toContain("Type the code instead");
    expect(text).toContain("Light on");
    expect(html).toContain('aria-label="The camera&#x27;s view"');
  });

  test("a phone with no camera says so and offers the typed code", async () => {
    const text = textOf(await render({ kind: "noCamera" }));
    expect(text).toContain("This phone has no camera to scan with.");
    expect(text).toContain("Type the code instead");
  });
});

describe("linking this phone (m3-design.md section 3)", () => {
  const gate = (
    initial: Parameters<typeof link.PhoneLinkGate>[0]["initial"],
    overrides: Partial<PhoneParts> = {},
    view?: Parameters<typeof renderWith>[2],
  ) =>
    renderWith(
      onPhone(
        createElement(link.PhoneLinkGate, initial === undefined ? {} : { initial }),
        overrides,
      ),
      { connection: { kind: "notLinked" } },
      view,
    );

  test("the first page: its title and the two ways in", async () => {
    const text = textOf(await gate({ kind: "start" }));
    expect(text).toContain("Link this phone");
    expect(text).toContain("Scan the code");
    expect(text).toContain("Type the code");
  });

  test("the typed code or link address, with its action under it", async () => {
    const html = await gate({ kind: "type" });
    expect(html).toMatch(/<input[^>]*aria-label="Code or link address"/u);
    expect(textOf(html)).toContain("Scan the code instead");
  });

  test("a code from another app is shown before it is used, naming its address", async () => {
    const read = (await import("../src/hub/finder")).readCode(QR);
    expect(read.ok).toBe(true);
    const step = link.stepForArrival({ from: "deepLink", text: QR });
    expect(step.kind).toBe("confirm");
    const text = textOf(await gate(step));
    expect(text).toContain("Link this phone to the home at 192.168.1.20?");
    expect(text).toContain("Cancel");
    expect(link.stepForArrival({ from: "deepLink", text: "https://example.com" })).toEqual({
      kind: "start",
    });
    // A restore code opened from another app goes to restoring; one that does not read, nowhere.
    expect(link.stepForArrival({ from: "deepLink", text: linkQr("restore") }).kind).toBe("restore");
    expect(link.stepForArrival({ from: "deepLink", text: "hsn://restore/1?h=x" }).kind).toBe(
      "start",
    );
  });

  test("the local network's page before the first link, and after a no", async () => {
    const code = {
      secret: { kind: "secret" as const, secret: new Uint8Array(16), identity: undefined },
      from: "qr" as const,
    };
    const asking = textOf(await gate({ kind: "network", code, refused: false }));
    expect(asking).toContain("Reach your hub");
    expect(asking).toContain("The app reaches your hub over your home network.");
    expect(asking).toContain("Allow the local network");
    const refused = textOf(await gate({ kind: "network", code, refused: true }));
    expect(refused).toContain(
      "Without the local network, this phone cannot reach your hub at home.",
    );
    expect(refused).toContain("Open settings");
  });

  test("linking and its failures in the phone's words, the system's refusal and no hub found among them", async () => {
    expect(textOf(await gate({ kind: "start" }, {}, { kind: "linking", from: "qr" }))).toContain(
      "Linking this phone…",
    );
    const failed = { kind: "failed", from: "qr", failure: "unreachable" } as const;
    expect(textOf(await gate({ kind: "start" }, {}, failed))).toContain(
      "The hub cannot be reached from this phone.",
    );
    const denied = {
      linker: { link: () => Promise.resolve(), reachFault: () => "localNetworkDenied" as const },
    };
    expect(textOf(await gate({ kind: "start" }, denied, failed))).toContain(
      "Turn on Local Network for this app in Settings.",
    );
    const none = {
      linker: { link: () => Promise.resolve(), reachFault: () => "noHubFound" as const },
    };
    expect(textOf(await gate({ kind: "start" }, none, failed))).toContain(
      "No hub answered on this network.",
    );
  });

  test("the phone client's reach in words: the system's refusal, or no hub found by the browse", () => {
    expect(words.reachFaultOf({ localNetworkDenied: false, browse: null })).toBeUndefined();
    expect(words.reachFaultOf({ localNetworkDenied: true, browse: null })).toBe(
      "localNetworkDenied",
    );
    expect(words.reachFaultOf({ localNetworkDenied: false, browse: "localNetworkDenied" })).toBe(
      "localNetworkDenied",
    );
    for (const browse of ["unsupported", "failed", "notBuilt"] as const)
      expect(words.reachFaultOf({ localNetworkDenied: false, browse })).toBe("noHubFound");
  });

  test("every failure the link view can show has the phone's words, and no word says browser", () => {
    for (const failure of Object.keys(LINK_FAILURE_KEYS) as (keyof typeof LINK_FAILURE_KEYS)[]) {
      const key = words.phoneFailureKey(failure, undefined);
      expect(has(key)).toBe(true);
      expect(i18n.t(key)).not.toContain("browser");
    }
    for (const reach of ["localNetworkDenied", "noHubFound"] as const)
      expect(has(words.phoneFailureKey("unreachable", reach))).toBe(true);
    // The reach's words only for an unreachable hub.
    expect(words.phoneFailureKey("refused", "noHubFound")).toBe("phoneLink.failure.refused");
    for (const fault of ["notOurs", "unreadable", "notHome"] as const)
      expect(has(words.codeNotice(fault))).toBe(true);
    expect(i18n.t(words.codeNotice("notOurs"))).toBe("This is not a code from your home system.");
  });

  test("removed: said, with Link again", async () => {
    const html = await renderWith(onPhone(createElement(link.PhoneLinkGate, {})), {
      connection: { kind: "removed" },
    });
    expect(textOf(html)).toContain("This phone was removed from your home.");
    expect(textOf(html)).toContain("Link again");
  });

  test("the hub asks for the new person's name, with the phone's button", async () => {
    const html = await gate({ kind: "start" }, {}, { kind: "askingName", from: "qr" });
    expect(html).toMatch(/<input[^>]*aria-label="Your name"/u);
    expect(textOf(html)).toContain("Link this phone");
  });

  test("Android's back goes from any step to the first page, and from it out", () => {
    expect(link.stepBack({ kind: "start" })).toBeNull();
    expect(link.stepBack({ kind: "scan" })).toEqual({ kind: "start" });
    expect(link.stepBack({ kind: "type" })).toEqual({ kind: "start" });
  });

  test("a browser has no phone parts, so no phone link page", async () => {
    const html = await renderWith(createElement(link.PhoneLinkGate, {}), {
      connection: { kind: "notLinked" },
    });
    expect(textOf(html)).toBe("");
  });
});

describe("restoring a hub from the phone (m3-design.md section 4)", () => {
  const offer = {
    identity: "AB3DEF7GHJ2KMNP4QRSTV5WXYZ",
    epoch: 2,
    madeMs: Date.UTC(2026, 2, 3, 3, 0, 0),
    lastChangeMs: Date.UTC(2026, 2, 1),
  };
  const page = (initial: Parameters<typeof restore.PhoneRestore>[0]["initial"]) =>
    renderWith(
      onPhone(
        createElement(restore.PhoneRestore, {
          code: null,
          ...(initial === undefined ? {} : { initial }),
        }),
      ),
      {},
    );

  test("each step in words", async () => {
    expect(textOf(await page({ kind: "checking" }))).toContain("Checking the backup…");
    expect(
      textOf(await page({ kind: "restoring", offered: { offer, homeName: "Home" } })),
    ).toContain(`Restoring Home from the backup of ${restore.dayAndMonth("en", offer.madeMs)}.`);
    expect(textOf(await page({ kind: "noKey", madeMs: offer.madeMs }))).toContain(
      `This phone does not hold the key for that backup. Use a phone that was linked to that home on ${restore.dayAndMonth("en", offer.madeMs)}.`,
    );
    expect(textOf(await page({ kind: "done", offered: { offer, homeName: null } }))).toContain(
      "Restored.",
    );
    expect(textOf(await page({ kind: "failed", fault: "wrongKey" }))).toContain(
      "This key does not open that backup.",
    );
    expect(textOf(await page({ kind: "failed", fault: "timeout" }))).toContain(
      "The new hub did not answer in time.",
    );
  });

  test("it starts at the camera, as Settings' Restore a hub opens it", async () => {
    const html = await renderWith(onPhone(createElement(restore.PhoneRestore, { code: null })), {});
    expect(textOf(html)).toContain("Scan the code");
  });

  test("every way a restore can stop has words", () => {
    for (const fault of [
      "unreachable",
      "refused",
      "wrongHub",
      "notAccepted",
      "storage",
      "wrongKey",
      "badFile",
      "expired",
      "busy",
      "protocol",
      "timeout",
    ] as const)
      expect(has(restore.restoreFaultKey(fault))).toBe(true);
  });

  test("the outcome's page: no key with the backup's date, the failure, or restored", () => {
    const offered = { offer, homeName: "Home" };
    expect(restore.stepAfter({ ok: false, fault: "noKey", offer }, undefined)).toEqual({
      kind: "noKey",
      madeMs: offer.madeMs,
    });
    expect(restore.stepAfter({ ok: false, fault: "busy" }, offered)).toEqual({
      kind: "failed",
      fault: "busy",
    });
    expect(restore.stepAfter({ ok: true, offer }, offered)).toEqual({ kind: "done", offered });
  });

  test("in a browser, which holds no key: where a restore is done", async () => {
    const html = await renderWith(createElement(restore.PhoneRestore, { code: null }), {});
    expect(textOf(html)).toContain("A hub is restored on the hub computer");
  });
});

describe("the shared screens on a phone", () => {
  test("choosing a file says to do it on the hub computer, under the same label", async () => {
    const html = await renderWith(
      createElement(FileInput, { label: "Backup file", onFile: () => undefined }),
      {},
    );
    expect(textOf(html)).toContain("Backup file");
    expect(textOf(html)).toContain("Choose this file on the hub computer");
    expect(html).not.toContain("<input");
  });

  test("a tick box's long label shrinks to wrap inside the gutter (on Link a device)", () => {
    // React Native Web's test render drops class names, so the class is read where it is written.
    const source = readFileSync(join(import.meta.dir, "..", "src", "ui", "parts.tsx"), "utf8");
    const toggle = source.slice(
      source.indexOf("export function Toggle"),
      source.indexOf("export function CheckList"),
    );
    expect(toggle).toContain(
      '<Text className="shrink font-text text-body text-ink">{label}</Text>',
    );
  });

  test("every key a screen gives the phone's words for has them, without the browser's", () => {
    const src = join(import.meta.dir, "..", "src");
    const used = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/u.test(f))
      .flatMap((f) =>
        [
          ...readFileSync(join(src, f), "utf8").matchAll(/\bt\("([^"]+)", (?:\{ \.\.\.)?HERE/gu),
        ].map((m) => m[1] ?? ""),
      );
    expect(used.length).toBeGreaterThan(8);
    for (const key of used) {
      expect(has(`${key}_phone`)).toBe(true);
      expect(i18n.t(key, { context: "phone" })).not.toMatch(/browser/u);
    }
  });
});

describe("a link's secret is never on screen (+native-intent, +not-found, the error screen)", () => {
  const SECRET = "BQUFBQUFBQUFBQUFBQUFBQ";

  test("link and restore codes received during startup or in use do not dispatch navigation", async () => {
    const { redirectSystemPath } = await import("../src/app/+native-intent");
    for (const purpose of ["link", "restore"] as const) {
      const path = linkQr(purpose);
      expect(redirectSystemPath({ path, initial: true })).toBe("/");
      expect(redirectSystemPath({ path, initial: false })).toBeNull();
    }
    expect(redirectSystemPath({ path: "hsn:///devices", initial: false })).toBe("/devices");
  });

  test("a code link becomes Home; any other link keeps only its path", () => {
    for (const purpose of ["link", "restore"] as const) {
      expect(systemPath(linkQr(purpose))).toBe("/");
      expect(systemPath(linkQr(purpose).replace("hsn://", "/"))).toBe("/");
      expect(systemPath(linkQr(purpose).replace("hsn://", ""))).toBe("/");
    }
    expect(systemPath("hsn://pair/1?c=ABCD1234&d=a1b2c3d4e5f6")).toBe("/");
    expect(systemPath("HSN://LINK/1?s=x")).toBe("/");
    expect(systemPath("hsn:///devices")).toBe("/devices");
    expect(systemPath("/device/4")).toBe("/device/4");
    expect(systemPath(`hsn:///link?s=${SECRET}`)).toBe("/link");
    expect(systemPath(`https://example.com/x?s=${SECRET}#link=${SECRET}`)).toBe("/x");
    expect(systemPath("hsn://")).toBe("/");
    // "Link a device" is a route of its own; only version 1 of a code link is a code.
    expect(systemPath("/link")).toBe("/link");
    for (const link of [linkQr("link"), linkQr("restore"), `hsn:///x?s=${SECRET}`, `/a#${SECRET}`])
      expect(systemPath(link)).not.toContain(SECRET);
  });

  test("the page for no route names no path; the error screen says no message", async () => {
    const NotFound = (await import("../src/app/+not-found")).default;
    const notFound = textOf(await renderWith(createElement(NotFound), {}));
    expect(notFound).toContain("There is no such page");
    expect(notFound).not.toContain("/");
    const { ErrorBoundary } = await import("../src/ui/failed-screen");
    const failed = textOf(
      await renderWith(
        createElement(ErrorBoundary, {
          error: new Error(`Unmatched route ${linkQr("link")}`),
          retry: () => Promise.resolve(),
        }),
        {},
      ),
    );
    expect(failed).toContain("This page could not be shown");
    expect(failed).not.toContain(SECRET);
    expect(failed).not.toContain("hsn://");
  });
});

describe("what is wrong on the phone itself (phone-notices.tsx)", () => {
  const notices = (fault: VaultStatus["fault"], denied: boolean) =>
    renderWith(
      onPhone(createElement(PhoneNotices), {
        vault: createStore<VaultStatus>()(() => ({ fault, identity: null })),
        reach: createStore<ReachState>()(() => ({ localNetworkDenied: denied, browse: null })),
      }),
      {},
    );

  test("each fault of the secure store in words that say what to do", async () => {
    for (const [fault, said] of [
      ["locked", "Unlock the phone"],
      ["denied", "Restart the phone and open the app again."],
      ["corrupt", "Link this phone again"],
      ["full", "Free some space"],
      ["failed", "Try again"],
    ] as const) {
      const text = textOf(await notices(fault, false));
      expect(text).toContain(said);
      expect(text).not.toContain("vault.");
    }
    expect(textOf(await notices(null, false))).toBe("");
  });

  test("the local network refused: what will not work, and Open settings", async () => {
    const text = textOf(await notices(null, true));
    expect(text).toContain("Turn on Local Network for this app in Settings.");
    expect(text).toContain("Open settings");
  });

  test("nothing in a browser", async () => {
    expect(textOf(await renderWith(createElement(PhoneNotices), {}))).toBe("");
  });
});

describe("the Bluetooth permission before pairing or an update", () => {
  test("asks first, and gives radio-off, denied and unsupported states different actions", async () => {
    const { BluetoothPermission } = await import("../src/pairing/permission");
    const { TextLink } = await import("../src/ui/parts");
    const show = async (state: "off" | "unauthorized" | "unsupported" | undefined) =>
      textOf(
        await renderWith(
          onPhone(
            createElement(BluetoothPermission, {
              state,
              onAnswer: () => undefined,
              exit: createElement(TextLink, { href: "/devices", label: "Back to Devices" }),
            }),
          ),
          {},
        ),
      );
    expect(await show(undefined)).toContain("Bluetooth adds devices");
    expect(await show("off")).toContain("Turn it on and check again");
    expect(await show("unauthorized")).toContain("Open settings");
    expect(await show("unsupported")).toContain("Back to Devices");
    expect(await show("unsupported")).not.toContain("Open settings");
  });
});

const ble = await import("../src/platform/ble");
const { BluetoothEntry } = await import("../src/pairing/permission");
const { TextLink } = await import("../src/ui/parts");
const { radioClock } = await import("../src/pairing/radio");
type BluetoothCheck = typeof checkNativeBluetooth;

describe("starting Bluetooth on a mounted phone page", () => {
  const originalBle = { ...ble };
  let screen: ReturnType<typeof clientScreen> | undefined;

  afterEach(async () => {
    await screen?.close();
    screen = undefined;
    mock.restore();
    await mock.module("../src/platform/ble", () => originalBle);
  });

  /** Mounts a phone page with a scripted Bluetooth check. */
  async function mount(page: ReactElement, checkBluetooth: BluetoothCheck) {
    await mock.module("../src/platform/ble", () => ({ ...originalBle, checkBluetooth }));
    const view = clientScreen();
    screen = view;
    await view.render(onPhone(page));
    return view;
  }

  /** Mounts the shared entry and records when the page is allowed to proceed. */
  async function enter(checkBluetooth: BluetoothCheck) {
    const onReady = mock(() => undefined);
    const view = await mount(
      createElement(BluetoothEntry, {
        onReady,
        exit: createElement(TextLink, { href: "/devices", label: "Back to Devices" }),
      }),
      checkBluetooth,
    );
    return { view, onReady };
  }

  test("a pending Bluetooth check keeps the page frame and exit visible", async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<BluetoothCheck>>>();
    const { view, onReady } = await enter(() => pending.promise);
    expect(textOf(view.html())).toContain("Checking Bluetooth…");
    expect(view.html()).toContain('role="main"');
    expect(view.html()).toContain('href="/devices"');
    expect(textOf(view.html())).not.toContain("Bluetooth adds devices");
    expect(view.html()).not.toContain('role="button"');
    expect(onReady).not.toHaveBeenCalled();
  });

  test("a Bluetooth check with no reply ends at the deadline", async () => {
    const clock = new ManualClock();
    spyOn(radioClock, "after").mockImplementation(clock.after.bind(clock));
    const pending = Promise.withResolvers<Awaited<ReturnType<BluetoothCheck>>>();
    const { view, onReady } = await enter(() => pending.promise);
    expect(clock.pending).toBe(1);
    await screenAct(() => clock.advance(2999));
    expect(textOf(view.html())).toContain("Checking Bluetooth…");
    await screenAct(() => clock.advance(1));
    expect(clock.pending).toBe(0);
    expect(textOf(view.html())).toContain("Could not check Bluetooth.");
    expect(view.html()).toContain('href="/devices"');

    await screenAct(() => {
      pending.resolve("on");
    });
    expect(onReady).not.toHaveBeenCalled();
  });
});

describe("firmware results on the sensor page", () => {
  test("explains failed installs and does not attach a stale refusal to a confirmed update", async () => {
    const { UpdateResult } = await import("../src/pairing/update-page");
    const show = async (state: "confirmed" | "rolledBack" | "refused") =>
      textOf(
        await renderWith(
          createElement(UpdateResult, {
            event: { state, reason: "noWifi" },
            version: "1.4.0",
          }),
          {},
        ),
      );
    expect(await show("confirmed")).toContain("Updated to 1.4.0");
    expect(await show("confirmed")).not.toContain("couldn't join Wi-Fi");
    expect(await show("rolledBack")).toContain("couldn't join Wi-Fi");
    expect(await show("refused")).toContain("couldn't join Wi-Fi");
  });
});

test("no doors on a phone: opens the app’s device-add flow", async () => {
  const html = await renderWith(onPhone(createElement(Doors)), {});
  expect(textOf(html)).toContain("No doors yet. Add a door sensor in this app.");
  expect(html).toMatch(/<a[^>]*href="\/device\/add"[^>]*>Add a device<\/a>/u);
});

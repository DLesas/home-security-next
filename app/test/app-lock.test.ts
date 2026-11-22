/**
 * The app lock (m3-design.md section 6, "App lock"; AP1a, D63), its rules at their edges, with a
 * fake check, a fake `AppState`, clocks moved by hand and the secure store in memory: it locks at
 * start; on a return after more than a minute in the background (59 s and exactly 60 s do not, 61
 * s does, and a wall clock set back does too); not on a phone with no face, finger or passcode,
 * where it is not offered either; a failed and a cancelled unlock stay locked; turning it on asks
 * once; turned off, it never locks. Then the native file over a stand-in of
 * expo-local-authentication, the lock page and "Lock the app" under This phone.
 */
import "./support/render";
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { fakeCheck } from "../src/platform/app-lock.fake";
import { type CheckWords, type LockAbility, NO_ABILITY } from "../src/platform/app-lock-types";
import { memorySecureItems, type MemoryItems } from "../src/platform/vault";
import {
  type AppLock,
  appLock,
  AWAY_MS,
  awayTooLong,
  LOCK_ITEM,
  lockOffered,
  unlockKey,
} from "../src/ui/app-lock";
import { clientScreen, screenAct } from "./support/client-screen";
import { screenWorld, textOf } from "./support/screens";

const { LockPage, LockGate } = await import("../src/ui/lock-page");
const { PhoneProvider } = await import("../src/ui/phone-parts");
const { ThisPhoneScreen } = await import("../src/ui/this-phone");
const { NO_HOMES } = await import("../src/ui/homes");
const { standInPhoneParts } = await import("../src/ui/stand-ins");

const FACE: LockAbility = { level: "biometric", kinds: ["face"] };
const FINGER: LockAbility = { level: "biometric", kinds: ["fingerprint"] };
const PASSCODE: LockAbility = { level: "passcode", kinds: [] };
const WORDS: CheckWords = { prompt: "Unlock the app", cancel: "Cancel" };

/** The app coming and going, and two clocks moved by hand. */
function world(options: { ability?: LockAbility; items?: MemoryItems; on?: boolean } = {}) {
  const items = options.items ?? memorySecureItems();
  if (options.on === true) items.disk.set(LOCK_ITEM, "on");
  const phone = fakeCheck(options.ability ?? FACE);
  const listeners = new Set<(state: string) => void>();
  const time = { wall: 1_000_000, steady: 5_000 };
  const lock = appLock({
    check: phone.check,
    setting: items,
    foreground: {
      listen: (changed) => {
        listeners.add(changed);
        return () => {
          listeners.delete(changed);
        };
      },
    },
    clock: { wall: () => time.wall, steady: () => time.steady },
  });
  /** Publishes a simulated AppState transition. */
  const app = (state: string) => {
    for (const changed of listeners) changed(state);
  };
  /** The app in the background for `ms` on both clocks, then back. */
  const away = (ms: number, wallMs = ms) => {
    app("inactive");
    app("background");
    time.steady += ms;
    time.wall += wallMs;
    app("active");
  };
  return { lock, items, phone, app, away, time };
}

/** Reads the current screen gate status. */
const phase = (lock: AppLock) => lock.store.getState().phase;

describe("when the app locks", () => {
  test("at start, with the lock on; open at start with it off", async () => {
    const on = world({ on: true });
    expect(phase(on.lock)).toBe("starting");
    await on.lock.start();
    expect(phase(on.lock)).toBe("locked");
    const off = world();
    await off.lock.start();
    expect(phase(off.lock)).toBe("open");
  });

  test("the minute's edges: 59 s and exactly 60 s in the background do not lock, 61 s does", async () => {
    const w = world({ on: true });
    await w.lock.start();
    await w.lock.unlock(WORDS);
    expect(phase(w.lock)).toBe("open");
    w.away(59_000);
    expect(phase(w.lock)).toBe("open");
    w.away(AWAY_MS);
    expect(phase(w.lock)).toBe("open");
    w.away(61_000);
    expect(phase(w.lock)).toBe("locked");
  });

  test("the time away is by the wall clock or the steady one, whichever says more; a wall clock set back locks", () => {
    const left = { wall: 0, steady: 0 };
    expect(awayTooLong(left, { wall: 60_000, steady: 60_000 })).toBe(false);
    expect(awayTooLong(left, { wall: 60_001, steady: 0 })).toBe(true);
    expect(awayTooLong(left, { wall: 0, steady: 60_001 })).toBe(true);
    expect(awayTooLong(left, { wall: -1, steady: 1_000 })).toBe(true);
  });

  test("setting the phone's time back while away does not skip the lock", async () => {
    const w = world({ on: true });
    await w.lock.start();
    await w.lock.unlock(WORDS);
    // Five minutes away by the steady clock; the wall clock set back to 30 s after leaving.
    w.away(300_000, 30_000);
    expect(phase(w.lock)).toBe("locked");
    await w.lock.unlock(WORDS);
    w.away(1_000, -120_000);
    expect(phase(w.lock)).toBe("locked");
  });

  test("only the background counts: inactive (the system's own sheets) and a return with no background do not lock", async () => {
    const w = world({ on: true });
    await w.lock.start();
    await w.lock.unlock(WORDS);
    w.app("inactive");
    w.time.wall += 120_000;
    w.time.steady += 120_000;
    w.app("active");
    expect(phase(w.lock)).toBe("open");
  });

  test("an Android passcode prompt can complete after the app returns", async () => {
    const w = world({ on: true });
    await w.lock.start();
    const unlocking = w.lock.unlock(WORDS);
    w.away(120_000);
    await unlocking;
    expect(phase(w.lock)).toBe("open");
  });

  test("turned off, it never locks: not after 61 s, nor at the next start", async () => {
    const w = world({ on: true });
    await w.lock.start();
    await w.lock.unlock(WORDS);
    expect(await w.lock.turnOff()).toEqual({ ok: true, value: undefined });
    expect(w.items.disk.has(LOCK_ITEM)).toBe(false);
    w.away(61_000);
    expect(phase(w.lock)).toBe("open");
    const again = world({ items: memorySecureItems(w.items.disk) });
    await again.lock.start();
    expect(phase(again.lock)).toBe("open");
  });

  test("an unreadable setting keeps the app locked even if capability is unavailable", async () => {
    const items = memorySecureItems();
    items.failNext({ op: "get", name: LOCK_ITEM, fault: "failed" });
    const w = world({ items });
    await w.lock.start();
    expect(phase(w.lock)).toBe("locked");
    const bare = memorySecureItems();
    bare.failNext({ op: "get", name: LOCK_ITEM, fault: "failed" });
    const none = world({ items: bare, ability: NO_ABILITY });
    await none.lock.start();
    expect(phase(none.lock)).toBe("locked");
  });
});

describe("a phone with no face, no fingerprint and no passcode", () => {
  test("is not offered the lock, and turning it on asks nothing", async () => {
    const w = world({ ability: NO_ABILITY });
    await w.lock.start();
    expect(lockOffered(w.lock.store.getState())).toBe(false);
    expect(await w.lock.turnOn(WORDS)).toEqual({ ok: false, fault: "unavailable" });
    expect(w.phone.state.asked).toBe(0);
    expect(w.items.disk.has(LOCK_ITEM)).toBe(false);
  });

  test("a passcode alone is enough to offer it; a face or finger too", async () => {
    for (const ability of [PASSCODE, FACE, FINGER]) {
      const w = world({ ability });
      await w.lock.start();
      expect(lockOffered(w.lock.store.getState())).toBe(true);
    }
  });

  test("removing the device credential or failing the capability read cannot bypass an enabled lock", async () => {
    const w = world({ on: true, ability: NO_ABILITY });
    await w.lock.start();
    expect(phase(w.lock)).toBe("locked");
    w.phone.answer({ ok: false, fault: "unavailable" });
    await w.lock.unlock(WORDS);
    expect(w.lock.store.getState()).toMatchObject({ phase: "locked", said: "unavailable" });
    const later = world({ on: true });
    later.phone.state.unavailable = true;
    await later.lock.start();
    expect(phase(later.lock)).toBe("locked");
  });
});

describe("unlocking", () => {
  test("one check, its words given; then open", async () => {
    const w = world({ on: true });
    await w.lock.start();
    await w.lock.unlock(WORDS);
    expect(w.phone.state.asked).toBe(1);
    expect(w.phone.state.words).toEqual([WORDS]);
    expect(phase(w.lock)).toBe("open");
  });

  test("a cancelled unlock stays locked and says nothing", async () => {
    const w = world({ on: true });
    await w.lock.start();
    w.phone.answer({ ok: false, fault: "cancelled" });
    await w.lock.unlock(WORDS);
    expect(w.lock.store.getState()).toMatchObject({ phase: "locked", said: null });
  });

  test("a failed unlock stays locked and says so; too many tries says that; the next that works opens", async () => {
    const w = world({ on: true });
    await w.lock.start();
    w.phone.answer({ ok: false, fault: "failed" });
    await w.lock.unlock(WORDS);
    expect(w.lock.store.getState()).toMatchObject({ phase: "locked", said: "failed" });
    w.phone.answer({ ok: false, fault: "lockedOut" });
    await w.lock.unlock(WORDS);
    expect(w.lock.store.getState()).toMatchObject({ phase: "locked", said: "lockedOut" });
    await w.lock.unlock(WORDS);
    expect(w.lock.store.getState()).toMatchObject({ phase: "open", said: null });
  });

  test("one check at a time: a second press while one runs asks nothing", async () => {
    const w = world({ on: true });
    await w.lock.start();
    await Promise.all([w.lock.unlock(WORDS), w.lock.unlock(WORDS)]);
    expect(w.phone.state.asked).toBe(1);
  });
});

describe("turning it on", () => {
  test("asks for the check once, keeps the setting, and does not lock the person who just turned it on", async () => {
    const w = world();
    await w.lock.start();
    const turningOn = w.lock.turnOn(WORDS);
    expect(await w.lock.turnOn(WORDS)).toEqual({ ok: false, fault: "cancelled" });
    expect(await turningOn).toEqual({ ok: true, value: undefined });
    expect(w.phone.state.asked).toBe(1);
    expect(w.items.disk.get(LOCK_ITEM)).toBe("on");
    expect(phase(w.lock)).toBe("open");
    // On again: asks nothing more.
    await w.lock.turnOn(WORDS);
    expect(w.phone.state.asked).toBe(1);
    const restarted = world({ items: memorySecureItems(w.items.disk) });
    await restarted.lock.start();
    expect(phase(restarted.lock)).toBe("locked");
  });

  test("a cancelled or failed check leaves it off", async () => {
    const w = world();
    await w.lock.start();
    w.phone.answer({ ok: false, fault: "cancelled" });
    expect(await w.lock.turnOn(WORDS)).toEqual({ ok: false, fault: "cancelled" });
    w.phone.answer({ ok: false, fault: "failed" });
    expect(await w.lock.turnOn(WORDS)).toEqual({ ok: false, fault: "failed" });
    expect(w.lock.store.getState().on).toBe(false);
    expect(w.items.disk.has(LOCK_ITEM)).toBe(false);
    w.away(61_000);
    expect(phase(w.lock)).toBe("open");
  });

  test("a setting that cannot be written leaves it off", async () => {
    const w = world();
    await w.lock.start();
    w.items.failNext({ op: "set", name: LOCK_ITEM, fault: "full" });
    expect(await w.lock.turnOn(WORDS)).toEqual({ ok: false, fault: "notSaved" });
    expect(w.lock.store.getState().on).toBe(false);
  });
});

describe("unlock wording", () => {
  test("the unlock button is named after what the phone has", () => {
    expect(unlockKey(FACE, "ios")).toBe("lock.unlock.faceId");
    expect(unlockKey(FINGER, "ios")).toBe("lock.unlock.touchId");
    expect(unlockKey(PASSCODE, "ios")).toBe("lock.unlock.passcode");
    expect(unlockKey(FINGER, "android")).toBe("lock.unlock.fingerprint");
    expect(unlockKey(FACE, "android")).toBe("lock.unlock.face");
    expect(unlockKey({ level: "biometric", kinds: ["face", "fingerprint"] }, "android")).toBe(
      "lock.unlock.plain",
    );
    expect(unlockKey(PASSCODE, "android")).toBe("lock.unlock.screenLock");
    expect(unlockKey(NO_ABILITY, "ios")).toBe("lock.unlock.plain");
  });
});

describe("the pages", () => {
  /** Renders This phone with the requested lock and device. */
  async function onPhone(
    lock: AppLock,
    os: "ios" | "android" = "ios",
    openSettings: () => void = () => undefined,
  ) {
    const made = await screenWorld({});
    const parts = { ...standInPhoneParts(made.client), homes: NO_HOMES, lock, os, openSettings };
    return made.wrap(
      createElement(PhoneProvider, {
        parts,
        children: createElement(ThisPhoneScreen, { onLinkAnother: () => undefined }),
      }),
    );
  }

  /** The page as React's client renders it, after its effects; then closed. */
  async function shown(page: ReturnType<typeof createElement>): Promise<string> {
    const screen = clientScreen();
    const made = await screenWorld({});
    await screen.render(made.wrap(page));
    const html = screen.html();
    await screen.close();
    return html;
  }

  test("the lock page: the title Locked and one button, named after what the phone has", async () => {
    const w = world({ on: true });
    await w.lock.start();
    const html = await shown(createElement(LockPage, { lock: w.lock, os: "ios" }));
    expect(textOf(html)).toBe("Locked Unlock with Face ID");
    expect(html.match(/role="button"/gu)?.length).toBe(1);
    const android = world({ on: true, ability: FINGER });
    await android.lock.start();
    expect(
      textOf(await shown(createElement(LockPage, { lock: android.lock, os: "android" }))),
    ).toBe("Locked Unlock with your fingerprint");
  });

  test("pressing Unlock: a failure is said under the one button; a success opens", async () => {
    const w = world({ on: true });
    await w.lock.start();
    const screen = clientScreen();
    const made = await screenWorld({});
    await screen.render(made.wrap(createElement(LockPage, { lock: w.lock, os: "ios" })));
    w.phone.answer({ ok: false, fault: "failed" });
    expect(await screen.press("Unlock with Face ID")).toBe(true);
    expect(textOf(screen.html())).toContain("The phone could not check that it is you.");
    expect(phase(w.lock)).toBe("locked");
    w.phone.answer({ ok: false, fault: "cancelled" });
    await screen.press("Unlock with Face ID");
    expect(textOf(screen.html())).toBe("Locked Unlock with Face ID");
    await screen.press("Unlock with Face ID");
    expect(phase(w.lock)).toBe("open");
    await screen.close();
  });

  test("under This phone: 'Lock the app', with Face ID's own sentence first on an iPhone; nothing on a phone that cannot check", async () => {
    const w = world({ ability: FACE });
    await w.lock.start();
    const screen = clientScreen();
    await screen.render(await onPhone(w.lock));
    expect(textOf(screen.html())).toContain("App lock");
    expect(textOf(screen.html())).toContain("Lock the app");
    expect(await screen.press("Lock the app", "checkbox")).toBe(true);
    expect(textOf(screen.html())).toContain("Face ID unlocks the app when the app lock is on.");
    expect(w.phone.state.asked).toBe(0);
    expect(await screen.press("Allow Face ID")).toBe(true);
    expect(w.phone.state.asked).toBe(1);
    expect(w.lock.store.getState().on).toBe(true);
    await screen.close();
    const none = world({ ability: NO_ABILITY });
    await none.lock.start();
    const bare = clientScreen();
    await bare.render(await onPhone(none.lock));
    const bareText = textOf(bare.html());
    await bare.close();
    expect(bareText).not.toContain("Lock the app");
    expect(bareText).not.toContain("App lock");
  });

  test("Face ID unavailable after the system check offers the phone’s settings", async () => {
    const w = world();
    await w.lock.start();
    const screen = clientScreen();
    let opened = false;
    await screen.render(
      await onPhone(w.lock, "ios", () => {
        opened = true;
      }),
    );
    w.phone.answer({ ok: false, fault: "unavailable" });
    expect(await screen.press("Lock the app", "checkbox")).toBe(true);
    expect(await screen.press("Allow Face ID")).toBe(true);
    expect(await screen.press("Open settings")).toBe(true);
    expect(opened).toBe(true);
    expect(w.lock.store.getState().on).toBe(false);
    await screen.close();
  });

  test("the gate hides app content until successful authentication, then hides it again on return", async () => {
    const w = world({ on: true });
    const screen = clientScreen();
    const made = await screenWorld({});
    await screen.render(
      made.wrap(
        createElement(LockGate, {
          lock: w.lock,
          os: "ios",
          frame: (page) => page,
          children: createElement("div", null, "Disarmed Home Settings"),
        }),
      ),
    );
    expect(w.phone.state.asked).toBe(0);
    expect(textOf(screen.html())).toBe("Locked Unlock with Face ID");
    expect(await screen.press("Unlock with Face ID")).toBe(true);
    expect(textOf(screen.html())).toBe("Disarmed Home Settings");
    await screenAct(() => w.away(61_000));
    expect(textOf(screen.html())).toBe("Locked Unlock with Face ID");
    await screen.close();
  });

  test("ticking 'Lock the app' asks once and turns it on; unticking turns it off; a failed check says so", async () => {
    const w = world({ ability: FINGER });
    await w.lock.start();
    const screen = clientScreen();
    await screen.render(await onPhone(w.lock, "android"));
    w.phone.answer({ ok: false, fault: "failed" });
    expect(await screen.press("Lock the app", "checkbox")).toBe(true);
    expect(textOf(screen.html())).toContain("so the app lock is still off");
    expect(w.lock.store.getState().on).toBe(false);
    await screen.press("Lock the app", "checkbox");
    expect(w.lock.store.getState().on).toBe(true);
    expect(w.phone.state.asked).toBe(2);
    expect(screen.html()).toContain('aria-checked="true"');
    await screen.press("Lock the app", "checkbox");
    expect(w.lock.store.getState().on).toBe(false);
    expect(w.phone.state.asked).toBe(2);
    await screen.close();
  });
});

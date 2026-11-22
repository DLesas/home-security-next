/**
 * The app lock's rule (m3-design.md section 6, "App lock"; AP1a, D63): when the app's screens are
 * hidden behind the lock page, and what "Lock the app" offers. Platform-neutral, over the phone's
 * check (`platform/app-lock-types.ts`), the app coming and going (`AppState`), two clocks and the
 * secure store, so every rule runs under `bun test` (`test/app-lock.test.ts`).
 *
 * - **Offered** only on a phone that can check its person: a face or finger enrolled, or a
 *   passcode. "Lock the app" asks for the check once to turn on; turning it off asks nothing (the
 *   app is open to whoever turns it off).
 * - **Locks** at startup and on return after more than one minute in the background. Inactive
 *   states do not begin or end that interval. Either clock can establish the elapsed time.
 * - **Unlocks** only after successful system authentication, including the device passcode.
 * - The setting is a secure-store item. Reading it is required before the screens can show.
 *   The lock does not change key access or the hub client.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  type CheckFault,
  type CheckWords,
  type LockAbility,
  NO_ABILITY,
  type PersonCheck,
} from "../platform/app-lock-types";
import type { Outcome } from "../platform/split";
import type { SecureItems } from "../platform/vault";

/** Longer than this in the background, and the app locks on its return †. */
export const AWAY_MS = 60_000;

/** The secure store's item that holds the setting: "on", or none. */
export const LOCK_ITEM = "lock";

/** Two clocks: the wall's, and one that never goes back (`performance.now`). */
export interface LockClock {
  wall(): number;
  steady(): number;
}

/** When the app goes to the background and comes back: React Native's `AppState`. */
export interface Foreground {
  /** Calls `changed` with each new state ("active", "background", "inactive"…); returns the unsubscribe. */
  listen(changed: (state: string) => void): () => void;
}

/** A moment, on both clocks. */
export interface Moment {
  readonly wall: number;
  readonly steady: number;
}

/** Whether the time between leaving and coming back locks the app. */
export function awayTooLong(left: Moment, back: Moment): boolean {
  const wall = back.wall - left.wall;
  return wall < 0 || wall > AWAY_MS || back.steady - left.steady > AWAY_MS;
}

/** Whether this phone can offer the lock or show its existing setting. */
export function lockOffered(state: Pick<LockState, "ability" | "on">): boolean {
  return state.on || state.ability.level !== "none";
}

export interface LockState {
  /** `starting` until the setting is read (nothing is shown); then `locked` or `open`. */
  readonly phase: "starting" | "locked" | "open";
  /** Whether the lock is turned on. */
  readonly on: boolean;
  /** What the phone can check with, as last asked. */
  readonly ability: LockAbility;
  /** A check is running. */
  readonly checking: boolean;
  /** What the last unlock said; null for nothing. */
  readonly said: Exclude<CheckFault, "cancelled"> | null;
}

export interface LockDeps {
  readonly check: PersonCheck;
  readonly setting: SecureItems;
  readonly foreground: Foreground;
  readonly clock: LockClock;
}

/** Why "Lock the app" did not turn on, or off: the check's fault, or the store's. */
export type SetFault = CheckFault | "notSaved";

export interface AppLock {
  readonly store: StoreApi<LockState>;
  /** Reads the setting and starts following the app; once. */
  start(): Promise<void>;
  unlock(words: CheckWords): Promise<void>;
  /** Asks for the check, then turns the lock on. */
  turnOn(words: CheckWords): Promise<Outcome<undefined, SetFault>>;
  turnOff(): Promise<Outcome<undefined, SetFault>>;
  /** Asks again what the phone can check with (a face enrolled since, a passcode removed). */
  recheck(): Promise<void>;
}

/**
 * The unlock button's words, named after what the phone has: Face ID or Touch ID on an iPhone,
 * the one kind of biometrics an Android phone has enrolled, else its passcode or screen lock;
 * "Unlock" where the phone has several kinds, or cannot say.
 */
export function unlockKey(ability: LockAbility, os: "ios" | "android"): string {
  if (ability.level === "passcode")
    return os === "ios" ? "lock.unlock.passcode" : "lock.unlock.screenLock";
  if (ability.level !== "biometric") return "lock.unlock.plain";
  if (os === "ios") {
    if (ability.kinds.includes("face")) return "lock.unlock.faceId";
    if (ability.kinds.includes("fingerprint")) return "lock.unlock.touchId";
    return "lock.unlock.plain";
  }
  const [only, ...more] = ability.kinds;
  return only === undefined || more.length > 0 ? "lock.unlock.plain" : `lock.unlock.${only}`;
}

const done = { ok: true as const, value: undefined };

/** Keeps the app lock setting and applies authentication and foreground transitions. */
export function appLock(deps: LockDeps): AppLock {
  const store = createStore<LockState>()(() => ({
    phase: "starting",
    on: false,
    ability: NO_ABILITY,
    checking: false,
    said: null,
  }));
  let started: Promise<void> | undefined;
  let left: Moment | undefined;
  /** Pairs elapsed and wall time so a clock adjustment cannot shorten a long absence. */
  const now = (): Moment => ({ wall: deps.clock.wall(), steady: deps.clock.steady() });

  /** Updates button wording and eligibility without opening a locked screen. */
  async function askAbility(): Promise<Outcome<LockAbility, "failed">> {
    const result = await deps.check.ability();
    if (result.ok) store.setState({ ability: result.value });
    return result;
  }

  /** Locks synchronously on return so the next render can only show the lock page. */
  function changed(state: string): void {
    if (state === "background") {
      left ??= now();
      return;
    }
    if (state !== "active" || left === undefined) return;
    const away = left;
    left = undefined;
    const { on, phase } = store.getState();
    if (!on || phase !== "open" || !awayTooLong(away, now())) return;
    store.setState({ phase: "locked", said: null });
    void askAbility();
  }

  /** Loads the persisted setting before exposing any app screen. */
  async function start(): Promise<void> {
    deps.foreground.listen(changed);
    const [setting] = await Promise.all([deps.setting.get(LOCK_ITEM), askAbility()]);
    const on = !setting.ok || setting.value !== null;
    store.setState({ on, phase: on ? "locked" : "open" });
  }

  return {
    store,
    start: () => (started ??= start()),
    unlock: async (words) => {
      const before = store.getState();
      if (before.phase !== "locked" || before.checking) return;
      store.setState({ checking: true, said: null });
      const outcome = await deps.check.check(words);
      if (outcome.ok) {
        store.setState({ phase: "open", checking: false });
        return;
      }
      store.setState({
        checking: false,
        said: outcome.fault === "cancelled" ? null : outcome.fault,
      });
    },
    turnOn: async (words) => {
      const { phase, on, checking } = store.getState();
      if (phase !== "open" || checking) return { ok: false, fault: "cancelled" };
      if (on) return done;
      store.setState({ checking: true });
      const ability = await askAbility();
      if (!ability.ok || ability.value.level === "none") {
        store.setState({ checking: false });
        return { ok: false, fault: ability.ok ? "unavailable" : "failed" };
      }
      const outcome = await deps.check.check(words);
      if (!outcome.ok) {
        store.setState({ checking: false });
        return outcome;
      }
      const saved = await deps.setting.set(LOCK_ITEM, "on");
      store.setState({ on: saved.ok, checking: false });
      return saved.ok ? done : { ok: false, fault: "notSaved" };
    },
    recheck: async () => {
      await askAbility();
    },
    turnOff: async () => {
      const { phase, on, checking } = store.getState();
      if (phase !== "open" || checking) return { ok: false, fault: "cancelled" };
      if (!on) return done;
      store.setState({ checking: true });
      const saved = await deps.setting.delete(LOCK_ITEM);
      store.setState({ on: !saved.ok, checking: false });
      return saved.ok ? done : { ok: false, fault: "notSaved" };
    },
  };
}

/** The lock where the phone has none: a preview, the stand-ins. Never locks; offers nothing. */
export const NO_LOCK: AppLock = {
  store: createStore<LockState>()(() => ({
    phase: "open",
    on: false,
    ability: NO_ABILITY,
    checking: false,
    said: null,
  })),
  start: () => Promise.resolve(),
  unlock: () => Promise.resolve(),
  turnOn: () => Promise.resolve({ ok: false, fault: "unavailable" }),
  turnOff: () => Promise.resolve(done),
  recheck: () => Promise.resolve(),
};

/** The phone's local authentication for the app's screen lock (m3-design.md section 6). */
import type { Outcome } from "./split";

export type Biometry = "face" | "fingerprint" | "iris";

/** The device's enrolled security level and the biometric methods it reports. */
export interface LockAbility {
  readonly level: "none" | "passcode" | "biometric";
  readonly kinds: readonly Biometry[];
}

export const NO_ABILITY: LockAbility = { level: "none", kinds: [] };

export type CheckFault = "cancelled" | "failed" | "lockedOut" | "unavailable";

/** The words in the device's own authentication prompt. */
export interface CheckWords {
  readonly prompt: string;
  readonly cancel: string;
}

export interface PersonCheck {
  /** Reads the available methods without asking the person to authenticate. */
  ability(): Promise<Outcome<LockAbility, "failed">>;
  /** Runs one system check with the device credential available as a fallback. */
  check(words: CheckWords): Promise<Outcome<undefined, CheckFault>>;
}

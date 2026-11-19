import type { PhoneHub } from "./hub";

/** The console has no phone channel. */
export function currentPhoneHub(): PhoneHub | undefined {
  return undefined;
}

/** A browser reaches the page's own origin: nothing to ask. */
import type { Permission } from "./scanner";

const GRANTED: Permission = { state: "granted", canAskAgain: true };

export function permission(): Promise<Permission> {
  return Promise.resolve(GRANTED);
}

export function ask(): Promise<Permission> {
  return Promise.resolve(GRANTED);
}

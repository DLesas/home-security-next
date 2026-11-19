import type { Scanner } from "./scanner-types";

/** The browser does not scan phone codes. */
export const cameraScanner: Scanner = {
  available: () => Promise.resolve(false),
  permission: () => Promise.resolve({ state: "denied", canAskAgain: false }),
  ask: () => Promise.resolve({ state: "denied", canAskAgain: false }),
  View: () => null,
};

import type { BleCentral } from "./ble-types";

/** The web app has no Bluetooth. */
export const bleCentral: BleCentral = {
  state: () => Promise.resolve("unsupported"),
  scan: () => () => undefined,
  connect: () => Promise.resolve({ ok: false, fault: "failed" }),
};

/** Returns the unsupported state without prompting in the web app. */
export const askBluetooth = () => bleCentral.state();

/** Checks Bluetooth availability without prompting in the web app. */
export const checkBluetooth = askBluetooth;

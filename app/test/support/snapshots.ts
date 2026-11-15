/**
 * A new hub's snapshot as data, for tests of the store and the screens: no device, the two fixed
 * modes (D90), every optional category on (D69).
 */
import type { SnapshotObject } from "@hsn/protocol/app";

export function snapshotOf(hub: {
  readonly rev: number;
  readonly version: string;
  readonly identity: string;
  readonly boot: number;
}): SnapshotObject {
  return {
    rev: hub.rev,
    hub: {
      hub: hub.version,
      proto: 1,
      identity: hub.identity,
      fingerprint: "ab".repeat(32),
      timeZone: "Europe/London",
      clockTrusted: true,
      boot: hub.boot,
    },
    site: {
      channel: null,
      rate: 2,
      countdownS: 30,
      autoStopS: 180,
      wifiName: "",
      retentionRoutineDays: 30,
      retentionEventDays: 365,
    },
    mode: { mode: 2, modified: false },
    devices: [],
    sensors: [],
    sirens: [],
    gateways: [],
    alarm: null,
    siteMove: null,
    notifications: [],
    // The two fixed modes (D90), as a new hub's migration makes them; no groups or schedules.
    modes: [
      { id: 1, name: "Away", fixed: "away", groups: [], revision: 0 },
      { id: 2, name: "Disarmed", fixed: "disarmed", groups: [], revision: 0 },
    ],
    groups: [],
    schedules: [],
    notificationPrefs: {
      categories: [
        "sensorSilentWhileDisarmed",
        "sirenPathLost",
        "gatewayOffline",
        "batteryLow",
        "armDisarm",
        "updates",
      ],
      revision: 0,
    },
  };
}

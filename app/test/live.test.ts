/**
 * The live store (m2-design.md section 8): a snapshot replaces, events keep it; its state is plain
 * data with nothing secret in it.
 */
import { describe, expect, test } from "bun:test";
import type { DeviceObject, HubHello } from "@hsn/protocol/app";
import {
  applyEvent,
  applySnapshot,
  applyStatus,
  EMPTY_LIVE,
  type LiveState,
} from "../src/state/live";
import { snapshotOf } from "./support/snapshots";

const HELLO: HubHello = {
  proto: 1,
  hub: "1.0.0",
  boot: 3,
  rev: 40,
  client: { id: 7, person: 2, kind: "web" },
  features: [],
};

function device(id: number, role: DeviceObject["role"] = "sensor"): DeviceObject {
  return {
    id,
    name: `d${id}`,
    role,
    state: "paired",
    firmware: "1.0.0",
    batteryPercent: 80,
    signal: null,
    temperatureC: null,
    lastSeenMs: null,
    heardBy: null,
    health: { silent: false, batteryLow: false, tamperOpen: false, poorLink: false },
  };
}

function withSnapshot(): LiveState {
  const snapshot = {
    ...snapshotOf({ rev: 40, version: "1.0.0", identity: "a".repeat(26), boot: 3 }),
    rev: 40,
    devices: [device(4), device(9, "siren")],
    sensors: [
      { id: 4, arm: "disarmed" as const, door: "closed" as const, countdownSecondsLeft: null },
    ],
  };
  return applySnapshot(
    applyStatus(EMPTY_LIVE, { kind: "open", hello: HELLO }),
    snapshot,
    HELLO,
    1000,
  );
}

describe("the live store", () => {
  test("a snapshot gives the session, the revision and the devices", () => {
    const state = withSnapshot();
    expect(state.session).toEqual({ boot: 3, client: 7, person: 2, kind: "web", hub: "1.0.0" });
    expect(state.rev).toBe(40);
    expect(Object.keys(state.devices)).toEqual(["4", "9"]);
  });

  test("events: arming, a door, a countdown that counts from when it was told, the alarm", () => {
    let state = withSnapshot();
    state = applyEvent(
      state,
      {
        t: "evt",
        rev: 41,
        ev: "arming",
        body: { sensors: [{ sensor: 4, arm: "armed" }], mode: { mode: 1, modified: false } },
      },
      1000,
    );
    state = applyEvent(
      state,
      { t: "evt", rev: 42, ev: "door", body: { sensor: 4, open: true, atMs: 5 } },
      1000,
    );
    state = applyEvent(
      state,
      {
        t: "evt",
        rev: 43,
        ev: "countdown",
        body: { sensor: 4, what: "started", secondsLeft: 30, trigger: 1 },
      },
      2000,
    );
    expect(state.sensors[4]).toEqual({
      id: 4,
      arm: "armed",
      door: "open",
      countdownSecondsLeft: 30,
    });
    expect(state.countdowns[4]).toEqual({ secondsLeft: 30, toldAtMs: 2000 });
    state = applyEvent(
      state,
      {
        t: "evt",
        rev: 44,
        ev: "alarm",
        body: {
          what: "started",
          alarm: { startedMs: 9, triggers: [4], sirens: [9] },
          sirens: [],
          ended: null,
        },
      },
      2000,
    );
    state = applyEvent(
      state,
      {
        t: "evt",
        rev: 45,
        ev: "countdown",
        body: { sensor: 4, what: "ended", secondsLeft: 0, trigger: 1 },
      },
      2000,
    );
    expect(state.countdowns[4]).toBeUndefined();
    expect(state.alarm?.triggers).toEqual([4]);
    expect(state.rev).toBe(45);
  });

  test("a device added is noticed; a sensor added starts disarmed with its door not known", () => {
    let state = withSnapshot();
    state = applyEvent(
      state,
      { t: "evt", rev: 41, ev: "device", body: { what: "added", device: device(12, "gateway") } },
      0,
    );
    state = applyEvent(
      state,
      { t: "evt", rev: 42, ev: "device", body: { what: "added", device: device(13) } },
      0,
    );
    expect(state.added).toEqual([13, 12]);
    expect(state.sensors[13]).toEqual({
      id: 13,
      arm: "disarmed",
      door: "unknown",
      countdownSecondsLeft: null,
    });
  });

  test("forget drops a device the person may no longer view", () => {
    let state = withSnapshot();
    state = applyEvent(state, { t: "evt", rev: 41, ev: "forget", body: { device: 4 } }, 0);
    expect(state.devices[4]).toBeUndefined();
    expect(state.sensors[4]).toBeUndefined();
  });

  test("health events change the device's health", () => {
    let state = withSnapshot();
    state = applyEvent(
      state,
      { t: "evt", rev: 41, ev: "health", body: { device: 4, what: "batteryLow", sinceMs: 1 } },
      0,
    );
    state = applyEvent(
      state,
      { t: "evt", rev: 42, ev: "health", body: { device: 4, what: "tamperOpen", sinceMs: 1 } },
      0,
    );
    expect(state.devices[4]?.health).toEqual({
      silent: false,
      batteryLow: true,
      tamperOpen: true,
      poorLink: false,
    });
  });

  test("hub events: each told once, newest first; a failing database kept until it recovers", () => {
    let state = withSnapshot();
    state = applyEvent(
      state,
      { t: "evt", rev: 41, ev: "hub", body: { what: "databaseFailing", detail: {} } },
      0,
    );
    state = applyEvent(
      state,
      { t: "evt", rev: 42, ev: "hub", body: { what: "updateStaged", detail: { version: "1.1" } } },
      0,
    );
    state = applyEvent(
      state,
      { t: "evt", rev: 43, ev: "hub", body: { what: "updateStaged", detail: { version: "1.2" } } },
      0,
    );
    expect(state.databaseFailing).toBe(true);
    expect(state.hubNotices.map((n) => n.what)).toEqual(["updateStaged", "databaseFailing"]);
    state = applyEvent(
      state,
      { t: "evt", rev: 44, ev: "hub", body: { what: "databaseRecovered", detail: {} } },
      0,
    );
    expect(state.databaseFailing).toBe(false);
  });

  test("removal or no link empties what was shown", () => {
    const state = applyStatus(withSnapshot(), { kind: "removed" });
    expect(state).toEqual({ ...EMPTY_LIVE, connection: { kind: "removed" } });
  });
});

/**
 * The live store (m2-design.md section 8, `app/src/state/`): built from `snapshot` and kept by
 * events. Its state is plain data, the same in every tab (`tabs.ts` sends it to the others), and
 * holds nothing secret: no key, no link secret, no code; a test checks it.
 *
 * Every change is a pure function of the state and one input, so the tests drive it directly.
 */
import type {
  AppEvent,
  ClientKindValue,
  DeviceObject,
  GroupObject,
  HubHello,
  HubInfo,
  ModeObject,
  NotificationObject,
  NotificationPrefsObject,
  ScheduleObject,
  SnapshotObject,
} from "@hsn/protocol/app";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChannelStatus } from "../hub/channel";

type SensorStatus = SnapshotObject["sensors"][number];
type SirenStatus = SnapshotObject["sirens"][number];
type GatewayStatus = SnapshotObject["gateways"][number];

/** How the connection stands, as the screens show it. */
export type ConnectionView =
  | { readonly kind: "loading" }
  | { readonly kind: "notLinked" }
  | { readonly kind: "noStorage" }
  | { readonly kind: "connecting" }
  | { readonly kind: "open" }
  | {
      readonly kind: "waiting";
      readonly failure: string;
      readonly retryInMs: number;
      readonly attempt: number;
      readonly mayBeRemoved: boolean;
    }
  | { readonly kind: "removed" };

/** A countdown as last told, with the local time it was told at, so the banner counts down. */
export interface CountdownView {
  readonly secondsLeft: number;
  readonly toldAtMs: number;
}

export interface LiveState {
  readonly connection: ConnectionView;
  /** This session's `HubHello`: who this client is, which boot. */
  readonly session: {
    readonly boot: number;
    readonly client: number;
    readonly person: number | null;
    readonly kind: ClientKindValue;
    readonly hub: string;
  } | null;
  /** The live revision of what is shown; null before the first snapshot. */
  readonly rev: number | null;
  readonly hub: HubInfo | null;
  readonly site: SnapshotObject["site"] | null;
  readonly mode: SnapshotObject["mode"] | null;
  readonly devices: Readonly<Record<number, DeviceObject>>;
  readonly sensors: Readonly<Record<number, SensorStatus>>;
  readonly countdowns: Readonly<Record<number, CountdownView>>;
  readonly sirens: Readonly<Record<number, SirenStatus>>;
  readonly gateways: Readonly<Record<number, GatewayStatus>>;
  readonly alarm: SnapshotObject["alarm"];
  readonly siteMove: SnapshotObject["siteMove"];
  readonly notifications: readonly NotificationObject[];
  /** The modes, groups and schedules: the snapshot's, kept by `config` events and this tab's replies. */
  readonly modes: Readonly<Record<number, ModeObject>>;
  readonly groups: Readonly<Record<number, GroupObject>>;
  readonly schedules: Readonly<Record<number, ScheduleObject>>;
  /** This client's optional notification categories, from the snapshot and the prefs reply. */
  readonly notificationPrefs: NotificationPrefsObject | null;
  /** What the hub said of itself while this tab watched (`hub` events), newest first, five at most. */
  readonly hubNotices: readonly { readonly what: HubWhat; readonly rev: number }[];
  /** The hub said its database is failing (changes refused, reads work), until it says recovered. */
  readonly databaseFailing: boolean;
  /** Devices added while this tab watched, newest first, for the notice that one was added (D100). */
  readonly added: readonly number[];
  /** Raised by `config`, `people` and `record` events: the queries that read them read again. */
  readonly stale: {
    readonly config: number;
    readonly people: number;
    readonly history: number;
    readonly hub: number;
    readonly notifications: number;
  };
}

export const EMPTY_LIVE: LiveState = {
  connection: { kind: "loading" },
  session: null,
  rev: null,
  hub: null,
  site: null,
  mode: null,
  devices: {},
  sensors: {},
  countdowns: {},
  sirens: {},
  gateways: {},
  alarm: null,
  siteMove: null,
  notifications: [],
  modes: {},
  groups: {},
  schedules: {},
  notificationPrefs: null,
  hubNotices: [],
  databaseFailing: false,
  added: [],
  stale: { config: 0, people: 0, history: 0, hub: 0, notifications: 0 },
};

function byId<T extends { readonly id: number }>(items: readonly T[]): Record<number, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

function without<T>(record: Readonly<Record<number, T>>, id: number): Record<number, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => Number(key) !== id));
}

function connectionOf(status: ChannelStatus): ConnectionView {
  switch (status.kind) {
    case "waiting":
      return {
        kind: "waiting",
        failure: status.failure,
        retryInMs: status.retryInMs,
        attempt: status.attempt,
        mayBeRemoved: status.mayBeRemoved,
      };
    case "open":
      return { kind: "open" };
    default:
      return { kind: status.kind };
  }
}

export function applyStatus(state: LiveState, status: ChannelStatus): LiveState {
  const connection = connectionOf(status);
  if (status.kind === "notLinked" || status.kind === "removed" || status.kind === "noStorage") {
    return { ...EMPTY_LIVE, connection };
  }
  return { ...state, connection };
}

/** A new snapshot replaces everything the hub's state gives; a new session or boot always brings one. */
export function applySnapshot(
  state: LiveState,
  snapshot: SnapshotObject,
  hello: HubHello,
  nowMs: number,
): LiveState {
  const countdowns: Record<number, CountdownView> = {};
  for (const sensor of snapshot.sensors) {
    if (sensor.countdownSecondsLeft !== null)
      countdowns[sensor.id] = { secondsLeft: sensor.countdownSecondsLeft, toldAtMs: nowMs };
  }
  return {
    ...state,
    session: {
      boot: hello.boot,
      client: hello.client.id,
      person: hello.client.person,
      kind: hello.client.kind,
      hub: hello.hub,
    },
    rev: snapshot.rev,
    hub: snapshot.hub,
    site: snapshot.site,
    mode: snapshot.mode,
    devices: byId(snapshot.devices),
    sensors: byId(snapshot.sensors),
    countdowns,
    sirens: byId(snapshot.sirens),
    gateways: byId(snapshot.gateways),
    alarm: snapshot.alarm,
    siteMove: snapshot.siteMove,
    notifications: snapshot.notifications,
    modes: byId(snapshot.modes),
    groups: byId(snapshot.groups),
    schedules: byId(snapshot.schedules),
    notificationPrefs: snapshot.notificationPrefs,
    added: [],
    stale: {
      config: state.stale.config + 1,
      people: state.stale.people + 1,
      history: state.stale.history + 1,
      hub: state.stale.hub + 1,
      notifications: state.stale.notifications + 1,
    },
  };
}

export type HubWhat = Extract<AppEvent, { ev: "hub" }>["body"]["what"];

/** A `hub` event: told as a notice; a failing database kept until it recovers; status reads again. */
function hubEvent(state: LiveState, what: HubWhat, rev: number): LiveState {
  return {
    ...state,
    hubNotices: [{ what, rev }, ...state.hubNotices.filter((n) => n.what !== what)].slice(0, 5),
    databaseFailing:
      what === "databaseFailing"
        ? true
        : what === "databaseRecovered"
          ? false
          : state.databaseFailing,
    stale: { ...state.stale, hub: state.stale.hub + 1 },
  };
}

/** Marks a hub notice as seen. */
export function dismissHubNotice(state: LiveState, what: HubWhat): LiveState {
  return { ...state, hubNotices: state.hubNotices.filter((n) => n.what !== what) };
}

/** This client's categories as the `notifications.prefs` reply gave them. */
export function learnPrefs(state: LiveState, prefs: NotificationPrefsObject): LiveState {
  return { ...state, notificationPrefs: prefs };
}

/** Marks notifications read in the store, as `notifications.read` was answered. */
export function markRead(state: LiveState, seqs: readonly number[]): LiveState {
  return {
    ...state,
    notifications: state.notifications.map((n) =>
      seqs.includes(n.seq) ? { ...n, read: true } : n,
    ),
  };
}

function withSensor(
  state: LiveState,
  id: number,
  change: (sensor: SensorStatus) => SensorStatus,
): LiveState {
  const sensor = state.sensors[id];
  return sensor === undefined
    ? state
    : { ...state, sensors: { ...state.sensors, [id]: change(sensor) } };
}

function forgetDevice(state: LiveState, id: number): LiveState {
  return {
    ...state,
    devices: without(state.devices, id),
    sensors: without(state.sensors, id),
    countdowns: without(state.countdowns, id),
    sirens: without(state.sirens, id),
    gateways: without(state.gateways, id),
    added: state.added.filter((d) => d !== id),
  };
}

function withHealth(
  state: LiveState,
  id: number,
  change: Partial<DeviceObject["health"]>,
): LiveState {
  const device = state.devices[id];
  if (device === undefined) return state;
  return {
    ...state,
    devices: { ...state.devices, [id]: { ...device, health: { ...device.health, ...change } } },
  };
}

/** One event, already past the snapshot's `rev` (the channel drops the others). */
export function applyEvent(state: LiveState, event: AppEvent, nowMs: number): LiveState {
  const next = applyBody(state, event, nowMs);
  return next === state ? state : { ...next, rev: event.rev };
}

function applyBody(state: LiveState, event: AppEvent, nowMs: number): LiveState {
  switch (event.ev) {
    case "arming": {
      let next: LiveState = { ...state, mode: event.body.mode };
      for (const { sensor, arm } of event.body.sensors)
        next = withSensor(next, sensor, (s) => ({ ...s, arm }));
      return next;
    }
    case "countdown": {
      const { sensor, what, secondsLeft } = event.body;
      const running = what === "started" || what === "continued";
      const next = withSensor(state, sensor, (s) => ({
        ...s,
        countdownSecondsLeft: running ? secondsLeft : null,
      }));
      return {
        ...next,
        countdowns: running
          ? { ...next.countdowns, [sensor]: { secondsLeft, toldAtMs: nowMs } }
          : without(next.countdowns, sensor),
      };
    }
    case "alarm":
      return {
        ...state,
        alarm: event.body.alarm,
        sirens: { ...state.sirens, ...byId(event.body.sirens) },
      };
    case "door":
      return withSensor(state, event.body.sensor, (s) => ({
        ...s,
        door: event.body.open ? "open" : "closed",
      }));
    case "reading": {
      const device = state.devices[event.body.device];
      if (device === undefined) return state;
      const { batteryPercent, signal, temperatureC } = event.body;
      return {
        ...state,
        devices: {
          ...state.devices,
          [device.id]: { ...device, batteryPercent, signal, temperatureC },
        },
      };
    }
    case "health":
      return healthEvent(state, event.body);
    case "device":
      return deviceEvent(state, event.body);
    case "notification": {
      const others = state.notifications.filter((n) => n.seq !== event.body.seq);
      return {
        ...state,
        notifications: [event.body, ...others],
        stale: { ...state.stale, notifications: state.stale.notifications + 1 },
      };
    }
    case "record":
      return { ...state, stale: { ...state.stale, history: state.stale.history + 1 } };
    case "config":
      return configEvent(state, event.body);
    case "people":
      return { ...state, stale: { ...state.stale, people: state.stale.people + 1 } };
    case "site":
      return { ...state, siteMove: event.body };
    case "forget":
      return forgetDevice(state, event.body.device);
    case "hub":
      return hubEvent(state, event.body.what, event.rev);
    case "session":
    case "ping":
    case "backupKeyChanged":
    case "fileChunk":
    case "fileFailed":
      return state;
  }
}

function healthEvent(
  state: LiveState,
  body: Extract<AppEvent, { ev: "health" }>["body"],
): LiveState {
  switch (body.what) {
    case "silent":
      return withHealth(state, body.device, { silent: true });
    case "heard":
      return withHealth(state, body.device, { silent: false });
    case "batteryLow":
      return withHealth(state, body.device, { batteryLow: true });
    case "batteryOk":
      return withHealth(state, body.device, { batteryLow: false });
    case "tamperOpen":
      return withHealth(state, body.device, { tamperOpen: true });
    case "tamperClosed":
      return withHealth(state, body.device, { tamperOpen: false });
    case "offline":
    case "online": {
      const gateway = state.gateways[body.device];
      if (gateway === undefined) return state;
      return {
        ...state,
        gateways: {
          ...state.gateways,
          [body.device]: { ...gateway, offline: body.what === "offline" },
        },
      };
    }
    case "pathLost":
    case "pathBack":
    case "interference":
    case "interferenceEnded":
      // Which path is not in the event; the siren's own state comes with the next `device` or snapshot.
      return state;
  }
}

function deviceEvent(
  state: LiveState,
  body: Extract<AppEvent, { ev: "device" }>["body"],
): LiveState {
  const device = body.device;
  if (body.what === "removed") return forgetDevice(state, device.id);
  const known = state.devices[device.id] !== undefined;
  let next: LiveState = { ...state, devices: { ...state.devices, [device.id]: device } };
  if (body.what === "added" && !known) {
    next = { ...next, added: [device.id, ...next.added.filter((d) => d !== device.id)] };
    // A sensor added starts disarmed (section 7); its door is not known until it reports.
    if (device.role === "sensor" && next.sensors[device.id] === undefined) {
      next = {
        ...next,
        sensors: {
          ...next.sensors,
          [device.id]: {
            id: device.id,
            arm: "disarmed",
            door: "unknown",
            countdownSecondsLeft: null,
          },
        },
      };
    }
  }
  return next;
}

function configEvent(
  state: LiveState,
  body: Extract<AppEvent, { ev: "config" }>["body"],
): LiveState {
  const stale = { ...state.stale, config: state.stale.config + 1 };
  if ("group" in body)
    return { ...state, stale, groups: { ...state.groups, [body.group.id]: body.group } };
  if ("groupDeleted" in body)
    return { ...state, stale, groups: without(state.groups, body.groupDeleted) };
  if ("mode" in body)
    return { ...state, stale, modes: { ...state.modes, [body.mode.id]: body.mode } };
  if ("modeDeleted" in body)
    return { ...state, stale, modes: without(state.modes, body.modeDeleted) };
  if ("schedule" in body)
    return {
      ...state,
      stale,
      schedules: { ...state.schedules, [body.schedule.id]: body.schedule },
    };
  if ("scheduleDeleted" in body)
    return { ...state, stale, schedules: without(state.schedules, body.scheduleDeleted) };
  return { ...state, stale, site: body.site };
}

/** Marks the notice of an added device as seen. */
export function dismissAdded(state: LiveState, device: number): LiveState {
  return { ...state, added: state.added.filter((d) => d !== device) };
}

/** Learns modes, groups or schedules a read gave (for example a `mode.create` reply). */
export function learnConfig(
  state: LiveState,
  objects: {
    readonly modes?: readonly ModeObject[];
    readonly groups?: readonly GroupObject[];
    readonly schedules?: readonly ScheduleObject[];
    readonly deleted?: { readonly kind: "mode" | "group" | "schedule"; readonly id: number };
  },
): LiveState {
  const next = {
    ...state,
    modes: { ...state.modes, ...byId(objects.modes ?? []) },
    groups: { ...state.groups, ...byId(objects.groups ?? []) },
    schedules: { ...state.schedules, ...byId(objects.schedules ?? []) },
  };
  const gone = objects.deleted;
  if (gone === undefined) return next;
  if (gone.kind === "mode") return { ...next, modes: without(next.modes, gone.id) };
  if (gone.kind === "group") return { ...next, groups: without(next.groups, gone.id) };
  return { ...next, schedules: without(next.schedules, gone.id) };
}

export type LiveStore = StoreApi<LiveState>;

export function createLiveStore(initial: LiveState = EMPTY_LIVE): LiveStore {
  return createStore<LiveState>()(() => initial);
}

/**
 * Live updates (m2-design.md section 5, "Live updates"; section 6, the events table; HB14).
 *
 * - Every event comes from something the core did in a step: a decision, a state message
 *   (`armedChanged`, `countdownCancelled`, `clientRemoved`), or a change of the people or registry
 *   slices, which `app` sees by comparing their immutable rows with those it last saw. Nothing is
 *   polled and nothing reads the database.
 * - **Each event is checked against the permissions as they are when it is made**, not at
 *   `subscribe`: an event naming a sensor goes only to sessions whose person may view it (HB5a);
 *   the people of the household are shown to those with *manage users*, and each person their own
 *   person and clients. When a person loses the right to view a device, their sessions are told to
 *   `forget` it ‡.
 * - `rev` rises by one at each step that sends an event; every event of the step carries it, so a
 *   client sees the step's events together. A step is told apart by its input's `now`
 *   (`state.ts`), so a step that sends nothing leaves the slice as it was.
 *
 * Not built here, and why: `record` (history) needs the audit record as `hsn log --json` writes
 * it, which only the shell can make today (`shell/control/records.ts`); `health`, `reading`'s
 * battery, `config`, `notification` and `hub` are made from modules whose views are stubs (A4, A5,
 * A6, A8). `notification` events are `notify`'s to send (section 2).
 */
import type {
  AppEvent,
  AppEventBody,
  AppEventBodyV2,
  AppEventName,
  AppEventNameV2,
  AppEventV2,
  AppProtoVersion,
  Topic,
} from "@hsn/protocol/app";
import { sensorSummary } from "../alarm/view.ts";
import { deviceUpdateChanged } from "../firmware/view.ts";
import { currentMode } from "../layout/view.ts";
import type { AuditRecord } from "../model/audit.ts";
import type { Effect } from "../model/effects.ts";
import type { Context } from "../model/handler.ts";
import { clientId, type DeviceId, personId } from "../model/ids.ts";
import type { Actor, Internal } from "../model/messages.ts";
import { type ClientRow, type DeviceRow, DeviceState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { MessageType } from "@hsn/protocol";
import { batteryPercent } from "../health/view.ts";
import { msBetween, type Now } from "../model/time.ts";
import { actorOfClient, clientObject, hasGlobal, mayView, personObject } from "../people/view.ts";
import { registeredDevices } from "../registry/view.ts";
import {
  alarmObject,
  deviceObject,
  deviceVisible,
  sirenStatuses,
  visibleDevices,
} from "./objects.ts";
import type { CoreDeps } from "../model/handler.ts";
import { commitEvents, recordEvents, siteMoved } from "./live.ts";
import { deviceToV2 } from "./versions.ts";
import type { AppSlice, PeopleSeen, Session } from "./state.ts";

/** Which topic carries each event; those with none go to every session (section 6). */
const TOPIC_OF: Readonly<Partial<Record<AppEventNameV2, Topic>>> = {
  arming: "arming",
  countdown: "arming",
  alarm: "alarm",
  door: "devices",
  reading: "devices",
  health: "devices",
  device: "devices",
  notification: "notifications",
  record: "history",
  config: "config",
  people: "people",
  site: "hub",
  hub: "hub",
  // Version 2 (m3-updates-design section 4, `NEW_EVENT_TOPICS_V2`).
  deviceUpdate: "devices",
};

/**
 * An event's body for one session, by the version it agreed: `v1` for a version 1 session (absent
 * for an event version 1 does not name, which such a session is never sent), `v2` for a version 2
 * session. Either may give undefined: not this session's to see.
 */
export interface ByVersion<N extends AppEventNameV2> {
  readonly v1?: (
    session: Session,
    actor: Actor,
  ) => (N extends AppEventName ? AppEventBody<N> : never) | undefined;
  readonly v2: (session: Session, actor: Actor) => AppEventBodyV2<N> | undefined;
}

/** A session's channel version, as the protocol names it. */
export function versionOf(session: Session): AppProtoVersion {
  return session.proto >= 2 ? 2 : 1;
}

/** What one handler call sends: the slice as it now stands, and the effects. */
export class Sending {
  slice: AppSlice;
  readonly out: (Internal | Effect)[] = [];

  readonly #now: Now;

  constructor(slice: AppSlice, now: Now) {
    this.slice = slice;
    this.#now = now;
  }

  /**
   * The `rev` of this step's events: raised once, at the step's first event (`state.ts`). One
   * counter for the hub (section 11, "Step 1's questions"): a gap means nothing to a client, and a
   * jump tells a restricted viewer only that something happened somewhere; clients take a new
   * snapshot only on a new session or a new boot.
   */
  rev(): number {
    if (this.slice.revStep !== this.#now)
      this.slice = { ...this.slice, rev: this.slice.rev + 1, revStep: this.#now };
    return this.slice.rev;
  }

  /** An event to every session subscribed to its topic for which `to` holds now. */
  event<N extends AppEventName>(
    view: HubState,
    ev: N,
    body: (session: Session, actor: Actor) => AppEventBody<N> | undefined,
  ): void {
    const topic = TOPIC_OF[ev];
    const targets: { readonly session: Session; readonly body: AppEventBody<N> }[] = [];
    for (const session of this.slice.sessions.values()) {
      if (topic !== undefined && !session.topics.has(topic)) continue;
      const actor = actorOfClient(view, session.client);
      if (actor === undefined) continue;
      const made = body(session, actor);
      if (made !== undefined) targets.push({ session, body: made });
    }
    if (targets.length === 0) return;
    const rev = this.rev();
    for (const { session, body: made } of targets) {
      // The schema of `ev` types `made`, so the frame is that variant of `AppEvent`.
      const message = { t: "evt", rev, ev, body: made } as AppEvent;
      this.out.push({ kind: "appSend", conn: session.conn, message });
    }
  }

  /**
   * An event whose body differs by version (`device`, `notification`, `hub`) or that only version
   * 2 names (`deviceUpdate`): each session subscribed to its topic is given its own version's body.
   * `topic` false sends it whatever the session's subscriptions (a notification, `live.ts`), to
   * the sessions `to` names.
   */
  versioned<N extends AppEventNameV2>(
    view: HubState,
    ev: N,
    bodies: ByVersion<N>,
    to?: (session: Session) => boolean,
  ): void {
    const topic = to === undefined ? TOPIC_OF[ev] : undefined;
    const targets: { readonly session: Session; readonly body: unknown }[] = [];
    for (const session of this.slice.sessions.values()) {
      if (to !== undefined && !to(session)) continue;
      if (topic !== undefined && !session.topics.has(topic)) continue;
      const actor = actorOfClient(view, session.client);
      if (actor === undefined) continue;
      const made =
        versionOf(session) === 2 ? bodies.v2(session, actor) : bodies.v1?.(session, actor);
      if (made !== undefined) targets.push({ session, body: made });
    }
    if (targets.length === 0) return;
    const rev = this.rev();
    for (const { session, body: made } of targets) {
      // The schema of `ev` in the session's version typed `made`, so the frame is that variant.
      const message = { t: "evt", rev, ev, body: made } as AppEvent | AppEventV2;
      this.out.push({ kind: "appSend", conn: session.conn, message });
    }
  }
}

function seenOf(view: HubState): PeopleSeen {
  const people = view.people;
  return {
    userManagement: people.userManagement,
    people: people.people,
    roles: people.roles,
    permissions: people.permissions,
    clients: people.clients,
  };
}

/** The keys whose entries are not the same objects in `now` as in `before`. */
function changedKeys(
  before: ReadonlyMap<number, unknown>,
  now: ReadonlyMap<number, unknown>,
): readonly number[] {
  if (before === now) return [];
  const keys = new Set([...before.keys(), ...now.keys()]);
  return [...keys].filter((key) => before.get(key) !== now.get(key));
}

function canSeePerson(view: HubState, actor: Actor, person: number): boolean {
  return (
    actor.kind !== "person" || actor.person === person || hasGlobal(view, actor, "manageUsers")
  );
}

/**
 * People, clients, permissions and the switch, as they changed since `app` last looked: `people`
 * events, and `forget` for every device a session's person may no longer view.
 */
export function peopleChanges(sending: Sending, view: HubState): void {
  const before = sending.slice.seen;
  const now = seenOf(view);
  if (before === undefined) {
    sending.slice = { ...sending.slice, seen: now };
    return;
  }
  const unchanged =
    before.userManagement === now.userManagement &&
    before.people === now.people &&
    before.roles === now.roles &&
    before.permissions === now.permissions &&
    before.clients === now.clients;
  if (unchanged) return;
  sending.slice = { ...sending.slice, seen: now };

  const persons = new Set([
    ...changedKeys(before.people, now.people),
    ...changedKeys(before.roles, now.roles),
    ...changedKeys(before.permissions, now.permissions),
  ]);
  for (const person of [...persons].toSorted((a, b) => a - b)) {
    const current = view.people.people.get(personId(person));
    sending.event(view, "people", (_session, actor) => {
      if (!canSeePerson(view, actor, person)) return undefined;
      if (current?.removedMs !== null) return { personRemoved: person };
      const object = personObject(view.people, view, current.id);
      return object === undefined ? undefined : { person: object };
    });
  }
  for (const client of changedKeys(before.clients, now.clients).toSorted((a, b) => a - b)) {
    const old = before.clients.get(client);
    const row = view.people.clients.get(clientId(client));
    if (row === undefined) continue;
    // A client's last seen or last `seq` moving is not a change people are told of.
    if (old !== undefined && sameShown(old, row)) continue;
    sending.event(view, "people", (_session, actor) => {
      if (row.personId !== null && !canSeePerson(view, actor, row.personId)) return undefined;
      if (
        row.personId === null &&
        actor.kind === "person" &&
        !hasGlobal(view, actor, "manageUsers")
      )
        return undefined;
      return row.removedMs !== null ? { clientRemoved: row.id } : { client: clientObject(row) };
    });
  }
  if (before.userManagement !== now.userManagement) {
    sending.event(view, "people", () => ({ userManagement: now.userManagement }));
  }
  forgetLost(sending, view);
}

/** Whether a client's row changed only in what is not shown as a change (last seen, last `seq`). */
function sameShown(old: unknown, row: ClientRow): boolean {
  if (typeof old !== "object" || old === null) return false;
  const was = old as ClientRow;
  return (
    was.name === row.name &&
    was.personId === row.personId &&
    was.kind === row.kind &&
    was.removedMs === row.removedMs &&
    was.linkedByClient === row.linkedByClient
  );
}

/** The devices a session's person may view now. */
export function visibleSet(view: HubState, actor: Actor): ReadonlySet<DeviceId> {
  return new Set(visibleDevices(view, actor).map((row) => row.id));
}

/** `forget` for each device a session could view and no longer may ‡ (section 5). */
export function forgetLost(sending: Sending, view: HubState): void {
  const sessions = new Map(sending.slice.sessions);
  let changed = false;
  for (const session of sending.slice.sessions.values()) {
    const actor = actorOfClient(view, session.client);
    if (actor === undefined) continue;
    const now = visibleSet(view, actor);
    const lost = [...session.visible].filter((device) => !now.has(device));
    const same = lost.length === 0 && [...now].every((device) => session.visible.has(device));
    if (same) continue;
    changed = true;
    sessions.set(session.conn, { ...session, visible: now });
    for (const device of lost) {
      const rev = sending.rev();
      const message: AppEvent = { t: "evt", rev, ev: "forget", body: { device } };
      sending.out.push({ kind: "appSend", conn: session.conn, message });
    }
  }
  if (changed) sending.slice = { ...sending.slice, sessions };
}

/** Devices whose registry row or version 2 update summary changed since `app` last looked. */
export function deviceChanges(
  sending: Sending,
  view: HubState,
  deps: CoreDeps,
): ReadonlyMap<DeviceId, DeviceRow> {
  const rows = registeredDevices(view);
  const now = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    const old = sending.slice.devicesSeen.get(row.id);
    if (
      old === row &&
      (row.state === DeviceState.Removed ||
        !deviceUpdateChanged(view, sending.slice.firmwareSeen, row.id))
    )
      continue;
    const object = deviceObject(view, deps, row);
    if (object === undefined) continue;
    const objectV2 = deviceToV2(view, object);
    const what =
      old === undefined
        ? "added"
        : row.state !== old.state && object.state === "removed"
          ? "removed"
          : row.name !== old.name
            ? "renamed"
            : "state";
    const visible = (actor: Actor): boolean => deviceVisible(view, actor, row);
    sending.versioned(view, "device", {
      v1: (_session, actor) =>
        old !== row && visible(actor) ? { what, device: object } : undefined,
      v2: (_session, actor) => (visible(actor) ? { what, device: objectV2 } : undefined),
    });
  }
  return now;
}

/** Events made from one message (section 6's "When" column). */
export function eventsOf(sending: Sending, ctx: Context, message: Internal): void {
  const view = ctx.view;
  if (message.kind === "armedChanged") {
    const sensor = message.sensor;
    const line = sensorSummary(view, sensor, ctx.now.mono);
    if (line === undefined) return;
    const mode = currentMode(view);
    sending.event(view, "arming", (_session, actor) =>
      mayView(view, actor, sensor) ? { sensors: [{ sensor, arm: line.arm }], mode } : undefined,
    );
    return;
  }
  if (message.kind === "auditRecord") {
    decisionEvents(sending, ctx, message.record);
    recordEvents(sending, view, message.record);
    return;
  }
  if (message.kind === "accepted") sensorReport(sending, ctx, message);
  if (message.kind === "siteMove") siteMoved(sending, view);
  if (message.kind === "commit") commitEvents(sending, view, message.outcome);
}

function decisionEvents(sending: Sending, ctx: Context, record: AuditRecord): void {
  if (record.kind !== "decision") return;
  const row = record.row;
  const view = ctx.view;
  const sensor = row.deviceId;
  switch (row.kind) {
    case "countdown_started":
    case "countdown_continued": {
      if (sensor === null) return;
      sending.event(view, "countdown", (_session, actor) =>
        mayView(view, actor, sensor)
          ? {
              sensor,
              what: row.kind === "countdown_started" ? "started" : "continued",
              secondsLeft: row.value ?? 0,
              trigger: row.causeSeq,
            }
          : undefined,
      );
      return;
    }
    case "mode_switched":
    case "arming_changed": {
      // One per arming action (layout's, with its view already updated): the mode as it now is,
      // also when no sensor's state changed, so a shown mode never goes stale. The sensors that
      // changed come as their own `arming` events (`armedChanged`), each to those who may view it.
      const mode = currentMode(view);
      sending.event(view, "arming", () => ({ sensors: [], mode }));
      return;
    }
    case "alarm":
    case "alarm_trigger_added":
    case "alarm_ended": {
      const what =
        row.kind === "alarm" ? "started" : row.kind === "alarm_ended" ? "ended" : "triggerAdded";
      const ended = row.kind === "alarm_ended" ? (row.value === 1 ? "disarmed" : "byItself") : null;
      const sirens = sirenStatuses(view, ctx.now.mono);
      // Everyone may see the alarm ‡ (it concerns everyone in the house); its triggers by view.
      sending.event(view, "alarm", (_session, actor) => ({
        what,
        alarm: alarmObject(view, actor, ctx.now),
        sirens,
        ended,
      }));
      return;
    }
    default:
      return;
  }
}

type Accepted = Extract<Internal, { readonly kind: "accepted" }>;

/**
 * A sensor's report (section 5, "Live updates"; section 6): a door report accepted is a `door`
 * event at once, dated by its event age (D106); a sensor's status at most once a minute ‡ per
 * device is a `reading`, from the packet with the highest counter only (HD 8), its battery from
 * `health`'s view, its signal as the gateway heard it. Both to those who may view the sensor.
 */
function sensorReport(sending: Sending, ctx: Context, accepted: Accepted): void {
  const view = ctx.view;
  const sensor = accepted.device;
  const message = accepted.message;
  if (
    message.type !== MessageType.Heartbeat &&
    message.type !== MessageType.DoorChanged &&
    message.type !== MessageType.CoverChanged
  )
    return;
  if (message.type === MessageType.DoorChanged) {
    const atMs = Math.max(0, ctx.now.wall - message.eventAgeSeconds * 1000);
    const open = message.flags.doorOpen;
    sending.event(view, "door", (_session, actor) =>
      mayView(view, actor, sensor) ? { sensor, open, atMs } : undefined,
    );
  }
  if (!accepted.newest) return;
  const last = sending.slice.readings.get(sensor);
  const every = ctx.deps.rules.app.readingEventEveryMs;
  if (last !== undefined && msBetween(last, ctx.now.mono) < every) return;
  const readings = new Map(sending.slice.readings);
  readings.set(sensor, ctx.now.mono);
  sending.slice = { ...sending.slice, readings };
  const arrival = accepted.arrival;
  const body = {
    device: sensor,
    batteryPercent: batteryPercent(view, ctx.deps.rules, sensor),
    signal:
      arrival.path === "lora"
        ? { rssiDbm: arrival.rssiDbm, snrQuarterDb: arrival.snrQuarterDb }
        : null,
    temperatureC: message.temperatureCelsius,
  };
  sending.event(view, "reading", (_session, actor) =>
    mayView(view, actor, sensor) ? body : undefined,
  );
}

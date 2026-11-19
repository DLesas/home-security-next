/**
 * What each push says, per recipient (docs/m4-design.md section 5, "The sealed payload"; D76,
 * D96, D102, O15; m3-design section 6, presence offers). Built when the push is sent, from the
 * state as it then stands, so a late push says what its recipient may see now. Pure.
 *
 * - `n`: the notification's fields as `notify` raised them (its `NotificationObject` without
 *   `read` and `delayed`).
 * - `delayed`: sent more than `HubRules.notify.delayedAfterMs` (60 s ‡) after the event happened:
 *   `endedAtMs`, else `openedAtMs`, else the notification's raise time (D102).
 * - `names`: only `device` (the device the notification names) and `mode` (a mode switched to).
 *   These are the only household-typed names a push carries, and only here, sealed for one phone:
 *   never in `detail`, `kind` or the roster's two alerts, which carry no name at all. A device
 *   name is put only when the recipient may view that device now; a name over 64 characters, which
 *   the schema would refuse, is left out.
 * - `detail`: numbers only, the values a kind's text needs: `seconds` for `countdown_started` (the
 *   countdown's whole seconds), `openedAtMs` for `late_report_notification` (when the door opened),
 *   `endedAtMs` for `late_report_sirens` and for an `alarm` raised late at a start (when the
 *   countdown ended); wall milliseconds.
 * - `actions`: `disarm` on a countdown or an alarm when the recipient may manage its sensor (D76);
 *   a presence offer's one action (`PRESENCE_OFFERS`): `armAway`, or `disarm` when the recipient
 *   may manage a sensor that is armed. At most one.
 * - `armed`: any sensor armed when it was raised (D96, O15), as the row keeps it.
 * - A push the recipient may no longer see (its device's *view* taken away) is not built.
 * - The content's JSON is at most `HubRules.relay.contentMaxBytes` (1,279) bytes: past it, `detail`
 *   is left out, then `names`; one that still does not fit is not built.
 */
import {
  appIdentityBytes,
  formatIdentity,
  type NotificationObject,
  type PushContent,
} from "@hsn/protocol/app";
import { armedForUser, alarmSensors } from "../alarm/view.ts";
import type { CoreDeps } from "../model/handler.ts";
import {
  type ClientId,
  type DeviceId,
  deviceId,
  modeId,
  type PersonId,
  type Seq,
} from "../model/ids.ts";
import { ClientKind } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import type { Now } from "../model/time.ts";
import { modeById } from "../layout/view.ts";
import {
  appStaticPublic,
  liveClient,
  personMayManageDevice,
  personMayViewDevice,
  personRow,
} from "../people/view.ts";
import { deviceById, roleName } from "../registry/view.ts";
import { jsonBytes } from "./codec.ts";
import type { CauseFacts, Notice, Pending, RelaySlice } from "./state.ts";

type PushAction = PushContent["actions"][number];
type Names = PushContent["names"];
type Detail = NonNullable<PushContent["detail"]>;

/** The longest name a push carries (M2's `displayName`, the schema's `pushName`). */
const NAME_MAX = 64;

/** Categories whose push offers Disarm to someone who may manage the sensor (D76). */
const DISARM_CATEGORIES: ReadonlySet<string> = new Set(["countdown", "alarm"]);

/**
 * GUESS, the one place to correct: the notification kinds of the presence offers (m3-design
 * section 6, F16), by the one action each carries. They are the phone stream's hub engineer's to
 * define (H1, M5) and are not frozen yet; every use here and in the tests reads them from this.
 */
export const PRESENCE_OFFER_KINDS = {
  armAway: "presence_offer_away",
  disarm: "presence_offer_disarm",
} as const satisfies Readonly<Record<PushAction, string>>;

/** A presence offer's notification kind and its one action. */
export const PRESENCE_OFFERS: Readonly<Record<string, PushAction>> = Object.fromEntries(
  Object.entries(PRESENCE_OFFER_KINDS).map(([action, kind]) => [kind, action as PushAction]),
);

/** Notifications that are never pushed: told only to open sessions (section 9). */
export const NEVER_PUSHED: ReadonlySet<string> = new Set(["relay_unreachable"]);

/** The kind of a test push (`push.test`, section 9). */
export const PUSH_TEST_KIND = "push_test";

/** The hub's identity text, 26 characters, from its app key; undefined before the key exists. */
export function hubIdentity(view: HubState, deps: CoreDeps): string | undefined {
  const key = appStaticPublic(view);
  return key === undefined ? undefined : formatIdentity(appIdentityBytes(deps.sha256, key));
}

/** A notification's fields as a push carries them. */
export function noticeOf(notification: NotificationObject): Notice {
  return {
    seq: notification.seq,
    atMs: notification.atMs,
    clockOk: notification.clockOk,
    kind: notification.kind,
    category: notification.category,
    critical: notification.critical,
    device: notification.device,
    cause: notification.cause,
  };
}

/** The person a client pushes to: a live phone of a live person with a valid target. */
export function recipientOf(
  view: HubState,
  slice: RelaySlice,
  client: ClientId,
): PersonId | undefined {
  const row = liveClient(view, client);
  if (row?.kind !== ClientKind.Phone || row.personId === null) return undefined;
  if (personRow(view, row.personId)?.removedMs !== null) return undefined;
  const target = slice.targets.get(client);
  return target?.invalidMs === null ? row.personId : undefined;
}

/** Whether `person` may see what the notification names now: its device, if it names one. */
function mayView(view: HubState, person: PersonId, device: DeviceId | null): boolean {
  if (device === null) return true;
  const row = deviceById(view, device);
  if (row === undefined || roleName(row.role) !== "sensor") return true;
  return personMayViewDevice(view, person, device);
}

function fitName(name: string | undefined): string | undefined {
  return name !== undefined && name.length >= 1 && name.length <= NAME_MAX ? name : undefined;
}

function namesFor(view: HubState, notice: Notice, cause: CauseFacts | undefined): Names {
  const device =
    notice.device === null ? undefined : fitName(deviceById(view, deviceId(notice.device))?.name);
  const mode =
    cause?.kind === "mode_switched" && cause.value !== null
      ? fitName(modeById(view, modeId(cause.value))?.name)
      : undefined;
  return {
    ...(device === undefined ? {} : { device }),
    ...(mode === undefined ? {} : { mode }),
  };
}

/**
 * When the event behind a push happened, when its decision says (D102): `endedAtMs` for a late
 * report's sirens and an alarm raised late at a start (when the countdown ended), `openedAtMs` for
 * a report so late only a notification is left (when the door opened).
 */
function eventTimes(cause: CauseFacts | undefined): {
  readonly endedAtMs?: number;
  readonly openedAtMs?: number;
} {
  if (cause === undefined) return {};
  switch (cause.kind) {
    case "late_report_sirens":
    case "alarm":
      return cause.at === null ? {} : { endedAtMs: cause.at };
    case "late_report_notification":
      return cause.value === null ? {} : { openedAtMs: cause.value * 1000 };
    case "countdown_started":
    case "mode_switched":
      return {};
  }
}

function detailFor(cause: CauseFacts | undefined): Detail | undefined {
  if (cause?.kind === "countdown_started") {
    return cause.value === null ? undefined : { seconds: cause.value };
  }
  const times = eventTimes(cause);
  return Object.keys(times).length === 0 ? undefined : times;
}

function actionsFor(view: HubState, person: PersonId, notice: Notice): readonly PushAction[] {
  const offer = PRESENCE_OFFERS[notice.kind];
  if (offer === "armAway") return ["armAway"];
  if (offer === "disarm") {
    const armed = alarmSensors(view).filter((sensor) => armedForUser(view, sensor));
    return armed.some((sensor) => personMayManageDevice(view, person, sensor)) ? ["disarm"] : [];
  }
  if (!DISARM_CATEGORIES.has(notice.category) || notice.device === null) return [];
  return personMayManageDevice(view, person, deviceId(notice.device)) ? ["disarm"] : [];
}

/** When the event happened (D102): the decision's own time, else the notification's raise time. */
function eventAt(notice: Notice, cause: CauseFacts | undefined): number {
  const times = eventTimes(cause);
  return times.endedAtMs ?? times.openedAtMs ?? notice.atMs;
}

export type Built =
  | { readonly ok: true; readonly content: PushContent }
  | {
      readonly ok: false;
      /** Not a phone that can be pushed to, or one that may no longer see it: its row goes. */
      readonly why: "noRecipient" | "notVisible" | "tooLong" | "noIdentity";
    };

/** The first of `candidates` that fits the rule's size, or undefined. */
function fitting(candidates: readonly PushContent[], maxBytes: number): PushContent | undefined {
  return candidates.find((content) => jsonBytes(content) <= maxBytes);
}

/** What `pending` says to `client`, built now. */
export function pushFor(
  view: HubState,
  deps: CoreDeps,
  now: Now,
  slice: RelaySlice,
  pending: Pending,
): Built {
  const hub = hubIdentity(view, deps);
  if (hub === undefined) return { ok: false, why: "noIdentity" };
  const person = recipientOf(view, slice, pending.row.clientId);
  if (person === undefined) return { ok: false, why: "noRecipient" };
  const { notice } = pending;
  if (!mayView(view, person, notice.device === null ? null : deviceId(notice.device)))
    return { ok: false, why: "notVisible" };
  const names = namesFor(view, notice, pending.cause);
  const detail = detailFor(pending.cause);
  const base = {
    v: 1 as const,
    hub,
    n: notice,
    delayed: now.wall - eventAt(notice, pending.cause) > deps.rules.notify.delayedAfterMs,
    actions: actionsFor(view, person, notice),
    armed: pending.row.armed === 1,
  };
  const full: PushContent = { ...base, names, ...(detail === undefined ? {} : { detail }) };
  const content = fitting(
    [full, { ...base, names }, { ...base, names: {} }],
    deps.rules.relay.contentMaxBytes,
  );
  return content === undefined ? { ok: false, why: "tooLong" } : { ok: true, content };
}

/** A test push (`push.test`): kind `push_test`, about the hub, named by the request's record. */
export function testContent(hub: string, record: Seq, now: Now, armed: boolean): PushContent {
  return {
    v: 1,
    hub,
    n: {
      seq: record,
      atMs: now.wall,
      clockOk: now.wallTrusted,
      kind: PUSH_TEST_KIND,
      category: "hub",
      critical: false,
      device: null,
      cause: null,
    },
    delayed: false,
    names: {},
    actions: [],
    armed,
  };
}

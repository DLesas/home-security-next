/**
 * The live events of section 6 made from other modules' work (m2-design.md section 11, "Step 1's
 * questions": the `record`, `health`, `config` and `hub` events), and `notify`'s notifications:
 *
 * - `config`: every successful answer to a configuration operation (a group, a mode, a schedule),
 *   whoever asked (an app, `hsn`, a schedule), so `hsn`'s changes are announced too. Sent to every
 *   session subscribed to `config`. The site's settings are `changes.ts`'s.
 * - `site`: the move's stage, at every `siteMove`, to those with *manage system* (as
 *   `site.changeStatus`).
 * - `health`: from `health`'s and the device modules' decisions, to those who may view the device.
 * - `hub`: from `upkeep`'s decisions (`update_staged`, `update_switching`), the backup's hub events
 *   and the writer's trimming, to those with *manage system*.
 * - `record`: every record, as history filters it (section 7, "History", `history.ts`).
 * - `notification`: `notificationRaised`, to the sessions of the clients `notify` names. Every
 *   such session gets it, subscribed to `notifications` or not: `notify` has chosen its recipients
 *   by their categories, and a countdown's or an alarm's notice must not wait on a subscription.
 */
import {
  type AppOp,
  groupObject,
  modeObject,
  type NotificationObject,
  type NotificationObjectV2,
  scheduleObject,
} from "@hsn/protocol/app";
import type { AuditRecord } from "../model/audit.ts";
import type { CommitOutcome } from "../model/events.ts";
import type { ClientId } from "../model/ids.ts";
import type { AnswerTo, Internal, OpOutcome } from "../model/messages.ts";
import type { HubState } from "../model/state.ts";
import { hasGlobal, liveClient, mayView } from "../people/view.ts";
import { ClientKind } from "../model/rows.ts";
import { deviceById } from "../registry/view.ts";
import { Role } from "@hsn/protocol";
import type { Sending } from "./events.ts";
import { recordFor } from "./history.ts";
import { siteMoveObject } from "./objects.ts";
import { notificationFor } from "./versions.ts";

/** Where an answer goes, as a key. */
export function answerKey(answerTo: AnswerTo): string {
  switch (answerTo.kind) {
    case "control":
      return `c:${answerTo.request}`;
    case "app":
      return `a:${answerTo.conn}:${answerTo.id}`;
    case "schedule":
      return `s:${answerTo.schedule}:${answerTo.record}`;
  }
}

const CONFIG_OPS: ReadonlySet<AppOp["op"]> = new Set<AppOp["op"]>([
  "group.create",
  "group.update",
  "group.delete",
  "mode.create",
  "mode.update",
  "mode.delete",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
]);

type OpRequest = Extract<Internal, { readonly kind: "opRequest" }>;

/** A configuration operation on its way to its owner. */
export function noteConfigAsked(sending: Sending, request: OpRequest): void {
  if (!CONFIG_OPS.has(request.op.op)) return;
  const configAsked = new Map(sending.slice.configAsked);
  configAsked.set(answerKey(request.answerTo), request.op);
  sending.slice = { ...sending.slice, configAsked };
}

/** The `config` event of a configuration operation's answer, when it succeeded. */
export function configAnswered(
  sending: Sending,
  view: HubState,
  answerTo: AnswerTo,
  outcome: OpOutcome,
): void {
  const key = answerKey(answerTo);
  const op = sending.slice.configAsked.get(key);
  if (op === undefined) return;
  const configAsked = new Map(sending.slice.configAsked);
  configAsked.delete(key);
  sending.slice = { ...sending.slice, configAsked };
  if (!outcome.ok) return;
  const body = configBody(op, outcome.body);
  if (body !== undefined) sending.event(view, "config", () => body);
}

function configBody(op: AppOp, reply: unknown) {
  switch (op.op) {
    case "group.delete":
      return { groupDeleted: op.body.group };
    case "mode.delete":
      return { modeDeleted: op.body.mode };
    case "schedule.delete":
      return { scheduleDeleted: op.body.schedule };
    case "group.create":
    case "group.update": {
      const parsed = groupObject.safeParse(reply);
      return parsed.success ? { group: parsed.data } : undefined;
    }
    case "mode.create":
    case "mode.update": {
      const parsed = modeObject.safeParse(reply);
      return parsed.success ? { mode: parsed.data } : undefined;
    }
    case "schedule.create":
    case "schedule.update": {
      const parsed = scheduleObject.safeParse(reply);
      return parsed.success ? { schedule: parsed.data } : undefined;
    }
    default:
      return undefined;
  }
}

/** The move's stage changed (`siteMove`): a `site` event to those with manage system. */
export function siteMoved(sending: Sending, view: HubState): void {
  const move = siteMoveObject(view);
  sending.event(view, "site", (_session, actor) =>
    hasGlobal(view, actor, "manageSystem") ? move : undefined,
  );
}

/**
 * `notify`'s notification, to every session of the clients it names, in the session's version:
 * version 2's with `happenedAtMs` (D102), which `notify` gives beside the object.
 */
export function notificationEvents(
  sending: Sending,
  view: HubState,
  notification: NotificationObject,
  clients: readonly ClientId[],
  happenedAtMs: number | null | undefined,
): void {
  const to: ReadonlySet<ClientId> = new Set(clients);
  const v2 = notificationFor(view, notification, happenedAtMs, 2);
  sending.versioned(
    view,
    "notification",
    { v1: () => notification, v2: () => v2 as NotificationObjectV2 },
    (session) => to.has(session.client),
  );
}

type HealthWhat =
  | "silent"
  | "pathLost"
  | "offline"
  | "interference"
  | "interferenceEnded"
  | "batteryLow"
  | "batteryOk"
  | "tamperOpen"
  | "tamperClosed";

/**
 * The decisions a `health` event is made from. `heard`, `pathBack` and `online` have no decision
 * of their own in the model (a device heard again is only a reading), so none is sent for them.
 */
const HEALTH_OF: Readonly<Partial<Record<string, HealthWhat>>> = {
  sensor_silent: "silent",
  siren_silent: "silent",
  siren_wifi_lost: "pathLost",
  siren_lora_lost: "pathLost",
  gateway_offline: "offline",
  interference_started: "interference",
  noise_interference_started: "interference",
  interference_ended: "interferenceEnded",
  noise_interference_ended: "interferenceEnded",
  battery_low: "batteryLow",
  battery_ok: "batteryOk",
  tamper_opened: "tamperOpen",
  tamper_closed: "tamperClosed",
};

/**
 * `upkeep`'s backup decisions, each a `hub` event `backup` to those with manage system (section 5:
 * "`upkeep`'s decisions"). A restore and an update's outcome are no `hub` event: people learn of
 * them from notifications, and `update.status` holds the outcome (section 11, wave 2).
 */
const BACKUP_DECISIONS: ReadonlySet<string> = new Set([
  "backup_no_folder",
  "backup_overdue",
  "backup_key_replaced",
  "backup_folder_on_data_disk",
]);

/** Whether the actor may see a device: a sensor by view, sirens and gateways always ‡. */
function seesDevice(view: HubState, actor: Parameters<typeof mayView>[1], device: number): boolean {
  const row = deviceById(view, device as Parameters<typeof deviceById>[1]);
  return row?.role !== Role.Sensor || mayView(view, actor, row.id);
}

/** The `health`, `hub` and `record` events of one record. */
export function recordEvents(sending: Sending, view: HubState, record: AuditRecord): void {
  if (record.kind === "decision") {
    const row = record.row;
    const what = HEALTH_OF[row.kind];
    const device = row.deviceId;
    if (what !== undefined && device !== null) {
      sending.event(view, "health", (_session, actor) =>
        seesDevice(view, actor, device) ? { device, what, sinceMs: row.atMs } : undefined,
      );
    }
    if (row.kind === "backup_key_replaced" && row.value !== null) {
      // To the phones' sessions, which fetch the new key with `backup.key` (section 9).
      const epoch = row.value;
      sending.event(view, "backupKeyChanged", (session) =>
        liveClient(view, session.client)?.kind === ClientKind.Phone ? { epoch } : undefined,
      );
    }
    if (BACKUP_DECISIONS.has(row.kind)) {
      const kind = row.kind;
      sending.event(view, "hub", (_session, actor) =>
        hasGlobal(view, actor, "manageSystem")
          ? { what: "backup", detail: { kind, value: row.value } }
          : undefined,
      );
    }
    if (row.kind === "update_staged" || row.kind === "update_switching") {
      const hubWhat = row.kind === "update_staged" ? "updateStaged" : "updateSwitching";
      sending.event(view, "hub", (_session, actor) =>
        hasGlobal(view, actor, "manageSystem")
          ? { what: hubWhat, detail: { value: row.value } }
          : undefined,
      );
    }
  }
  if (record.kind === "hubEvent") {
    const row = record.row;
    if (row.code === "backup_written" || row.code === "backup_failed") {
      const kind = row.code;
      sending.event(view, "hub", (_session, actor) =>
        hasGlobal(view, actor, "manageSystem")
          ? { what: "backup", detail: { kind, message: row.message } }
          : undefined,
      );
    }
    if (row.code === "update_refused") {
      // A release refused, or a switch refused for space (section 5).
      sending.event(view, "hub", (_session, actor) =>
        hasGlobal(view, actor, "manageSystem")
          ? { what: "updateRefused", detail: { message: row.message, reason: row.detail } }
          : undefined,
      );
    }
  }
  sending.event(view, "record", (_session, actor) => recordFor(view, actor, record));
}

/** The writer's trimming and the database's size, from a `commit` input (HD 6). */
/**
 * The writer's state, from a `commit` input (HD 5, HD 6): `databaseFailing` at the first failed
 * commit of a run of failures, `databaseRecovered` at the first commit after them, the trimming
 * and the size guard's state. To those with manage system.
 */
export function commitEvents(sending: Sending, view: HubState, outcome: CommitOutcome): void {
  const toSystem = (
    what: "historyShortened" | "databaseSize" | "databaseFailing" | "databaseRecovered",
    detail: Record<string, string | number | boolean | null>,
  ): void => {
    sending.event(view, "hub", (_session, actor) =>
      hasGlobal(view, actor, "manageSystem") ? { what, detail } : undefined,
    );
  };
  if (outcome.kind === "failed" && !sending.slice.databaseFailing) {
    sending.slice = { ...sending.slice, databaseFailing: true };
    toSystem("databaseFailing", { message: outcome.message, full: outcome.full === true });
  } else if (outcome.kind === "recovered" && sending.slice.databaseFailing) {
    sending.slice = { ...sending.slice, databaseFailing: false };
    toSystem("databaseRecovered", {});
  } else if (outcome.kind === "trimmed") {
    toSystem("historyShortened", {
      routineRows: outcome.report.routineRows,
      eventRows: outcome.report.eventRows,
      oldestRoutineMs: outcome.report.oldestRoutineMs,
      oldestEventMs: outcome.report.oldestEventMs,
      inUseBytes: outcome.report.inUseBytes,
    });
  } else if (outcome.kind === "trimExhausted" || outcome.kind === "trimEnded") {
    toSystem("databaseSize", { inUseBytes: outcome.inUseBytes });
  }
}

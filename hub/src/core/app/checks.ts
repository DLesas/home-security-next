/**
 * Who may make each operation (m2-design.md section 6's "Who" column; section 7), checked on the
 * hub for every request, from the client's own record and never from anything the client says.
 *
 * `app` checks what it can see: the console listener (C), *manage system* (MS), and the devices an
 * operation names (V, M), including HB5a's rule for arming. The owners of `own` and people's
 * operations (`people`, `notify`, `upkeep`) check those themselves, from the actor the request
 * carries, since only they know whose a client, a notification or a token is; so do they for any
 * request, whatever its source.
 */
import { Role } from "@hsn/protocol";
import type { AppOp, AppOpName, AppOpNameV2, AppOpV2, AppProtoVersion } from "@hsn/protocol/app";
import { armState } from "../alarm/view.ts";
import type { DeviceId } from "../model/ids.ts";
import { deviceId, groupId, modeId } from "../model/ids.ts";
import type { Actor, OpOutcome } from "../model/messages.ts";
import { ArmState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { hasGlobal, mayManage, mayView, notManaged, userManagementOn } from "../people/view.ts";
import { deviceById } from "../registry/view.ts";
import { sensorsChanged } from "../layout/view.ts";
import type { Session } from "./state.ts";

type ArmingOp = Extract<AppOp, { readonly op: "mode.switch" | "arm" | "disarm" }>;

function unauthorizedSystem(): OpOutcome {
  return { ok: false, error: { code: "unauthorized", detail: { permission: "manageSystem" } } };
}

function unauthorizedDevices(devices: readonly DeviceId[]): OpOutcome {
  return { ok: false, error: { code: "unauthorized", detail: { devices: [...devices] } } };
}

const CONSOLE_ONLY: ReadonlySet<AppOpName> = new Set<AppOpName>([
  "usb.list",
  "usb.add",
  "usb.erase",
  "site.wifi",
  "restore.start",
  "update.upload",
]);

const MANAGE_SYSTEM: ReadonlySet<AppOpName> = new Set<AppOpName>([
  "hub.status",
  "group.create",
  "group.update",
  "group.delete",
  "mode.create",
  "mode.update",
  "mode.delete",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "device.rename",
  "device.remove",
  "siren.settings",
  "siren.test",
  "gateway.settings",
  "usb.list",
  "usb.add",
  "usb.erase",
  "site.set",
  "site.wifi",
  "site.survey",
  "site.change",
  "site.changeStatus",
  "backup.status",
  "backup.settings",
  "backup.now",
  "backup.export",
  "restore.start",
  "update.status",
  "update.upload",
  "update.approve",
  "update.cancel",
]);

/**
 * Whether the operation may come only on the console listener (C), as this body has it, on a
 * session of `proto`. Version 2 opens `site.wifi` to manage system from any client (m3-design
 * section 5: every Provision already carries the password inside the channel); a version 1
 * session keeps version 1's rule.
 */
export function consoleOnly(op: AppOp, proto: AppProtoVersion = 1): boolean {
  // `backup.settings`: MS; the folder C (section 6).
  if (op.op === "backup.settings") return op.body.folder !== undefined;
  if (op.op === "site.wifi") return proto === 1;
  return CONSOLE_ONLY.has(op.op);
}

/**
 * Version 2's rows `app` checks for their owners (m3-design sections 3 to 6, m4-design section 9):
 * manage system for pairing and the hub's offered releases. `firmware` and `relay` check their
 * own; `presence.set` and `backup.keyHeld` are the phone's own, which `app` (`presence.ts`) and
 * `upkeep` check.
 */
const MANAGE_SYSTEM_V2: ReadonlySet<AppOpNameV2> = new Set<AppOpNameV2>([
  "pair.prepare",
  "pair.finish",
  "update.offers",
  "update.fetch",
]);

/** The refusal of a version 2 operation by `app`, or undefined when it goes to its owner. */
export function refusalV2(view: HubState, actor: Actor, op: AppOpV2): OpOutcome | undefined {
  return MANAGE_SYSTEM_V2.has(op.op) && !hasGlobal(view, actor, "manageSystem")
    ? unauthorizedSystem()
    : undefined;
}

/**
 * The sensors an arming request needs *manage* on (HB5a; section 7, "Arming needs"): those whose
 * state it would change; for a disarm, every sensor it names; `mine` none.
 */
function armingNeeds(view: HubState, op: ArmingOp): readonly DeviceId[] {
  if (op.op === "disarm" && op.body.target === "mine") return [];
  const target = op.op === "mode.switch" ? undefined : op.body.target;
  if (target !== undefined && target !== "mine" && "sensor" in target) {
    const sensor = deviceId(target.sensor);
    if (op.op === "disarm") return [sensor];
    const arm = armState(view, sensor);
    return arm === undefined || arm === ArmState.Disarmed ? [sensor] : [];
  }
  // A mode or a group: `layout` knows which sensors; none for one that does not exist, which its
  // owner answers `notFound`.
  return modeOrGroupTouches(view, op) ?? [];
}

/**
 * HB5a's selector for a mode or a group: `layout`'s `sensorsChanged(view, target)` (section 11,
 * "Step 1's questions"), undefined when there is no such mode or group.
 */
function modeOrGroupTouches(view: HubState, op: ArmingOp): readonly DeviceId[] | undefined {
  if (op.op === "mode.switch")
    return sensorsChanged(view, { kind: "mode", mode: modeId(op.body.mode) });
  const target = op.body.target;
  if (target === "mine" || !("group" in target)) return [];
  return sensorsChanged(view, {
    kind: op.op === "arm" ? "arm" : "disarm",
    group: groupId(target.group),
  });
}

/** `sensor.settings`: M(d) for countdown and heartbeat; MS for reply rate and correction. */
function sensorSettingsCheck(
  view: HubState,
  actor: Actor,
  op: Extract<AppOp, { readonly op: "sensor.settings" }>,
): OpOutcome | undefined {
  const body = op.body;
  // `linkCheck` is a radio setting, like the reply rate: MS (section 11, "Step 1's questions").
  const system =
    body.replyRate !== undefined || body.correction !== undefined || body.linkCheck !== undefined;
  if (system && !hasGlobal(view, actor, "manageSystem")) return unauthorizedSystem();
  const sensor = deviceId(body.sensor);
  const own = body.countdown !== undefined || body.heartbeat !== undefined;
  if (own && !mayManage(view, actor, sensor)) return unauthorizedDevices([sensor]);
  return undefined;
}

/**
 * The refusal for a request this actor may not make on this session, or undefined when `app` lets
 * it through to its owner.
 */
export function refusal(
  view: HubState,
  session: Session | undefined,
  actor: Actor,
  op: AppOp,
): OpOutcome | undefined {
  // The hub computer's own commands have every permission (HD 9) and are C by nature.
  const onConsole = session === undefined || session.listener === "console";
  const proto: AppProtoVersion = session !== undefined && session.proto >= 2 ? 2 : 1;
  if (consoleOnly(op, proto) && !onConsole)
    return { ok: false, error: { code: "consoleOnly", detail: {} } };
  if (MANAGE_SYSTEM.has(op.op) && !hasGlobal(view, actor, "manageSystem"))
    return unauthorizedSystem();
  switch (op.op) {
    case "mode.switch":
    case "arm":
    case "disarm": {
      if (actor.kind !== "person" || !userManagementOn(view)) return undefined;
      // A sensor that does not exist is the owner's `notFound`, not a refusal.
      const needs = armingNeeds(view, op).filter((d) => deviceById(view, d) !== undefined);
      const missing = notManaged(view, actor, needs);
      return missing.length === 0 ? undefined : unauthorizedDevices(missing);
    }
    case "sensor.settings":
      return sensorSettingsCheck(view, actor, op);
    case "device.show": {
      const row = deviceById(view, deviceId(op.body.device));
      if (row?.role === Role.Sensor && !mayView(view, actor, row.id))
        return unauthorizedDevices([row.id]);
      return undefined;
    }
    case "history.query": {
      const hidden = (op.body.devices ?? [])
        .map(deviceId)
        .filter((d) => deviceById(view, d)?.role === Role.Sensor && !mayView(view, actor, d));
      return hidden.length === 0 ? undefined : unauthorizedDevices(hidden);
    }
    default:
      return undefined;
  }
}

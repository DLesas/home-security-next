/**
 * Requests for M1a's modules (m2-design.md section 2, "Requests for M1a's modules"): those modules
 * are unchanged and take only their own request messages, answered with `answer {request, reply}`.
 * So `app`, after its checks, sends the module the request message `control` would send for the
 * matching `hsn` command, with the person's actor text, numbered from 2⁴⁰ ‡, and turns the
 * module's `answer` into the operation's reply.
 *
 * HD 9's refusals become section 5's errors by section 11's table (`outcomeOfError`).
 * `siren.test`'s reply names the request's `commands` record (section 11, "Step 1's questions").
 * `site.show` and `usb.list` are reads answered from their modules' views, as `hsn site show` and
 * `hsn usb list` are (section 2). A device is not removed while a schedule names it (`inUse`), nor
 * while it is in a countdown or the alarm (`busy`, section 7).
 */
import {
  MAX_WIFI_NAME_BYTES,
  MAX_WIFI_PASSWORD_BYTES,
  Role,
  toHex,
  wifiBytes,
} from "@hsn/protocol";
import type { AppError, AppOp } from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import { alarmSummary, countdownRunning } from "../alarm/view.ts";
import { coreFault, type CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import { schedulesNaming } from "../schedules/view.ts";
import { firmwareNumber, firmwareText } from "../registry/view.ts";
import { belonging, boardByLabel, usbBoards } from "../setup/view.ts";
import { hubSigning } from "../registry/view.ts";
import type { ControlReply } from "../model/control.ts";
import { type DeviceId, deviceId, type RequestId, type Seq } from "../model/ids.ts";
import type { DomainMessage, OpOutcome } from "../model/messages.ts";
import { DeviceState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { deviceById, deviceByName, roleName, roleNumber } from "../registry/view.ts";
import { deviceObject, siteMoveObject, siteObject } from "./objects.ts";
import type { CoreDeps } from "../model/handler.ts";

function invalid(
  field: string,
  reason: Extract<AppError, { readonly code: "invalid" }>["detail"]["reason"],
): OpOutcome {
  return { ok: false, error: { code: "invalid", detail: { field, reason } } };
}

function deviceNotFound(id: number): OpOutcome {
  return { ok: false, error: { code: "notFound", detail: { what: "device", id } } };
}

/** A paired device of `role` by number, or undefined. */
function working(view: HubState, id: number, role: number): boolean {
  const row = deviceById(view, deviceId(id));
  return (
    row?.role === role &&
    row.state !== DeviceState.Removed &&
    row.state !== DeviceState.Provisioning
  );
}

/**
 * Why a device may not be removed now (section 7, "Modes, groups and arming"): a schedule names it
 * (`inUse`, its entries' ids), or it is in a countdown or the alarm (`busy`).
 */
function removalRefused(view: HubState, device: DeviceId): OpOutcome | undefined {
  const named = schedulesNaming(view, { sensor: device });
  if (named.length > 0)
    return {
      ok: false,
      error: { code: "invalid", detail: { field: "device", reason: "inUse", refs: [...named] } },
    };
  if (countdownRunning(view, device))
    return { ok: false, error: { code: "busy", detail: { because: "countdown" } } };
  const run = alarmSummary(view);
  if (run !== undefined && (run.triggers.includes(device) || run.sirens.includes(device)))
    return { ok: false, error: { code: "busy", detail: { because: "alarm" } } };
  return undefined;
}

/** `usb.list` (section 6), as `hsn usb list` answers it from the setup module's view. */
function usbList(view: HubState) {
  const hub = hubSigning(view);
  return {
    ports: usbBoards(view).map((board) => {
      const identity = board.identity;
      return {
        port: board.label,
        identity:
          identity === undefined
            ? null
            : {
                role: roleName(identity.role) ?? null,
                chipId: toHex(identity.chipId),
                firmware: firmwareText(firmwareNumber(identity.firmwareVersion)),
                paired: !identity.paired
                  ? ("no" as const)
                  : belonging(identity, hub?.identity) === "ours"
                    ? ("toThisHub" as const)
                    : ("toAnotherHub" as const),
                development: identity.developmentBuild,
              },
      };
    }),
  };
}

/** What becomes of an operation owned by an M1a module: its request message, or a refusal. */
export type M1aRouted =
  | { readonly kind: "request"; readonly message: DomainMessage }
  | { readonly kind: "refused"; readonly outcome: OpOutcome }
  | { readonly kind: "answered"; readonly outcome: OpOutcome };

/** The request message for `op`, or undefined when `op` is not an M1a module's. */
export function m1aRequest(
  view: HubState,
  op: AppOp,
  asked: { readonly request: RequestId; readonly actor: string; readonly record: Seq },
): M1aRouted | undefined {
  const refused = (outcome: OpOutcome): M1aRouted => ({ kind: "refused", outcome });
  const request = (message: DomainMessage): M1aRouted => ({ kind: "request", message });
  switch (op.op) {
    case "device.rename":
    case "device.remove": {
      const row = deviceById(view, deviceId(op.body.device));
      if (row === undefined || row.role === 0 || row.state === DeviceState.Removed)
        return refused(deviceNotFound(op.body.device));
      if (op.op === "device.rename")
        return request({
          kind: "deviceRenameRequest",
          device: row.id,
          name: op.body.name,
          ...asked,
        });
      const removal = removalRefused(view, row.id);
      return removal === undefined
        ? request({ kind: "deviceRemoveRequest", device: row.id, ...asked })
        : refused(removal);
    }
    case "site.show":
      return { kind: "answered", outcome: { ok: true, body: siteObject(view) } };
    case "usb.list":
      return { kind: "answered", outcome: { ok: true, body: usbList(view) } };
    case "sensor.settings": {
      const { sensor, ...change } = op.body;
      if (!working(view, sensor, Role.Sensor)) return refused(deviceNotFound(sensor));
      if (Object.keys(change).length === 0) return refused(invalid("sensor", "format"));
      return request({ kind: "sensorSettingsRequest", sensor: deviceId(sensor), change, ...asked });
    }
    case "siren.settings":
      if (!working(view, op.body.siren, Role.Siren)) return refused(deviceNotFound(op.body.siren));
      return request({
        kind: "sirenSettingsRequest",
        siren: deviceId(op.body.siren),
        maxSoundS: op.body.max,
        ...asked,
      });
    case "siren.test":
      if (!working(view, op.body.siren, Role.Siren)) return refused(deviceNotFound(op.body.siren));
      return request({
        kind: "sirenTestRequest",
        siren: deviceId(op.body.siren),
        seconds: op.body.seconds,
        ...asked,
      });
    case "gateway.settings": {
      const { gateway, statusS, interferenceDb, interferenceS, powerDbm, sirenPowerDbm } = op.body;
      const row = deviceById(view, deviceId(gateway));
      if (row === undefined || !working(view, gateway, Role.Gateway))
        return refused(deviceNotFound(gateway));
      const change = {
        ...(statusS === undefined ? {} : { statusIntervalS: statusS }),
        ...(interferenceDb === undefined ? {} : { interferenceDb }),
        ...(interferenceS === undefined ? {} : { interferenceS }),
        ...(powerDbm === undefined ? {} : { defaultPowerDbm: powerDbm }),
        ...(sirenPowerDbm === undefined ? {} : { sirenPowerDbm }),
      };
      if (Object.keys(change).length === 0) return refused(invalid("gateway", "format"));
      return request({
        kind: "gatewaySettingsRequest",
        gateway: row.id,
        name: row.name,
        change,
        ...asked,
      });
    }
    case "usb.add":
    case "usb.erase": {
      const board = boardByLabel(view, op.body.port);
      if (board === undefined) return refused(invalid("port", "unknownReference"));
      return op.op === "usb.add"
        ? request({
            kind: "usbAddRequest",
            link: board.link,
            name: op.body.name,
            role: op.body.role === undefined ? undefined : roleNumber(op.body.role),
            ...asked,
          })
        : request({ kind: "usbEraseRequest", link: board.link, ...asked });
    }
    case "site.set": {
      const change = op.body;
      if (Object.keys(change).length === 0) return refused(invalid("", "format"));
      return request({ kind: "siteSettingsRequest", change, ...asked });
    }
    case "site.wifi": {
      const name = wifiBytes(op.body.name);
      const password = wifiBytes(op.body.password);
      if (name.length > MAX_WIFI_NAME_BYTES) return refused(invalid("name", "range"));
      if (password.length > MAX_WIFI_PASSWORD_BYTES) return refused(invalid("password", "range"));
      return request({ kind: "siteWifiRequest", name, password, ...asked });
    }
    case "site.survey":
      return request({ kind: "siteSurveyRequest", ...asked });
    case "site.change": {
      const body = op.body;
      const action =
        body === "cancel"
          ? ({ kind: "cancel" } as const)
          : "start" in body
            ? ({ kind: "start", channel: body.start.channel, rate: body.start.rate } as const)
            : ({ kind: "force", yes: body.force.yes } as const);
      return request({ kind: "siteChangeRequested", action, ...asked });
    }
    case "site.changeStatus":
      return request({ kind: "siteChangeRequested", action: { kind: "status" }, ...asked });
    default:
      return undefined;
  }
}

/**
 * An HD 9 refusal as section 5's error, by the table of section 11 ("Step 1's questions"). A
 * refusal the table does not name is a fault in the step (HD 2): a new M1a code is mapped when it
 * is added. One already given as an app error (`app`) is passed on as it is.
 */
function outcomeOfError(
  ctx: Context,
  op: AppOp,
  error: Extract<ControlReply, { ok: false }>["error"],
): Result<OpOutcome, CoreFault> {
  const fail = (e: AppError): Result<OpOutcome, CoreFault> => ok({ ok: false, error: e });
  const refuse = (
    field: string,
    reason: Extract<AppError, { readonly code: "invalid" }>["detail"]["reason"],
  ) => ok(invalid(field, reason));
  if (error.app !== undefined) return ok({ ok: false, error: error.app });
  const body: unknown = op.body;
  const device =
    typeof body === "object" && body !== null && "device" in body && typeof body.device === "number"
      ? body.device
      : 0;
  switch (error.code) {
    case "unknownDevice":
      return ok(deviceNotFound(device));
    case "nameTaken":
      return refuse("name", "taken");
    case "unknownPort":
      return refuse("port", "unknownReference");
    case "boardRefused":
      return refuse("port", "format");
    case "badRequest":
    case "nothingToChange":
      return refuse("", "format");
    case "noAnswer":
      return refuse("port", "noAnswer");
    case "noGateway":
      return refuse("", "noGateway");
    case "sitePaired":
      return refuse("channel", "fixed");
    case "moveInProgress":
    case "notAnnouncing":
      return fail({ code: "busy", detail: { because: "siteMove" } });
    case "doorsOpen": {
      const doors = (error.names ?? []).flatMap((name) => {
        const row = deviceByName(ctx.view, name);
        return row === undefined ? [] : [row.id];
      });
      return fail({ code: "needsConfirmation", detail: { openDoors: doors, lowBattery: [] } });
    }
    case "failed":
      return fail({ code: "unavailable", detail: {} });
    case "opRefused":
    case "notBuilt":
      return err(
        coreFault(ctx.event, "core/app", "an M1a refusal section 5 does not map", {
          op: op.op,
          code: error.code,
        }),
      );
  }
}

/** The M1a module's answer as the operation's reply (section 6's reply column). */
export function m1aOutcome(
  ctx: Context,
  op: AppOp,
  reply: ControlReply,
  record: Seq,
): Result<OpOutcome, CoreFault> {
  if (!reply.ok) return outcomeOfError(ctx, op, reply.error);
  return ok(okOutcome(ctx.view, ctx.deps, op, reply.result, record));
}

function okOutcome(
  view: HubState,
  deps: CoreDeps,
  op: AppOp,
  result: Extract<ControlReply, { ok: true }>["result"],
  record: Seq,
): OpOutcome {
  const device = (id: number): OpOutcome => {
    const row = deviceById(view, deviceId(id));
    const object = row === undefined ? undefined : deviceObject(view, deps, row);
    return object === undefined ? deviceNotFound(id) : { ok: true, body: object };
  };
  switch (op.op) {
    case "device.rename":
    case "device.remove":
      return device(op.body.device);
    case "usb.add":
      return result.kind === "usbAdd" ? device(result.device) : { ok: true, body: {} };
    case "sensor.settings":
    case "siren.settings":
    case "gateway.settings":
      return "version" in result
        ? { ok: true, body: { version: result.version } }
        : { ok: true, body: {} };
    case "siren.test":
      return result.kind === "sirenTest"
        ? { ok: true, body: { seconds: result.seconds, decision: record } }
        : { ok: true, body: {} };
    case "usb.erase":
      return { ok: true, body: {} };
    case "site.set":
    case "site.wifi":
      return { ok: true, body: siteObject(view) };
    case "site.survey":
      return result.kind === "siteSurvey"
        ? { ok: true, body: { channel: result.channel, rate: siteObject(view).rate } }
        : { ok: true, body: {} };
    case "site.change":
    case "site.changeStatus":
      return { ok: true, body: siteMoveObject(view) };
    default:
      return { ok: true, body: {} };
  }
}

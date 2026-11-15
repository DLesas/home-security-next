/**
 * Every command of hub-design.md section 9 turned into what the core does with it: an answer the
 * control module gives at once from the state (status, devices, device show, usb list, site
 * show, and every refusal it can see itself), or a request message to the module that owns the
 * change, which answers it later through an `answer` message; or, for `hsn log`, nothing but its
 * record, since the shell flushes, reads and streams (section 3, "Reads never defeat the
 * batching").
 */
import { m2OwnerOf } from "../model/ops.ts";
import {
  MAX_WIFI_NAME_BYTES,
  MAX_WIFI_PASSWORD_BYTES,
  Role,
  toHex,
  wifiBytes,
} from "@hsn/protocol";
import { err, ok, type Result } from "neverthrow";
import type { CommandResult, ControlCommand, ControlReply } from "../model/control.ts";
import {
  AWAY_MODE,
  type ConnId,
  DISARMED_MODE,
  HUB_DEVICE,
  type RequestId,
  type Seq,
  tokenId,
} from "../model/ids.ts";
import type { DomainMessage, SensorSelection } from "../model/messages.ts";
import type { DeviceRow } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import type { Now } from "../model/time.ts";
import {
  deviceByName,
  firmwareNumber,
  firmwareText,
  hubSigning,
  isWorking,
  registeredDevices,
  roleName,
  roleNumber,
  stateName,
} from "../registry/view.ts";
import { schedulesNaming } from "../schedules/view.ts";
import { belonging, boardByLabel, usbBoards } from "../setup/view.ts";
import { type ControlSources, WAITING_TEXT } from "./sources.ts";
import type { ControlErrorCode } from "./view.ts";

/** What becomes of one command. */
export type Routed =
  | { readonly kind: "answer"; readonly reply: ControlReply }
  | { readonly kind: "forward"; readonly message: DomainMessage }
  | { readonly kind: "shell" };

type Command<K extends ControlCommand["kind"]> = Extract<ControlCommand, { readonly kind: K }>;
type DeviceSummary = Extract<CommandResult, { readonly kind: "devices" }>["devices"][number];

function answer(result: CommandResult): Routed {
  return { kind: "answer", reply: { ok: true, result } };
}

function refuse(code: ControlErrorCode, message: string, names?: readonly string[]): Routed {
  return {
    kind: "answer",
    reply: {
      ok: false,
      error: names === undefined ? { code, message } : { code, message, names: [...names] },
    },
  };
}

/** The command without some of its fields, for the request messages that carry the rest. */
function without<T extends object, K extends keyof T>(value: T, ...keys: readonly K[]): Omit<T, K> {
  const dropped: ReadonlySet<PropertyKey> = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !dropped.has(key))) as Omit<
    T,
    K
  >;
}

/** A device of `role` that is paired with this hub, by name. */
function working(view: HubState, name: string, role: number): DeviceRow | undefined {
  const row = deviceByName(view, name);
  return row?.role === role && isWorking(row.state) ? row : undefined;
}

function noSuch(name: string, role: string): Routed {
  return refuse("unknownDevice", `no paired ${role} is called ${name}`, [name]);
}

/** `--all`, or the paired sensors named, each once; any other name is refused, all named. */
function sensorsNamed(
  view: HubState,
  target: Command<"arm">["sensors"],
): Result<SensorSelection, readonly string[]> {
  if (target === "all") return ok("all");
  const unknown = target.filter((name) => working(view, name, Role.Sensor) === undefined);
  if (unknown.length > 0) return err([...new Set(unknown)]);
  const ids = target.flatMap((name) => {
    const row = working(view, name, Role.Sensor);
    return row === undefined ? [] : [row.id];
  });
  return ok([...new Set(ids)]);
}

function summary(view: HubState, row: DeviceRow, sources: ControlSources): DeviceSummary {
  return {
    name: row.name,
    role: roleName(row.role) ?? "sensor",
    address: row.address,
    state: stateName(row.state),
    firmware: row.firmware === 0 ? null : firmwareText(row.firmware),
    lastSeenMs: sources.deviceDetail(view, row.id).lastSeenMs,
  };
}

function usbList(view: HubState): Routed {
  const hub = hubSigning(view);
  return answer({
    kind: "usbList",
    ports: usbBoards(view).map((board) => {
      const identity = board.identity;
      return {
        port: board.label,
        identity:
          identity === undefined
            ? null
            : {
                role: identity.role,
                chipId: toHex(identity.chipId),
                firmware: firmwareText(firmwareNumber(identity.firmwareVersion)),
                paired: identity.paired,
                ours: belonging(identity, hub?.identity) === "ours",
                hubIdentity: identity.paired ? toHex(identity.hubIdentity) : null,
                development: identity.developmentBuild,
              },
      };
    }),
  });
}

function requested(message: DomainMessage): Routed {
  return { kind: "forward", message };
}

/**
 * `hsn arm --all` and `hsn disarm --all` are switches to the fixed modes Away and Disarmed
 * (m2-design.md section 1, D90), sent to layout as `hsn op mode.switch` is, with the hub computer
 * as actor. The sensors end as `hsn arm --all` and `hsn disarm --all` left them, and the command
 * keeps its answer (control turns the alarm's into `hsn arm`'s or `hsn disarm`'s, `m1-replies.ts`).
 * `--continue` confirms open doors (D50); the hub computer is never asked about a battery, since
 * `hsn arm` cannot confirm one and never asked.
 */
function switchTo(
  command: Command<"arm"> | Command<"disarm">,
  request: RequestId,
  conn: ConnId,
  actor: string,
  record: Seq,
): Routed {
  const body =
    command.kind === "arm"
      ? { mode: AWAY_MODE, confirm: { openDoors: command.continue, lowBattery: true } }
      : { mode: DISARMED_MODE };
  return requested({
    kind: "opRequest",
    owner: "layout",
    op: { op: "mode.switch", body },
    actor: { kind: "computer", name: actor },
    answerTo: { kind: "control", request, conn },
    record,
  });
}

/** Routes one command (section 9). */
export function route(
  view: HubState,
  now: Now,
  sources: ControlSources,
  request: RequestId,
  conn: ConnId,
  actor: string,
  record: Seq,
  command: ControlCommand,
): Routed {
  const asked = { request, actor, record };
  switch (command.kind) {
    case "status": {
      const status = sources.status(view, now);
      return status === undefined ? refuse("failed", `status is ${WAITING_TEXT}`) : answer(status);
    }
    case "arm":
    case "disarm": {
      const sensors = sensorsNamed(view, command.sensors);
      if (sensors.isErr()) {
        return refuse(
          "unknownDevice",
          `not paired sensors: ${sensors.error.join(", ")}`,
          sensors.error,
        );
      }
      if (sensors.value === "all") return switchTo(command, request, conn, actor, record);
      return command.kind === "arm"
        ? requested({
            kind: "armRequest",
            sensors: sensors.value,
            continueOpen: command.continue,
            ...asked,
          })
        : requested({ kind: "disarmRequest", sensors: sensors.value, ...asked });
    }
    case "devices":
      return answer({
        kind: "devices",
        devices: registeredDevices(view).map((row) => summary(view, row, sources)),
      });
    case "deviceShow": {
      const row = deviceByName(view, command.name);
      if (row === undefined)
        return refuse("unknownDevice", `no device is called ${command.name}`, [command.name]);
      const detail = sources.deviceDetail(view, row.id);
      return answer({
        kind: "deviceShow",
        device: summary(view, row, sources),
        settings: detail.settings,
        reading: detail.reading,
      });
    }
    case "usbList":
      return usbList(view);
    case "usbAdd":
    case "usbErase": {
      const board = boardByLabel(view, command.port);
      if (board === undefined)
        return refuse(
          "unknownPort",
          `no USB board is open on ${command.port}: see \`hsn usb list\``,
        );
      return command.kind === "usbAdd"
        ? requested({
            kind: "usbAddRequest",
            link: board.link,
            name: command.name,
            role: command.role === undefined ? undefined : roleNumber(command.role),
            ...asked,
          })
        : requested({ kind: "usbEraseRequest", link: board.link, ...asked });
    }
    case "deviceRename":
    case "deviceRemove": {
      const name = command.kind === "deviceRename" ? command.from : command.name;
      const row = deviceByName(view, name);
      if (row === undefined || row.id === HUB_DEVICE)
        return refuse("unknownDevice", `no device is called ${name}`, [name]);
      if (command.kind === "deviceRename") {
        return requested({
          kind: "deviceRenameRequest",
          device: row.id,
          name: command.to,
          ...asked,
        });
      }
      // A sensor a schedule entry names cannot be removed: the entries are named (m2-design.md
      // section 7; section 11, "Step 1's questions, settled").
      const named = schedulesNaming(view, { sensor: row.id });
      if (named.length > 0) {
        return {
          kind: "answer",
          reply: {
            ok: false,
            error: {
              code: "opRefused",
              message: `named by schedules ${named.join(", ")}`,
              app: { code: "invalid", detail: { field: "device", reason: "inUse", refs: named } },
            },
          },
        };
      }
      return requested({ kind: "deviceRemoveRequest", device: row.id, ...asked });
    }
    case "sensorSet": {
      const row = working(view, command.name, Role.Sensor);
      if (row === undefined) return noSuch(command.name, "sensor");
      const change = without(command, "kind", "name");
      if (Object.keys(change).length === 0)
        return refuse("badRequest", "nothing to set: give at least one setting");
      return requested({ kind: "sensorSettingsRequest", sensor: row.id, change, ...asked });
    }
    case "gatewaySet": {
      const row = working(view, command.name, Role.Gateway);
      if (row === undefined) return noSuch(command.name, "gateway");
      const change = {
        ...(command.statusS === undefined ? {} : { statusIntervalS: command.statusS }),
        ...(command.interferenceDb === undefined ? {} : { interferenceDb: command.interferenceDb }),
        ...(command.interferenceS === undefined ? {} : { interferenceS: command.interferenceS }),
        ...(command.powerDbm === undefined ? {} : { defaultPowerDbm: command.powerDbm }),
        ...(command.sirenPowerDbm === undefined ? {} : { sirenPowerDbm: command.sirenPowerDbm }),
      };
      if (Object.keys(change).length === 0)
        return refuse("badRequest", "nothing to set: give at least one setting");
      return requested({
        kind: "gatewaySettingsRequest",
        gateway: row.id,
        name: row.name,
        change,
        ...asked,
      });
    }
    case "sirenSet":
    case "sirenTest": {
      const row = working(view, command.name, Role.Siren);
      if (row === undefined) return noSuch(command.name, "siren");
      return command.kind === "sirenSet"
        ? requested({
            kind: "sirenSettingsRequest",
            siren: row.id,
            maxSoundS: command.max,
            ...asked,
          })
        : requested({
            kind: "sirenTestRequest",
            siren: row.id,
            seconds: command.seconds,
            ...asked,
          });
    }
    case "siteShow": {
      const site = sources.site(view);
      return site === undefined
        ? refuse("failed", `the site's settings are ${WAITING_TEXT}`)
        : answer({ kind: "siteShow", site });
    }
    case "siteSurvey":
      return requested({ kind: "siteSurveyRequest", ...asked });
    case "siteSet": {
      const change = without(command, "kind");
      if (Object.keys(change).length === 0)
        return refuse("badRequest", "nothing to set: give at least one setting");
      return requested({ kind: "siteSettingsRequest", change, ...asked });
    }
    case "siteChange":
      return requested({
        kind: "siteChangeRequested",
        action: { kind: "start", channel: command.channel, rate: command.rate },
        ...asked,
      });
    case "siteChangeStatus":
      return requested({ kind: "siteChangeRequested", action: { kind: "status" }, ...asked });
    case "siteChangeCancel":
      return requested({ kind: "siteChangeRequested", action: { kind: "cancel" }, ...asked });
    case "siteChangeForce":
      return requested({
        kind: "siteChangeRequested",
        action: { kind: "force", yes: command.yes },
        ...asked,
      });
    case "siteWifi": {
      const name = wifiBytes(command.name);
      const password = wifiBytes(command.password);
      if (name.length > MAX_WIFI_NAME_BYTES)
        return refuse("badRequest", `a Wi-Fi name has at most ${MAX_WIFI_NAME_BYTES} bytes (§9)`);
      if (password.length > MAX_WIFI_PASSWORD_BYTES) {
        return refuse(
          "badRequest",
          `a Wi-Fi password has at most ${MAX_WIFI_PASSWORD_BYTES} bytes (§9)`,
        );
      }
      return requested({ kind: "siteWifiRequest", name, password, ...asked });
    }
    case "log":
      return { kind: "shell" };
    // M2 (m2-design.md section 6): to the operation's owner, with the hub computer as actor.
    case "op": {
      const op = command.operation;
      const owner = m2OwnerOf(op.op);
      if (owner === undefined) {
        return refuse("notBuilt", `${op.op} has no module yet (m2-design.md section 2)`);
      }
      return requested({
        kind: "opRequest",
        owner,
        op,
        actor: { kind: "computer", name: actor },
        answerTo: { kind: "control", request, conn },
        record,
      });
    }
    case "consoleToken":
      return requested({ kind: "consoleTokenRequest", for: command.for ?? "open", ...asked });
    case "consoleTokenWait":
      return requested({
        kind: "consoleTokenWaitRequest",
        token: tokenId(command.token),
        ...asked,
      });
  }
}

/** Placeholder for a secret in a command's record. */
export const REDACTED = "(not recorded)";

/**
 * A command's arguments as its record keeps them (`commands.args`, AL8): every field but the
 * kind, as JSON, with the Wi-Fi password left out.
 */
export function recordedArgs(command: ControlCommand): string {
  const args =
    command.kind === "siteWifi"
      ? { ...without(command, "kind"), password: REDACTED }
      : without(command, "kind");
  return JSON.stringify(args);
}

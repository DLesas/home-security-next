/**
 * `hsn`'s readable output (hub-design.md section 9): one block per command result, and one line
 * per audit record, its packet bodies decoded with `@hsn/protocol`. Everything the hub or a
 * device wrote (names, messages, log texts) is printed with its control characters escaped, so
 * no text can steer the terminal.
 */
import { concatBytes, decodeMessage, fromHex, MessageType, toHex } from "@hsn/protocol";
import { Result } from "neverthrow";
import type { CommandResult, ControlError, RecordJson } from "../src/control-protocol/index.ts";

const CHANNEL_MHZ = ["868.1", "868.3", "868.5"] as const;
const PATHS = ["LoRa", "Wi-Fi", "USB"] as const;
const LAST_C0 = 0x1f;
const DEL = 0x7f;
const LAST_C1 = 0x9f;

/** Text from the hub with every control character shown as \xNN or \u{N}. */
export function printable(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out +=
      code <= LAST_C0 || (code >= DEL && code <= LAST_C1)
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : char;
  }
  return out;
}

const safeFromHex = Result.fromThrowable(fromHex, () => undefined);
const utf8 = new TextDecoder("utf-8", { fatal: false });

function names(list: readonly string[]): string {
  return list.length === 0 ? "none" : list.map(printable).join(", ");
}

function time(ms: number | null): string {
  return ms === null ? "never" : new Date(ms).toISOString();
}

function channelText(channel: number | null): string {
  return channel === null ? "not chosen" : `${CHANNEL_MHZ[channel] ?? channel} MHz`;
}

function hex32(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

/** Rows as aligned columns. */
function table(head: readonly string[], rows: readonly (readonly string[])[]): readonly string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(head), ...rows.map(line)];
}

function activity(
  a: { readonly kind: string; readonly secondsLeft: number | null } | null,
): string {
  if (a === null) return "unknown";
  return a.secondsLeft === null ? a.kind : `${a.kind} (${a.secondsLeft} s left)`;
}

/** The lines `hsn` prints for a command that worked. */
export function formatResult(result: CommandResult): readonly string[] {
  switch (result.kind) {
    case "status":
      return [
        `alarm: ${result.alarm === null ? "none" : `since ${time(result.alarm.startedMs)}, set off by ${names(result.alarm.triggers)}, sounding ${names(result.alarm.sirens)}`}`,
        "",
        ...table(
          ["SENSOR", "ARMED", "DOOR", "COUNTDOWN"],
          result.sensors.map((s) => [
            printable(s.name),
            s.arm,
            s.door,
            s.countdownSecondsLeft === null ? "-" : `${s.countdownSecondsLeft} s`,
          ]),
        ),
        "",
        ...table(
          ["SIREN", "SHOULD", "COMMANDED", "REPORTED", "WI-FI", "LORA"],
          result.sirens.map((s) => [
            printable(s.name),
            activity(s.should),
            activity(s.commanded),
            activity(s.reported),
            s.wifi,
            s.lora,
          ]),
        ),
        "",
        ...table(
          ["GATEWAY", "SESSION", "LINK", "LAST STATUS", "NOISE", "BASELINE"],
          result.gateways.map((g) => [
            printable(g.name),
            g.session ? "yes" : "no",
            g.link === null ? "-" : printable(g.link),
            time(g.lastStatusMs),
            g.noiseMedianDbm === null ? "-" : `${g.noiseMedianDbm} dBm`,
            g.baselineDbm === null ? "-" : `${g.baselineDbm.toFixed(1)} dBm`,
          ]),
        ),
        "",
        `last commit: ${time(result.lastCommitMs)}, ${result.stagedItems} items staged`,
        `database: ${result.databaseBytes === null ? "-" : `${(result.databaseBytes / 1024 / 1024).toFixed(1)} MB in use`}${result.historyShortened ? "; history is being shortened to stay within the disk limit" : ""}`,
      ];
    case "arm":
      return [
        `armed: ${names(result.armed)}`,
        ...(result.waitsForDoorToClose.length === 0
          ? []
          : [`armed, waiting for the door to close: ${names(result.waitsForDoorToClose)}`]),
      ];
    case "disarm":
      return [
        `disarmed: ${names(result.disarmed)}`,
        ...(result.countdownsCancelled.length === 0
          ? []
          : [`countdowns cancelled: ${names(result.countdownsCancelled)}`]),
        ...(result.alarmEnded ? ["the alarm ended"] : []),
      ];
    case "devices":
      return result.devices.length === 0
        ? ["no devices"]
        : table(
            ["NAME", "ROLE", "STATE", "ADDRESS", "FIRMWARE", "LAST SEEN"],
            result.devices.map((d) => [
              printable(d.name),
              d.role,
              d.state,
              hex32(d.address),
              d.firmware ?? "-",
              time(d.lastSeenMs),
            ]),
          );
    case "deviceShow": {
      const d = result.device;
      return [
        `${printable(d.name)}: ${d.role}, ${d.state}`,
        `address: ${hex32(d.address)}`,
        `firmware: ${d.firmware ?? "unknown"}`,
        `last seen: ${time(d.lastSeenMs)}`,
        ...(result.settings === null
          ? []
          : Object.entries(result.settings)
              .filter(([key]) => key !== "role")
              .map(([key, value]) => `${key}: ${String(value)}`)),
        ...(result.reading === null ? [] : [`latest reading: ${result.reading}`]),
      ];
    }
    case "usbList":
      return result.ports.length === 0
        ? ["no USB boards"]
        : table(
            ["PORT", "ROLE", "CHIP", "FIRMWARE", "PAIRED", "BUILD"],
            result.ports.map((p) => {
              const i = p.identity;
              if (i === null) return [printable(p.port), "-", "-", "-", "no Identity yet", "-"];
              return [
                printable(p.port),
                ["none", "sensor", "siren", "gateway"][i.role] ?? `role ${i.role}`,
                i.chipId,
                i.firmware,
                !i.paired
                  ? "no"
                  : i.ours
                    ? "to this hub"
                    : `to another hub (${i.hubIdentity ?? "?"})`,
                i.development ? "development" : "release",
              ];
            }),
          );
    case "usbAdd":
      return [
        `added ${printable(result.name)}: ${result.role}, device ${result.device}, address ${hex32(result.address)}, chip ${result.chip}; it restarts, and is contacted at its first packet`,
      ];
    case "usbErase":
      return [`Erase sent to ${printable(result.port)}; the board restarts unpaired`];
    case "deviceRename":
      return [`renamed to ${printable(result.name)}`];
    case "deviceRemove":
      return [`removed ${printable(result.name)}: its key is deleted, its history kept`];
    case "sensorSet":
    case "gatewaySet":
    case "sirenSet":
      return [`${printable(result.name)}: settings version ${result.version}`];
    case "sirenTest":
      return [`${printable(result.name)}: testing for ${result.seconds} s`];
    case "siteShow":
    case "siteSet": {
      const s = result.site;
      return [
        `channel: ${channelText(s.channel)}`,
        `rate: DR${s.rate}`,
        `entry countdown: ${s.countdownS} s`,
        `automatic stop: ${s.autoStopS} s`,
        `Wi-Fi: ${s.wifiName === null ? "not set" : printable(s.wifiName)}`,
        `powers: replies ${s.replyPowerDbm} dBm, sirens ${s.sirenPowerDbm} dBm`,
      ];
    }
    case "siteSurvey":
      return [
        `quietest: ${channelText(result.channel)}`,
        ...result.noise.map((n) => `  ${channelText(n.channel)}: ${n.medianDbm.toFixed(1)} dBm`),
      ];
    case "siteChange":
      return [
        `announcing ${channelText(result.channel)}, DR${result.rate} to ${result.sensors} sensors`,
      ];
    case "siteChangeStatus": {
      const m = result.move;
      if (m === null) return ["no site move has been made"];
      return [
        `move ${m.id}: ${m.stage}${m.forced ? " (forced)" : ""}, to ${channelText(m.channel)}, DR${m.rate}`,
        m.stage === "announcing"
          ? `confirmed: ${m.confirmed} of ${m.total}`
          : `followed: ${m.followed} of ${m.total}`,
        ...m.waiting.map((w) => `  waiting for ${printable(w.name)} since ${time(w.sinceMs)}`),
        ...(m.graceEndsMs === null ? [] : [`silence grace ends ${time(m.graceEndsMs)}`]),
      ];
    }
    case "siteChangeCancel":
      return [`cancelled; ${result.sensors} sensors clear the next settings at their next reply`];
    case "siteChangeForce":
      return result.switched
        ? [`switched; left behind, to be paired again: ${names(result.leftBehind)}`]
        : [
            `a forced switch would leave behind, to be paired again: ${names(result.leftBehind)}`,
            "run `hsn site change force --yes` to switch",
          ];
    case "siteWifi":
      return ["the site's Wi-Fi details are set"];
    case "log":
      return result.records.map(formatRecord);
    case "op":
      return [JSON.stringify(result.body)];
    case "consoleToken":
      return [`open ${result.url} within ${Math.round(result.expiresInMs / 1000)} s`];
    case "fileChunk":
      return [];
  }
}

/** The lines `hsn` prints, on standard error, for a command the hub refused. */
export function formatError(error: ControlError): readonly string[] {
  return [
    `hsn: ${printable(error.message)}`,
    ...(error.names === undefined ? [] : [`  ${names(error.names)}`]),
  ];
}

const TYPE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(MessageType).map(([name, type]) => [type, name]),
);

/** A decoded packet body's fields, with bytes as hex. */
function body(type: number, hex: string): string {
  const bytes = safeFromHex(hex);
  if (bytes.isErr()) return hex;
  const decoded = decodeMessage(concatBytes(new Uint8Array([type]), bytes.value));
  if (!decoded.ok) return `${hex} (${decoded.error.code})`;
  const fields: Record<string, unknown> = { ...decoded.value };
  delete fields.type;
  return printable(
    JSON.stringify(fields, (_key, value: unknown) =>
      value instanceof Uint8Array ? toHex(value) : value,
    ),
  );
}

/** One audit record as one line. */
export function formatRecord(record: RecordJson): string {
  switch (record.kind) {
    case "rx":
    case "tx": {
      const r = record.row;
      const path = PATHS[r.path] ?? `path ${r.path}`;
      return `${time(r.atMs)} ${record.kind} device ${r.deviceId} ${TYPE_NAMES[r.type] ?? `type ${r.type}`} #${r.counter} ${path} ${body(r.type, r.body)}`;
    }
    case "decision": {
      const r = record.row;
      return `${time(r.atMs)} decision ${printable(r.kind)}${r.deviceId === null ? "" : ` device ${r.deviceId}`}${r.value === null ? "" : ` value ${r.value}`}`;
    }
    case "deviceLog": {
      const r = record.row;
      const text = safeFromHex(r.text);
      return `${time(r.atMs)} log device ${r.deviceId} level ${r.level} code ${r.code}: ${printable(text.isOk() ? utf8.decode(text.value) : r.text)}${r.repeatOf === null ? "" : ` (repeat of #${r.repeatOf})`}`;
    }
    case "hubEvent": {
      const r = record.row;
      return `${time(r.atMs)} ${r.level} ${printable(r.origin)} ${printable(r.code)}: ${printable(r.message)}`;
    }
    case "command": {
      const r = record.row;
      return `${time(r.atMs)} command ${printable(r.kind)} by ${printable(r.actor)}: ${printable(r.outcome)}`;
    }
    case "reject": {
      const r = record.row;
      return `${time(r.minute * 60_000)} rejected ${r.count} × ${printable(r.reason)} via ${printable(r.via)}`;
    }
    case "notification": {
      const r = record.row;
      return `${time(r.atMs)} notification ${printable(r.kind)} (${printable(r.category)}${r.critical ? ", critical" : ""})${r.deviceId === null ? "" : ` device ${r.deviceId}`}`;
    }
    case "notificationRead": {
      const r = record.row;
      return `${time(r.atMs)} notification #${r.notificationSeq} read by client ${r.clientId}`;
    }
  }
}

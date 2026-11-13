/**
 * The control module (hub-design.md section 2, module 5; section 9; AL8): every command of
 * section 9 routed to its frozen request message or answered from the state, names resolved,
 * exactly one answer per command, each command recorded with its actor, its arguments (no
 * secrets) and its outcome, and no answer before what the command changed is written.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { answerError, answerOk } from "../../../src/core/control/view.ts";
import { route, REDACTED, recordedArgs } from "../../../src/core/control/translate.ts";
import { type ControlSources, VIEW_SOURCES } from "../../../src/core/control/sources.ts";
import { OUTCOME_OK, OUTCOME_SHELL } from "../../../src/core/control/handle.ts";
import type { ControlCommand } from "../../../src/core/model/control.ts";
import type { Handler } from "../../../src/core/model/handler.ts";
import { deviceId, requestId, seq } from "../../../src/core/model/ids.ts";
import { type DeviceRow, DeviceState } from "../../../src/core/model/rows.ts";
import { setupCore } from "../setup/support/core.ts";
import {
  CHIP_B,
  commandRows,
  Driver,
  errorCode,
  hubEvents,
  identityFrame,
  onlyReply,
  replies,
  Role,
  snapshot,
} from "../setup/support/driver.ts";
import { expectNoKeyLeaks, noteValue } from "../setup/support/leak-guard.ts";

afterAll(() => {
  expectNoKeyLeaks();
});

function row(
  id: number,
  role: number,
  name: string,
  state: DeviceRow["state"] = DeviceState.Contacted,
): DeviceRow {
  return {
    id: deviceId(id),
    address: 0x5e000000 + id,
    role,
    name,
    chipId: new Uint8Array([0, 0, 0, 0, 0, id]),
    firmware: 0x010203,
    development: false,
    state,
    addedMs: 1,
    removedMs: null,
  };
}

const DEVICES = [
  row(2, Role.Gateway, "gw1"),
  row(3, Role.Sensor, "front"),
  row(4, Role.Sensor, "back", DeviceState.Paired),
  row(5, Role.Siren, "hall"),
  row(6, Role.Sensor, "new", DeviceState.Provisioning),
  row(7, Role.Sensor, "#7-gone", DeviceState.Removed),
];

function hubWith(core = setupCore()): Driver {
  const hub = new Driver(core);
  hub.boot(snapshot({ devices: DEVICES }));
  return hub;
}

const NOW = { mono: 0 as never, wall: 0, wallTrusted: true };

function routed(command: ControlCommand, hub = hubWith()) {
  return route(hub.state, NOW, VIEW_SOURCES, requestId(9), "dimitri", seq(77), command);
}

describe("every command of section 9 is routed (translate)", () => {
  const asked = { request: requestId(9), actor: "dimitri", record: seq(77) };
  const forwarded: readonly [ControlCommand, unknown][] = [
    [
      { kind: "arm", sensors: "all", continue: false },
      { kind: "armRequest", sensors: "all", continueOpen: false, ...asked },
    ],
    [
      { kind: "arm", sensors: ["front", "back", "front"], continue: true },
      { kind: "armRequest", sensors: [deviceId(3), deviceId(4)], continueOpen: true, ...asked },
    ],
    [
      { kind: "disarm", sensors: ["back"] },
      { kind: "disarmRequest", sensors: [deviceId(4)], ...asked },
    ],
    [
      { kind: "deviceRename", from: "front", to: "porch" },
      { kind: "deviceRenameRequest", device: deviceId(3), name: "porch", ...asked },
    ],
    [
      { kind: "deviceRemove", name: "hall" },
      { kind: "deviceRemoveRequest", device: deviceId(5), ...asked },
    ],
    [
      { kind: "sensorSet", name: "front", countdown: 45, replyRate: "learn" },
      {
        kind: "sensorSettingsRequest",
        sensor: deviceId(3),
        change: { countdown: 45, replyRate: "learn" },
        ...asked,
      },
    ],
    [
      { kind: "sirenSet", name: "hall", max: 120 },
      { kind: "sirenSettingsRequest", siren: deviceId(5), maxSoundS: 120, ...asked },
    ],
    [
      { kind: "sirenTest", name: "hall" },
      { kind: "sirenTestRequest", siren: deviceId(5), seconds: undefined, ...asked },
    ],
    [
      { kind: "sirenTest", name: "hall", seconds: 3 },
      { kind: "sirenTestRequest", siren: deviceId(5), seconds: 3, ...asked },
    ],
    [{ kind: "siteSurvey" }, { kind: "siteSurveyRequest", ...asked }],
    [
      { kind: "siteSet", countdown: 20, autoStop: 200 },
      { kind: "siteSettingsRequest", change: { countdown: 20, autoStop: 200 }, ...asked },
    ],
    [
      { kind: "siteChange", rate: 2 },
      {
        kind: "siteChangeRequested",
        action: { kind: "start", channel: undefined, rate: 2 },
        ...asked,
      },
    ],
    [
      { kind: "siteChangeStatus" },
      { kind: "siteChangeRequested", action: { kind: "status" }, ...asked },
    ],
    [
      { kind: "siteChangeCancel" },
      { kind: "siteChangeRequested", action: { kind: "cancel" }, ...asked },
    ],
    [
      { kind: "siteChangeForce", yes: false },
      { kind: "siteChangeRequested", action: { kind: "force", yes: false }, ...asked },
    ],
    [
      { kind: "siteChangeForce", yes: true },
      { kind: "siteChangeRequested", action: { kind: "force", yes: true }, ...asked },
    ],
  ];
  for (const [command, message] of forwarded) {
    test(`${command.kind} ${JSON.stringify(command).slice(0, 60)} becomes its request`, () => {
      expect(routed(command)).toEqual({ kind: "forward", message: message as never });
    });
  }

  test("site wifi carries the name and password as UTF-8 bytes (§9)", () => {
    expect(routed({ kind: "siteWifi", name: "Café", password: "pässwörd" })).toEqual({
      kind: "forward",
      message: {
        kind: "siteWifiRequest",
        name: new TextEncoder().encode("Café"),
        password: new TextEncoder().encode("pässwörd"),
        ...asked,
      },
    });
  });

  test("usb add and erase name the link of the port, and the role by its number", () => {
    const hub = hubWith();
    const { link } = hub.openUsb("/dev/ttyACM0");
    expect(routed({ kind: "usbAdd", port: "/dev/ttyACM0", name: "x", role: "siren" }, hub)).toEqual(
      {
        kind: "forward",
        message: { kind: "usbAddRequest", link, name: "x", role: Role.Siren, ...asked },
      },
    );
    expect(routed({ kind: "usbAdd", port: "/dev/ttyACM0", name: "x" }, hub)).toEqual({
      kind: "forward",
      message: { kind: "usbAddRequest", link, name: "x", role: undefined, ...asked },
    });
    expect(routed({ kind: "usbErase", port: "/dev/ttyACM0" }, hub)).toEqual({
      kind: "forward",
      message: { kind: "usbEraseRequest", link, ...asked },
    });
  });

  test("hsn log is left to the shell", () => {
    expect(routed({ kind: "log", follow: true })).toEqual({ kind: "shell" });
  });
});

describe("answers control gives from the state (section 3: no database read)", () => {
  test("status lists the sensors as the alarm module sees them, and the writer's part is the shell's", () => {
    const result = routed({ kind: "status" });
    expect(
      result.kind === "answer" && result.reply.ok ? result.reply.result : undefined,
    ).toMatchObject({
      kind: "status",
      lastCommitMs: null,
      stagedItems: 0,
      databaseBytes: null,
      historyShortened: false,
    });
  });

  test("site show gives the site module's row", () => {
    const result = routed({ kind: "siteShow" });
    expect(result.kind === "answer" && result.reply.ok ? result.reply.result.kind : undefined).toBe(
      "siteShow",
    );
  });
});

describe("refusals control can see itself", () => {
  const refused: readonly [string, ControlCommand, string][] = [
    [
      "an unknown sensor",
      { kind: "arm", sensors: ["front", "nobody", "hall"], continue: false },
      "unknownDevice",
    ],
    ["a sensor still provisioning", { kind: "disarm", sensors: ["new"] }, "unknownDevice"],
    ["a removed sensor", { kind: "arm", sensors: ["#7-gone"], continue: false }, "unknownDevice"],
    [
      "a siren named as a sensor",
      { kind: "sensorSet", name: "hall", countdown: 3 },
      "unknownDevice",
    ],
    ["a sensor named as a siren", { kind: "sirenSet", name: "front", max: 3 }, "unknownDevice"],
    ["a sensor set with nothing to set", { kind: "sensorSet", name: "front" }, "badRequest"],
    ["a site set with nothing to set", { kind: "siteSet" }, "badRequest"],
    ["renaming nobody", { kind: "deviceRename", from: "nobody", to: "x" }, "unknownDevice"],
    ["an unknown port", { kind: "usbAdd", port: "/dev/none", name: "x" }, "unknownPort"],
    [
      "a Wi-Fi name of 33 bytes",
      { kind: "siteWifi", name: "n".repeat(33), password: "" },
      "badRequest",
    ],
    [
      "a Wi-Fi name of 17 two-byte characters",
      { kind: "siteWifi", name: "é".repeat(17), password: "" },
      "badRequest",
    ],
    [
      "a Wi-Fi password of 65 bytes",
      { kind: "siteWifi", name: "n", password: "p".repeat(65) },
      "badRequest",
    ],
  ];
  for (const [what, command, code] of refused) {
    test(`${what} is refused as ${code}`, () => {
      const result = routed(command);
      expect(
        result.kind === "answer" && !result.reply.ok ? result.reply.error.code : "routed",
      ).toBe(code);
    });
  }

  test("an arm naming unknown sensors names every one of them, once", () => {
    const result = routed({ kind: "arm", sensors: ["x", "front", "x", "y"], continue: false });
    expect(result.kind === "answer" && !result.reply.ok ? result.reply.error.names : []).toEqual([
      "x",
      "y",
    ]);
  });

  test("a Wi-Fi name of 32 bytes and a password of 64 are taken", () => {
    expect(routed({ kind: "siteWifi", name: "é".repeat(16), password: "p".repeat(64) }).kind).toBe(
      "forward",
    );
  });
});

describe("answers made from the state", () => {
  test("devices lists every device but the hub, with state, role and firmware", () => {
    const reply = onlyReply(hubWith().command({ kind: "devices" }).effects);
    expect(
      reply.ok && reply.result.kind === "devices"
        ? reply.result.devices.map((d) => [d.name, d.role, d.state, d.firmware, d.lastSeenMs])
        : [],
    ).toEqual([
      ["gw1", "gateway", "contacted", "1.2.3", null],
      ["front", "sensor", "contacted", "1.2.3", null],
      ["back", "sensor", "paired", "1.2.3", null],
      ["hall", "siren", "contacted", "1.2.3", null],
      ["new", "sensor", "provisioning", "1.2.3", null],
      ["#7-gone", "sensor", "removed", "1.2.3", null],
    ]);
  });

  test("device show gives the registry's row, and the rest from the sources", () => {
    const sources: ControlSources = {
      ...VIEW_SOURCES,
      deviceDetail: () => ({ lastSeenMs: 42, settings: null, reading: "0a0b" }),
    };
    const hub = hubWith(setupCore(sources));
    const reply = onlyReply(hub.command({ kind: "deviceShow", name: "front" }).effects);
    expect(reply).toEqual({
      ok: true,
      result: {
        kind: "deviceShow",
        device: {
          name: "front",
          role: "sensor",
          address: 0x5e000003,
          state: "contacted",
          firmware: "1.2.3",
          lastSeenMs: 42,
        },
        settings: null,
        reading: "0a0b",
      },
    });
    expect(errorCode(onlyReply(hub.command({ kind: "deviceShow", name: "nobody" }).effects))).toBe(
      "unknownDevice",
    );
  });

  test("status comes whole from the sources when they exist", () => {
    const status = {
      kind: "status",
      sensors: [],
      alarm: null,
      sirens: [],
      gateways: [],
      lastCommitMs: null,
      stagedItems: 0,
      databaseBytes: null,
      historyShortened: false,
    } as const;
    const hub = hubWith(setupCore({ ...VIEW_SOURCES, status: () => status }));
    expect(onlyReply(hub.command({ kind: "status" }).effects)).toEqual({
      ok: true,
      result: status,
    });
  });

  test("usb list shows each open port and its board's latest Identity", () => {
    const hub = hubWith();
    hub.openUsb("/dev/ttyACM0");
    const { link } = hub.openUsb("/dev/ttyACM1");
    hub.frame(link, identityFrame({ role: Role.Sensor, chipId: CHIP_B, development: true }));
    const reply = onlyReply(hub.command({ kind: "usbList" }).effects);
    expect(
      reply.ok && reply.result.kind === "usbList"
        ? reply.result.ports.map((p) => [p.port, p.identity?.chipId ?? null])
        : [],
    ).toEqual([
      ["/dev/ttyACM0", null],
      ["/dev/ttyACM1", "010203040506"],
    ]);
  });
});

/** An alarm stand-in that answers arms at once, writing first, and disarms never. */
const answeringAlarm: Handler<"alarm"> = (slice, message) => {
  if (message.kind !== "armRequest") return ok({ slice, out: [] });
  return ok({
    slice,
    out: [
      {
        kind: "write",
        durability: "now",
        op: { table: "countdowns", op: "delete", key: { sensorId: deviceId(3) } },
      },
      answerOk(message.request, { kind: "arm", armed: ["front"], waitsForDoorToClose: [] }),
    ],
  });
};

/** A sensors stand-in that answers each settings request twice: the second must not pass. */
const answeringTwice: Handler<"sensors"> = (slice, message) =>
  ok({
    slice,
    out:
      message.kind === "sensorSettingsRequest"
        ? [
            answerOk(message.request, { kind: "sensorSet", name: "front", version: 8 }),
            answerError(message.request, "failed", "again"),
          ]
        : [],
  });

describe("one answer per command, recorded (AL8)", () => {
  test("an answer from the owning module is passed on once, in the step that wrote the change", () => {
    const hub = hubWith(setupCore(VIEW_SOURCES, { alarm: answeringAlarm }));
    const { effects } = hub.command({ kind: "arm", sensors: ["front"], continue: false });
    expect(onlyReply(effects)).toEqual({
      ok: true,
      result: { kind: "arm", armed: ["front"], waitsForDoorToClose: [] },
    });
    const writeAt = effects.findIndex((e) => e.kind === "write" && e.durability === "now");
    const respondAt = effects.findIndex((e) => e.kind === "respond");
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(respondAt).toBeGreaterThan(writeAt);
    expect(hub.state.control.pending.size).toBe(0);
  });

  test("a second answer to one request is not passed on; it is a warning", () => {
    const hub = hubWith(setupCore(VIEW_SOURCES, { sensors: answeringTwice }));
    const { effects } = hub.command({ kind: "sensorSet", name: "front", countdown: 20 });
    expect(replies(effects)).toHaveLength(1);
    expect(hubEvents(effects).map((e) => [e.row.code, e.durability])).toEqual([
      ["answer_not_waited_for", "now"],
    ]);
  });

  test("a command whose owner answers later waits, and is answered then", () => {
    const hub = hubWith();
    const { request, effects } = hub.command({ kind: "disarm", sensors: "all" });
    expect(replies(effects)).toEqual([]);
    expect(hub.state.control.pending.get(request)?.kind).toBe("disarm");
  });

  test("every answered command is recorded with its actor, kind, arguments and outcome, routine", () => {
    const hub = hubWith(setupCore(VIEW_SOURCES, { alarm: answeringAlarm }));
    const armed = hub.command(
      { kind: "arm", sensors: ["front"], continue: true },
      undefined,
      "dimitri",
    ).effects;
    const refused = hub.command({ kind: "deviceShow", name: "nobody" }, undefined, "ana").effects;
    expect(commandRows(armed).map((r) => [r.actor, r.kind, r.args, r.outcome, r.detail])).toEqual([
      ["dimitri", "arm", '{"sensors":["front"],"continue":true}', OUTCOME_OK, null],
    ]);
    expect(commandRows(refused).map((r) => [r.actor, r.kind, r.outcome])).toEqual([
      ["ana", "deviceShow", "unknownDevice"],
    ]);
    const durabilities = [...armed, ...refused].flatMap((e) =>
      e.kind === "record" && e.record.kind === "command" ? [e.durability] : [],
    );
    expect(durabilities).toEqual(["routine", "routine"]);
  });

  test("the Wi-Fi password never reaches the record", () => {
    const command: ControlCommand = { kind: "siteWifi", name: "home", password: "hunter2-secret" };
    expect(recordedArgs(command)).toBe(`{"name":"home","password":"${REDACTED}"}`);
    const hub = hubWith();
    const { effects } = hub.command({ kind: "siteWifi", name: "home", password: "p".repeat(65) });
    expect(commandRows(effects)[0]?.args.includes("ppp")).toBe(false);
    noteValue(effects);
  });

  test("hsn log is recorded, and not answered by the core", () => {
    const hub = hubWith();
    const { effects } = hub.command({ kind: "log", follow: false, logKind: "rx" });
    expect(replies(effects)).toEqual([]);
    expect(commandRows(effects).map((r) => [r.kind, r.outcome, r.args])).toEqual([
      ["log", OUTCOME_SHELL, '{"follow":false,"logKind":"rx"}'],
    ]);
    expect(hub.state.control.pending.size).toBe(0);
  });

  test("a restart forgets the requests of the run before", () => {
    const hub = hubWith();
    hub.command({ kind: "disarm", sensors: "all" });
    hub.boot(snapshot({ devices: DEVICES }), 2);
    expect(hub.state.control.pending.size).toBe(0);
  });

  test("an answer to a request that is not waiting is a warning, and no answer goes out", () => {
    const answerFromNowhere: Handler<"sensors"> = (slice, message) =>
      ok({
        slice,
        out: message.kind === "tick" ? [answerOk(requestId(77), { kind: "siteWifi" })] : [],
      });
    const hub = hubWith(setupCore(VIEW_SOURCES, { sensors: answerFromNowhere }));
    const effects = hub.advance(1);
    expect(replies(effects)).toEqual([]);
    expect(hubEvents(effects).map((e) => e.row.code)).toEqual(["answer_not_waited_for"]);
  });
});

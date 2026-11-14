/**
 * Step 0 of M2 (m2-design.md section 11): the six new modules are stubs that change nothing, in
 * their fixed places; every operation the hub computer may send is routed to its owner and
 * answered `notBuilt`, which a test can tell from every real refusal; the new events reach the
 * core without a fault; and the frozen model types are used by the stubs.
 */
import { describe, expect, test } from "bun:test";
import { APP_OP_NAMES, APP_OPS, type AppOpName } from "@hsn/protocol/app";
import { CONTROL_OPS, controlCommand, typedCommand } from "../../../src/control-protocol/index.ts";
import type { ControlCommand } from "../../../src/core/model/control.ts";
import { DECISION_KINDS, M2_HUB_EVENTS } from "../../../src/core/model/decisions.ts";
import type { Effect, FileWork } from "../../../src/core/model/effects.ts";
import { BATTERY_CURVE_INTERIM, DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubEvent } from "../../../src/core/model/events.ts";
import {
  APP_REQUEST_BASE,
  clientId,
  connId,
  deviceId,
  isAppRequest,
  personId,
  requestId,
  jobId,
  scheduleId,
  sendRef,
  sendRefModule,
  TOKEN_RANGES,
  tokenId,
  tokenPurpose,
  moduleSendRef,
} from "../../../src/core/model/ids.ts";
import { M2_MODULES, MODULE_ORDER } from "../../../src/core/model/modules.ts";
import { m2OwnerOf, OP_OWNERS } from "../../../src/core/model/ops.ts";
import { emptyState, makeCore, MODULES } from "../../../src/core/step.ts";
import { handleControl } from "../../../src/core/control/handle.ts";
import { EMPTY_CONTROL_SLICE } from "../../../src/core/control/state.ts";
import type { Context } from "../../../src/core/model/handler.ts";
import { mono } from "../../../src/core/model/time.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { ok } from "neverthrow";
import { seq } from "../../../src/core/model/ids.ts";
import { Driver, errorCode, onlyReply, snapshot } from "../setup/support/driver.ts";

function hub(): Driver {
  const driver = new Driver(makeCore(MODULES));
  driver.boot(snapshot());
  return driver;
}

/** A body section 6's schema takes, for each operation the hub computer may send. */
const BODIES: Readonly<Record<(typeof CONTROL_OPS)[number], unknown>> = {
  snapshot: {},
  "hub.info": {},
  "hub.status": {},
  "mode.switch": { mode: 1 },
  arm: { target: { group: 1 } },
  disarm: { target: { sensor: 3 } },
  "group.create": { name: "Ground", sensors: [3], sirens: "all" },
  "group.update": { group: 1, name: "Ground", sensors: [3], sirens: [5], ifRevision: 0 },
  "group.delete": { group: 1, ifRevision: 0 },
  "mode.create": { name: "Night", groups: [1] },
  "mode.update": { mode: 3, name: "Night", groups: [], ifRevision: 0 },
  "mode.delete": { mode: 3, ifRevision: 0 },
  "schedule.create": {
    name: "Night",
    action: "switchMode",
    target: { mode: 1 },
    at: "22:00",
    days: ["mon", "fri"],
    enabled: true,
  },
  "schedule.update": {
    schedule: 1,
    name: "Night",
    action: "arm",
    target: { group: 1 },
    at: "22:30",
    days: "everyDay",
    enabled: false,
    ifRevision: 2,
  },
  "schedule.delete": { schedule: 1, ifRevision: 2 },
  "notifications.list": { limit: 10 },
  "people.list": {},
  "person.create": { name: "Anna" },
  "person.rename": { person: 1, name: "Ann", ifRevision: 0 },
  "person.remove": { person: 1, ifRevision: 0 },
  "permissions.set": {
    person: 1,
    devices: [{ device: 3, manage: true, view: true }],
    manageUsers: true,
    manageSystem: false,
    ifRevision: 0,
  },
  "userManagement.set": { on: true },
  "clients.list": {},
  "client.rename": { client: 2, name: "Ben's laptop" },
  "client.remove": { client: 2, also: [] },
  "link.create": { kind: "ownDevice", form: "qr" },
  "link.cancel": { token: 4 },
  "backup.status": {},
  "backup.settings": { hour: 4 },
  "backup.now": {},
  "backup.export": { history: false },
  "restore.start": { job: 1 },
  "update.upload": { job: 1 },
  "update.status": {},
  "update.approve": {},
  "update.cancel": {},
};

function opCommand(name: (typeof CONTROL_OPS)[number]): ControlCommand {
  const parsed = controlCommand.safeParse({ kind: "op", op: name, body: BODIES[name] });
  expect([name, parsed.success]).toEqual([name, true]);
  const typed = parsed.success ? typedCommand(parsed.data) : undefined;
  expect(typed).toBeDefined();
  return typed ?? { kind: "status" };
}

describe("the module order (m2-design.md section 2)", () => {
  test("M2's seven sit at their places, and every one is a definition of the core", () => {
    const at = (m: string) => MODULE_ORDER.indexOf(m as (typeof MODULE_ORDER)[number]);
    expect(at("control")).toBeLessThan(at("people"));
    expect(at("people")).toBeLessThan(at("layout"));
    expect(at("layout")).toBeLessThan(at("app"));
    expect(at("app")).toBeLessThan(at("schedules"));
    expect(at("schedules")).toBeLessThan(at("gateways"));
    expect(at("sirens")).toBeLessThan(at("health"));
    expect(at("health")).toBeLessThan(at("notify"));
    expect(at("notify")).toBeLessThan(at("upkeep"));
    expect(MODULE_ORDER.indexOf("upkeep")).toBe(18);
    expect(MODULE_ORDER.indexOf("audit")).toBe(19);
    expect(MODULE_ORDER).toHaveLength(20);
    expect(Object.keys(MODULES).toSorted()).toEqual([...MODULE_ORDER].toSorted());
  });

  test("send references number the modules by their new places; each reads back its module", () => {
    for (const module of MODULE_ORDER) {
      expect(sendRefModule(moduleSendRef(module, 7))).toBe(module);
    }
    expect(sendRefModule(sendRef(0))).toBeUndefined();
  });
});

describe("the stubs change nothing (m2-design.md section 11, step 0)", () => {
  test("a boot leaves every M2 slice as it was, with no timers", () => {
    const driver = hub();
    const empty = makeCore(MODULES).emptyState();
    for (const module of M2_MODULES) {
      expect([module, driver.state[module]]).toEqual([module, empty[module]]);
    }
  });

  test("the new events reach the core without a fault and change no M2 slice", () => {
    const driver = hub();
    const before = M2_MODULES.map((m) => driver.state[m]);
    const events: readonly HubEvent[] = [
      { kind: "timeZone", zone: "Europe/London" },
      {
        kind: "clientConnected",
        conn: connId(1),
        client: clientId(2),
        listener: "console",
        proto: 1,
        app: "1.0.0",
      },
      {
        kind: "clientRequest",
        conn: connId(1),
        client: clientId(2),
        request: { id: 1, seq: undefined, op: { op: "hub.info", body: {} } },
      },
      {
        kind: "linkCompleted",
        conn: connId(3),
        token: tokenId(4),
        staticKey: new Uint8Array(32),
        listener: "lan",
        link: { name: "Ben's laptop", kind: "web" },
      },
      { kind: "linkFailed", token: tokenId(4), reason: "badPsk" },
      {
        kind: "fileReady",
        job: jobId(1),
        outcome: { kind: "failed", reason: "unreachable", message: "no folder" },
      },
      { kind: "restoreOpened", conn: connId(5), token: tokenId(6) },
      { kind: "restoreKey", conn: connId(5), token: tokenId(6), key: new Uint8Array(32), epoch: 1 },
      { kind: "clientClosed", conn: connId(1), reason: "remote" },
      {
        kind: "inputRejected",
        rejection: { source: "app", conn: connId(1), reason: "badShape", bytes: 40, issues: [] },
      },
    ];
    for (const event of events) {
      const effects = driver.input(event);
      // No M2 effect leaves a stub.
      expect(
        effects.filter((e) =>
          ["appSend", "closeClient", "linkSecret", "fileJob", "historyRead"].includes(e.kind),
        ),
      ).toEqual([]);
    }
    expect(M2_MODULES.map((m) => driver.state[m])).toEqual(before);
  });
});

describe("the hub computer's operations (m2-design.md section 6)", () => {
  test.each([...CONTROL_OPS])(
    "%s is answered notBuilt by its owner, or by control when it has none",
    (name) => {
      const driver = hub();
      const { effects } = driver.command(opCommand(name));
      const reply = onlyReply(effects);
      expect(errorCode(reply)).toBe("notBuilt");
      expect(reply.ok ? undefined : (reply.error.app?.code ?? "control")).toBe(
        m2OwnerOf(name) === undefined ? "control" : "notBuilt",
      );
    },
  );

  test("notBuilt is its own code: a real refusal of an M1a command is still what it was", () => {
    const driver = hub();
    const refusal = onlyReply(driver.command({ kind: "deviceShow", name: "nobody" }).effects);
    expect(errorCode(refusal)).toBe("unknownDevice");
  });

  test("hsn open's console token is answered notBuilt by people", () => {
    const driver = hub();
    expect(errorCode(onlyReply(driver.command({ kind: "consoleToken" }).effects))).toBe("notBuilt");
  });

  test("an operation the hub computer does not send, or a body its schema refuses, is not a command", () => {
    expect(controlCommand.safeParse({ kind: "op", op: "pong", body: {} }).success).toBe(false);
    expect(
      controlCommand.safeParse({ kind: "op", op: "subscribe", body: { topics: [] } }).success,
    ).toBe(false);
    expect(controlCommand.safeParse({ kind: "op", op: "mode.switch", body: {} }).success).toBe(
      false,
    );
    expect(controlCommand.safeParse({ kind: "op", op: "nope", body: {} }).success).toBe(false);
  });

  test("the owners of section 11: upkeep's, app's history, the shell's file chunks", () => {
    for (const name of APP_OP_NAMES) {
      if (/^(?:backup|update)\./u.test(name) || name === "restore.start") {
        expect([name, OP_OWNERS[name]]).toEqual([name, "upkeep"]);
      }
    }
    expect(OP_OWNERS["history.query"]).toBe("app");
    expect(OP_OWNERS.fileChunk).toBe("shell");
    expect(m2OwnerOf("fileChunk")).toBeUndefined();
    expect(m2OwnerOf("device.rename")).toBeUndefined();
    expect(OP_OWNERS["device.rename"]).toBe("registry");
  });

  test("token numbers: link tokens below 2³¹ (people), restore tokens from 2³¹ (upkeep)", () => {
    expect(TOKEN_RANGES.link.last + 1).toBe(TOKEN_RANGES.restore.first);
    expect(tokenPurpose(tokenId(2 ** 31 - 1))).toBe("link");
    expect(tokenPurpose(tokenId(2 ** 31))).toBe("restore");
    const secret: Effect = {
      kind: "linkSecret",
      token: tokenId(2 ** 31),
      purpose: "restore",
      psk: null,
    };
    expect(secret.kind).toBe("linkSecret");
  });

  test("app's requests to M1a's modules are numbered from 2⁴⁰, above every control request", () => {
    expect(APP_REQUEST_BASE).toBe(2 ** 40);
    expect(isAppRequest(requestId(2 ** 32 - 1))).toBe(false);
    expect(isAppRequest(requestId(APP_REQUEST_BASE))).toBe(true);
    // An answer to one of app's numbers is not control's: it records nothing and answers nothing.
    const ctx: Context = {
      now: { mono: mono(0), wall: 0, wallTrusted: true },
      view: emptyState(),
      deps: {
        cipher: VectorCipher.fromVectors(),
        rules: DEFAULT_RULES,
        calendar: UNBUILT_CALENDAR,
      },
      entropy: entropyCursor(new Uint8Array(32), "tick"),
      records: { take: () => ok(seq(0)) },
      event: "tick",
    };
    const reply = { ok: false, error: { code: "notBuilt", message: "-" } } as const;
    const handled = handleControl(
      EMPTY_CONTROL_SLICE,
      { kind: "answer", request: requestId(APP_REQUEST_BASE), reply },
      ctx,
    );
    expect(handled.isOk() ? handled.value.out : undefined).toEqual([]);
  });

  test("every operation has an owner entry, and the control operations are app operations", () => {
    expect(Object.keys(OP_OWNERS).toSorted()).toEqual([...APP_OP_NAMES].map(String).toSorted());
    for (const name of CONTROL_OPS) expect(APP_OPS[name as AppOpName]).toBeDefined();
    expect(scheduleId(1)).toBe(scheduleId(1));
  });
});

describe("the frozen M2 model (m2-design.md sections 2, 7 and 9)", () => {
  test("FileWork has section 2's seven variants, and historyRead carries the person's filter", () => {
    const upload = { conn: connId(1), job: 2 };
    const key = new Uint8Array(32);
    const work: readonly FileWork[] = [
      { kind: "backup", folder: "/backups", keep: 20, key, epoch: 1 },
      { kind: "export", conn: connId(1), history: false, key, epoch: 1 },
      { kind: "stageUpdate", upload },
      { kind: "switchUpdate", version: "2.0.0" },
      { kind: "readRestore", upload },
      { kind: "applyRestore", upload, key },
      { kind: "switchRestore" },
    ];
    expect(new Set(work.map((w) => w.kind)).size).toBe(7);
    const read: Effect = {
      kind: "historyRead",
      conn: connId(1),
      id: 4,
      query: { limit: 50 },
      allowed: { devices: [deviceId(3)], person: personId(1), clients: [clientId(7)], hub: false },
    };
    expect(read.kind).toBe("historyRead");
  });

  test("upkeep's decisions and hub events, and the interim battery table", () => {
    for (const kind of ["backup_overdue", "backup_key_replaced", "backup_folder_on_data_disk"]) {
      expect(DECISION_KINDS as readonly string[]).toContain(kind);
    }
    expect(M2_HUB_EVENTS.backup_written).toEqual({ level: "info", durability: "routine" });
    expect(M2_HUB_EVENTS.backup_failed).toEqual({ level: "warning", durability: "routine" });
    expect(DEFAULT_RULES.health.batteryCurve).toBe(BATTERY_CURVE_INTERIM);
    const points: readonly (readonly number[])[] = BATTERY_CURVE_INTERIM;
    expect(points).toContainEqual([3500, DEFAULT_RULES.health.batteryLowPercent]);
    expect(points).toContainEqual([3600, DEFAULT_RULES.health.batteryOkPercent]);
  });
});

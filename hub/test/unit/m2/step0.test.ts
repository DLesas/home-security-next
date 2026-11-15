/**
 * Step 0 of M2 (m2-design.md section 11): the six new modules are stubs that change nothing, in
 * their fixed places; every operation the hub computer may send is routed to its owner and
 * answered `notBuilt`, which a test can tell from every real refusal; the new events reach the
 * core without a fault; and the frozen model types are used by the stubs.
 */
import { nodeSha256 } from "@hsn/protocol";
import { describe, expect, test } from "bun:test";
import { APP_OP_NAMES, APP_OPS, type AppOpName, LINKING } from "@hsn/protocol/app";
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
import { Driver, errorCode, onlyReply, replies, snapshot } from "../setup/support/driver.ts";

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

/**
 * What is still not built (m2-design.md section 11): nothing, since `layout` built its groups and
 * modes in wave 2. `every-operation.test.ts` is the check that fails on any `notBuilt` or silence.
 */
const NOT_BUILT_OPS: ReadonlySet<string> = new Set<string>();

describe("every M2 module is built and takes M2's events (section 11)", () => {
  test("no module is a stub, and a boot of an empty hub sends nothing to apps", () => {
    const driver = new Driver(makeCore(MODULES));
    const effects = driver.boot(snapshot());
    expect(M2_MODULES.length).toBe(7);
    expect(effects.filter((e) => e.kind === "appSend" || e.kind === "closeConn")).toEqual([]);
  });

  test("every new event reaches the core without a fault", () => {
    const driver = hub();
    const events: readonly HubEvent[] = [
      {
        kind: "hubFacts",
        version: "0.1.0",
        addresses: ["192.168.1.20"],
        appsPort: 8444,
        consolePort: 8445,
        certificateSha256: new Uint8Array(32),
      },
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
      { kind: "linkFailed", token: tokenId(4), reason: "badPsk", address: "192.168.1.30" },
      {
        kind: "fileReady",
        job: jobId(1),
        outcome: { kind: "failed", reason: "unreachable", message: "no folder" },
      },
      { kind: "clientRefused", address: "192.168.1.31", reason: "unknownToken", count: 2 },
      {
        kind: "shellWarning",
        code: "data_folder_was_open",
        message: "the data folder was open",
        detail: null,
      },
      { kind: "restoreOpened", conn: connId(5), token: tokenId(6) },
      { kind: "restoreKey", conn: connId(5), token: tokenId(6), key: new Uint8Array(32), epoch: 1 },
      { kind: "clientClosed", conn: connId(1), reason: "remote" },
      {
        kind: "inputRejected",
        rejection: { source: "app", conn: connId(1), reason: "badShape", bytes: 40, issues: [] },
      },
    ];
    // `driver.input` fails the test on a `CoreFault`; a shell warning is recorded as a hub event.
    let recorded = false;
    for (const event of events) {
      const effects = driver.input(event);
      if (event.kind === "shellWarning")
        recorded = effects.some(
          (e) =>
            e.kind === "record" &&
            e.record.kind === "hubEvent" &&
            e.record.row.origin === "shell" &&
            e.record.row.code === "data_folder_was_open",
        );
    }
    expect(recorded).toBe(true);
  });
});

describe("the hub computer's operations (m2-design.md section 6)", () => {
  test.each([...CONTROL_OPS])(
    "%s is answered once by its owner: done, refused for one of section 5's reasons, or notBuilt",
    (name) => {
      const driver = hub();
      const { effects } = driver.command(opCommand(name));
      // An operation on an upload (`restore.start`, `update.upload`) is answered when its file
      // job ends (section 6): the job's end, here a failed read, gives the one answer.
      const job = effects.find((e) => e.kind === "fileJob");
      const reply = onlyReply(
        job?.kind === "fileJob" && replies(effects).length === 0
          ? driver.input({
              kind: "fileReady",
              job: job.job,
              outcome: { kind: "failed", reason: "io", message: "the upload could not be read" },
            })
          : effects,
      );
      const owner = m2OwnerOf(name);
      expect(owner).toBeDefined();
      // An answer is the owner's: done, an app error carried in `app`, or notBuilt, which is
      // distinguishable from every real refusal (section 11).
      if (!reply.ok) {
        expect(["opRefused", "notBuilt"]).toContain(reply.error.code);
        expect(reply.error.app?.code === "notBuilt").toBe(reply.error.code === "notBuilt");
      }
      // Not built: exactly the operations still waiting for their owner.
      expect([name, errorCode(reply) === "notBuilt"]).toEqual([name, NOT_BUILT_OPS.has(name)]);
    },
  );

  test("notBuilt is its own code: a real refusal of an M1a command is still what it was", () => {
    const driver = hub();
    const refusal = onlyReply(driver.command({ kind: "deviceShow", name: "nobody" }).effects);
    expect(errorCode(refusal)).toBe("unknownDevice");
  });

  test("hsn open's console token is made by people: a console address, good for 2 minutes", () => {
    const driver = hub();
    // The facts come before any client, `hsn` included (`AppSide.open`, section 2): the console's
    // address names its listener's real port.
    driver.input({
      kind: "hubFacts",
      version: "0.1.0",
      addresses: ["192.168.1.20"],
      appsPort: 8444,
      consolePort: 8445,
      certificateSha256: new Uint8Array(32),
    });
    const effects = driver.command({ kind: "consoleToken" }).effects;
    const reply = onlyReply(effects);
    const result = reply.ok ? reply.result : undefined;
    expect(result).toMatchObject({
      kind: "consoleToken",
      expiresInMs: LINKING.consoleTokenExpiryMs,
    });
    expect(result?.kind === "consoleToken" ? result.url : "").toMatch(
      /^http:\/\/127\.0\.0\.1:8445\/#console=[A-Za-z0-9_-]{22}$/u,
    );
    // The shell is told the token's key with its purpose, before the address is shown (section 5).
    expect(effects.filter((e) => e.kind === "linkSecret")).toMatchObject([{ purpose: "link" }]);
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
      askName: false,
      lookup: null,
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
        sha256: nodeSha256,
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

/**
 * Every request is answered (m2-design.md sections 5 and 7): each operation of `APP_OPS`, sent
 * with a valid body, gets exactly one answer, on the real core with every module: a reply from the
 * core, or, for the two the shell answers (`history.query`, `hub.status`), exactly one effect
 * asking it to (`historyRead`, `hubStatusRead`); one sent by someone without the permission gets
 * exactly one refusal. `fileChunk` is the shell's alone and never reaches the core (section 6).
 */
import { describe, expect, test } from "bun:test";
import { APP_OP_NAMES, type AppOp, type AppOpName, parseAppOp } from "@hsn/protocol/app";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { ConnId } from "../../../src/core/model/ids.ts";
import { MODULES } from "../../../src/core/step.ts";
import { OP_OWNERS } from "../../../src/core/model/ops.ts";
import {
  ANNA,
  BEN,
  BEN_LAPTOP,
  CONSOLE_CLIENT,
  FRONT,
  GARAGE,
  household,
  Hub,
  permission,
  repliesTo,
  role,
} from "../people/support/hub.ts";

/** A body section 6's schema takes, for every operation. */
const BODIES: Readonly<Record<AppOpName, unknown>> = {
  snapshot: {},
  subscribe: { topics: ["arming"] },
  "hub.info": {},
  "hub.status": {},
  "mode.switch": { mode: 1 },
  arm: { target: { sensor: GARAGE } },
  disarm: { target: { sensor: GARAGE } },
  "group.create": { name: "Ground", sensors: [FRONT], sirens: "all" },
  "group.update": { group: 1, name: "Ground", sensors: [FRONT], sirens: "all", ifRevision: 0 },
  "group.delete": { group: 1, ifRevision: 0 },
  "mode.create": { name: "Night", groups: [] },
  "mode.update": { mode: 3, name: "Night", groups: [], ifRevision: 0 },
  "mode.delete": { mode: 3, ifRevision: 0 },
  "schedule.create": {
    name: "Night",
    action: "switchMode",
    target: { mode: 1 },
    at: "22:00",
    days: "everyDay",
    enabled: true,
  },
  "schedule.update": {
    schedule: 1,
    name: "Night",
    action: "switchMode",
    target: { mode: 1 },
    at: "22:00",
    days: "everyDay",
    enabled: true,
    ifRevision: 0,
  },
  "schedule.delete": { schedule: 1, ifRevision: 0 },
  "device.list": {},
  "device.show": { device: GARAGE },
  "device.rename": { device: GARAGE, name: "shed" },
  "device.remove": { device: GARAGE },
  "sensor.settings": { sensor: GARAGE, countdown: 20, replyRate: 3 },
  // A siren with no key in the test cipher would fault its seal, not its answer: a siren that is
  // not one is answered notFound by app, which is what this test needs of it.
  "siren.settings": { siren: 99, max: 120 },
  "siren.test": { siren: 99 },
  "gateway.settings": { gateway: 30, statusS: 10 },
  "usb.list": {},
  "usb.add": { port: "/dev/x", name: "new" },
  "usb.erase": { port: "/dev/x" },
  "site.show": {},
  "site.set": { countdown: 20 },
  "site.wifi": { name: "home", password: "secret" },
  "site.survey": {},
  "site.change": "cancel",
  "site.changeStatus": {},
  "history.query": { limit: 10 },
  "notifications.list": { limit: 10 },
  "notifications.read": { seqs: [1] },
  "notifications.prefs": { categories: [] },
  "people.list": {},
  "person.create": { name: "Cleo" },
  "person.rename": { person: 1, name: "Ann", ifRevision: 0 },
  "person.remove": { person: 1, ifRevision: 0 },
  "permissions.set": {
    person: 1,
    devices: [],
    manageUsers: true,
    manageSystem: true,
    ifRevision: 0,
  },
  "userManagement.set": { on: false },
  "clients.list": {},
  "client.rename": { client: 7, name: "Laptop" },
  "client.remove": { client: 8, also: [] },
  "link.create": { kind: { newPerson: {} }, form: "code" },
  "link.cancel": { token: 9 },
  pong: {},
  "backup.key": {},
  "backup.status": {},
  "backup.settings": { folder: "/backups" },
  "backup.now": {},
  "backup.export": { history: false },
  "restore.start": { job: 1 },
  "update.status": {},
  "update.upload": { job: 1 },
  "update.approve": {},
  "update.cancel": {},
  fileChunk: { job: 1, n: 0, data: "" },
};

/** What Ben (no permission at all but viewing the front door) may not do, so is refused. */
const REFUSED_TO_BEN: ReadonlySet<AppOpName> = new Set<AppOpName>([
  "hub.status",
  "mode.switch",
  "arm",
  "disarm",
  "group.create",
  "group.update",
  "group.delete",
  "mode.create",
  "mode.update",
  "mode.delete",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "device.show",
  "device.rename",
  "device.remove",
  "sensor.settings",
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
  "person.create",
  "person.rename",
  "person.remove",
  "permissions.set",
  "userManagement.set",
  "client.rename",
  "client.remove",
  "link.create",
  "backup.key",
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

function opOf(name: AppOpName): AppOp {
  const parsed = parseAppOp(name, BODIES[name]);
  expect([name, parsed.ok ? "ok" : parsed.issues]).toEqual([name, "ok"]);
  return parsed.ok ? parsed.value : { op: "pong", body: {} };
}

/** The answers a request got: replies on its connection, or the shell's effects for it. */
function answers(effects: readonly Effect[], conn: ConnId, id: number): readonly string[] {
  const replies = repliesTo(effects, conn)
    .filter((r) => r.id === id)
    .map((r) => (r.ok ? "ok" : r.error.code));
  const shell = effects.flatMap((e) =>
    (e.kind === "historyRead" || e.kind === "hubStatusRead") && e.conn === conn && e.id === id
      ? [e.kind]
      : [],
  );
  return [...replies, ...shell];
}

function household_(): Hub {
  const hub = new Hub(MODULES);
  hub.boot(
    household({
      userManagement: true,
      roles: [role(ANNA, true, true), role(BEN, false, false)],
      permissions: [permission(BEN, FRONT, false, true)],
    }),
  );
  return hub;
}

/** Console-only operations are refused as that first, whoever asks (section 6). */
const CONSOLE_FIRST: ReadonlySet<AppOpName> = new Set<AppOpName>([
  "site.wifi",
  "restore.start",
  "update.upload",
  "backup.settings",
]);

// The shell's own (`fileChunk`, and `pong`: liveness is the transport's) never reach the core.
const OPS = APP_OP_NAMES.filter((name) => OP_OWNERS[name] !== "shell" && name !== "pong");

describe("every request is answered exactly once (sections 5 and 7)", () => {
  test.each([...OPS])("%s, by the console", (name) => {
    const hub = household_();
    const conn = hub.connect(CONSOLE_CLIENT, "console");
    const { id, effects } = hub.request(conn, CONSOLE_CLIENT, opOf(name));
    // A file job is answered when the shell says it is done (`fileReady`, section 9).
    const later = effects.flatMap((e) =>
      e.kind === "fileJob"
        ? hub.input({
            kind: "fileReady",
            job: e.job,
            outcome: { kind: "failed", reason: "badFile", message: "not one" },
          })
        : [],
    );
    expect([name, answers([...effects, ...later], conn, id).length]).toEqual([name, 1]);
  });

  test.each([...OPS])("%s, by someone without the permission when it needs one", (name) => {
    const hub = household_();
    const conn = hub.connect(BEN_LAPTOP);
    const { id, effects } = hub.request(conn, BEN_LAPTOP, opOf(name));
    const got = answers(effects, conn, id);
    expect([name, got.length]).toEqual([name, 1]);
    if (REFUSED_TO_BEN.has(name))
      expect([name, got[0]]).toEqual([
        name,
        name.startsWith("usb.") || CONSOLE_FIRST.has(name) ? "consoleOnly" : "unauthorized",
      ]);
  });
});

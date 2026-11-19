/**
 * One scripted household day on the core, as version 1 sessions see it (docs/m3-m4-plan.md: "a
 * version 1 session receives byte-for-byte what it received before"): four version 1 sessions
 * (Anna's laptop, Anna's phone, Ben's laptop, the console) make every kind of request `app`
 * answers or routes, and receive the events of arming, devices, people, notifications, the
 * backup key and the hub. Every frame each version 1 session is sent is kept as the wire would
 * carry it: `versionGate(1, …)` as the shell applies it, then `JSON.stringify`.
 *
 * The scenario was recorded before channel version 2 was wired into `app`
 * (`fixtures/v1-frames.json`, written with `HSN_RECORD_V1_FRAMES=1`), and is replayed against
 * the code as it now is. `extra` adds sessions the recording did not have (a version 2 session
 * beside them): the version 1 frames must not change for it either.
 *
 * `notify` and `upkeep` are stand-ins here that raise what those modules raise (a notification,
 * the backup key's replacement, a staged update), so the recording does not move with their
 * owners' work beside this one.
 */
import { MODULES } from "../../../../src/core/step.ts";
import type { Effect } from "../../../../src/core/model/effects.ts";
import { type ClientId, type ConnId, seq } from "../../../../src/core/model/ids.ts";
import type { Internal } from "../../../../src/core/model/messages.ts";
import { versionGate } from "../../../../src/shell/app/channel.ts";
import {
  ANNA_LAPTOP,
  ANNA_PHONE,
  BEN_LAPTOP,
  CONSOLE_CLIENT,
  emitter,
  household,
  Hub,
  testModules,
  WALL_AT_START,
} from "../../people/support/hub.ts";

/** The recorded frames: for each step of the scenario, each version 1 session's frames in order. */
export interface RecordedStep {
  readonly step: string;
  readonly frames: readonly { readonly to: string; readonly json: string }[];
}

const NOTIFICATION = {
  seq: 2 ** 32 * 1 + 900,
  atMs: WALL_AT_START + 5_000,
  clockOk: true,
  kind: "armed_door_opened",
  category: "countdown",
  critical: false,
  device: 11,
  cause: null,
  read: false,
  delayed: false,
} as const;

function decision(kind: string, value: number | null): Internal {
  return {
    kind: "auditRecord",
    durability: "now",
    record: {
      kind: "decision",
      row: {
        seq: seq(2 ** 32 + 950 + (value ?? 0)),
        atMs: WALL_AT_START + 6_000,
        clockOk: true,
        kind: kind as never,
        deviceId: null,
        causeSeq: null,
        value,
        detail: null,
      },
    },
  };
}

/** What each module that stands in here raises, once, at the scenario's ticks. */
function standIns() {
  return testModules({
    layout: MODULES.layout,
    notify: emitter("notify", [
      {
        kind: "notificationRaised",
        notification: NOTIFICATION,
        clients: [ANNA_LAPTOP, ANNA_PHONE, CONSOLE_CLIENT, BEN_LAPTOP],
        happenedAtMs: WALL_AT_START + 4_000,
      },
    ]),
    upkeep: emitter("upkeep", [
      decision("backup_key_replaced", 3),
      decision("update_staged", null),
    ]),
  });
}

export interface ScenarioOptions {
  /** Sessions the recording did not have, opened after the version 1 ones (a version 2 session). */
  readonly extra?: (hub: Hub) => void;
}

/** Runs the scenario and gives what each version 1 session was sent, step by step. */
export function runV1Scenario(options: ScenarioOptions = {}): readonly RecordedStep[] {
  const hub = new Hub(standIns());
  const steps: RecordedStep[] = [];
  hub.boot(household());
  const sessions = new Map<ConnId, string>();
  const open = (client: ClientId, name: string, listener: "lan" | "console" = "lan"): ConnId => {
    const conn = hub.connect(client, listener);
    sessions.set(conn, name);
    return conn;
  };
  const anna = open(ANNA_LAPTOP, "anna");
  const phone = open(ANNA_PHONE, "phone");
  const ben = open(BEN_LAPTOP, "ben");
  const console = open(CONSOLE_CLIENT, "console", "console");
  options.extra?.(hub);

  const keep = (step: string, effects: readonly Effect[]): void => {
    const frames: { to: string; json: string }[] = [];
    for (const effect of effects) {
      if (effect.kind !== "appSend") continue;
      const to = sessions.get(effect.conn);
      if (to === undefined) continue;
      const wire = versionGate(1, effect.message);
      if (wire !== undefined) frames.push({ to, json: JSON.stringify(wire) });
    }
    steps.push({ step, frames });
  };
  const ask = (step: string, conn: ConnId, client: ClientId, op: Parameters<Hub["request"]>[2]) => {
    keep(step, hub.request(conn, client, op).effects);
  };

  const all = ["arming", "devices", "alarm", "notifications", "history", "config", "people", "hub"];
  for (const [conn, client] of [
    [anna, ANNA_LAPTOP],
    [phone, ANNA_PHONE],
    [ben, BEN_LAPTOP],
    [console, CONSOLE_CLIENT],
  ] as const) {
    const who = sessions.get(conn) ?? "";
    ask(`${who} subscribe`, conn, client, { op: "subscribe", body: { topics: all as never } });
    ask(`${who} snapshot`, conn, client, { op: "snapshot", body: {} });
    ask(`${who} hub.info`, conn, client, { op: "hub.info", body: {} });
    ask(`${who} device.list`, conn, client, { op: "device.list", body: {} });
  }
  ask("anna device.show", anna, ANNA_LAPTOP, { op: "device.show", body: { device: 11 } });
  ask("anna device.show missing", anna, ANNA_LAPTOP, { op: "device.show", body: { device: 77 } });
  ask("anna site.show", anna, ANNA_LAPTOP, { op: "site.show", body: {} });
  ask("anna people.list", anna, ANNA_LAPTOP, { op: "people.list", body: {} });
  ask("anna clients.list", anna, ANNA_LAPTOP, { op: "clients.list", body: {} });
  ask("anna notifications.list", anna, ANNA_LAPTOP, {
    op: "notifications.list",
    body: { limit: 10 },
  });
  ask("anna device.rename", anna, ANNA_LAPTOP, {
    op: "device.rename",
    body: { device: 11, name: "front-door" },
  });
  ask("anna device.rename taken", anna, ANNA_LAPTOP, {
    op: "device.rename",
    body: { device: 12, name: "front-door" },
  });
  ask("anna site.wifi on the home network", anna, ANNA_LAPTOP, {
    op: "site.wifi",
    body: { name: "home", password: "a new password" },
  });
  ask("console site.wifi", console, CONSOLE_CLIENT, {
    op: "site.wifi",
    body: { name: "home-2", password: "another password" },
  });
  ask("anna backup.key from a laptop", anna, ANNA_LAPTOP, { op: "backup.key", body: {} });
  ask("phone backup.key", phone, ANNA_PHONE, { op: "backup.key", body: {} });
  ask("anna arm front", anna, ANNA_LAPTOP, {
    op: "arm",
    body: { target: { sensor: 11 } },
  });
  ask("ben mode.switch away", ben, BEN_LAPTOP, { op: "mode.switch", body: { mode: 1 } });
  ask("ben disarm mine", ben, BEN_LAPTOP, { op: "disarm", body: { target: "mine" } });
  ask("anna group.create", anna, ANNA_LAPTOP, {
    op: "group.create",
    body: { name: "Downstairs", sensors: [11, 12], sirens: "all" },
  });
  ask("anna link.create", anna, ANNA_LAPTOP, {
    op: "link.create",
    body: { kind: "ownDevice", form: "qr" },
  });
  ask("anna client.rename", anna, ANNA_LAPTOP, {
    op: "client.rename",
    body: { client: 7, name: "Anna's laptop" },
  });
  ask("console usb.list", console, CONSOLE_CLIENT, { op: "usb.list", body: {} });
  ask("anna usb.list on the home network", anna, ANNA_LAPTOP, { op: "usb.list", body: {} });
  ask("console device.remove", console, CONSOLE_CLIENT, {
    op: "device.remove",
    body: { device: 12 },
  });
  keep("the stand-ins raise a notification, the key's replacement and an update", hub.advance(10));
  ask("anna snapshot again", anna, ANNA_LAPTOP, { op: "snapshot", body: {} });
  return steps;
}

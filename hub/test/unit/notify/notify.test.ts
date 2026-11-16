/**
 * The notify module (m2-design.md section 7, "Notifications"; section 3, durability): the table
 * row by row, recipients from `people`'s view, categories per client, critical ones written now
 * and the rest routine, no flood, one notice per action from its summary, `notificationRaised`
 * for `app`, unread across a restart, and the three operations.
 */
import { describe, expect, test } from "bun:test";
import { categoryBit, type NotificationObject } from "@hsn/protocol/app";
import { DECISION_KINDS, type DecisionKind } from "../../../src/core/model/decisions.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import {
  type ClientId,
  clientId,
  connId,
  type DeviceId,
  deviceId,
  type PersonId,
  personId,
  type Seq,
} from "../../../src/core/model/ids.ts";
import type { Actor, AnswerTo, Internal } from "../../../src/core/model/messages.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  ClientKind,
  type ClientRow,
  type NotificationRow,
  type PermissionRow,
} from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import type { Durability } from "../../../src/core/model/store.ts";
import { clientsFor } from "../../../src/core/notify/audience.ts";
import { handleNotify, recipientBytes, recipientsOf } from "../../../src/core/notify/handle.ts";
import {
  type Classified,
  classifyDecision,
  floodExempt,
  scheduleWarnings,
} from "../../../src/core/notify/table.ts";
import { unreadFor } from "../../../src/core/notify/view.ts";
import {
  boot,
  GATEWAY,
  MINUTE_US,
  rec,
  Runner,
  SECOND_US,
  SENSOR,
  SENSOR2,
  SIREN,
  snapshotWith,
  viewWith,
  WALL0,
} from "../health/support.ts";

const ANNA = personId(1);
const BEN = personId(2);
const ANNA_LAPTOP = clientId(11);
const ANNA_PHONE = clientId(12);
const BEN_LAPTOP = clientId(21);
const CONSOLE = clientId(1);

function client(id: ClientId, person: PersonId | null): ClientRow {
  return {
    id,
    personId: person,
    staticKey: new Uint8Array(32),
    kind: person === null ? ClientKind.Console : ClientKind.Web,
    name: `c${id}`,
    linkedByClient: null,
    createdMs: 0,
    removedMs: null,
    lastSeq: 0,
    lastSeenMs: null,
    backupKeyEpoch: null,
  };
}

interface Home {
  readonly userManagement?: boolean;
  readonly armed?: readonly DeviceId[];
  readonly prefs?: readonly { client: ClientId; categories: number }[];
  readonly notifications?: readonly NotificationRow[];
  readonly reads?: readonly { notificationSeq: Seq; clientId: ClientId }[];
}

/** Anna may manage SENSOR and SENSOR2 (but view only through manage on SENSOR2) and has manage system; Ben may view SENSOR2. */
function peopleView(home: Home): HubState {
  const base = viewWith(home.armed ?? []);
  const permission = (p: PersonId, d: DeviceId, manage: boolean, view: boolean): PermissionRow => ({
    personId: p,
    deviceId: d,
    manage,
    view,
  });
  return {
    ...base,
    people: {
      ...base.people,
      userManagement: home.userManagement ?? false,
      people: new Map(
        [ANNA, BEN].map((id) => [
          id,
          { id, name: `p${id}`, createdMs: 0, removedMs: null, revision: 1 },
        ]),
      ),
      clients: new Map(
        [
          client(CONSOLE, null),
          client(ANNA_LAPTOP, ANNA),
          client(ANNA_PHONE, ANNA),
          client(BEN_LAPTOP, BEN),
        ].map((row) => [row.id, row]),
      ),
      roles: new Map([
        [ANNA, { personId: ANNA, manageUsers: true, manageSystem: true, revision: 1 }],
        [BEN, { personId: BEN, manageUsers: false, manageSystem: false, revision: 1 }],
      ]),
      permissions: new Map([
        [
          ANNA,
          new Map([
            [SENSOR, permission(ANNA, SENSOR, true, true)],
            [SENSOR2, permission(ANNA, SENSOR2, true, false)],
          ]),
        ],
        [BEN, new Map([[SENSOR2, permission(BEN, SENSOR2, false, true)]])],
      ]),
    },
  };
}

function notify(home: Home = {}): Runner<"notify"> {
  const runner = new Runner("notify", handleNotify, peopleView(home));
  runner.run(
    boot(
      snapshotWith({
        notificationPrefs: (home.prefs ?? []).map((p) => ({
          clientId: p.client,
          categories: p.categories,
          revision: 1,
        })),
        notifications: home.notifications ?? [],
        notificationReads: (home.reads ?? []).map((r, i) => ({
          seq: rec(800 + i),
          atMs: WALL0,
          clockOk: true,
          notificationSeq: r.notificationSeq,
          clientId: r.clientId,
        })),
      }),
    ),
  );
  return runner;
}

let n = 0;

function decisionRecord(
  kind: DecisionKind,
  options: {
    readonly device?: DeviceId | null;
    readonly value?: number | null;
    readonly detail?: Uint8Array | null;
    readonly durability?: Durability;
  } = {},
): Internal {
  n += 1;
  return {
    kind: "auditRecord",
    durability: options.durability ?? "now",
    record: {
      kind: "decision",
      row: {
        seq: rec(500_000 + n),
        atMs: 0,
        clockOk: true,
        kind,
        deviceId: options.device === undefined ? SENSOR : options.device,
        causeSeq: null,
        value: options.value ?? null,
        detail: options.detail ?? null,
      },
    },
  };
}

function notifications(out: readonly (Internal | Effect)[]) {
  return out.flatMap((item) =>
    item.kind === "auditRecord" && item.record.kind === "notification"
      ? [{ durability: item.durability, row: item.record.row }]
      : [],
  );
}

function raised(out: readonly (Internal | Effect)[]) {
  return out.flatMap((item) =>
    item.kind === "notificationRaised"
      ? [{ notification: item.notification, clients: item.clients }]
      : [],
  );
}

function clientsTold(out: readonly (Internal | Effect)[]): readonly ClientId[] {
  return raised(out)[0]?.clients ?? [];
}

function recipientsIn(out: readonly (Internal | Effect)[]): readonly PersonId[] {
  const row = notifications(out)[0]?.row;
  return row === undefined ? [] : recipientsOf(row);
}

const FACTS_DISARMED = { armed: () => false, anyArmed: false, switchChanges: () => [] };
const FACTS_ARMED = { armed: () => true, anyArmed: true, switchChanges: () => [] };

const ANSWER: AnswerTo = {
  kind: "app",
  conn: connId(9),
  client: ANNA_LAPTOP,
  id: 1,
  seq: undefined,
};

function op(name: string, body: unknown, person: PersonId, c: ClientId): Internal {
  const actor: Actor = { kind: "person", person, client: c, name: `p${person} (client ${c})` };
  return {
    kind: "opRequest",
    owner: "notify",
    op: { op: name, body } as Extract<Internal, { kind: "opRequest" }>["op"],
    actor,
    answerTo: ANSWER,
    record: rec(1),
  };
}

describe("the table (section 7)", () => {
  const cases: readonly [DecisionKind, string, boolean, boolean][] = [
    // kind, category, critical (disarmed facts, no value), cannot be turned off
    ["countdown_started", "countdown", true, true],
    ["alarm", "alarm", true, true],
    ["late_report_sirens", "alarm", true, true],
    ["late_report_notification", "alarm", true, true],
    ["local_alarm_reported", "localAlarm", false, true],
    ["tamper_opened", "tamper", false, true],
    ["long_press_ignored", "longPress", false, true],
    ["sensor_silent", "sensorSilentWhileDisarmed", false, false],
    ["siren_silent", "sirenSilent", false, true],
    ["siren_wifi_lost", "sirenPathLost", false, false],
    ["siren_lora_lost", "sirenPathLost", false, false],
    ["gateway_offline", "gatewayOffline", false, false],
    ["interference_started", "jamming", false, true],
    ["noise_interference_started", "jamming", false, true],
    ["interference_learned_as_normal", "jamming", false, true],
    ["battery_low", "batteryLow", false, false],
    ["mode_switched", "armDisarm", false, false],
    ["arming_changed", "armDisarm", false, false],
    ["door_state_unexpected", "stateUnexpected", false, true],
    ["cover_state_unexpected", "stateUnexpected", false, true],
    ["schedules_waiting_for_clock", "scheduleMissedOrHeldBack", false, true],
    ["schedule_missed", "scheduleMissedOrHeldBack", false, true],
    ["schedule_held_back", "scheduleMissedOrHeldBack", false, true],
    ["update_staged", "updates", false, false],
    ["update_healthy", "updates", false, false],
    ["update_rolled_back", "hub", false, true],
    ["restored", "hub", false, true],
    ["backup_no_folder", "backup", false, true],
    ["backup_overdue", "backup", false, true],
    ["backup_key_replaced", "backup", false, true],
    ["backup_folder_on_data_disk", "backup", false, true],
  ];

  test.each(cases)(
    "%s: %s, critical %p, cannot be turned off %p",
    (kind, category, critical, mandatory) => {
      expect(classifyDecision(kind, SENSOR, null, null, FACTS_DISARMED)).toMatchObject({
        category,
        critical,
        mandatory,
      });
    },
  );

  test("while armed: tamper, silence, jamming and an unexpected door are critical; a cover never", () => {
    expect(classifyDecision("tamper_opened", SENSOR, null, null, FACTS_ARMED)?.critical).toBe(true);
    expect(classifyDecision("sensor_silent", SENSOR, null, null, FACTS_ARMED)).toMatchObject({
      category: "sensorSilentWhileArmed",
      critical: true,
      mandatory: true,
    });
    expect(
      classifyDecision("interference_started", GATEWAY, null, null, FACTS_ARMED)?.critical,
    ).toBe(true);
    expect(
      classifyDecision("door_state_unexpected", SENSOR, null, null, FACTS_ARMED)?.critical,
    ).toBe(true);
    expect(classifyDecision("cover_state_unexpected", SENSOR, 1, null, FACTS_ARMED)?.critical).toBe(
      false,
    );
  });

  test("siren_silent is critical only while a sensor is armed: its value 1 (HD 8)", () => {
    expect(classifyDecision("siren_silent", SIREN, 1, null, FACTS_DISARMED)?.critical).toBe(true);
    expect(classifyDecision("siren_silent", SIREN, null, null, FACTS_ARMED)?.critical).toBe(false);
  });

  test("gateway_offline cannot be turned off while a sensor only it hears is armed (D97)", () => {
    const detail = recipientBytes([SENSOR2]);
    const armed = { ...FACTS_ARMED, armed: (s: DeviceId) => s === SENSOR2 };
    expect(classifyDecision("gateway_offline", GATEWAY, 1, detail, armed)?.mandatory).toBe(true);
    const other = { ...FACTS_ARMED, armed: (s: DeviceId) => s === SENSOR };
    expect(classifyDecision("gateway_offline", GATEWAY, 1, detail, other)?.mandatory).toBe(false);
  });

  test("a schedule's run is told only for its warnings: a door left waiting or a low battery", () => {
    const detail = (lists: readonly (readonly number[])[]) => {
      const bytes: number[] = [0, 0];
      for (const list of lists) {
        bytes.push(list.length & 0xff, list.length >> 8);
        for (const d of list) bytes.push(d & 0xff, (d >> 8) & 0xff, 0, 0);
      }
      return Uint8Array.from(bytes);
    };
    expect(scheduleWarnings(detail([[3, 4], [], [], []]))).toEqual([]);
    expect(
      classifyDecision("schedule_ran", null, 1, detail([[3, 4], [], [], []]), FACTS_DISARMED),
    ).toBeUndefined();
    const warned = classifyDecision(
      "schedule_ran",
      null,
      1,
      detail([[3], [], [4], [3]]),
      FACTS_DISARMED,
    );
    expect(warned).toMatchObject({ category: "armDisarm" });
    expect(warned?.sensors).toEqual([deviceId(4), deviceId(3)]);
  });

  test("never from the per-sensor armed and disarmed; nothing for a door while disarmed (D46)", () => {
    const listed = new Set<string>([...cases.map((c) => c[0]), "schedule_ran"]);
    for (const kind of DECISION_KINDS.filter((k) => !listed.has(k))) {
      expect(
        classifyDecision(kind, SENSOR, 1, Uint8Array.of(1, 0, 0, 0), FACTS_ARMED),
      ).toBeUndefined();
    }
    const runner = notify();
    expect(runner.run(decisionRecord("report_while_disarmed"))).toEqual([]);
    expect(runner.run(decisionRecord("armed", { detail: Uint8Array.of(65) }))).toEqual([]);
    expect(runner.run(decisionRecord("disarmed", { detail: Uint8Array.of(65) }))).toEqual([]);
  });
});

describe("recipients from people's view (D69, D76, HB5a)", () => {
  test("with user management off, every person (D13), and every one of their clients and the console", () => {
    const out = notify().run(decisionRecord("battery_low", { device: SENSOR }));
    expect(recipientsIn(out)).toEqual([ANNA, BEN]);
    expect(clientsTold(out)).toEqual([CONSOLE, ANNA_LAPTOP, ANNA_PHONE, BEN_LAPTOP]);
  });

  test("with it on: those who may view the sensor; manage includes view", () => {
    const runner = notify({ userManagement: true });
    const one = runner.run(decisionRecord("battery_low", { device: SENSOR }));
    expect(recipientsIn(one)).toEqual([ANNA]);
    expect(clientsTold(one)).toEqual([CONSOLE, ANNA_LAPTOP, ANNA_PHONE]);
    expect(recipientsIn(runner.run(decisionRecord("battery_low", { device: SENSOR2 })))).toEqual([
      ANNA,
      BEN,
    ]);
  });

  test("a siren or gateway: every person; the hub as a whole: manage system", () => {
    const runner = notify({ userManagement: true });
    expect(recipientsIn(runner.run(decisionRecord("siren_wifi_lost", { device: SIREN })))).toEqual([
      ANNA,
      BEN,
    ]);
    expect(recipientsIn(runner.run(decisionRecord("backup_no_folder", { device: null })))).toEqual([
      ANNA,
    ]);
    expect(recipientsIn(runner.run(decisionRecord("backup_overdue", { device: null })))).toEqual([
      ANNA,
    ]);
  });

  test("an action: the viewers of any sensor it changes", () => {
    const runner = notify({ userManagement: true });
    const onlySensor = runner.run(
      decisionRecord("arming_changed", { device: null, detail: recipientBytes([SENSOR]) }),
    );
    expect(recipientsIn(onlySensor)).toEqual([ANNA]);
    const both = runner.run(
      decisionRecord("arming_changed", { device: null, detail: recipientBytes([SENSOR, SENSOR2]) }),
    );
    expect(recipientsIn(both)).toEqual([ANNA, BEN]);
    expect(notifications(both)[0]?.row.category).toBe("armDisarm");
  });

  test("the object `app` sends: section 7's fields, unread, not delayed", () => {
    const out = notify().run(decisionRecord("countdown_started"));
    const object: NotificationObject | undefined = raised(out)[0]?.notification;
    expect(object).toMatchObject({
      kind: "countdown_started",
      category: "countdown",
      critical: true,
      device: SENSOR,
      read: false,
      delayed: false,
    });
    expect(object?.seq).toBe(notifications(out)[0]?.row.seq);
  });
});

describe("removed people and clients are never recipients", () => {
  test("a removed console, a removed person and a removed client get nothing; the live ones do", () => {
    const base = peopleView({});
    const OLD_CONSOLE = clientId(2);
    const BEN_PHONE = clientId(22);
    const removed = { removedMs: WALL0 };
    const view: HubState = {
      ...base,
      people: {
        ...base.people,
        people: new Map(base.people.people).set(BEN, {
          id: BEN,
          name: "pBen",
          createdMs: 0,
          removedMs: WALL0,
          revision: 2,
        }),
        clients: new Map(base.people.clients)
          .set(OLD_CONSOLE, { ...client(OLD_CONSOLE, null), ...removed })
          .set(ANNA_PHONE, { ...client(ANNA_PHONE, ANNA), ...removed })
          // A removed person's client not yet marked removed: still not a recipient.
          .set(BEN_PHONE, client(BEN_PHONE, BEN)),
      },
    };
    const runner = new Runner("notify", handleNotify, view);
    runner.run(boot(snapshotWith()));
    for (const record of [
      decisionRecord("battery_low", { device: SENSOR }),
      decisionRecord("siren_wifi_lost", { device: SIREN }),
      decisionRecord("backup_overdue", { device: null }),
      decisionRecord("arming_changed", { device: null, detail: recipientBytes([SENSOR, SENSOR2]) }),
    ]) {
      const out = runner.run(record);
      expect(recipientsIn(out)).toEqual([ANNA]);
      expect(clientsTold(out)).toEqual([CONSOLE, ANNA_LAPTOP]);
    }
    // A new client of a removed person is told to no client of theirs, only the live console.
    const linked = runner.run({ kind: "clientAdded", client: clientId(23), person: BEN });
    expect(recipientsIn(linked)).toEqual([]);
    // Asked directly for a removed person's clients, `clientsFor` gives only the live console.
    expect(clientsFor(view, [BEN, ANNA])).toEqual([CONSOLE, ANNA_LAPTOP]);
    expect(clientsTold(linked)).toEqual([CONSOLE]);
  });
});

describe("durability (section 3, section 7)", () => {
  test("a critical notification is written now, whatever its decision's class", () => {
    const runner = notify();
    expect(notifications(runner.run(decisionRecord("countdown_started")))[0]?.durability).toBe(
      "now",
    );
    expect(
      notifications(runner.run(decisionRecord("alarm", { durability: "routine" })))[0]?.durability,
    ).toBe("now");
  });

  test("every other notification is routine, though its decision is now", () => {
    const runner = notify();
    for (const kind of ["battery_low", "tamper_opened", "local_alarm_reported"] as const) {
      expect(
        notifications(runner.run(decisionRecord(kind, { device: SENSOR2 }))).map(
          (r) => r.durability,
        ),
      ).toEqual(["routine"]);
    }
  });

  test("reads are routine records, answered at once, with no write", () => {
    const runner = notify();
    const seq = notifications(runner.run(decisionRecord("battery_low")))[0]?.row.seq ?? 0;
    const out = runner.run(op("notifications.read", { seqs: [seq] }, ANNA, ANNA_LAPTOP));
    expect(out.filter((o) => o.kind === "write")).toEqual([]);
    expect(out[0]).toMatchObject({
      kind: "auditRecord",
      durability: "routine",
      record: { kind: "notificationRead" },
    });
    expect(out[1]).toEqual({ kind: "opAnswer", answerTo: ANSWER, outcome: { ok: true, body: {} } });
  });
});

describe("no flood (section 7)", () => {
  test("the same kind about the same device at most once every 10 minutes", () => {
    const runner = notify();
    expect(
      notifications(runner.run(decisionRecord("siren_wifi_lost", { device: SIREN }))),
    ).toHaveLength(1);
    runner.at(9 * MINUTE_US);
    expect(runner.run(decisionRecord("siren_wifi_lost", { device: SIREN }))).toEqual([]);
    expect(
      notifications(runner.run(decisionRecord("siren_lora_lost", { device: SIREN }))),
    ).toHaveLength(1);
    expect(
      notifications(runner.run(decisionRecord("siren_wifi_lost", { device: GATEWAY }))),
    ).toHaveLength(1);
    runner.at(10 * MINUTE_US);
    expect(
      notifications(runner.run(decisionRecord("siren_wifi_lost", { device: SIREN }))),
    ).toHaveLength(1);
  });

  test("a failing disk is told once every 10 minutes, not at every retry", () => {
    const runner = notify();
    const failed = (s: number): Internal => ({
      kind: "auditRecord",
      durability: "now",
      record: {
        kind: "hubEvent",
        row: {
          seq: rec(700 + s),
          atMs: 0,
          clockOk: true,
          level: "critical",
          origin: "shell/storage/writer",
          code: "commit_failed",
          message: "",
          detail: null,
        },
      },
    });
    expect(notifications(runner.run(failed(1))).map((r) => r.row.category)).toEqual(["disk"]);
    runner.at(10 * SECOND_US);
    expect(runner.run(failed(2))).toEqual([]);
  });

  test("critical notices are each told: a second cover opening while armed", () => {
    const runner = notify({ armed: [SENSOR] });
    for (let i = 0; i < 3; i++) {
      expect(notifications(runner.run(decisionRecord("tamper_opened")))).toHaveLength(1);
      expect(notifications(runner.run(decisionRecord("countdown_started")))).toHaveLength(1);
    }
    const disarmed = notify();
    expect(notifications(disarmed.run(decisionRecord("tamper_opened")))).toHaveLength(1);
    expect(disarmed.run(decisionRecord("tamper_opened"))).toEqual([]);
  });

  test("people's, schedules', new clients' and the hub's are exempt", () => {
    const exempt = (category: Classified["category"]) =>
      floodExempt({ category, critical: false, mandatory: true, sensors: undefined });
    expect(
      ["armDisarm", "scheduleMissedOrHeldBack", "newClient", "hub"].every((c) =>
        exempt(c as Classified["category"]),
      ),
    ).toBe(true);
    expect(exempt("tamper")).toBe(false);
    const runner = notify();
    for (let i = 0; i < 2; i++) {
      expect(
        notifications(runner.run(decisionRecord("mode_switched", { device: null, value: 1 }))),
      ).toHaveLength(1);
      expect(notifications(runner.run(decisionRecord("restored", { device: null })))).toHaveLength(
        1,
      );
    }
  });
});

describe("categories per client (D69, D75, AP9a)", () => {
  const OFF = 0;
  test("an optional category turned off leaves that client out; the others are still told", () => {
    const runner = notify({ prefs: [{ client: ANNA_LAPTOP, categories: OFF }] });
    expect(clientsTold(runner.run(decisionRecord("battery_low")))).toEqual([
      CONSOLE,
      ANNA_PHONE,
      BEN_LAPTOP,
    ]);
  });

  test("what cannot be turned off goes whatever the categories say", () => {
    const runner = notify({ prefs: [{ client: ANNA_LAPTOP, categories: OFF }] });
    expect(clientsTold(runner.run(decisionRecord("tamper_opened")))).toContain(ANNA_LAPTOP);
    expect(
      clientsTold(runner.run(decisionRecord("sensor_silent", { device: SENSOR2 }))),
    ).not.toContain(ANNA_LAPTOP);
  });

  test("gateway offline with an armed sensor only it hears goes through gatewayOffline off (D97)", () => {
    const runner = notify({ armed: [SENSOR2], prefs: [{ client: ANNA_LAPTOP, categories: OFF }] });
    const out = runner.run(
      decisionRecord("gateway_offline", { device: GATEWAY, detail: recipientBytes([SENSOR2]) }),
    );
    expect(clientsTold(out)).toContain(ANNA_LAPTOP);
  });

  test("notifications.prefs writes the client's row now and answers with it", () => {
    const runner = notify();
    const out = runner.run(
      op("notifications.prefs", { categories: ["batteryLow", "sirenPathLost"] }, ANNA, ANNA_LAPTOP),
    );
    expect(out).toEqual([
      {
        kind: "write",
        durability: "now",
        op: {
          table: "notification_prefs",
          op: "upsert",
          row: {
            clientId: ANNA_LAPTOP,
            categories: categoryBit("batteryLow") | categoryBit("sirenPathLost"),
            revision: 1,
          },
        },
      },
      {
        kind: "opAnswer",
        answerTo: ANSWER,
        outcome: { ok: true, body: { categories: ["sirenPathLost", "batteryLow"], revision: 1 } },
      },
    ]);
    expect(
      clientsTold(runner.run(decisionRecord("update_staged", { device: null }))),
    ).not.toContain(ANNA_LAPTOP);
  });

  test("a removed client's row is deleted", () => {
    const runner = notify({ prefs: [{ client: ANNA_LAPTOP, categories: OFF }] });
    expect(runner.run({ kind: "clientRemoved", client: ANNA_LAPTOP })).toEqual([
      {
        kind: "write",
        durability: "now",
        op: { table: "notification_prefs", op: "delete", key: { clientId: ANNA_LAPTOP } },
      },
    ]);
  });
});

describe("unread, delayed and a restart (section 7, D102)", () => {
  function viewOf(runner: Runner<"notify">): HubState {
    return { ...runner.view, notify: runner.slice };
  }

  test("a person's unread of the last 7 days, read when any client of theirs read it", () => {
    const runner = notify();
    const first = notifications(runner.run(decisionRecord("battery_low")))[0]?.row.seq ?? 0;
    runner.at(30 * SECOND_US);
    runner.run(decisionRecord("tamper_opened"));
    const now = WALL0 + 61_000;
    expect(
      unreadFor(viewOf(runner), ANNA, WALL0, DEFAULT_RULES, now).map((o) => [o.kind, o.delayed]),
    ).toEqual([
      ["battery_low", true],
      ["tamper_opened", false],
    ]);
    runner.run(op("notifications.read", { seqs: [first] }, ANNA, ANNA_PHONE));
    expect(unreadFor(viewOf(runner), ANNA, WALL0).map((o) => o.kind)).toEqual(["tamper_opened"]);
    expect(unreadFor(viewOf(runner), BEN, WALL0).map((o) => o.kind)).toEqual([
      "battery_low",
      "tamper_opened",
    ]);
    expect(unreadFor(viewOf(runner), ANNA, WALL0 + 31_000)).toEqual([]);
  });

  test("older than 7 days is dropped as new ones come", () => {
    const runner = notify();
    runner.run(decisionRecord("battery_low"));
    runner.at(7 * 24 * 60 * MINUTE_US + SECOND_US);
    runner.run(decisionRecord("tamper_opened"));
    expect(runner.slice.notifications.map((r) => r.row.kind)).toEqual(["tamper_opened"]);
  });

  test("across a restart: the snapshot's notifications and reads give the same unread", () => {
    const before = notify();
    const rows = [
      notifications(before.run(decisionRecord("battery_low")))[0]?.row,
      notifications(before.run(decisionRecord("tamper_opened")))[0]?.row,
    ].filter((r): r is NotificationRow => r !== undefined);
    before.run(op("notifications.read", { seqs: [rows[0]?.seq ?? 0] }, ANNA, ANNA_LAPTOP));
    const reads = before.out.flatMap((o) =>
      o.kind === "auditRecord" && o.record.kind === "notificationRead" ? [o.record.row] : [],
    );
    const after = notify({ notifications: rows, reads });
    const viewAfter = { ...after.view, notify: after.slice };
    expect(unreadFor(viewAfter, ANNA, WALL0).map((o) => o.kind)).toEqual(["tamper_opened"]);
    expect(unreadFor(viewAfter, BEN, WALL0).map((o) => o.kind)).toEqual([
      "battery_low",
      "tamper_opened",
    ]);
    // A read before the restart is not recorded again.
    expect(
      after
        .run(op("notifications.read", { seqs: [rows[0]?.seq ?? 0] }, ANNA, ANNA_LAPTOP))
        .filter((o) => o.kind === "auditRecord"),
    ).toEqual([]);
  });
});

describe("what is raised before any session: a restore, a healthy update, a rollback (section 5, 7)", () => {
  test("waits unread for the first session, across a restart, and is not given twice", () => {
    const before = notify({ userManagement: true });
    const kinds = ["restored", "update_healthy", "update_rolled_back"] as const;
    const rows = kinds.flatMap((kind) =>
      notifications(before.run(decisionRecord(kind, { device: null, durability: "now" }))).map(
        (r) => r.row,
      ),
    );
    expect(rows.map((r) => [r.kind, r.category, r.critical])).toEqual([
      ["restored", "hub", false],
      ["update_healthy", "updates", false],
      ["update_rolled_back", "hub", false],
    ]);
    // To manage system only: Anna, not Ben.
    expect(rows.map((r) => recipientsOf(r))).toEqual([[ANNA], [ANNA], [ANNA]]);
    const kindsFor = (runner: Runner<"notify">, person: PersonId) =>
      unreadFor({ ...runner.view, notify: runner.slice }, person, WALL0).map((o) => o.kind);
    expect(kindsFor(before, ANNA)).toEqual([...kinds]);
    expect(kindsFor(before, BEN)).toEqual([]);
    // A restart before anyone connects: the snapshot brings them back, still unread.
    const after = notify({ userManagement: true, notifications: rows });
    expect(kindsFor(after, ANNA)).toEqual([...kinds]);
    // The first session's client reads them: not given again, nor after another restart.
    const read = after.run(
      op("notifications.read", { seqs: rows.map((r) => r.seq) }, ANNA, ANNA_LAPTOP),
    );
    const reads = read.flatMap((o) =>
      o.kind === "auditRecord" && o.record.kind === "notificationRead" ? [o.record.row] : [],
    );
    expect(reads).toHaveLength(3);
    expect(kindsFor(after, ANNA)).toEqual([]);
    const again = notify({ userManagement: true, notifications: rows, reads });
    expect(kindsFor(again, ANNA)).toEqual([]);
  });
});

describe('a restore waiting (section 9, "A swap that did not happen")', () => {
  let k = 0;
  const waiting = (reason: string): Internal => {
    k += 1;
    return {
      kind: "auditRecord",
      durability: "now",
      record: {
        kind: "hubEvent",
        row: {
          seq: rec(900 + k),
          atMs: 0,
          clockOk: true,
          level: "critical",
          origin: "shell",
          code: "restore_waiting",
          message: "a restore is waiting and could not be put in place",
          detail: JSON.stringify({ reason }),
        },
      },
    };
  };
  const unreadKinds = (runner: Runner<"notify">) =>
    unreadFor({ ...runner.view, notify: runner.slice }, ANNA, WALL0).map((o) => o.kind);

  test("one critical notification, written now, to manage system, with the reason", () => {
    const runner = notify({
      userManagement: true,
      prefs: [{ client: ANNA_LAPTOP, categories: 0 }],
    });
    const out = runner.run(waiting("walInUse"));
    const rows = notifications(out);
    expect(rows.map((r) => [r.row.kind, r.row.category, r.row.critical, r.durability])).toEqual([
      ["restore_waiting", "hub", true, "now"],
    ]);
    expect(recipientsIn(out)).toEqual([ANNA]);
    // Not to be turned off: every client of Anna's and the console, none of Ben's.
    expect(clientsTold(out)).toEqual([CONSOLE, ANNA_LAPTOP, ANNA_PHONE]);
    expect(new TextDecoder().decode(rows[0]?.row.detail ?? new Uint8Array())).toBe(
      JSON.stringify({ reason: "walInUse" }),
    );
  });

  test("refused again at a later start: one more, so one per start; gone once the restore is in", () => {
    const first = notify({ userManagement: true });
    const rows = notifications(first.run(waiting("walInUse"))).map((r) => r.row);
    // The next start, on the old database: its snapshot brings the first back, and the shell's
    // warning raises the start's own.
    const second = notify({ userManagement: true, notifications: rows });
    const again = notifications(second.run(waiting("walInUse")));
    expect(again).toHaveLength(1);
    expect(unreadKinds(second)).toEqual(["restore_waiting", "restore_waiting"]);
    // The swap goes in: the start is on the restored database, whose notifications are its own
    // (a backup holds no history), and `restored` is recorded.
    const restored = notify({ userManagement: true });
    notifications(restored.run(decisionRecord("restored", { device: null })));
    expect(unreadKinds(restored)).toEqual(["restored"]);
  });
});

describe("operations", () => {
  test("notifications.read marks once; a notification not the person's is notFound", () => {
    const runner = notify({ userManagement: true });
    const seq =
      notifications(runner.run(decisionRecord("battery_low", { device: SENSOR })))[0]?.row.seq ?? 0;
    const read = runner.run(op("notifications.read", { seqs: [seq, seq] }, ANNA, ANNA_LAPTOP));
    expect(read.filter((o) => o.kind === "auditRecord")).toHaveLength(1);
    expect(runner.run(op("notifications.read", { seqs: [seq] }, ANNA, ANNA_LAPTOP))).toEqual([
      { kind: "opAnswer", answerTo: ANSWER, outcome: { ok: true, body: {} } },
    ]);
    expect(runner.run(op("notifications.read", { seqs: [seq] }, BEN, BEN_LAPTOP))).toEqual([
      {
        kind: "opAnswer",
        answerTo: ANSWER,
        outcome: {
          ok: false,
          error: { code: "notFound", detail: { what: "notification", id: seq } },
        },
      },
    ]);
  });

  test("notifications.list: the person's, newest first, before and limit", () => {
    const runner = notify();
    const seqs = (["battery_low", "tamper_opened", "local_alarm_reported"] as const).map(
      (kind) => notifications(runner.run(decisionRecord(kind)))[0]?.row.seq ?? 0,
    );
    const answerOf = (out: readonly (Internal | Effect)[]) =>
      out[0]?.kind === "opAnswer" && out[0].outcome.ok
        ? (out[0].outcome.body as { notifications: NotificationObject[] }).notifications.map(
            (o) => o.seq,
          )
        : [];
    expect(
      answerOf(runner.run(op("notifications.list", { limit: 10 }, ANNA, ANNA_LAPTOP))),
    ).toEqual([...seqs].reverse());
    expect(
      answerOf(
        runner.run(op("notifications.list", { limit: 1, before: seqs[2] ?? 0 }, ANNA, ANNA_LAPTOP)),
      ),
    ).toEqual([seqs[1] ?? 0]);
  });
});

describe("a new client (section 7, People and permissions)", () => {
  test("told to the other clients of its person and the console, never to itself", () => {
    const runner = notify();
    const out = runner.run({ kind: "clientAdded", client: ANNA_PHONE, person: ANNA });
    expect(notifications(out).map((r) => [r.row.category, r.durability])).toEqual([
      ["newClient", "routine"],
    ]);
    expect(recipientsIn(out)).toEqual([ANNA]);
    expect(clientsTold(out)).toEqual([CONSOLE, ANNA_LAPTOP]);
  });
});

describe("rules values", () => {
  test("as the design sets them", () => {
    expect(DEFAULT_RULES.notify).toEqual({
      unreadWindowMs: 7 * 24 * 3600 * 1000,
      delayedAfterMs: 60_000,
      sameKindEveryMs: 600_000,
      consoleGetsAll: true,
    });
  });
});

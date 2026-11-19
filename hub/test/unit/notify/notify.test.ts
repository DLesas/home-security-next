/**
 * The notify module (m2-design.md section 7, "Notifications"; section 3, durability): the table
 * row by row, recipients from `people`'s view, categories per client, critical ones written now
 * and the rest routine, no flood, one notice per action from its summary, `notificationRaised`
 * for `app`, unread across a restart, and the three operations.
 */
import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import {
  categoryBit,
  type NotificationObject,
  notificationObject,
  notificationObjectV2,
  type NotificationObjectV2,
} from "@hsn/protocol/app";
import {
  DECISION_KINDS,
  type DecisionKind,
  eventAtDetail,
  M3M4_DECISION_KINDS,
  M3M4_HUB_EVENTS,
} from "../../../src/core/model/decisions.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import {
  type ClientId,
  clientId,
  connId,
  type DeviceId,
  deviceId,
  HUB_DEVICE,
  type PersonId,
  personId,
  type Seq,
} from "../../../src/core/model/ids.ts";
import { pausedDetail } from "../../../src/core/firmware/records.ts";
import type { Context } from "../../../src/core/model/handler.ts";
import { ALL_OPTIONAL_ON } from "../../../src/core/notify/deliver.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import type { Actor, AnswerTo, Internal } from "../../../src/core/model/messages.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  ClientKind,
  type ClientRow,
  type HubEventLevel,
  PILOT_FAILED_REASON,
  NO_CONTACT_REASON,
  ROLLED_BACK_REASON,
  type NotificationRow,
  type PermissionRow,
} from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import type { Durability } from "../../../src/core/model/store.ts";
import { clientsFor } from "../../../src/core/notify/audience.ts";
import { notifyDeadlines } from "../../../src/core/notify/deadlines.ts";
import { handleNotify, recipientBytes, recipientsOf } from "../../../src/core/notify/handle.ts";
import {
  type Classified,
  classifyDecision,
  classifyHubEvent,
  floodExempt,
  scheduleWarnings,
} from "../../../src/core/notify/table.ts";
import { asVersion2, happenedAtFor, unreadFor } from "../../../src/core/notify/view.ts";
import { NEVER_PUSHED, PRESENCE_OFFER_KINDS } from "../../../src/core/relay/content.ts";
import {
  ANNA as R_ANNA,
  ANNA_PHONE as R_ANNA_PHONE,
  BEN as R_BEN,
  BEN_PHONE as R_BEN_PHONE,
  BEN_PHONE2 as R_BEN_PHONE2,
  pushes,
  relayRunner,
  relaySnapshot,
  type Runner as RelayRunner,
  R1 as R_R1,
  S2 as R_S2,
} from "../relay-core/support.ts";
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

// ——— M3 and M4 (docs/m4-design.md sections 4, 5, 6 and 9; m3-updates-design section 4; D102) ———

let h = 0;

/** A hub event on its way to audit, at the level and class the model gives it. */
function hubEventRecord(code: string, detail: string | null = null): Internal {
  h += 1;
  const table: Readonly<
    Record<string, { level: HubEventLevel; durability: Durability } | undefined>
  > = M3M4_HUB_EVENTS;
  const spec = table[code] ?? { level: "warning", durability: "now" };
  return {
    kind: "auditRecord",
    durability: spec.durability,
    record: {
      kind: "hubEvent",
      row: {
        seq: rec(600_000 + h),
        atMs: 0,
        clockOk: true,
        level: spec.level,
        origin: "core",
        code,
        message: "",
        detail,
      },
    },
  };
}

/** Every `notificationRaised` message in full, as `app` and `relay` read it. */
function raisedMessages(out: readonly (Internal | Effect)[]) {
  return out.flatMap((item) => (item.kind === "notificationRaised" ? [item] : []));
}

/** `notifications.list`'s notifications, from its answer. */
function listedIn(out: readonly (Internal | Effect)[]): readonly NotificationObject[] {
  const answer = out.find((o) => o.kind === "opAnswer");
  return answer?.kind === "opAnswer" && answer.outcome.ok
    ? (answer.outcome.body as { notifications: NotificationObject[] }).notifications
    : [];
}

function viewOfRunner(runner: Runner<"notify">): HubState {
  return { ...runner.view, notify: runner.slice };
}

/** The fields of version 1's object, exactly: nothing added (version 1 parses strictly). */
const V1_FIELDS = [
  "atMs",
  "category",
  "cause",
  "clockOk",
  "critical",
  "delayed",
  "device",
  "kind",
  "read",
  "seq",
];

describe("the new notifications, each with its category, recipients and durability", () => {
  // Anna has manage system; Ben does not, but may view SENSOR2.
  const home: Home = { userManagement: true };

  test("relay_unreachable: hub, to manage system and the console, not to be turned off, routine", () => {
    const runner = notify({ ...home, prefs: [{ client: ANNA_LAPTOP, categories: 0 }] });
    const out = runner.run(hubEventRecord("relay_unreachable"));
    const rows = notifications(out);
    expect(rows.map((r) => [r.row.kind, r.row.category, r.row.critical, r.durability])).toEqual([
      ["relay_unreachable", "hub", false, "routine"],
    ]);
    expect(rows[0]?.row.deviceId).toBe(null);
    expect(recipientsIn(out)).toEqual([ANNA]);
    // Every optional category off on Anna's laptop: it is told all the same.
    expect(clientsTold(out)).toEqual([CONSOLE, ANNA_LAPTOP, ANNA_PHONE]);
    expect(raisedMessages(out)).toHaveLength(1);
    // The hub event is written now as the model gives it; the notice rides on that commit.
    expect(M3M4_HUB_EVENTS.relay_unreachable).toEqual({ level: "warning", durability: "now" });
  });

  test("relay_unreachable is the one kind the relay module never pushes (section 9)", () => {
    const out = notify(home).run(hubEventRecord("relay_unreachable"));
    const kind = raisedMessages(out)[0]?.notification.kind ?? "";
    expect(NEVER_PUSHED.has(kind)).toBe(true);
    for (const other of [
      "update_offered",
      "firmware_rolled_back",
      "rollout_paused",
      "firmware_store_damaged",
    ]) {
      expect(NEVER_PUSHED.has(other)).toBe(false);
    }
  });

  test("relay_unreachable is told at each outage: the flood rule does not hold back the hub's", () => {
    const runner = notify(home);
    expect(notifications(runner.run(hubEventRecord("relay_unreachable")))).toHaveLength(1);
    runner.at(5 * MINUTE_US);
    expect(notifications(runner.run(hubEventRecord("relay_unreachable")))).toHaveLength(1);
  });

  const UPDATES: readonly [DecisionKind, DeviceId | null, number | null, Uint8Array | null][] = [
    ["update_offered", null, null, null],
    ["firmware_release_offered", null, (1 << 16) | (2 << 8) | 3, null],
    ["firmware_refused", SENSOR2, 8, null],
    ["firmware_refused", SIREN, 18, null],
    ["firmware_rolled_back", SENSOR2, (1 << 16) | (2 << 8) | 3, null],
    // The pause the hub makes with no notice of its own: a pilot failed its soak.
    ["rollout_paused", SENSOR2, 1, pausedDetail(SENSOR2, PILOT_FAILED_REASON)],
    ["firmware_reminder", SENSOR2, 2, null],
  ];

  test.each(UPDATES)(
    "%s about %p: updates, can be turned off, not critical, to manage system only, routine",
    (kind, device, value, detail) => {
      const runner = notify(home);
      const out = runner.run(decisionRecord(kind, { device, value, detail }));
      const rows = notifications(out);
      expect(rows.map((r) => [r.row.kind, r.row.category, r.row.critical, r.durability])).toEqual([
        [kind, "updates", false, "routine"],
      ]);
      // The device it names stays on it, for its words; who is told is manage system's.
      expect(rows[0]?.row.deviceId).toBe(device);
      expect(recipientsIn(out)).toEqual([ANNA]);
      expect(clientsTold(out)).toEqual([CONSOLE, ANNA_LAPTOP, ANNA_PHONE]);
      expect(raisedMessages(out)).toHaveLength(1);
      expect(classifyDecision(kind, device, value, detail, FACTS_ARMED)).toMatchObject({
        category: "updates",
        critical: false,
        mandatory: false,
      });
    },
  );

  test("with updates turned off, a client is not told them; its person's other clients are", () => {
    const runner = notify({ ...home, prefs: [{ client: ANNA_PHONE, categories: 0 }] });
    // Each kind about each device once: the flood rule holds none of them back.
    for (const [kind, device, value, detail] of UPDATES) {
      expect(clientsTold(runner.run(decisionRecord(kind, { device, value, detail })))).toEqual([
        CONSOLE,
        ANNA_LAPTOP,
      ]);
    }
  });

  test("with user management off, every person has manage system, so every person is told", () => {
    const out = notify().run(decisionRecord("firmware_rolled_back", { device: SENSOR, value: 1 }));
    expect(recipientsIn(out)).toEqual([ANNA, BEN]);
  });

  test("no other decision or hub event of M3 and M4 raises one", () => {
    const told = new Set<string>([
      ...UPDATES.map((u) => u[0]),
      "presence_offer_away",
      "presence_offer_disarm",
    ]);
    for (const kind of M3M4_DECISION_KINDS.filter((k) => !told.has(k))) {
      expect(classifyDecision(kind, SENSOR, 1, null, FACTS_ARMED)).toBeUndefined();
      expect(notify(home).run(decisionRecord(kind, { device: SENSOR, value: 1 }))).toEqual([]);
    }
    const toldEvents = new Set(["relay_unreachable", "firmware_store_damaged"]);
    for (const code of Object.keys(M3M4_HUB_EVENTS).filter((c) => !toldEvents.has(c))) {
      expect(classifyHubEvent(code)).toBeUndefined();
      expect(notify(home).run(hubEventRecord(code))).toEqual([]);
    }
  });

  test("no notify deadline at or before the step's time, after any of them", () => {
    const runner = notify(home);
    const check = () => {
      expect(notifyDeadlines(runner.slice).filter((t) => t.at <= runner.now.mono)).toEqual([]);
    };
    runner.run(hubEventRecord("relay_unreachable"));
    check();
    for (const [i, [kind, device, value, detail]] of UPDATES.entries()) {
      runner.at((i + 1) * MINUTE_US);
      runner.run(decisionRecord(kind, { device, value, detail }));
      check();
    }
    runner.run(op("notifications.list", { limit: 50 }, ANNA, ANNA_LAPTOP));
    check();
  });
});

describe("happenedAtMs (D102), for version 2 only", () => {
  const LATE_MS = WALL0 - 5 * 3_600_000;

  test("a late notification's event time beside its object; null for one raised as it happened", () => {
    const runner = notify();
    const late = (out: readonly (Internal | Effect)[]) => raisedMessages(out)[0]?.happenedAtMs;
    expect(late(runner.run(decisionRecord("alarm", { detail: eventAtDetail(LATE_MS) })))).toBe(
      LATE_MS,
    );
    expect(
      late(
        runner.run(
          decisionRecord("late_report_sirens", { value: 20, detail: eventAtDetail(LATE_MS + 7) }),
        ),
      ),
    ).toBe(LATE_MS + 7);
    expect(
      late(runner.run(decisionRecord("late_report_notification", { value: LATE_MS / 1000 }))),
    ).toBe(LATE_MS);
    // Raised as the event happens: null, never left out.
    for (const out of [
      runner.run(decisionRecord("alarm")),
      runner.run(decisionRecord("battery_low", { device: SENSOR2 })),
      runner.run(hubEventRecord("relay_unreachable")),
      runner.run(decisionRecord("update_offered", { device: null })),
      runner.run({ kind: "clientAdded", client: ANNA_PHONE, person: ANNA }),
    ]) {
      const [message] = raisedMessages(out);
      expect(message).toBeDefined();
      expect(message !== undefined && "happenedAtMs" in message).toBe(true);
      expect(message?.happenedAtMs).toBe(null);
    }
  });

  test("the snapshot's and notifications.list's give the same value, and so after a restart", () => {
    const runner = notify();
    const lateOut = runner.run(decisionRecord("alarm", { detail: eventAtDetail(LATE_MS) }));
    const onTimeOut = runner.run(decisionRecord("battery_low", { device: SENSOR2 }));
    const given = new Map(
      [...raisedMessages(lateOut), ...raisedMessages(onTimeOut)].map((m) => [
        m.notification.seq,
        m.happenedAtMs,
      ]),
    );
    const [lateSeq, onTimeSeq] = [...given.keys()];
    expect([...given.values()]).toEqual([LATE_MS, null]);

    const check = (r: Runner<"notify">) => {
      const view = viewOfRunner(r);
      expect(happenedAtFor(view, lateSeq ?? 0)).toBe(LATE_MS);
      expect(happenedAtFor(view, onTimeSeq ?? 0)).toBe(null);
      expect(happenedAtFor(view, 12_345)).toBeUndefined();
      const snapshot = asVersion2(view, unreadFor(view, ANNA, WALL0, DEFAULT_RULES, WALL0));
      const listed = asVersion2(
        view,
        listedIn(r.run(op("notifications.list", { limit: 10 }, ANNA, ANNA_LAPTOP))),
      );
      const pairs = (objects: readonly NotificationObjectV2[]) =>
        objects.map((o): readonly [number, number | null | undefined] => [o.seq, o.happenedAtMs]);
      expect(pairs(snapshot)).toEqual([...given]);
      expect(pairs(listed)).toEqual([...given].reverse());
      for (const object of [...snapshot, ...listed]) {
        expect(notificationObjectV2.safeParse(object).success).toBe(true);
      }
    };
    check(runner);
    const rows = notifications(runner.out).map((r) => r.row);
    check(notify({ notifications: rows }));
  });

  test("version 1's objects never gain it: the event's, the snapshot's and the list's", () => {
    const runner = notify();
    const out = runner.run(decisionRecord("alarm", { detail: eventAtDetail(LATE_MS) }));
    const view = viewOfRunner(runner);
    const objects = [
      ...raisedMessages(out).map((m) => m.notification),
      ...unreadFor(view, ANNA, WALL0, DEFAULT_RULES, WALL0),
      ...listedIn(runner.run(op("notifications.list", { limit: 10 }, ANNA, ANNA_LAPTOP))),
    ];
    expect(objects).toHaveLength(3);
    for (const object of objects) {
      expect(Object.keys(object).sort()).toEqual(V1_FIELDS);
      expect(notificationObject.safeParse(object).success).toBe(true);
    }
  });

  test("an existing notification's every field is unchanged for a version 1 client", () => {
    const runner = notify();
    const out = runner.run(decisionRecord("countdown_started"));
    const seq = notifications(out)[0]?.row.seq ?? 0;
    const cause = rec(500_000 + n);
    const expected: NotificationObject = {
      seq,
      atMs: WALL0,
      clockOk: true,
      kind: "countdown_started",
      category: "countdown",
      critical: true,
      device: SENSOR,
      cause,
      read: false,
      delayed: false,
    };
    expect(raisedMessages(out)).toEqual([
      {
        kind: "notificationRaised",
        notification: expected,
        clients: [CONSOLE, ANNA_LAPTOP, ANNA_PHONE, BEN_LAPTOP],
        happenedAtMs: null,
      },
    ]);
    const view = viewOfRunner(runner);
    expect(unreadFor(view, ANNA, WALL0, DEFAULT_RULES, WALL0)).toEqual([expected]);
    expect(
      listedIn(runner.run(op("notifications.list", { limit: 10 }, ANNA, ANNA_LAPTOP))),
    ).toEqual([expected]);
  });
});

describe("notifications.list's delayed: what the notification's own row says (D102)", () => {
  const listed = (runner: Runner<"notify">) =>
    listedIn(runner.run(op("notifications.list", { limit: 10 }, ANNA, ANNA_LAPTOP)))
      .map((o) => [o.kind, o.delayed])
      .reverse();

  test("raised exactly 60 s ‡ after its event: not delayed; a millisecond more: delayed", () => {
    const runner = notify();
    runner.run(decisionRecord("alarm", { detail: eventAtDetail(WALL0 - 60_000) }));
    runner.run(decisionRecord("late_report_sirens", { detail: eventAtDetail(WALL0 - 60_001) }));
    expect(listed(runner)).toEqual([
      ["alarm", false],
      ["late_report_sirens", true],
    ]);
    expect(raisedMessages(runner.out).map((m) => m.notification.delayed)).toEqual([false, true]);
  });

  test("late_report_notification counted from the opening, at the edge too", () => {
    const runner = notify();
    runner.run(decisionRecord("late_report_notification", { value: (WALL0 - 60_000) / 1000 }));
    runner.run(decisionRecord("late_report_notification", { value: (WALL0 - 61_000) / 1000 }));
    expect(listed(runner)).toEqual([
      ["late_report_notification", false],
      ["late_report_notification", true],
    ]);
  });

  test("asked an hour later, the same: one raised on time is not delayed, a late one is", () => {
    const runner = notify();
    runner.run(decisionRecord("battery_low", { device: SENSOR2 }));
    runner.run(decisionRecord("alarm", { detail: eventAtDetail(WALL0 - 3_600_000) }));
    runner.at(60 * MINUTE_US);
    expect(listed(runner)).toEqual([
      ["battery_low", false],
      ["alarm", true],
    ]);
    // After a restart, from the rows alone.
    const rows = notifications(runner.out).map((r) => r.row);
    expect(listed(notify({ notifications: rows }).at(60 * MINUTE_US))).toEqual([
      ["battery_low", false],
      ["alarm", true],
    ]);
  });
});

describe("a rollout paused: one notice per event, none for a person's own pause", () => {
  const home: Home = { userManagement: true };
  const kindsOf = (out: readonly (Internal | Effect)[]) =>
    notifications(out).map((r) => r.row.kind);
  const paused = (device: DeviceId | null, detail: Uint8Array | null) =>
    decisionRecord("rollout_paused", { device, value: 1, detail });

  test("a person's pause (no detail) is not told", () => {
    const runner = notify(home);
    expect(classifyDecision("rollout_paused", null, 1, null, FACTS_ARMED)).toBeUndefined();
    expect(runner.run(paused(null, null))).toEqual([]);
  });

  test("a refusal that pauses: only firmware_refused, for every device reason and noContact", () => {
    const runner = notify(home);
    for (let reason = 1; reason <= NO_CONTACT_REASON; reason++) {
      const device = reason % 2 === 0 ? SENSOR2 : SIREN;
      runner.at(reason * 11 * MINUTE_US);
      const out = [
        ...runner.run(decisionRecord("firmware_refused", { device, value: reason })),
        ...runner.run(paused(device, pausedDetail(device, reason))),
      ];
      expect(kindsOf(out)).toEqual(["firmware_refused"]);
      expect(raisedMessages(out)).toHaveLength(1);
    }
  });

  test("a rollback that pauses: only firmware_rolled_back", () => {
    const runner = notify(home);
    const out = [
      ...runner.run(decisionRecord("firmware_rolled_back", { device: SENSOR2, value: 0x010203 })),
      ...runner.run(paused(SENSOR2, pausedDetail(SENSOR2, ROLLED_BACK_REASON))),
    ];
    expect(kindsOf(out)).toEqual(["firmware_rolled_back"]);
  });

  test("decided from the pause's own record, not from what came before it in the step", () => {
    // Alone, with no refusal or rollback before it, a refusal's or rollback's pause is still not told.
    const runner = notify(home);
    expect(runner.run(paused(SENSOR2, pausedDetail(SENSOR2, 8)))).toEqual([]);
    expect(runner.run(paused(SENSOR2, pausedDetail(SENSOR2, ROLLED_BACK_REASON)))).toEqual([]);
  });

  test("the reasons at their edges, with a device: 18 no, 19 (pilot failed) yes, 20 no, 21 yes", () => {
    const told = [NO_CONTACT_REASON, PILOT_FAILED_REASON, ROLLED_BACK_REASON, 21].map(
      (reason) =>
        classifyDecision(
          "rollout_paused",
          SENSOR2,
          1,
          pausedDetail(SENSOR2, reason),
          FACTS_ARMED,
        ) !== undefined,
    );
    expect(told).toEqual([false, true, false, true]);
    // Reason 0 names no refusal either: told.
    expect(
      classifyDecision("rollout_paused", SENSOR2, 1, pausedDetail(SENSOR2, 0), FACTS_ARMED),
    ).toBeDefined();
  });

  test("a pilot that failed its soak: told, in updates, to manage system", () => {
    const out = notify(home).run(paused(SENSOR2, pausedDetail(SENSOR2, PILOT_FAILED_REASON)));
    expect(notifications(out).map((r) => [r.row.kind, r.row.category, r.durability])).toEqual([
      ["rollout_paused", "updates", "routine"],
    ]);
    expect(recipientsIn(out)).toEqual([ANNA]);
  });

  test("the store damaged: one notice, the critical firmware_store_damaged, not its pause too", () => {
    const runner = notify(home);
    const out = [
      ...runner.run(hubEventRecord("firmware_store_damaged", "{}")),
      ...runner.run(paused(null, pausedDetail(HUB_DEVICE, 8))),
    ];
    expect(kindsOf(out)).toEqual(["firmware_store_damaged"]);
    expect(raisedMessages(out)).toHaveLength(1);
    // Alone, from its own record: still not told.
    expect(runner.run(paused(null, pausedDetail(HUB_DEVICE, 8)))).toEqual([]);
    // With no device and a reason the rule does not know: told rather than lost.
    expect(kindsOf(runner.run(paused(null, pausedDetail(HUB_DEVICE, 21))))).toEqual([
      "rollout_paused",
    ]);
  });

  test("a detail not laid out as firmware's (not 5 bytes) is told rather than lost", () => {
    expect(
      classifyDecision("rollout_paused", null, 1, Uint8Array.of(0, 0, 0, 0), FACTS_ARMED),
    ).toBeDefined();
  });
});

describe("firmware_store_damaged: critical, as restore_waiting is", () => {
  const home: Home = { userManagement: true, prefs: [{ client: ANNA_LAPTOP, categories: 0 }] };
  const detail = JSON.stringify({ image: 3, problem: "missing", version: "1.2.3" });

  test("hub, critical, written now, to manage system and the console, not to be turned off", () => {
    expect(M3M4_HUB_EVENTS.firmware_store_damaged).toEqual({
      level: "critical",
      durability: "now",
    });
    const out = notify(home).run(hubEventRecord("firmware_store_damaged", detail));
    const rows = notifications(out);
    expect(rows.map((r) => [r.row.kind, r.row.category, r.row.critical, r.durability])).toEqual([
      ["firmware_store_damaged", "hub", true, "now"],
    ]);
    expect(classifyHubEvent("firmware_store_damaged")).toEqual(classifyHubEvent("restore_waiting"));
    expect(rows[0]?.row.deviceId).toBe(null);
    expect(recipientsIn(out)).toEqual([ANNA]);
    expect(clientsTold(out)).toEqual([CONSOLE, ANNA_LAPTOP, ANNA_PHONE]);
    expect(new TextDecoder().decode(rows[0]?.row.detail ?? new Uint8Array())).toBe(detail);
    expect(raisedMessages(out)[0]?.happenedAtMs).toBe(null);
  });

  test("critical, so each one is told: two images damaged at the same start", () => {
    const runner = notify(home);
    expect(
      notifications(runner.run(hubEventRecord("firmware_store_damaged", detail))),
    ).toHaveLength(1);
    expect(
      notifications(runner.run(hubEventRecord("firmware_store_damaged", detail))),
    ).toHaveLength(1);
  });
});

describe("presence offers (m3-design section 6): to exactly the people named, in armDisarm", () => {
  const offer = (
    kind: "presence_offer_away" | "presence_offer_disarm",
    people: readonly PersonId[],
  ) =>
    decisionRecord(kind, {
      device: null,
      value: kind === "presence_offer_disarm" ? (people[0] ?? null) : null,
      detail: recipientBytes(people),
    });

  test.each(["presence_offer_away", "presence_offer_disarm"] as const)(
    "%s: armDisarm, can be turned off, not critical, routine, to the named people only",
    (kind) => {
      // With user management off every person may arm and view everything: still only Ben.
      const out = notify().run(offer(kind, [BEN]));
      expect(
        notifications(out).map((r) => [r.row.kind, r.row.category, r.row.critical, r.durability]),
      ).toEqual([[kind, "armDisarm", false, "routine"]]);
      expect(notifications(out)[0]?.row.deviceId).toBe(null);
      expect(recipientsIn(out)).toEqual([BEN]);
      // Ben's laptop, and the console, which is told every notification (section 7); none of Anna's.
      expect(clientsTold(out)).toEqual([CONSOLE, BEN_LAPTOP]);
      expect(raisedMessages(out)).toHaveLength(1);
      expect(classifyDecision(kind, null, null, recipientBytes([BEN]), FACTS_ARMED)).toMatchObject({
        category: "armDisarm",
        critical: false,
        mandatory: false,
      });
    },
  );

  test("the away offer to every person it names; a person with manage system not named gets none", () => {
    const out = notify({ userManagement: true }).run(offer("presence_offer_away", [BEN]));
    expect(recipientsIn(out)).toEqual([BEN]);
    expect(clientsTold(out)).not.toContain(ANNA_LAPTOP);
    const both = notify({ userManagement: true }).run(offer("presence_offer_away", [BEN, ANNA]));
    expect(recipientsIn(both)).toEqual([ANNA, BEN]);
    expect(clientsTold(both)).toEqual([CONSOLE, ANNA_LAPTOP, ANNA_PHONE, BEN_LAPTOP]);
  });

  test("a client with armDisarm turned off is not told; its person's other clients are", () => {
    const runner = notify({ prefs: [{ client: ANNA_PHONE, categories: 0 }] });
    for (const kind of ["presence_offer_away", "presence_offer_disarm"] as const) {
      expect(clientsTold(runner.run(offer(kind, [ANNA])))).toEqual([CONSOLE, ANNA_LAPTOP]);
    }
    const off = notify({
      prefs: [
        { client: ANNA_PHONE, categories: 0 },
        { client: ANNA_LAPTOP, categories: ALL_OPTIONAL_ON & ~categoryBit("armDisarm") },
      ],
    });
    expect(clientsTold(off.run(offer("presence_offer_disarm", [ANNA])))).toEqual([CONSOLE]);
  });

  test("a named person since removed, or no one named, is told to nobody's clients", () => {
    expect(recipientsIn(notify().run(offer("presence_offer_away", [personId(9)])))).toEqual([]);
    const none = notify().run(offer("presence_offer_away", []));
    expect(recipientsIn(none)).toEqual([]);
    expect(clientsTold(none)).toEqual([CONSOLE]);
  });

  test("each offer is told, though two come within 10 minutes (armDisarm is exempt)", () => {
    const runner = notify();
    expect(notifications(runner.run(offer("presence_offer_away", [ANNA])))).toHaveLength(1);
    expect(notifications(runner.run(offer("presence_offer_away", [ANNA])))).toHaveLength(1);
  });

  test("the kinds are the relay module's: pushed, never in NEVER_PUSHED", () => {
    expect(Object.values(PRESENCE_OFFER_KINDS).sort()).toEqual([
      "presence_offer_away",
      "presence_offer_disarm",
    ]);
    for (const kind of Object.values(PRESENCE_OFFER_KINDS))
      expect(NEVER_PUSHED.has(kind)).toBe(false);
  });
});

describe("presence offers through notify and on to relay: each push with its one action", () => {
  /** notify's handler on the relay runner's whole view, its `notificationRaised` sent to relay. */
  function offerToRelay(
    runner: RelayRunner,
    kind: "presence_offer_away" | "presence_offer_disarm",
    people: readonly PersonId[],
  ): ReadonlyMap<number, readonly string[]> {
    let next = 0;
    const ctx: Context = {
      now: runner.now,
      view: runner.view,
      deps: runner.deps,
      entropy: entropyCursor(new Uint8Array(32), "tick"),
      records: { take: () => ok(rec(900_000 + (next += 1))) },
      event: "tick",
    };
    const handled = handleNotify(runner.view.notify, offerRecord(kind, people), ctx);
    expect(handled.isOk()).toBe(true);
    const out = handled.isOk() ? handled.value.out : [];
    const sent = raisedMessages(out).flatMap((message) => pushes(runner.send(message).out));
    return new Map(sent.map((p) => [p.client, p.content.actions]));
  }

  function offerRecord(
    kind: "presence_offer_away" | "presence_offer_disarm",
    people: readonly PersonId[],
  ): Internal {
    return decisionRecord(kind, {
      device: null,
      value: kind === "presence_offer_disarm" ? (people[0] ?? null) : null,
      detail: recipientBytes(people),
    });
  }

  function upRelay(): RelayRunner {
    const runner = relayRunner(relaySnapshot());
    runner.up();
    return runner;
  }

  test("Away: Arm away, to the phones of the people named only", () => {
    const runner = upRelay();
    expect(offerToRelay(runner, "presence_offer_away", [R_BEN])).toEqual(
      new Map([
        [R_BEN_PHONE, ["armAway"]],
        [R_BEN_PHONE2, ["armAway"]],
      ]),
    );
    expect(offerToRelay(runner, "presence_offer_away", [R_ANNA, R_BEN])).toEqual(
      new Map([
        [R_ANNA_PHONE, ["armAway"]],
        [R_BEN_PHONE, ["armAway"]],
        [R_BEN_PHONE2, ["armAway"]],
      ]),
    );
  });

  test("Disarm: Disarm to the arriving person, who may manage a sensor that is armed", () => {
    const runner = upRelay();
    runner.arm(R_S2);
    expect(offerToRelay(runner, "presence_offer_disarm", [R_BEN])).toEqual(
      new Map([
        [R_BEN_PHONE, ["disarm"]],
        [R_BEN_PHONE2, ["disarm"]],
      ]),
    );
  });

  test("a phone with armDisarm turned off gets no push of the offer", () => {
    const base = relaySnapshot();
    const prefs = [
      {
        clientId: R_BEN_PHONE2,
        categories: ALL_OPTIONAL_ON & ~categoryBit("armDisarm"),
        revision: 1,
      },
    ];
    const runner = relayRunner({ ...base, m2: { ...base.m2, notificationPrefs: prefs } });
    runner.up();
    expect([...offerToRelay(runner, "presence_offer_away", [R_BEN]).keys()]).toEqual([R_BEN_PHONE]);
  });
});

describe("group_sirens_gone (D144): a history record only, notified to nobody", () => {
  const groups = Uint8Array.of(1, 0, 0, 0, 3, 0, 0, 0);
  const gone = (client: ClientId | null) =>
    decisionRecord("group_sirens_gone", { device: SIREN, value: client, detail: groups });

  test("raises nothing, whoever asked: the app, the console, hsn, the siren's button, a start", () => {
    expect(classifyDecision("group_sirens_gone", SIREN, null, groups, FACTS_ARMED)).toBeUndefined();
    for (const home of [{}, { userManagement: true }]) {
      const runner = notify(home);
      for (const client of [null, ANNA_PHONE, BEN_LAPTOP, CONSOLE, clientId(99)]) {
        expect(runner.run(gone(client))).toEqual([]);
      }
    }
  });

  test("nothing for the relay to push", () => {
    const runner = relayRunner(relaySnapshot());
    runner.up();
    let next = 0;
    const ctx: Context = {
      now: runner.now,
      view: runner.view,
      deps: runner.deps,
      entropy: entropyCursor(new Uint8Array(32), "tick"),
      records: { take: () => ok(rec(950_000 + (next += 1))) },
      event: "tick",
    };
    for (const client of [null, R_ANNA_PHONE]) {
      const record = decisionRecord("group_sirens_gone", {
        device: R_R1,
        value: client,
        detail: groups,
      });
      const handled = handleNotify(runner.view.notify, record, ctx);
      const out = handled.isOk() ? handled.value.out : [];
      expect(out).toEqual([]);
      expect(raisedMessages(out).flatMap((m) => pushes(runner.send(m).out))).toEqual([]);
    }
  });
});

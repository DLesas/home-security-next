/**
 * D144 in `layout`: a group whose chosen sirens are all gone sounds every siren, and that is
 * recorded (`group_sirens_gone`) once per occurrence, naming the siren and the groups, with the
 * client that asked (none at the siren's own button), and at a start when found so unrecorded.
 * The layout handler alone over a hand-made view (registry rows set by the test), and once end to
 * end with the real registry, layout and notify (the alarm harness).
 */
import { describe, expect, test } from "bun:test";
import { ButtonAction, decodeMessage, MessageType, Role } from "@hsn/protocol";
import { groupsOf, SIRENS_GONE } from "../../../src/core/layout/gone.ts";
import { handleLayout } from "../../../src/core/layout/handle.ts";
import { layoutDeadlines } from "../../../src/core/layout/deadlines.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import {
  clientId,
  connId,
  type DeviceId,
  deviceId,
  type GroupId,
  groupId,
  linkId,
  personId,
  requestId,
  type Seq,
} from "../../../src/core/model/ids.ts";
import type { Actor, Internal } from "../../../src/core/model/messages.ts";
import {
  type DeviceRow,
  DeviceState,
  type GroupRow,
  type NotificationRow,
} from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import {
  boot,
  DEVICE_ROWS,
  rec,
  Runner,
  SIREN,
  snapshotWith,
  viewWith,
  WALL0,
} from "../health/support.ts";
import { Home } from "../../scenarios/alarm/harness.ts";

const HALL = SIREN;
const PORCH = deviceId(7);
const ATTIC = deviceId(8);

const DOWNSTAIRS = groupId(1);
const UPSTAIRS = groupId(2);
const BOTH = groupId(3);
const EVERY = groupId(4);

/** The groups by their chosen sirens; "all" is every siren. */
type Spec = readonly [GroupId, readonly DeviceId[] | "all"];

const SPECS: readonly Spec[] = [
  [DOWNSTAIRS, [HALL]],
  [UPSTAIRS, [HALL]],
  [BOTH, [PORCH, ATTIC]],
  // On every siren, with a list kept from before: never such a group.
  [EVERY, "all"],
];

const HALL_ROW: DeviceRow | undefined = DEVICE_ROWS.find((row) => row.id === SIREN);

function sirenRow(id: DeviceId, name: string): readonly DeviceRow[] {
  return HALL_ROW === undefined ? [] : [{ ...HALL_ROW, id, name, address: 0x200 + id }];
}

function homeView(): HubState {
  const base = viewWith();
  const devices = new Map(base.registry.devices);
  for (const row of [...sirenRow(PORCH, "porch"), ...sirenRow(ATTIC, "attic")])
    devices.set(row.id, row);
  return { ...base, registry: { ...base.registry, devices } };
}

function groupsSnapshot(specs: readonly Spec[], notifications: readonly NotificationRow[] = []) {
  const groups: GroupRow[] = specs.map(([id, sirens]) => ({
    id,
    name: `g${id}`,
    allSirens: sirens === "all",
    revision: 1,
  }));
  const groupSirens = specs.flatMap(([id, sirens]) =>
    sirens === "all"
      ? [{ groupId: id, sirenId: HALL }]
      : sirens.map((s) => ({ groupId: id, sirenId: s })),
  );
  return snapshotWith({ groups, groupSirens, groupMembers: [], notifications });
}

/** Sets a device's registry row as the registry would leave it (before layout sees a message). */
function setState(runner: Runner<"layout">, device: DeviceId, state: DeviceState, atMs = WALL0) {
  const row = runner.view.registry.devices.get(device);
  expect(row).toBeDefined();
  if (row === undefined) return;
  const named = state !== DeviceState.ResetByOwner && state !== DeviceState.Removed;
  const devices = new Map(runner.view.registry.devices).set(device, {
    ...row,
    state,
    removedMs: named ? null : atMs,
  });
  runner.view = { ...runner.view, registry: { ...runner.view.registry, devices } };
}

function layout(specs: readonly Spec[] = SPECS, notifications: readonly NotificationRow[] = []) {
  const runner = new Runner("layout", handleLayout, homeView());
  runner.run(boot(groupsSnapshot(specs, notifications)));
  return runner;
}

/** The siren reset by its owner: the registry's row, then its `deviceRemoved`. */
function reset(runner: Runner<"layout">, siren: DeviceId, atMs = WALL0) {
  setState(runner, siren, DeviceState.ResetByOwner, atMs);
  return runner.run({ kind: "deviceRemoved", device: siren });
}

/** Added again: the registry's row provisioning, then its `deviceAdded`. */
function addedAgain(runner: Runner<"layout">, siren: DeviceId) {
  setState(runner, siren, DeviceState.Provisioning);
  return runner.run({
    kind: "deviceAdded",
    device: siren,
    role: Role.Siren,
    address: 1,
    name: "x",
  });
}

function gone(out: readonly (Internal | Effect)[]) {
  return out.flatMap((item) =>
    item.kind === "auditRecord" &&
    item.record.kind === "decision" &&
    item.record.row.kind === SIRENS_GONE
      ? [
          {
            durability: item.durability,
            siren: item.record.row.deviceId,
            client: item.record.row.value,
            cause: item.record.row.causeSeq,
            groups: groupsOf(item.record.row.detail),
          },
        ]
      : [],
  );
}

describe("a siren reset at the device (D144)", () => {
  test("leaving one group: one record, written now, naming the siren and the group, nobody asked", () => {
    const runner = layout([
      [DOWNSTAIRS, [HALL]],
      [BOTH, [PORCH, ATTIC]],
    ]);
    expect(gone(reset(runner, HALL))).toEqual([
      { durability: "now", siren: HALL, client: null, cause: null, groups: [DOWNSTAIRS] },
    ]);
  });

  test("leaving two groups: one record naming both; a group on every siren is never named", () => {
    const runner = layout();
    expect(gone(reset(runner, HALL))).toEqual([
      { durability: "now", siren: HALL, client: null, cause: null, groups: [DOWNSTAIRS, UPSTAIRS] },
    ]);
  });

  test("a siren in no group's list: nothing recorded", () => {
    const runner = layout([[DOWNSTAIRS, [HALL]]]);
    expect(gone(reset(runner, PORCH))).toEqual([]);
  });

  test("a group on every siren only: nothing recorded, and nothing changes for it", () => {
    const runner = layout([[EVERY, "all"]]);
    const before = runner.slice.groups.get(EVERY);
    expect(gone(reset(runner, HALL))).toEqual([]);
    expect(runner.slice.groups.get(EVERY)).toEqual(before);
  });

  test("the last of two going: the first nothing, the second the record, naming it", () => {
    const runner = layout();
    expect(gone(reset(runner, PORCH))).toEqual([]);
    expect(gone(reset(runner, ATTIC))).toEqual([
      { durability: "now", siren: ATTIC, client: null, cause: null, groups: [BOTH] },
    ]);
  });

  test("once per occurrence: a repeated deviceRemoved records nothing more", () => {
    const runner = layout();
    expect(gone(reset(runner, HALL))).toHaveLength(1);
    expect(gone(runner.run({ kind: "deviceRemoved", device: HALL }))).toEqual([]);
  });

  test("added again, then reset again: recorded twice, once each time; the adding records nothing", () => {
    const runner = layout([[DOWNSTAIRS, [HALL]]]);
    expect(gone(reset(runner, HALL))).toHaveLength(1);
    expect(gone(addedAgain(runner, HALL))).toEqual([]);
    expect(runner.slice.sirensGone.size).toBe(0);
    setState(runner, HALL, DeviceState.Paired);
    expect(gone(runner.run({ kind: "provisionAnswered", device: HALL, result: 0 }))).toEqual([]);
    expect(gone(reset(runner, HALL))).toEqual([
      { durability: "now", siren: HALL, client: null, cause: null, groups: [DOWNSTAIRS] },
    ]);
  });

  test("no layout deadline at or before the step's time, after any of these", () => {
    const runner = layout();
    reset(runner, HALL);
    addedAgain(runner, HALL);
    expect(layoutDeadlines(runner.slice).filter((t) => t.at <= runner.now.mono)).toEqual([]);
  });
});

describe("found so at a start: known, never recorded again", () => {
  function started() {
    const runner = new Runner("layout", handleLayout, homeView());
    setState(runner, HALL, DeviceState.ResetByOwner, WALL0 - 60_000);
    return { runner, out: runner.run(boot(groupsSnapshot(SPECS))) };
  }

  test("a start records nothing: the reset that made it is in the history already", () => {
    expect(gone(started().out)).toEqual([]);
  });

  test("but knows the state: a later deviceRemoved records nothing, and an ending then a reset does", () => {
    const { runner } = started();
    expect([...runner.slice.sirensGone]).toEqual([DOWNSTAIRS, UPSTAIRS]);
    expect(gone(runner.run({ kind: "deviceRemoved", device: HALL }))).toEqual([]);
    expect(gone(addedAgain(runner, HALL))).toEqual([]);
    expect(gone(reset(runner, HALL))).toEqual([
      { durability: "now", siren: HALL, client: null, cause: null, groups: [DOWNSTAIRS, UPSTAIRS] },
    ]);
  });

  test("a second start records nothing either", () => {
    const { runner } = started();
    expect(gone(runner.run(boot(groupsSnapshot(SPECS))))).toEqual([]);
  });

  test("nothing so at a start: nothing known", () => {
    const runner = new Runner("layout", handleLayout, homeView());
    expect(gone(runner.run(boot(groupsSnapshot(SPECS))))).toEqual([]);
    expect(runner.slice.sirensGone.size).toBe(0);
  });
});

describe("who asked: the app's own asking", () => {
  const remove = (device: DeviceId, actor: string, record: Seq): Internal => ({
    kind: "deviceRemoveRequest",
    device,
    request: requestId(1),
    actor,
    record,
  });

  test("removed from the app: the client in the record, its request the cause; deviceRemoved adds none", () => {
    const runner = layout([[DOWNSTAIRS, [HALL]]]);
    setState(runner, HALL, DeviceState.Removed);
    const out = runner.run(remove(HALL, "Anna (client 11)", rec(5)));
    expect(gone(out)).toEqual([
      { durability: "now", siren: HALL, client: 11, cause: rec(5), groups: [DOWNSTAIRS] },
    ]);
    // The removal turns the group to every siren, as it always did.
    expect(runner.slice.groups.get(DOWNSTAIRS)).toMatchObject({ allSirens: true, sirens: [] });
    expect(gone(runner.run({ kind: "deviceRemoved", device: HALL }))).toEqual([]);
  });

  test("removed by hsn: nobody's client, so nobody is left out", () => {
    const runner = layout([[DOWNSTAIRS, [HALL]]]);
    setState(runner, HALL, DeviceState.Removed);
    expect(gone(runner.run(remove(HALL, "dimitri", rec(5))))[0]?.client).toBe(null);
  });

  test("removing a siren already reset (already told): nothing more", () => {
    const runner = layout([[DOWNSTAIRS, [HALL]]]);
    expect(gone(reset(runner, HALL))).toHaveLength(1);
    setState(runner, HALL, DeviceState.Removed);
    expect(gone(runner.run(remove(HALL, "Anna (client 11)", rec(5))))).toEqual([]);
  });

  test("a refused removal (the device still there) changes and records nothing", () => {
    const runner = layout([[DOWNSTAIRS, [HALL]]]);
    expect(runner.run(remove(HALL, "Anna (client 11)", rec(5)))).toEqual([]);
  });

  test("the last of two removed while the other is reset: recorded, with the client", () => {
    const runner = layout([[BOTH, [PORCH, ATTIC]]]);
    reset(runner, PORCH);
    setState(runner, ATTIC, DeviceState.Removed);
    expect(gone(runner.run(remove(ATTIC, "Ben (client 21)", rec(6))))).toEqual([
      { durability: "now", siren: ATTIC, client: 21, cause: rec(6), groups: [BOTH] },
    ]);
  });

  test("in the editor: keeping only a reset siren is recorded with the client; adding again ends it", () => {
    const anna: Actor = {
      kind: "person",
      person: personId(1),
      client: clientId(11),
      name: "Anna (client 11)",
    };
    const runner = layout([[DOWNSTAIRS, [HALL, PORCH]]]);
    const update = (sirens: readonly DeviceId[]): Internal => ({
      kind: "opRequest",
      owner: "layout",
      op: {
        op: "group.update",
        body: {
          group: DOWNSTAIRS,
          name: "g1",
          sensors: [],
          sirens,
          ifRevision: runner.slice.groups.get(DOWNSTAIRS)?.revision ?? 0,
        },
      },
      actor: anna,
      answerTo: { kind: "app", conn: connId(1), client: clientId(11), id: 1, seq: 1 },
      record: rec(9),
    });
    expect(gone(reset(runner, HALL))).toEqual([]);
    expect(gone(reset(runner, PORCH))).toHaveLength(1);
    expect(gone(addedAgain(runner, PORCH))).toEqual([]);
    // In the editor, keeping only the reset hall: such a group again, by the person's asking.
    expect(gone(runner.run(update([HALL])))).toEqual([
      { durability: "now", siren: HALL, client: 11, cause: rec(9), groups: [DOWNSTAIRS] },
    ]);
    // The hall added again ends it, with no record; its next reset is told again.
    expect(gone(addedAgain(runner, HALL))).toEqual([]);
    expect(runner.slice.sirensGone.size).toBe(0);
    expect(gone(reset(runner, HALL))).toEqual([
      { durability: "now", siren: HALL, client: null, cause: null, groups: [DOWNSTAIRS] },
    ]);
  });
});

describe("the group's editor", () => {
  test("keeping only the group's own reset siren: recorded with the person's client and request", () => {
    const anna: Actor = {
      kind: "person",
      person: personId(1),
      client: clientId(11),
      name: "Anna (client 11)",
    };
    const runner = layout([[BOTH, [PORCH, ATTIC]]]);
    expect(gone(reset(runner, PORCH))).toEqual([]);
    const out = runner.run({
      kind: "opRequest",
      owner: "layout",
      op: {
        op: "group.update",
        body: { group: BOTH, name: "g3", sensors: [], sirens: [PORCH], ifRevision: 1 },
      },
      actor: anna,
      answerTo: { kind: "app", conn: connId(1), client: clientId(11), id: 1, seq: 1 },
      record: rec(9),
    });
    expect(gone(out)).toEqual([
      { durability: "now", siren: PORCH, client: 11, cause: rec(9), groups: [BOTH] },
    ]);
  });
});

describe("end to end: the real registry, layout and notify", () => {
  test("a siren's own reset button: recorded once, notified to nobody", () => {
    const h = new Home({
      sensors: [{ name: "front" }],
      sirens: [{ name: "hall" }, { name: "porch" }],
      layout: {
        groups: [
          { id: 1, name: "Downstairs", sensors: ["front"], sirens: ["hall"] },
          { id: 2, name: "Garage", sensors: [], sirens: "all" },
        ],
      },
    });
    const hall = h.sirenDevice("hall");
    const decoded = decodeMessage(
      new Uint8Array([
        MessageType.Button,
        1,
        0x10,
        100,
        20,
        0,
        0,
        0,
        ButtonAction.FactoryResetGoingAhead,
      ]),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const button: Internal = {
      kind: "accepted",
      device: hall,
      role: Role.Siren,
      counter: 900,
      message: decoded.value,
      arrival: { path: "usb", link: linkId(1) },
      record: rec(3),
      newest: true,
    };
    h.inject(button);
    expect(h.world.state.registry.devices.get(hall)?.state).toBe(DeviceState.ResetByOwner);
    const records = h.decisions(SIRENS_GONE);
    expect(records.map((r) => [r.deviceId, r.value, [...groupsOf(r.detail)]])).toEqual([
      [hall, null, [groupId(1)]],
    ]);
    const notices = h.world.effects.flatMap((e) =>
      e.kind === "record" && e.record.kind === "notification" && e.record.row.kind === SIRENS_GONE
        ? [e.record.row]
        : [],
    );
    // A history record only (D144): nobody is notified, so nothing is raised, nor pushed.
    expect(notices).toEqual([]);
    expect(
      h.seen.filter(
        (seen) =>
          seen.message.kind === "notificationRaised" &&
          seen.message.notification.kind === SIRENS_GONE,
      ),
    ).toEqual([]);
    // Again: nothing more.
    h.inject({ kind: "deviceRemoved", device: hall });
    expect(h.decisions(SIRENS_GONE)).toHaveLength(1);
    // A person chooses the porch for the group instead: it ends, with no record; the porch's
    // own reset later is a new occurrence, recorded again.
    const porch = h.sirenDevice("porch");
    const answer = h.request({
      op: "group.update",
      body: {
        group: 1,
        name: "Downstairs",
        sensors: [h.sensor("front")],
        sirens: [porch],
        ifRevision: 0,
      },
    });
    expect(answer?.ok).toBe(true);
    expect(h.decisions(SIRENS_GONE)).toHaveLength(1);
    h.inject({ ...button, device: porch, record: rec(4) });
    expect(h.decisions(SIRENS_GONE).map((r) => [r.deviceId, [...groupsOf(r.detail)]])).toEqual([
      [hall, [groupId(1)]],
      [porch, [groupId(1)]],
    ]);
  });
});

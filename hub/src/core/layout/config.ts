/**
 * Making, changing and deleting groups and modes (m2-design.md section 6, `group.*`, `mode.*`;
 * sections 4 and 7): a name unique among its kind, compared as exact text (section 7, "Names");
 * every sensor, siren and group named must exist (`invalid {unknownReference}`); the fixed modes
 * cannot be changed or deleted (D90, `invalid {fixed}`); a change or a deletion names the
 * revision it was made against, and a stale one is a `conflict` carrying the object as it is;
 * deleting what a schedule entry names is refused, naming the entries (section 11, "Step 1's
 * questions, settled"). Changing a group changes no sensor's arming: its sirens apply from the
 * next trigger (section 7). Every change takes a new revision and is written now (section 3).
 * Permissions (*manage system*) are checked by `app` before the request arrives (section 2).
 */
import { ok } from "neverthrow";
import type { AppOp } from "@hsn/protocol/app";
import { alarmSensors } from "../alarm/view.ts";
import {
  type DeviceId,
  deviceId,
  type GroupId,
  groupId,
  type ModeId,
  modeId,
} from "../model/ids.ts";
import { ModeFixed } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { schedulesNaming } from "../schedules/view.ts";
import { sirenIds } from "../sirens/view.ts";
import { answered, type Changing, type Message, type Out, writeNow } from "./out.ts";
import type { Group, LayoutSlice, Mode } from "./state.ts";

type DeleteOp = Extract<AppOp, { readonly op: "group.delete" | "mode.delete" }>;
type ConfigOp = Extract<
  AppOp,
  {
    readonly op:
      | "group.create"
      | "group.update"
      | "group.delete"
      | "mode.create"
      | "mode.update"
      | "mode.delete";
  }
>;
type Outcome = Parameters<typeof answered>[1];
type Refusal = Extract<Outcome, { ok: false }>;

/** A group as the operations' replies and `conflict` carry it (section 6). */
export function groupObject(group: Group) {
  return {
    id: group.id,
    name: group.name,
    sensors: group.sensors,
    sirens: group.allSirens ? ("all" as const) : group.sirens,
    revision: group.revision,
  };
}

const FIXED_NAMES = {
  [ModeFixed.No]: "no",
  [ModeFixed.Away]: "away",
  [ModeFixed.Disarmed]: "disarmed",
} as const;

/** A mode as the operations' replies and `conflict` carry it (section 6). */
export function modeObject(mode: Mode) {
  return {
    id: mode.id,
    name: mode.name,
    fixed: FIXED_NAMES[mode.fixed],
    groups: mode.groups,
    revision: mode.revision,
  };
}

export function isConfigOp(op: AppOp): op is ConfigOp {
  return op.op.startsWith("group.") || (op.op.startsWith("mode.") && op.op !== "mode.switch");
}

function invalid(field: string, reason: "taken" | "unknownReference" | "fixed" | "range"): Refusal {
  return { ok: false, error: { code: "invalid", detail: { field, reason } } };
}

/** The first id of `ids` not in `known`, as `invalid {field.N, unknownReference}`. */
function unknownIn(
  field: string,
  ids: readonly number[],
  known: ReadonlySet<number>,
): Refusal | undefined {
  const at = ids.findIndex((id) => !known.has(id));
  return at < 0 ? undefined : invalid(`${field}.${at}`, "unknownReference");
}

/** A group's fields checked against what exists, or the refusal (section 6). */
function groupFields(
  slice: LayoutSlice,
  view: HubState,
  body: {
    readonly name: string;
    readonly sensors: readonly number[];
    readonly sirens: "all" | readonly number[];
  },
  self: GroupId | undefined,
): Refusal | Pick<Group, "name" | "sensors" | "allSirens" | "sirens"> {
  if ([...slice.groups.values()].some((g) => g.name === body.name && g.id !== self)) {
    return invalid("name", "taken");
  }
  const sensors = unknownIn("sensors", body.sensors, new Set(alarmSensors(view)));
  if (sensors !== undefined) return sensors;
  if (body.sirens !== "all") {
    // A list of no siren would sound nothing, which no group may (section 7): "all" is the way.
    if (body.sirens.length === 0) return invalid("sirens", "range");
    const sirens = unknownIn("sirens", body.sirens, new Set(sirenIds(view)));
    if (sirens !== undefined) return sirens;
  }
  return {
    name: body.name,
    sensors: [...new Set(body.sensors.map(deviceId))],
    allSirens: body.sirens === "all",
    sirens: body.sirens === "all" ? [] : [...new Set(body.sirens.map(deviceId))],
  };
}

/** A mode's fields checked against what exists, or the refusal (section 6). */
function modeFields(
  slice: LayoutSlice,
  body: { readonly name: string; readonly groups: readonly number[] },
  self: ModeId | undefined,
): Refusal | Pick<Mode, "name" | "groups"> {
  if ([...slice.modes.values()].some((m) => m.name === body.name && m.id !== self)) {
    return invalid("name", "taken");
  }
  const groups = unknownIn("groups", body.groups, new Set(slice.groups.keys()));
  if (groups !== undefined) return groups;
  return { name: body.name, groups: [...new Set(body.groups.map(groupId))] };
}

function isRefusal(value: object): value is Refusal {
  return "ok" in value;
}

/** The rows of a group that differ from `before` (none before a new one), written now. */
function groupRows(before: Group | undefined, next: Group): Out {
  const was = (list: readonly DeviceId[] | undefined, id: DeviceId) => list?.includes(id) === true;
  const prevSirens = before === undefined || before.allSirens ? [] : before.sirens;
  const nextSirens = next.allSirens ? [] : next.sirens;
  return [
    writeNow({
      table: "groups",
      op: "upsert",
      row: { id: next.id, name: next.name, allSirens: next.allSirens, revision: next.revision },
    }),
    ...(before?.sensors ?? [])
      .filter((s) => !next.sensors.includes(s))
      .map((sensorId) =>
        writeNow({ table: "group_members", op: "delete", key: { groupId: next.id, sensorId } }),
      ),
    ...next.sensors
      .filter((s) => !was(before?.sensors, s))
      .map((sensorId) =>
        writeNow({ table: "group_members", op: "upsert", row: { groupId: next.id, sensorId } }),
      ),
    ...(before?.sirens ?? [])
      .filter((s) => !nextSirens.includes(s))
      .map((sirenId) =>
        writeNow({ table: "group_sirens", op: "delete", key: { groupId: next.id, sirenId } }),
      ),
    ...nextSirens
      .filter((s) => !prevSirens.includes(s))
      .map((sirenId) =>
        writeNow({ table: "group_sirens", op: "upsert", row: { groupId: next.id, sirenId } }),
      ),
  ];
}

/** The rows of a mode that differ from `before` (none before a new one), written now. */
function modeRows(before: Mode | undefined, next: Mode): Out {
  return [
    writeNow({
      table: "modes",
      op: "upsert",
      row: { id: next.id, name: next.name, fixed: next.fixed, revision: next.revision },
    }),
    ...(before?.groups ?? [])
      .filter((g) => !next.groups.includes(g))
      .map((groupId) =>
        writeNow({ table: "mode_groups", op: "delete", key: { modeId: next.id, groupId } }),
      ),
    ...next.groups
      .filter((g) => before?.groups.includes(g) !== true)
      .map((groupId) =>
        writeNow({ table: "mode_groups", op: "upsert", row: { modeId: next.id, groupId } }),
      ),
  ];
}

/** The next id of a kind: one above every id held (section 4's row ids). */
function nextId(ids: Iterable<number>): number {
  return Math.max(0, ...ids) + 1;
}

function saveGroup(
  slice: LayoutSlice,
  view: HubState,
  message: Message<"opRequest">,
  op: Extract<ConfigOp, { op: "group.create" | "group.update" }>,
): Changing {
  const before = op.op === "group.update" ? slice.groups.get(groupId(op.body.group)) : undefined;
  if (op.op === "group.update") {
    if (before === undefined) {
      return refused(slice, message, {
        ok: false,
        error: { code: "notFound", detail: { what: "group", id: op.body.group } },
      });
    }
    if (before.revision !== op.body.ifRevision) {
      return refused(slice, message, {
        ok: false,
        error: {
          code: "conflict",
          detail: { revision: before.revision, object: groupObject(before) },
        },
      });
    }
  }
  const fields = groupFields(slice, view, op.body, before?.id);
  if (isRefusal(fields)) return refused(slice, message, fields);
  const next: Group = {
    ...fields,
    id: before?.id ?? groupId(nextId(slice.groups.keys())),
    revision: before === undefined ? 0 : before.revision + 1,
  };
  return ok({
    slice: { ...slice, groups: new Map(slice.groups).set(next.id, next) },
    out: [
      ...groupRows(before, next),
      ...answered(message.answerTo, { ok: true, body: groupObject(next) }),
    ],
  });
}

function saveMode(
  slice: LayoutSlice,
  message: Message<"opRequest">,
  op: Extract<ConfigOp, { op: "mode.create" | "mode.update" }>,
): Changing {
  const before = op.op === "mode.update" ? slice.modes.get(modeId(op.body.mode)) : undefined;
  if (op.op === "mode.update") {
    if (before === undefined) {
      return refused(slice, message, {
        ok: false,
        error: { code: "notFound", detail: { what: "mode", id: op.body.mode } },
      });
    }
    if (before.fixed !== ModeFixed.No) return refused(slice, message, invalid("mode", "fixed"));
    if (before.revision !== op.body.ifRevision) {
      return refused(slice, message, {
        ok: false,
        error: {
          code: "conflict",
          detail: { revision: before.revision, object: modeObject(before) },
        },
      });
    }
  }
  const fields = modeFields(slice, op.body, before?.id);
  if (isRefusal(fields)) return refused(slice, message, fields);
  const next: Mode = {
    ...fields,
    id: before?.id ?? modeId(nextId(slice.modes.keys())),
    fixed: ModeFixed.No,
    revision: before === undefined ? 0 : before.revision + 1,
  };
  return ok({
    slice: { ...slice, modes: new Map(slice.modes).set(next.id, next) },
    out: [
      ...modeRows(before, next),
      ...answered(message.answerTo, { ok: true, body: modeObject(next) }),
    ],
  });
}

function refused(
  slice: LayoutSlice,
  message: Message<"opRequest">,
  error: Parameters<typeof answered>[1],
): Changing {
  return ok({ slice, out: answered(message.answerTo, error) });
}

/**
 * A group deleted: its rows go, and the user modes that held it lose it, each with a new revision
 * (SPEC-QUESTION: section 7 does not say; a mode keeps its other groups).
 */
function deleteGroup(
  slice: LayoutSlice,
  view: HubState,
  message: Message<"opRequest">,
  op: Extract<DeleteOp, { op: "group.delete" }>,
): Changing {
  const id = groupId(op.body.group);
  const group = slice.groups.get(id);
  if (group === undefined) {
    return refused(slice, message, {
      ok: false,
      error: { code: "notFound", detail: { what: "group", id } },
    });
  }
  if (group.revision !== op.body.ifRevision) {
    return refused(slice, message, {
      ok: false,
      error: { code: "conflict", detail: { revision: group.revision, object: groupObject(group) } },
    });
  }
  const named = schedulesNaming(view, { group: id });
  if (named.length > 0) {
    return refused(slice, message, {
      ok: false,
      error: { code: "invalid", detail: { field: "group", reason: "inUse", refs: named } },
    });
  }
  const groups = new Map(slice.groups);
  groups.delete(id);
  const modes = new Map(slice.modes);
  const out: Out[number][] = [
    ...group.sensors.map((sensorId) =>
      writeNow({ table: "group_members", op: "delete", key: { groupId: id, sensorId } }),
    ),
    ...group.sirens.map((sirenId) =>
      writeNow({ table: "group_sirens", op: "delete", key: { groupId: id, sirenId } }),
    ),
    writeNow({ table: "groups", op: "delete", key: { id } }),
  ];
  for (const mode of slice.modes.values()) {
    if (!mode.groups.includes(id)) continue;
    const next: Mode = {
      ...mode,
      groups: mode.groups.filter((g) => g !== id),
      revision: mode.revision + 1,
    };
    modes.set(mode.id, next);
    out.push(
      writeNow({ table: "mode_groups", op: "delete", key: { modeId: mode.id, groupId: id } }),
      writeNow({
        table: "modes",
        op: "upsert",
        row: { id: next.id, name: next.name, fixed: next.fixed, revision: next.revision },
      }),
    );
  }
  return ok({
    slice: { ...slice, groups, modes },
    out: [...out, ...answered(message.answerTo, { ok: true, body: {} })],
  });
}

/**
 * A mode deleted: the fixed ones are refused (D90). Deleting the current mode leaves arming that
 * matches no mode, as the migration's mixed site (SPEC-QUESTION: section 7 does not say).
 */
function deleteMode(
  slice: LayoutSlice,
  view: HubState,
  message: Message<"opRequest">,
  op: Extract<DeleteOp, { op: "mode.delete" }>,
): Changing {
  const id = modeId(op.body.mode);
  const mode = slice.modes.get(id);
  if (mode === undefined) {
    return refused(slice, message, {
      ok: false,
      error: { code: "notFound", detail: { what: "mode", id } },
    });
  }
  if (mode.fixed !== ModeFixed.No) {
    return refused(slice, message, {
      ok: false,
      error: { code: "invalid", detail: { field: "mode", reason: "fixed" } },
    });
  }
  if (mode.revision !== op.body.ifRevision) {
    return refused(slice, message, {
      ok: false,
      error: { code: "conflict", detail: { revision: mode.revision, object: modeObject(mode) } },
    });
  }
  const named = schedulesNaming(view, { mode: id });
  if (named.length > 0) {
    return refused(slice, message, {
      ok: false,
      error: { code: "invalid", detail: { field: "mode", reason: "inUse", refs: named } },
    });
  }
  const modes = new Map(slice.modes);
  modes.delete(id);
  const current = slice.current === id;
  const next: LayoutSlice = {
    ...slice,
    modes,
    ...(current ? { current: null, modified: true } : {}),
  };
  return ok({
    slice: next,
    out: [
      ...mode.groups.map((groupId) =>
        writeNow({ table: "mode_groups", op: "delete", key: { modeId: id, groupId } }),
      ),
      writeNow({ table: "modes", op: "delete", key: { id } }),
      ...(current
        ? [
            writeNow({
              table: "mode_state",
              op: "upsert",
              row: { currentModeId: null, modeModified: true },
            }),
          ]
        : []),
      ...answered(message.answerTo, { ok: true, body: {} }),
    ],
  });
}

export function onConfig(
  slice: LayoutSlice,
  view: HubState,
  message: Message<"opRequest">,
  op: ConfigOp,
): Changing {
  switch (op.op) {
    case "group.create":
    case "group.update":
      return saveGroup(slice, view, message, op);
    case "mode.create":
    case "mode.update":
      return saveMode(slice, message, op);
    case "group.delete":
      return deleteGroup(slice, view, message, op);
    case "mode.delete":
      return deleteMode(slice, view, message, op);
  }
}

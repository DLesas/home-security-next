/**
 * The layout module's handler (m2-design.md section 2, module 7; section 7, "Modes, groups and
 * arming"; section 11, "Step 1's questions, settled"; D50, D74, D90, D95, D117).
 *
 * - **Boot**: the groups, modes and `mode_state` as stored. Migration 2 made the two fixed modes
 *   and gave an existing site its mode from its sensors' states (section 4); a database without
 *   those rows (a test's) gets the same, in memory.
 * - **Arming requests** (`mode.switch`, `arm`, `disarm`, from control, app or schedules) are
 *   resolved to sensors (`resolve.ts`) and sent to the alarm module as `armSensors` or
 *   `disarmSensors`, which arms, disarms and answers whoever asked. Before sending, layout asks
 *   the alarm's view what the alarm will do: only a switch the alarm will make is recorded
 *   (`mode_switched`, before the per-sensor `armed` and `disarmed`, section 1) and sets the
 *   current mode, clearing `mode_modified` (a schedule's that held sensors back sets it, D117);
 *   every other arming action the alarm takes is recorded as `arming_changed`, its notice's
 *   summary, and one that changes a sensor sets `mode_modified`. A refused request
 *   (`needsConfirmation`) records and changes nothing here.
 * - **M1a's `hsn arm <sensor>…` and `hsn disarm <sensor>…`** go to the alarm as built; layout
 *   records their `arming_changed` and sets `mode_modified` as for any arming of a sensor.
 * - **A removed device** leaves its groups: a sensor their members, a siren their lists, and a
 *   list left empty returns its group to every siren (section 7).
 * - **Making, changing and deleting groups and modes** (`config.ts`).
 * - A sensor added while a mode is current starts disarmed (section 12, Q8): the alarm adds it
 *   disarmed and nothing here changes; Away, which is every sensor, arms it at its next switch.
 */
import { ok } from "neverthrow";
import {
  actorText,
  alarmSensors,
  armingAskOf,
  armingPlan,
  armRequestAsk,
  disarmingPlan,
} from "../alarm/view.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Context, Handler } from "../model/handler.ts";
import {
  AWAY_MODE,
  type DeviceId,
  deviceId,
  DISARMED_MODE,
  type GroupId,
  type ModeId,
  type Seq,
} from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { ArmState, DeviceState, type ModeStateRow } from "../model/rows.ts";
import { notBuiltAnswer } from "../util/not-built.ts";
import { actorDetail, decision } from "../util/records.ts";
import { isConfigOp, onConfig } from "./config.ts";
import {
  answered,
  type Changed,
  type Changing,
  type Message,
  type Out,
  unchanged,
  writeNow,
} from "./out.ts";
import { isArmingOp, resolve } from "./resolve.ts";
import { FIXED_MODES, type Group, type LayoutSlice, type Mode } from "./state.ts";

function modeStateRow(slice: LayoutSlice): ModeStateRow {
  return { currentModeId: slice.current, modeModified: slice.modified };
}

/**
 * `mode_state` as migration 2 inserts it from the sensors' states (section 4): Disarmed when no
 * sensor is armed (a site with no sensor too), Away when every one is, otherwise no mode, changed.
 * A sensor waiting for its door counts as armed; a removed one not at all.
 */
export function migrationModeState(snapshot: DurableSnapshot): ModeStateRow {
  const live = new Set(
    snapshot.devices.filter((d) => d.state !== DeviceState.Removed).map((d) => d.id),
  );
  const arms = snapshot.sensorConfig.filter((c) => live.has(c.deviceId)).map((c) => c.arm);
  const armed = arms.filter((arm) => arm !== ArmState.Disarmed).length;
  if (armed === 0) return { currentModeId: DISARMED_MODE, modeModified: false };
  if (armed === arms.length) return { currentModeId: AWAY_MODE, modeModified: false };
  return { currentModeId: null, modeModified: true };
}

/** The slice from what is stored (section 4), the fixed modes always among the modes (D90). */
export function loadLayout(snapshot: DurableSnapshot): LayoutSlice {
  const { m2 } = snapshot;
  const members = new Map<GroupId, DeviceId[]>();
  for (const row of m2.groupMembers) {
    members.set(row.groupId, [...(members.get(row.groupId) ?? []), row.sensorId]);
  }
  const sirens = new Map<GroupId, DeviceId[]>();
  for (const row of m2.groupSirens) {
    sirens.set(row.groupId, [...(sirens.get(row.groupId) ?? []), row.sirenId]);
  }
  const modeGroups = new Map<ModeId, GroupId[]>();
  for (const row of m2.modeGroups) {
    modeGroups.set(row.modeId, [...(modeGroups.get(row.modeId) ?? []), row.groupId]);
  }
  const groups = new Map(
    m2.groups.map((row): [GroupId, Group] => [
      row.id,
      {
        id: row.id,
        name: row.name,
        allSirens: row.allSirens,
        sensors: members.get(row.id) ?? [],
        sirens: sirens.get(row.id) ?? [],
        revision: row.revision,
      },
    ]),
  );
  const stored = m2.modes.map((row): [ModeId, Mode] => [
    row.id,
    { ...row, groups: modeGroups.get(row.id) ?? [] },
  ]);
  const fixed = FIXED_MODES.filter((mode) => !stored.some(([, m]) => m.fixed === mode.fixed));
  const state = m2.modeState ?? migrationModeState(snapshot);
  return {
    timers: [],
    groups,
    modes: new Map([...fixed.map((mode): [ModeId, Mode] => [mode.id, mode]), ...stored]),
    current: state.currentModeId,
    modified: state.modeModified,
  };
}

/** `mode_modified` set: arming changed since the last switch (section 7). */
function modified(slice: LayoutSlice): Changed {
  if (slice.modified) return { slice, out: [] };
  const next: LayoutSlice = { ...slice, modified: true };
  return {
    slice: next,
    out: [writeNow({ table: "mode_state", op: "upsert", row: modeStateRow(next) })],
  };
}

/**
 * An arming action that is not a switch (a group, a sensor, `mine`, `hsn arm <sensor>…`),
 * recorded before the alarm's per-sensor decisions as `arming_changed`, its notice's summary
 * (section 7): value 1 an arm, 0 a disarm; the sensor when it named one; in its detail the
 * sensors it changes, each a device number as u32 LE (`sensorList`), which `notify` reads for the
 * notice's recipients. The actor is the per-sensor decisions' and the cause's (AL8). Then
 * `mode_modified` when it changes a sensor, and the request.
 */
function armingChanged(
  slice: LayoutSlice,
  ctx: Context,
  fields: {
    readonly arm: boolean;
    readonly sensor: DeviceId | undefined;
    readonly record: Seq;
    /** The sensors the action changes, in the alarm's order of acting. */
    readonly changed: readonly DeviceId[];
  },
  request: Internal | undefined,
): Changing {
  return decision(ctx, "routine", {
    kind: "arming_changed",
    device: fields.sensor,
    cause: fields.record,
    value: fields.arm ? 1 : 0,
    detail: sensorList(fields.changed),
  }).map(({ message }) => {
    const changed = fields.changed.length > 0 ? modified(slice) : { slice, out: [] };
    return {
      slice: changed.slice,
      out: [message, ...changed.out, ...(request === undefined ? [] : [request])],
    };
  });
}

/** Device numbers as a decision's detail, u32 LE each (HD 6, as `gateway_offline`'s). */
export function sensorList(sensors: readonly DeviceId[]): Uint8Array {
  const bytes = new Uint8Array(sensors.length * 4);
  const view = new DataView(bytes.buffer);
  sensors.forEach((sensor, i) => {
    view.setUint32(i * 4, sensor, true);
  });
  return bytes;
}

/** The sensor an arming operation named, when it named one. */
function namedSensor(op: Message<"opRequest">["op"]): DeviceId | undefined {
  if (op.op !== "arm" && op.op !== "disarm") return undefined;
  const target = op.body.target;
  return typeof target === "object" && "sensor" in target ? deviceId(target.sensor) : undefined;
}

/** A mode switch, an arm or a disarm, resolved and sent to the alarm (section 7). */
function onArmingOp(slice: LayoutSlice, ctx: Context, message: Message<"opRequest">): Changing {
  const { op, actor, answerTo, record } = message;
  if (!isArmingOp(op)) return unchanged(slice);
  const resolved = resolve(ctx.view, slice, op, actor);
  const text = actorText(actor);
  switch (resolved.kind) {
    case "notFound":
      return ok({
        slice,
        out: answered(answerTo, {
          ok: false,
          error: { code: "notFound", detail: { what: resolved.what, id: resolved.id } },
        }),
      });
    case "disarm": {
      // A schedule's disarm holds back the triggers and counting sensors (D117): the alarm
      // follows the actor, and so does the plan read here.
      const plan = disarmingPlan(ctx.view, resolved.sensors, actor.kind === "schedule");
      const request: Internal = {
        kind: "disarmSensors",
        sensors: resolved.sensors,
        actor,
        answerTo,
        record,
      };
      if (plan.unknown.length > 0) return ok({ slice, out: [request] });
      return armingChanged(
        slice,
        ctx,
        {
          arm: false,
          sensor: namedSensor(op),
          record,
          changed: plan.toDisarm,
        },
        request,
      );
    }
    case "arm": {
      const request: Message<"armSensors"> = {
        kind: "armSensors",
        sensors: resolved.sensors,
        mode: resolved.mode?.id,
        confirm: resolved.confirm,
        actor,
        answerTo,
        record,
      };
      const plan = armingPlan(ctx.view, armingAskOf(request));
      if (plan.kind !== "go") return ok({ slice, out: [request] });
      const mode = resolved.mode;
      if (mode === undefined) {
        return armingChanged(
          slice,
          ctx,
          {
            arm: true,
            sensor: namedSensor(op),
            record,
            changed: plan.toArm,
          },
          request,
        );
      }
      // The switch sets the current mode and clears `mode_modified` (section 7); a schedule's
      // that held sensors back (D117) leaves arming other than the mode's, and sets it.
      const next: LayoutSlice = { ...slice, current: mode.id, modified: plan.heldBack.length > 0 };
      // A switch to the mode already current, unchanged, writes nothing: the row is as it is.
      const same = next.current === slice.current && next.modified === slice.modified;
      // Written now (section 11, "Step 1's questions, settled"): in the switch's own commit, and
      // a switch that changes no sensor is not lost in a power cut either.
      return decision(ctx, "now", {
        kind: "mode_switched",
        device: undefined,
        cause: record,
        value: mode.id,
        detail: actorDetail(text),
      }).map(({ message: switched }) => ({
        slice: same ? slice : next,
        out: [
          switched,
          ...(same
            ? []
            : [writeNow({ table: "mode_state", op: "upsert", row: modeStateRow(next) })]),
          request,
        ],
      }));
    }
  }
}

/**
 * M1a's `hsn arm <sensor>…` and `hsn disarm <sensor>…`, which go to the alarm as built (AL1):
 * one the alarm will take is recorded here as `arming_changed`, `hsn`'s through layout (section
 * 11, "Step 1's questions, settled"), and one that changes a sensor sets `mode_modified`.
 */
function onM1Request(
  slice: LayoutSlice,
  ctx: Context,
  message: Message<"armRequest"> | Message<"disarmRequest">,
): Changing {
  const sensors = message.sensors === "all" ? alarmSensors(ctx.view) : message.sensors;
  const single = sensors.length === 1 ? sensors[0] : undefined;
  const fields = { sensor: single, record: message.record };
  if (message.kind === "disarmRequest") {
    const plan = disarmingPlan(ctx.view, sensors, false);
    if (plan.unknown.length > 0) return unchanged(slice);
    return armingChanged(slice, ctx, { ...fields, arm: false, changed: plan.toDisarm }, undefined);
  }
  const plan = armingPlan(ctx.view, armRequestAsk(sensors, message.continueOpen));
  if (plan.kind !== "go") return unchanged(slice);
  return armingChanged(slice, ctx, { ...fields, arm: true, changed: plan.toArm }, undefined);
}

/**
 * A removed device leaves its groups (section 7): a sensor their members, a siren their lists; a
 * list left empty returns its group to every siren ‡, so no group can silently sound nothing.
 * Each group changed takes a new revision, written now with its rows.
 */
function onDeviceRemoved(slice: LayoutSlice, device: DeviceId): Changing {
  const touched = [...slice.groups.values()].filter(
    (g) => g.sensors.includes(device) || g.sirens.includes(device),
  );
  if (touched.length === 0) return unchanged(slice);
  const groups = new Map(slice.groups);
  const out: Out[number][] = [];
  for (const group of touched) {
    const sirens = group.sirens.filter((s) => s !== device);
    const next: Group = {
      ...group,
      sensors: group.sensors.filter((s) => s !== device),
      sirens,
      allSirens: group.allSirens || sirens.length === 0,
      revision: group.revision + 1,
    };
    groups.set(group.id, next);
    if (group.sensors.includes(device)) {
      out.push(
        writeNow({
          table: "group_members",
          op: "delete",
          key: { groupId: group.id, sensorId: device },
        }),
      );
    }
    if (group.sirens.includes(device)) {
      out.push(
        writeNow({
          table: "group_sirens",
          op: "delete",
          key: { groupId: group.id, sirenId: device },
        }),
      );
    }
    out.push(
      writeNow({
        table: "groups",
        op: "upsert",
        row: { id: next.id, name: next.name, allSirens: next.allSirens, revision: next.revision },
      }),
    );
  }
  return ok({ slice: { ...slice, groups }, out });
}

function route(slice: LayoutSlice, message: Internal, ctx: Context): Changing {
  switch (message.kind) {
    case "boot":
      return unchanged(loadLayout(message.snapshot));
    case "opRequest":
      if (message.owner !== "layout") return unchanged(slice);
      if (isArmingOp(message.op)) return onArmingOp(slice, ctx, message);
      if (isConfigOp(message.op)) return onConfig(slice, ctx.view, message, message.op);
      return ok({ slice, out: [notBuiltAnswer(message)] });
    case "armRequest":
    case "disarmRequest":
      return onM1Request(slice, ctx, message);
    case "deviceRemoved":
      return onDeviceRemoved(slice, message.device);
    default:
      return unchanged(slice);
  }
}

export const handleLayout: Handler<"layout"> = route;

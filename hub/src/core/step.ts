/**
 * The core's one function and its dispatcher (hub-design.md section 2, "The function" and
 * "Modules and the dispatcher").
 *
 * A step puts every due timer on the queue, earliest first, then the input's event; it then
 * takes messages from the front until the queue is empty. Every message goes to the twenty-two
 * modules in the fixed order of `MODULE_ORDER`, except a timer, which goes to its owner only; a
 * handler returns its slice unchanged for messages it ignores. Each handler sees the state after
 * every earlier handler, and what it emits joins the back of the queue (messages) or the step's
 * effects (effects), in order. The same state and input always give the same result.
 *
 * The order, as the joint step 0 of M3 and M4 placed it (docs/m3-m4-plan.md): clock, registry,
 * links, setup, control, people, relay, layout, app, schedules, gateways, intake, alarm, site,
 * firmware, sensors, slots, sirens, health, notify, upkeep, audit.
 */
import { err, ok, type Result } from "neverthrow";
import { alarmDeadlines } from "./alarm/deadlines.ts";
import { handleAlarm } from "./alarm/handle.ts";
import { EMPTY_ALARM_SLICE } from "./alarm/state.ts";
import { auditDeadlines } from "./audit/deadlines.ts";
import { handleAudit } from "./audit/handle.ts";
import { EMPTY_AUDIT_SLICE } from "./audit/state.ts";
import { nextRecordSeq } from "./audit/view.ts";
import { clockDeadlines } from "./clock/deadlines.ts";
import { handleClock } from "./clock/handle.ts";
import { EMPTY_CLOCK_SLICE } from "./clock/state.ts";
import { controlDeadlines } from "./control/deadlines.ts";
import { handleControl } from "./control/handle.ts";
import { EMPTY_CONTROL_SLICE } from "./control/state.ts";
import { gatewaysDeadlines } from "./gateways/deadlines.ts";
import { handleGateways } from "./gateways/handle.ts";
import { EMPTY_GATEWAYS_SLICE } from "./gateways/state.ts";
import { intakeDeadlines } from "./intake/deadlines.ts";
import { handleIntake } from "./intake/handle.ts";
import { EMPTY_INTAKE_SLICE } from "./intake/state.ts";
import { linksDeadlines } from "./links/deadlines.ts";
import { handleLinks } from "./links/handle.ts";
import { EMPTY_LINKS_SLICE } from "./links/state.ts";
import { EFFECT_KINDS, type Effect } from "./model/effects.ts";
import { type CoreFault, coreFault } from "./model/errors.ts";
import type { HubEvent, Input } from "./model/events.ts";
import type {
  Context,
  CoreDeps,
  Handled,
  Handler,
  RecordCursor,
  StepFunction,
  Stepped,
} from "./model/handler.ts";
import { RECORDS_PER_BOOT, recordSeq, type Seq, seqBoot } from "./model/ids.ts";
import type { Internal } from "./model/messages.ts";
import { MODULE_ORDER, type ModuleName } from "./model/modules.ts";
import type { HubState } from "./model/state.ts";
import type { Mono } from "./model/time.ts";
import type { Timer, TimerOf } from "./model/timers.ts";
import { registryDeadlines } from "./registry/deadlines.ts";
import { handleRegistry } from "./registry/handle.ts";
import { EMPTY_REGISTRY_SLICE } from "./registry/state.ts";
import { sensorsDeadlines } from "./sensors/deadlines.ts";
import { handleSensors } from "./sensors/handle.ts";
import { EMPTY_SENSORS_SLICE } from "./sensors/state.ts";
import { setupDeadlines } from "./setup/deadlines.ts";
import { handleSetup } from "./setup/handle.ts";
import { EMPTY_SETUP_SLICE } from "./setup/state.ts";
import { sirensDeadlines } from "./sirens/deadlines.ts";
import { handleSirens } from "./sirens/handle.ts";
import { EMPTY_SIRENS_SLICE } from "./sirens/state.ts";
import { siteDeadlines } from "./site/deadlines.ts";
import { handleSite } from "./site/handle.ts";
import { EMPTY_SITE_SLICE } from "./site/state.ts";
import { slotsDeadlines } from "./slots/deadlines.ts";
import { handleSlots } from "./slots/handle.ts";
import { EMPTY_SLOTS_SLICE } from "./slots/state.ts";
import { entropyCursor } from "./util/entropy.ts";
import { peopleDeadlines } from "./people/deadlines.ts";
import { handlePeople } from "./people/handle.ts";
import { EMPTY_PEOPLE_SLICE } from "./people/state.ts";
import { layoutDeadlines } from "./layout/deadlines.ts";
import { handleLayout } from "./layout/handle.ts";
import { EMPTY_LAYOUT_SLICE } from "./layout/state.ts";
import { appDeadlines } from "./app/deadlines.ts";
import { handleApp } from "./app/handle.ts";
import { EMPTY_APP_SLICE } from "./app/state.ts";
import { schedulesDeadlines } from "./schedules/deadlines.ts";
import { handleSchedules } from "./schedules/handle.ts";
import { EMPTY_SCHEDULES_SLICE } from "./schedules/state.ts";
import { healthDeadlines } from "./health/deadlines.ts";
import { handleHealth } from "./health/handle.ts";
import { EMPTY_HEALTH_SLICE } from "./health/state.ts";
import { notifyDeadlines } from "./notify/deadlines.ts";
import { handleNotify } from "./notify/handle.ts";
import { EMPTY_NOTIFY_SLICE } from "./notify/state.ts";
import { upkeepDeadlines } from "./upkeep/deadlines.ts";
import { handleUpkeep } from "./upkeep/handle.ts";
import { EMPTY_UPKEEP_SLICE } from "./upkeep/state.ts";
import { firmwareDeadlines } from "./firmware/deadlines.ts";
import { handleFirmware } from "./firmware/handle.ts";
import { EMPTY_FIRMWARE_SLICE } from "./firmware/state.ts";
import { relayDeadlines } from "./relay/deadlines.ts";
import { handleRelay } from "./relay/handle.ts";
import { EMPTY_RELAY_SLICE } from "./relay/state.ts";

/** A step that would handle more messages than this is a loop: a `CoreFault` (section 2). */
export const MAX_MESSAGES_PER_STEP = 10_000;

/** What the dispatcher needs of one module. */
export interface ModuleDefinition<K extends ModuleName> {
  /** The slice before the boot event. */
  readonly empty: HubState[K];
  readonly handle: Handler<K>;
  /** The module's timers (section 2, "Timers"). */
  readonly deadlines: (slice: HubState[K]) => readonly TimerOf<K>[];
}

/** One definition per module. */
export type Modules = { readonly [K in ModuleName]: ModuleDefinition<K> };

/**
 * The twenty-two modules of the core: M1a's thirteen, M2's seven (m2-design.md section 2) and the
 * joint step 0's two (`relay`, `firmware`; docs/m3-m4-plan.md).
 */
export const MODULES: Modules = {
  clock: { empty: EMPTY_CLOCK_SLICE, handle: handleClock, deadlines: clockDeadlines },
  registry: { empty: EMPTY_REGISTRY_SLICE, handle: handleRegistry, deadlines: registryDeadlines },
  links: { empty: EMPTY_LINKS_SLICE, handle: handleLinks, deadlines: linksDeadlines },
  setup: { empty: EMPTY_SETUP_SLICE, handle: handleSetup, deadlines: setupDeadlines },
  control: { empty: EMPTY_CONTROL_SLICE, handle: handleControl, deadlines: controlDeadlines },
  people: { empty: EMPTY_PEOPLE_SLICE, handle: handlePeople, deadlines: peopleDeadlines },
  relay: { empty: EMPTY_RELAY_SLICE, handle: handleRelay, deadlines: relayDeadlines },
  layout: { empty: EMPTY_LAYOUT_SLICE, handle: handleLayout, deadlines: layoutDeadlines },
  app: { empty: EMPTY_APP_SLICE, handle: handleApp, deadlines: appDeadlines },
  schedules: {
    empty: EMPTY_SCHEDULES_SLICE,
    handle: handleSchedules,
    deadlines: schedulesDeadlines,
  },
  gateways: { empty: EMPTY_GATEWAYS_SLICE, handle: handleGateways, deadlines: gatewaysDeadlines },
  intake: { empty: EMPTY_INTAKE_SLICE, handle: handleIntake, deadlines: intakeDeadlines },
  alarm: { empty: EMPTY_ALARM_SLICE, handle: handleAlarm, deadlines: alarmDeadlines },
  site: { empty: EMPTY_SITE_SLICE, handle: handleSite, deadlines: siteDeadlines },
  firmware: { empty: EMPTY_FIRMWARE_SLICE, handle: handleFirmware, deadlines: firmwareDeadlines },
  sensors: { empty: EMPTY_SENSORS_SLICE, handle: handleSensors, deadlines: sensorsDeadlines },
  slots: { empty: EMPTY_SLOTS_SLICE, handle: handleSlots, deadlines: slotsDeadlines },
  sirens: { empty: EMPTY_SIRENS_SLICE, handle: handleSirens, deadlines: sirensDeadlines },
  health: { empty: EMPTY_HEALTH_SLICE, handle: handleHealth, deadlines: healthDeadlines },
  notify: { empty: EMPTY_NOTIFY_SLICE, handle: handleNotify, deadlines: notifyDeadlines },
  upkeep: { empty: EMPTY_UPKEEP_SLICE, handle: handleUpkeep, deadlines: upkeepDeadlines },
  audit: { empty: EMPTY_AUDIT_SLICE, handle: handleAudit, deadlines: auditDeadlines },
};

/** The core built from a set of modules: the real twenty-two, or a test's. */
export interface Core {
  readonly step: StepFunction;
  readonly nextDeadline: (state: HubState) => Mono | undefined;
  readonly emptyState: () => HubState;
  /**
   * Every module's timers, in module order, for the loop's guard against a deadline left in the
   * past (`HubLoop`). A core without it (a test's stand-in) is guarded by `nextDeadline` alone.
   */
  readonly deadlines?: (state: HubState) => readonly Timer[];
}

/** The first timer of `state` at or before `now`: a deadline a step must not leave behind. */
export function overdueTimer(timers: readonly Timer[], now: Mono): Timer | undefined {
  return timers.find((timer) => timer.at <= now);
}

const effectKinds: ReadonlySet<string> = new Set(EFFECT_KINDS);

function isEffect(item: Internal | Effect): item is Effect {
  return effectKinds.has(item.kind);
}

/** Every timer of every module, in module order. */
function allTimers(modules: Modules, state: HubState): readonly Timer[] {
  return MODULE_ORDER.flatMap((name) => timersOf(modules, state, name));
}

function timersOf<K extends ModuleName>(
  modules: Modules,
  state: HubState,
  name: K,
): readonly TimerOf<K>[] {
  const module: ModuleDefinition<K> = modules[name];
  return module.deadlines(state[name]);
}

/** Runs one module's handler on its own slice. */
function deliver<K extends ModuleName>(
  modules: Modules,
  state: HubState,
  name: K,
  message: Internal,
  ctx: Context,
): Result<Handled<K>, CoreFault> {
  const module: ModuleDefinition<K> = modules[name];
  return module.handle(state[name], message, ctx);
}

/**
 * Sequence numbers for one step: from the boot's first on a `boot` input, otherwise from the
 * audit module's next one.
 */
function recordCursor(start: Seq, event: HubEvent["kind"]): RecordCursor {
  const boot = seqBoot(start);
  let n = start - boot * RECORDS_PER_BOOT;
  return {
    take() {
      const taken = recordSeq(boot, n);
      if (taken === undefined) {
        return err(coreFault(event, "core/step", "record sequence exhausted", { boot, n }));
      }
      n += 1;
      return ok(taken);
    },
  };
}

function firstSeqOf(input: Input, state: HubState): Seq | undefined {
  return input.event.kind === "boot" ? recordSeq(input.event.boot.id, 0) : nextRecordSeq(state);
}

/**
 * Freezes the state and everything in it. Typed arrays cannot be frozen and Maps and Sets keep
 * their methods, so for those the readonly types are the guard; their contents are frozen.
 */
function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return;
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      deepFreeze(key, seen);
      deepFreeze(entry, seen);
    }
  } else if (value instanceof Set) {
    for (const entry of value) deepFreeze(entry, seen);
  } else {
    for (const entry of Object.values(value)) deepFreeze(entry, seen);
  }
  Object.freeze(value);
}

/** Builds `step`, `nextDeadline` and `emptyState` over a set of modules. */
export function makeCore(modules: Modules): Core {
  function nextDeadline(state: HubState): Mono | undefined {
    let earliest: Mono | undefined;
    for (const timer of allTimers(modules, state)) {
      if (earliest === undefined || timer.at < earliest) earliest = timer.at;
    }
    return earliest;
  }

  function emptyState(): HubState {
    return {
      clock: modules.clock.empty,
      registry: modules.registry.empty,
      links: modules.links.empty,
      setup: modules.setup.empty,
      control: modules.control.empty,
      people: modules.people.empty,
      relay: modules.relay.empty,
      layout: modules.layout.empty,
      app: modules.app.empty,
      schedules: modules.schedules.empty,
      gateways: modules.gateways.empty,
      intake: modules.intake.empty,
      alarm: modules.alarm.empty,
      site: modules.site.empty,
      firmware: modules.firmware.empty,
      sensors: modules.sensors.empty,
      slots: modules.slots.empty,
      sirens: modules.sirens.empty,
      health: modules.health.empty,
      notify: modules.notify.empty,
      upkeep: modules.upkeep.empty,
      audit: modules.audit.empty,
    };
  }

  function step(state: HubState, input: Input, deps: CoreDeps): Result<Stepped, CoreFault> {
    const event = input.event.kind;
    const firstSeq = firstSeqOf(input, state);
    if (firstSeq === undefined) {
      return err(coreFault(event, "core/step", "boot id out of range for record sequences"));
    }
    const entropy = entropyCursor(input.entropy, event);
    const records = recordCursor(firstSeq, event);

    // Due timers first, earliest first; equal times keep module order (the sort is stable).
    const due = allTimers(modules, state)
      .filter((timer) => timer.at <= input.now.mono)
      .toSorted((a, b) => a.at - b.at);
    const queue: Internal[] = [
      ...due.map((timer): Internal => ({ kind: "timer", key: timer.key, at: timer.at })),
      input.event,
    ];
    const effects: Effect[] = [];
    let current = state;

    for (let next = 0; next < queue.length; next++) {
      if (next >= MAX_MESSAGES_PER_STEP) {
        return err(
          coreFault(event, "core/step", "too many messages in one step", {
            limit: MAX_MESSAGES_PER_STEP,
          }),
        );
      }
      const message = queue[next];
      if (message === undefined) break;
      const targets: readonly ModuleName[] =
        message.kind === "timer" ? [message.key.module] : MODULE_ORDER;
      for (const name of targets) {
        const ctx: Context = { now: input.now, view: current, deps, entropy, records, event };
        const handled = deliver(modules, current, name, message, ctx);
        if (handled.isErr()) return err(handled.error);
        const { slice, out } = handled.value;
        if (slice !== current[name]) current = { ...current, [name]: slice };
        for (const item of out) {
          if (isEffect(item)) effects.push(item);
          else queue.push(item);
        }
      }
    }

    if (deps.checkDeadlines === true) {
      const left = overdueTimer(allTimers(modules, current), input.now.mono);
      if (left !== undefined) {
        return err(
          coreFault(
            event,
            `core/${left.key.module}`,
            `a deadline left at or before the step's time: ${left.key.module} ${JSON.stringify(left.key)} at ${String(left.at)}, the step at ${String(input.now.mono)}`,
            {
              module: left.key.module,
              timer: JSON.stringify(left.key),
              at: left.at,
              now: input.now.mono,
            },
          ),
        );
      }
    }
    if (deps.deepFreeze === true) deepFreeze(current);
    return ok({ state: current, effects, wake: nextDeadline(current) });
  }

  return {
    step,
    nextDeadline,
    emptyState,
    deadlines: (state: HubState) => allTimers(modules, state),
  };
}

const core = makeCore(MODULES);

/** `step(state, input, deps)`: the new state, the effects and the next wake (section 2). */
export const step: StepFunction = core.step;

/** The earliest timer of every module, or undefined when there is none. */
export const nextDeadline: (state: HubState) => Mono | undefined = core.nextDeadline;

/** The state before the boot event: every module's empty slice. */
export const emptyState: () => HubState = core.emptyState;

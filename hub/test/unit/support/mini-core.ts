/**
 * The clock and audit modules through a dispatcher of their own, for their unit tests
 * (hub-design.md section 2, "Modules and the dispatcher"). It keeps the real
 * dispatcher's rules that matter to these two: due timers first, then the event, then every
 * message emitted, each to the modules in order (clock first, a test's stand-in modules next,
 * audit last), a timer to its owner only, and one record cursor per step, starting at the boot's
 * first sequence number on a boot input and otherwise where audit says.
 */
import { err, ok, type Result } from "neverthrow";
import { auditDeadlines } from "../../../src/core/audit/deadlines.ts";
import { handleAudit } from "../../../src/core/audit/handle.ts";
import { type AuditSlice, EMPTY_AUDIT_SLICE } from "../../../src/core/audit/state.ts";
import { handleClock } from "../../../src/core/clock/handle.ts";
import { type ClockSlice, EMPTY_CLOCK_SLICE } from "../../../src/core/clock/state.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import { type CoreFault, coreFault } from "../../../src/core/model/errors.ts";
import type { DurableSnapshot, Input } from "../../../src/core/model/events.ts";
import type { Context, CoreDeps, RecordCursor } from "../../../src/core/model/handler.ts";
import { RECORDS_PER_BOOT, recordSeq, type Seq, seqBoot } from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import type { Mono } from "../../../src/core/model/time.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";

/** The core's dependencies for these tests: neither module opens a packet. */
export const MINI_DEPS: CoreDeps = { cipher: VectorCipher.fromVectors(), rules: DEFAULT_RULES };

/** A snapshot of an empty database (as `test/world/world.ts` has it, without loading the core). */
export function emptyTestSnapshot(): DurableSnapshot {
  return {
    devices: [],
    sendCounters: [],
    hubKeys: undefined,
    site: undefined,
    sensorConfig: [],
    sirenConfig: [],
    gatewayConfig: [],
    countdowns: [],
    alarm: undefined,
    alarmTriggers: [],
    alarmSirens: [],
    previousBoot: undefined,
    deviceState: [],
    lossDaily: [],
    provisioningKeys: new Map(),
  };
}

/** The two slices these tests run. */
export interface MiniState {
  readonly clock: ClockSlice;
  readonly audit: AuditSlice;
}

export const EMPTY_MINI_STATE: MiniState = { clock: EMPTY_CLOCK_SLICE, audit: EMPTY_AUDIT_SLICE };

/** A module between clock and audit, standing in for the ones not yet written. */
export type StandIn = (
  message: Internal,
  ctx: Context,
) => Result<readonly (Internal | Effect)[], CoreFault>;

export interface MiniStepped {
  readonly state: MiniState;
  readonly effects: readonly Effect[];
  readonly wake: Mono | undefined;
}

const EFFECT_KINDS: ReadonlySet<string> = new Set([
  "write",
  "record",
  "cadence",
  "send",
  "close",
  "respond",
  "advertise",
]);

/**
 * The view other modules see. Clock and audit read only `view.clock` and `view.audit` (through
 * the clock's selectors), so the other slices are absent; the cast says only that.
 */
function viewOf(state: MiniState): HubState {
  return state as unknown as HubState;
}

function cursor(start: Seq, event: Input["event"]["kind"]): RecordCursor {
  const boot = seqBoot(start);
  let n = start - boot * RECORDS_PER_BOOT;
  return {
    take() {
      const taken = recordSeq(boot, n);
      if (taken === undefined)
        return err(coreFault(event, "test/mini-core", "record sequence exhausted"));
      n += 1;
      return ok(taken);
    },
  };
}

export function miniStep(
  state: MiniState,
  input: Input,
  deps: CoreDeps,
  standIns: readonly StandIn[] = [],
): Result<MiniStepped, CoreFault> {
  const event = input.event.kind;
  const first =
    input.event.kind === "boot" ? recordSeq(input.event.boot.id, 0) : state.audit.nextRecord;
  if (first === undefined) return err(coreFault(event, "test/mini-core", "boot id out of range"));
  const records = cursor(first, event);
  const entropy = entropyCursor(input.entropy, event);
  const due = auditDeadlines(state.audit).filter((timer) => timer.at <= input.now.mono);
  const queue: Internal[] = [
    ...due.map((t): Internal => ({ kind: "timer", key: t.key, at: t.at })),
    input.event,
  ];
  const effects: Effect[] = [];
  let current = state;
  const push = (out: readonly (Internal | Effect)[]): void => {
    for (const item of out) {
      if (EFFECT_KINDS.has(item.kind)) effects.push(item as Effect);
      else queue.push(item as Internal);
    }
  };
  // The queue grows as messages are handled; `for … of` takes the new ones too.
  for (const message of queue) {
    const ctx = (): Context => ({
      now: input.now,
      view: viewOf(current),
      deps,
      entropy,
      records,
      event,
    });
    if (message.kind !== "timer") {
      const clock = handleClock(current.clock, message, ctx());
      if (clock.isErr()) return err(clock.error);
      current = { ...current, clock: clock.value.slice };
      push(clock.value.out);
      for (const standIn of standIns) {
        const out = standIn(message, ctx());
        if (out.isErr()) return err(out.error);
        push(out.value);
      }
    }
    if (message.kind !== "timer" || message.key.module === "audit") {
      const audit = handleAudit(current.audit, message, ctx());
      if (audit.isErr()) return err(audit.error);
      current = { ...current, audit: audit.value.slice };
      push(audit.value.out);
    }
  }
  const timers = auditDeadlines(current.audit);
  const wake = timers.length === 0 ? undefined : (Math.min(...timers.map((t) => t.at)) as Mono);
  return ok({ state: current, effects, wake });
}

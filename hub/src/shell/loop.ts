/**
 * The hub's loop (hub-design.md section 4, "One turn of the loop"): it takes the inputs the
 * adapters queued, runs `step` on each, and performs the effects in section 4's order.
 *
 * 1. Take the waiting inputs, at most 64, in arrival order; stamp each with the time and 32 fresh
 *    random bytes, and run `step`. A `CoreFault` leaves the state as it was for that input; it is
 *    handed back as the next turn's first input, which the audit module records with the next
 *    number (section 10); more than 100 in an hour stop the hub for a restart ‡.
 * 2. Stage every `write` and `record` effect of the turn with the writer, in order, and hand each
 *    `record` to the control socket for `hsn log --follow` as it is staged.
 * 3. Flush when the writer is due: at once when anything "now" was staged. The commit's outcome,
 *    a failure or a recovery, is the core's next `commit` input.
 * 4. Perform the sends, closes, answers and advertisements in order, each send through the send
 *    gate. A send refused, at the gate or by its link, comes back as `sendFailed`. While the
 *    turn's "now" commit failed, nothing it justified leaves: its sends are held back and its
 *    answers wait for a commit that succeeds.
 * 5. The writer's own upkeep, then the one system timer for the earliest of the core's wake and
 *    the writer's flush deadline.
 */
import type { Result } from "neverthrow";
import type { AuditRecord } from "../core/model/audit.ts";
import type { ControlReply } from "../core/model/control.ts";
import type { Effect } from "../core/model/effects.ts";
import type { CoreFault, HubError } from "../core/model/errors.ts";
import { type CommitOutcome, type HubEvent, INPUT_ENTROPY_BYTES } from "../core/model/events.ts";
import type { CoreDeps } from "../core/model/handler.ts";
import type { RequestId } from "../core/model/ids.ts";
import type { HubState } from "../core/model/state.ts";
import { type Mono, monoAfterMs } from "../core/model/time.ts";
import type { Core } from "../core/step.ts";
import type { Advertiser } from "../ports/advertiser.ts";
import type { Clock } from "../ports/clock.ts";
import type { Links } from "../ports/links.ts";
import type { Random } from "../ports/random.ts";
import type {
  CommitInfo,
  FlushReason,
  StagedEffect,
  StorageError,
  Writer,
} from "../ports/writer.ts";
import { admitSend } from "./storage/send-gate.ts";

/** Commit outcomes one turn hands the core; any more wait for the next turn. */
const MAX_OUTCOMES_PER_TURN = 4;
/** Inputs one turn takes (section 4, step 1). */
export const MAX_INPUTS_PER_TURN = 64;
/** More core faults than this in an hour stop the hub for a restart ‡ (section 10). */
export const MAX_FAULTS_PER_HOUR = 100;
const HOUR_MS = 3_600_000;

/** What the loop needs of the writer: the port, with its flush rules and outcome. */
export interface LoopWriter extends Writer {
  flushIfDue(
    now: Mono,
  ): Result<(CommitInfo & { readonly committed: boolean }) | undefined, StorageError>;
  takeOutcome(): CommitOutcome | undefined;
  maintain(): Result<void, StorageError>;
  flush(reason: FlushReason): Result<CommitInfo & { readonly committed: boolean }, StorageError>;
}

/** The ports the loop drives. */
export interface LoopPorts {
  readonly clock: Clock;
  readonly random: Random;
  readonly links: Links;
  readonly control: {
    respond(request: RequestId, reply: ControlReply): void;
    /** Every record as it is staged, for `--follow` (section 9). */
    publish(record: AuditRecord): void;
  };
  readonly writer: LoopWriter;
  readonly advertiser: Advertiser;
  /** Sets the one system timer for `at`, replacing the last; none when undefined. */
  readonly wakeAt: (at: Mono | undefined) => void;
  /** Asks for another turn soon: inputs are still waiting. */
  readonly soon: () => void;
  /** An error the loop recorded, for `fatal.log` and standard error. */
  readonly report: (error: HubError) => void;
  /** The hub must stop: random bytes failed, or too many faults (section 10). */
  readonly fatal: (error: HubError) => void;
}

/** What one turn did, for tests and the budget. */
export interface TurnSummary {
  readonly inputs: number;
  readonly faults: readonly CoreFault[];
  readonly effects: readonly Effect[];
  readonly committed: boolean;
}

export class HubLoop {
  readonly #core: Core;
  readonly #deps: CoreDeps;
  readonly #ports: LoopPorts;
  #state: HubState;
  readonly #queue: HubEvent[] = [];
  /** Answers a failed "now" commit holds back, until a commit succeeds (section 4). */
  #held: { readonly request: RequestId; readonly reply: ControlReply }[] = [];
  #failing = false;
  #faultTimes: Mono[] = [];
  #stopped = false;

  constructor(core: Core, deps: CoreDeps, ports: LoopPorts, state: HubState = core.emptyState()) {
    this.#core = core;
    this.#deps = deps;
    this.#ports = ports;
    this.#state = state;
  }

  get state(): HubState {
    return this.#state;
  }

  /** Inputs waiting for the next turn. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** An adapter's event: queued for the next turn, in arrival order. */
  enqueue(event: HubEvent): void {
    if (this.#stopped) return;
    this.#queue.push(event);
    this.#ports.soon();
  }

  /** The loop takes nothing more (a clean stop or a fatal error). */
  stop(): void {
    this.#stopped = true;
  }

  /** One turn (section 4). */
  turn(): TurnSummary {
    const { clock, writer, control } = this.#ports;
    const inputs = this.#queue.splice(0, MAX_INPUTS_PER_TURN);
    const effects: Effect[] = [];
    const faults: CoreFault[] = [];
    for (const event of inputs) {
      const entropy = this.#ports.random.bytes(INPUT_ENTROPY_BYTES);
      if (entropy.isErr()) {
        this.#ports.fatal(entropy.error);
        this.stop();
        break;
      }
      const now = clock.now();
      const result = this.#core.step(
        this.#state,
        { now, entropy: entropy.value, event },
        this.#deps,
      );
      if (result.isOk()) {
        this.#state = result.value.state;
        effects.push(...result.value.effects);
        continue;
      }
      faults.push(result.error);
      this.#ports.report(result.error);
      // The fault goes back to the core as the next input, so the audit module records it with
      // the next number, in time order (section 6). A fault on that input is reported only.
      this.#countFault(now.mono);
      const fault = result.error;
      const again = event.kind === "inputRejected" && event.rejection.source === "core";
      if (!again && !this.#stopped) {
        this.#queue.unshift({
          kind: "inputRejected",
          rejection: {
            source: "core",
            event: fault.event,
            origin: fault.origin,
            message: fault.message,
            detail: fault.detail ?? {},
          },
        });
      }
    }

    // Step 2: stage, publishing each record for --follow as it is staged.
    const staged: StagedEffect[] = [];
    for (const effect of effects) {
      if (effect.kind === "write" || effect.kind === "record") staged.push(effect);
      if (effect.kind === "cadence") writer.setCadence(effect.everyMs);
    }
    writer.stage(staged);
    for (const item of staged) if (item.kind === "record") control.publish(item.record);

    // Step 3: flush when due; at once for anything "now".
    const needsNow = staged.some((item) => item.durability === "now");
    const flushed = writer.flushIfDue(clock.now().mono);
    if (flushed.isErr()) {
      this.#failing = true;
      this.#ports.report(flushed.error);
    } else if (flushed.value?.committed === true) {
      this.#failing = false;
    }
    const committed = !(needsNow && flushed.isErr());
    // Each outcome the commit had (a failure or recovery, what the size guard trimmed): bounded.
    for (let taken = 0; taken < MAX_OUTCOMES_PER_TURN; taken++) {
      const outcome = writer.takeOutcome();
      if (outcome === undefined) break;
      this.#queue.push({ kind: "commit", outcome });
    }

    // Step 4: the turn's sends, closes, answers and advertisements, in order.
    if (!this.#failing) this.#releaseHeld();
    for (const effect of effects) this.#perform(effect, committed);

    // Step 5: upkeep, then the one timer.
    const upkeep = writer.maintain();
    if (upkeep.isErr()) this.#ports.report(upkeep.error);
    this.#arm();
    if (this.#queue.length > 0) this.#ports.soon();
    return { inputs: inputs.length, faults, effects, committed };
  }

  /** The earliest of the core's wake and the writer's flush deadline (section 4, step 5). */
  nextWake(): Mono | undefined {
    const now = this.#ports.clock.now().mono;
    const wakes = [this.#core.nextDeadline(this.#state), this.#ports.writer.due(now)].filter(
      (at) => at !== undefined,
    );
    return wakes.length === 0 ? undefined : wakes.reduce((a, b) => (b < a ? b : a));
  }

  #arm(): void {
    this.#ports.wakeAt(this.nextWake());
  }

  #releaseHeld(): void {
    const held = this.#held;
    this.#held = [];
    for (const { request, reply } of held) this.#ports.control.respond(request, reply);
  }

  #perform(effect: Effect, committed: boolean): void {
    const { links, control, advertiser, writer } = this.#ports;
    switch (effect.kind) {
      case "write":
      case "record":
      case "cadence":
        return;
      case "send": {
        const admitted = admitSend(writer, effect.counters, committed);
        if (admitted.isErr()) {
          this.#queue.push({
            kind: "sendFailed",
            link: effect.link,
            ref: effect.ref,
            error: "notDurable",
          });
          return;
        }
        const sent = links.send(effect.link, effect.bytes, effect.ref);
        if (sent.isErr()) {
          this.#queue.push({
            kind: "sendFailed",
            link: effect.link,
            ref: effect.ref,
            error: sent.error.code,
          });
        }
        return;
      }
      case "close": {
        const closed = links.close(effect.link, effect.reason);
        if (closed.isErr()) this.#ports.report(closed.error);
        return;
      }
      case "respond":
        if (committed && !this.#failing) control.respond(effect.request, effect.reply);
        else this.#held.push({ request: effect.request, reply: effect.reply });
        return;
      case "advertise": {
        const advertised = advertiser.advertise(effect.identity, effect.port);
        if (advertised.isErr()) this.#ports.report(advertised.error);
        return;
      }
      // M2's effects (m2-design.md section 2) are performed by the app listeners and the file
      // jobs, joined in step 2; step 0's stubs never emit them, so one here is reported.
      case "appSend":
      case "closeClient":
      case "linkSecret":
      case "fileJob":
      case "historyRead":
        this.#ports.report({
          kind: "internal",
          origin: "shell/loop",
          message: `the ${effect.kind} effect is not built yet (m2-design.md section 11, step 2)`,
        });
        return;
    }
  }

  #countFault(at: Mono): void {
    const since = monoAfterMs(at, -HOUR_MS);
    this.#faultTimes = [...this.#faultTimes.filter((t) => t >= since), at];
    if (this.#faultTimes.length > MAX_FAULTS_PER_HOUR) {
      this.#ports.fatal({
        kind: "internal",
        origin: "shell/loop",
        message: `more than ${MAX_FAULTS_PER_HOUR} core faults within an hour`,
      });
      this.stop();
    }
  }
}

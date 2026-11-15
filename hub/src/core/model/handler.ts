/**
 * The core's function and its handlers (hub-design.md section 2, "The function" and "Modules
 * and the dispatcher").
 */
import type { Sha256 } from "@hsn/protocol";
import type { Result } from "neverthrow";
import type { Calendar } from "./calendar.ts";
import type { DeviceCipher } from "./cipher.ts";
import type { Effect } from "./effects.ts";
import type { CoreFault } from "./errors.ts";
import type { HubEvent, Input } from "./events.ts";
import type { Seq } from "./ids.ts";
import type { Internal } from "./messages.ts";
import type { ModuleName } from "./modules.ts";
import type { HubRules } from "./rules.ts";
import type { HubState } from "./state.ts";
import type { Mono, Now } from "./time.ts";

export interface CoreDeps {
  readonly cipher: DeviceCipher;
  readonly rules: HubRules;
  /** Calendar arithmetic over a fixed time-zone database (m2-design.md section 2). */
  readonly calendar: Calendar;
  /**
   * SHA-256, a pure function as `cipher` is, the shell passing `@noble/hashes`' (m2-design.md
   * section 2): the core hashes a token's secret for its pre-shared key and lookup, and the app key
   * for the hub's identity (section 5), so no secret need travel in an input as well as an effect.
   */
  readonly sha256: Sha256;
  /**
   * True in test builds: the state is deep-frozen after every step, so a mutation fails at once
   * (section 2). SPEC-QUESTION: the core may not read `process`, so `step` cannot tell a test
   * build by itself; the caller says so here.
   */
  readonly deepFreeze?: boolean;
}

/** What one step returns. */
export interface Stepped {
  readonly state: HubState;
  readonly effects: readonly Effect[];
  /** The earliest timer of the new state, for the shell's one system timer; none when undefined. */
  readonly wake: Mono | undefined;
}

/** `step(state, input, deps)`: the one pure function of the core. */
export type StepFunction = (
  state: HubState,
  input: Input,
  deps: CoreDeps,
) => Result<Stepped, CoreFault>;

/**
 * The input's random bytes, handed out in order (section 2): 8 for a welcome's hub random, 4 for
 * a new address, 16 for a key. Taking more than the input carries is a `CoreFault`.
 */
export interface EntropyCursor {
  take(length: number): Result<Uint8Array, CoreFault>;
}

/**
 * Record sequence numbers, handed out in order during one step, so a decision can name the
 * record that caused it before either is written (section 2). The audit module keeps the next
 * one in its slice from the records it handles. SPEC-QUESTION: section 2's `Context` has no such
 * member, yet audit runs last while the records' causes are named first; this is the smallest
 * change that lets every module take a sequence number when it makes a record.
 */
export interface RecordCursor {
  take(): Result<Seq, CoreFault>;
}

export interface Context {
  readonly now: Now;
  /** The state after every earlier handler of this step, read only through `view.ts` selectors. */
  readonly view: HubState;
  readonly deps: CoreDeps;
  readonly entropy: EntropyCursor;
  readonly records: RecordCursor;
  /**
   * The kind of this step's input, for the `CoreFault`s a handler returns (section 10).
   * SPEC-QUESTION: section 2's `Context` lacks it, but every `CoreFault` must name it.
   */
  readonly event: HubEvent["kind"];
}

/** What a handler returns: its new slice, and the messages and effects it emits, in order. */
export interface Handled<K extends ModuleName> {
  readonly slice: HubState[K];
  readonly out: readonly (Internal | Effect)[];
}

/** A module's handler: it can change only its own slice, since its return type is that slice. */
export type Handler<K extends ModuleName> = (
  slice: HubState[K],
  message: Internal,
  ctx: Context,
) => Result<Handled<K>, CoreFault>;

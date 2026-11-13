/**
 * The control module's slice (hub-design.md section 2, module 5; section 9): the commands
 * waiting for their answer, each with what its record needs (AL8: who asked, and what).
 */
import type { ControlCommandKind } from "../model/control.ts";
import type { RequestId, Seq } from "../model/ids.ts";
import type { TimerOf } from "../model/timers.ts";

/** A command sent on to the module that owns its change, until that module answers. */
export interface PendingCommand {
  readonly kind: ControlCommandKind;
  /** The user name the CLI reported (section 9). */
  readonly actor: string;
  /** The command's arguments as JSON, secrets left out (`commands.args`). */
  readonly args: string;
  /**
   * The command's `commands` record, numbered and stamped when the command arrived: the
   * decisions it causes name this number before the record is written with its outcome.
   */
  readonly record: Seq;
  readonly atMs: number;
  readonly clockOk: boolean;
}

export interface ControlSlice {
  readonly timers: readonly TimerOf<"control">[];
  readonly pending: ReadonlyMap<RequestId, PendingCommand>;
}

/** The slice before the boot event. */
export const EMPTY_CONTROL_SLICE: ControlSlice = { timers: [], pending: new Map() };

/**
 * The relay module's slice (docs/m4-design.md section 4): relay settings, push targets (tokens,
 * never keys), the push outbox, the link's state as the shell reports it, and what each push says.
 *
 * - **Keys are never here.** A phone's push key enters the core once, in `push.register`'s body,
 *   and leaves it at once in the `push_keys` write and the `pushKey` effect, both in the step that
 *   took it (the `PushKeys` port holds it from then on). No field below can hold one: targets are
 *   `PushTargetRow`s (key id, platform, environment, token), and a pending push keeps the facts of
 *   its notification, never sealed bytes; the shell seals with the key it holds.
 * - **The outbox** is `push_outbox`, one row per notification and phone, durable as its
 *   notification (critical ones written now, the rest routine), with `armed` and the decision's
 *   facts in the row. After a restart the rows are matched with the notifications the boot
 *   snapshot carries (the last 7 days), which with the row is everything a push says.
 * - **The link** is what the shell last reported (`relayLink`), for the URL in use only.
 */
import type { PushContent } from "@hsn/protocol/app";
import type { RelayDownReason } from "../model/events.ts";
import type { ClientId, OutboxId, Seq } from "../model/ids.ts";
import type { PushOutboxRow, PushTargetRow, RelaySettingsRow } from "../model/rows.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** A notification's fields as a push carries them (`PushContent.n`). */
export type Notice = PushContent["n"];

/** The decision kinds whose facts a push's text names (`content.ts`). */
export type CauseKind = "countdown_started" | "late_report_notification" | "mode_switched";

/**
 * A decision's facts a push names: the countdown's seconds, when a late-reported door opened, the
 * mode switched to. Seen as the decision passes on its way to audit, before `notify` raises the
 * notification that names it (relay runs before notify, and both in the same step); kept in the
 * outbox row's `facts` as this object's JSON, so a push after a restart says the same.
 */
export interface CauseFacts {
  readonly seq: Seq;
  readonly kind: CauseKind;
  readonly value: number | null;
}

/** One push waiting for the relay or for its result (D102). */
export interface Pending {
  /** The row as last written; its `armed` is any sensor armed when it was raised (D96, O15). */
  readonly row: PushOutboxRow;
  readonly notice: Notice;
  /** The facts of the decision that raised it (the row's `facts`, read). */
  readonly cause: CauseFacts | undefined;
  /** Sent on the present link and waiting for its result. */
  readonly inFlight: boolean;
}

/** The relay link, as the shell reports it. */
export type LinkState =
  /** No relay in use: none chosen, or the default is a placeholder (RD 2). */
  | { readonly kind: "off" }
  /** Not joined: from the start until the first `up`, and after any `down`. */
  | { readonly kind: "down"; readonly reason: RelayDownReason | undefined }
  | { readonly kind: "up"; readonly roles: readonly string[] };

/** One outage of the link, from its start until it is up again. */
export interface Outage {
  /** `relay_unreachable` was recorded for it (once per outage). */
  readonly alerted: boolean;
  /** `relay_identity_in_use` was recorded for it (once per outage). */
  readonly replaced: boolean;
  /** When it began; undefined for the one that began at the start (nothing to measure from). */
  readonly since: Mono | undefined;
}

/** The ups and downs of the present record period (`relay_link`, one record per period). */
export interface Tally {
  readonly ups: number;
  readonly downs: number;
  readonly longestDownMs: number;
}

export interface RelaySlice {
  readonly timers: readonly TimerOf<"relay">[];
  /** `relay_settings`' one row. */
  readonly settings: RelaySettingsRow;
  /**
   * The deployment's default relay, as the boot input gives it (`BootInfo.defaultRelayUrl`): what
   * `settings.url` null means; null while the domain is a placeholder (m4-design section 2).
   */
  readonly defaultUrl: string | null;
  readonly link: LinkState;
  /** The wall time the link's state last changed; null when it has not since the start. */
  readonly changedMs: number | null;
  /** The present outage, while the link is down with a relay in use. */
  readonly outage: Outage | undefined;
  /** Ups and downs since the present record period began; undefined when none happened. */
  readonly tally: Tally | undefined;
  /** `push_targets`, by client. */
  readonly targets: ReadonlyMap<ClientId, PushTargetRow>;
  /** `push_outbox`, by row id. */
  readonly outbox: ReadonlyMap<OutboxId, Pending>;
  /** `push.test` pushes waiting for their result: never stored. */
  readonly tests: ReadonlyMap<OutboxId, ClientId>;
  /** The next outbox or test id: never reused within a run, above every stored row's. */
  readonly nextId: number;
  /** The last roster sent on this run's links: its revision, and the `armed` its alerts carry. */
  readonly roster: { readonly rev: number; readonly armed: boolean | undefined };
  /** The newest decision of each kind whose facts a push names. */
  readonly causes: ReadonlyMap<CauseKind, CauseFacts>;
}

/** `relay_settings` before it is read: the deployment's default (m4-design section 4). */
export const DEFAULT_SETTINGS: RelaySettingsRow = { url: null, revision: 0 };

/** The slice before the boot event. */
export const EMPTY_RELAY_SLICE: RelaySlice = {
  timers: [],
  settings: DEFAULT_SETTINGS,
  defaultUrl: null,
  link: { kind: "off" },
  changedMs: null,
  outage: undefined,
  tally: undefined,
  targets: new Map(),
  outbox: new Map(),
  tests: new Map(),
  nextId: 1,
  roster: { rev: 0, armed: undefined },
  causes: new Map(),
};

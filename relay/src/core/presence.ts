/**
 * The relay's presence core (docs/m4-design.md section 3, "Presence: the hub-unreachable alerts";
 * D64, D96): its types only, frozen by the joint step 0. B2 writes the pure function over them,
 * with time as an input, tested over simulated days.
 *
 * | When | The relay |
 * | --- | --- |
 * | A frame arrives | last contact = now; `online`. If it was `alerted`, it first sends `back` to every target |
 * | No frame for 75 s ‡ | closes the link; `quiet` |
 * | 180 s after last contact, past the grace end, not `alerted`, with targets | sends `unreachable` to every target; `alerted`. Once per outage |
 * | `restarting {withinMs}` | grace end = now + min(`withinMs`, 10 minutes ‡); answers `restartingAck` |
 * | A new link of the hub joins | a frame, and any grace ends: the announced restart is over (B2's FROZEN-CHANGE, approved) |
 * | The relay starts | every hub not `alerted` gets last contact = the start time; `alerted` ones stay so |
 *
 * The values are `PRESENCE_RULES` (`rules.ts`).
 */

/** A hub's presence: linked and heard, silent and closed, or its phones told. */
export type PresenceState = "online" | "quiet" | "alerted";

/** What the relay keeps per hub identity (SQLite `hubs`). */
export interface HubPresence {
  /** The hub's app identity, 26 characters. */
  readonly identity: string;
  /** The last frame on an authenticated link, or the relay's start for a hub not `alerted`. */
  readonly lastContactMs: number;
  readonly state: PresenceState;
  /** An announced restart's grace end; 0 for none. No alert before it. */
  readonly graceEndMs: number;
  /** Whether the hub's roster holds any target: with none, nobody is told. */
  readonly hasTargets: boolean;
}

/** What the core is told. */
export type PresenceInput =
  /** Any frame on the hub's authenticated link. */
  | { readonly kind: "frame"; readonly identity: string; readonly atMs: number }
  /**
   * A new link of the hub joined (message 3 proved its key). A contact, as a frame is, and the end
   * of any announced restart's grace: a hub back early that then goes silent is alerted 180 s
   * after its last contact, not when the old grace would have run out.
   */
  | { readonly kind: "linkJoined"; readonly identity: string; readonly atMs: number }
  /** `restarting {reason, withinMs}` on the hub's link. */
  | {
      readonly kind: "restarting";
      readonly identity: string;
      readonly reason: "update" | "restore";
      readonly withinMs: number;
      readonly atMs: number;
    }
  /** The hub's roster changed: it now has targets, or none. */
  | {
      readonly kind: "roster";
      readonly identity: string;
      readonly hasTargets: boolean;
      readonly atMs: number;
    }
  /** Time passed: the shell's timer, at the earliest `nextWakeMs` the core asked for. */
  | { readonly kind: "tick"; readonly atMs: number }
  /** The relay started (D96: a restarted relay starts its 3-minute clock afresh). */
  | { readonly kind: "relayStarted"; readonly atMs: number };

/** What the core asks the shell to do. */
export type PresenceOutput =
  /** Push the hub's sealed `unreachable` alert to every target of its roster. */
  | { readonly kind: "sendUnreachable"; readonly identity: string }
  /** Push the hub's sealed `back` alert to every target of its roster. */
  | { readonly kind: "sendBack"; readonly identity: string }
  /** Close the hub's link: silent for `PRESENCE_RULES.silentCloseMs`. */
  | { readonly kind: "closeLink"; readonly identity: string }
  /** Answer `restartingAck` on the hub's link. */
  | { readonly kind: "restartingAck"; readonly identity: string }
  /** Write the hub's row (state, last contact, grace end). */
  | { readonly kind: "store"; readonly hub: HubPresence };

/** One step of the presence core. */
export interface PresenceStep {
  readonly hubs: ReadonlyMap<string, HubPresence>;
  readonly out: readonly PresenceOutput[];
  /** When the core next needs a `tick`; null when nothing waits. */
  readonly nextWakeMs: number | null;
}

/** The pure presence core: no input or output, time only from its inputs. */
export type PresenceCore = (
  hubs: ReadonlyMap<string, HubPresence>,
  input: PresenceInput,
) => PresenceStep;

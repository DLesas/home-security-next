/**
 * The app module's slice (m2-design.md section 2): app sessions (connection, client, protocol
 * version, subscriptions), the live revision, and the requests waiting for their owner's answer.
 * Memory only (section 3): sessions close at a restart and clients reconnect and take a snapshot.
 */
import type { AppOp, AppOpV2, AppProtoVersion, Topic } from "@hsn/protocol/app";
import type { AppListener, HubEvent } from "../model/events.ts";
import type { ClientId, ConnId, DeviceId, RequestId, Seq } from "../model/ids.ts";
import type { DeviceRow } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import type { Mono, Now } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import type { PresenceMap } from "./presence.ts";

export interface Session {
  readonly conn: ConnId;
  readonly client: ClientId;
  readonly listener: AppListener;
  /** The channel version agreed (section 5, "Versions"). */
  readonly proto: number;
  readonly app: string;
  readonly topics: ReadonlySet<Topic>;
  /**
   * The devices its person could view when last checked: when one goes, the session is told to
   * `forget` it (section 5, "Live updates").
   */
  readonly visible: ReadonlySet<DeviceId>;
}

/** Where a request from an app is answered. */
export interface AppAnswerTo {
  readonly kind: "app";
  readonly conn: ConnId;
  readonly client: ClientId;
  readonly id: number;
  readonly seq: number | undefined;
  /** The asking session's channel version: its reply is made, and kept, in that version's form. */
  readonly proto: AppProtoVersion;
}

/** A change's `commands` record (section 4), numbered and stamped when the request arrived. */
export interface CommandStamp {
  readonly seq: Seq;
  readonly atMs: number;
  readonly clockOk: boolean;
  readonly actor: string;
  readonly args: string;
}

/** A request sent on to its owner, until the owner answers. */
export interface PendingRequest {
  readonly answerTo: AppAnswerTo;
  /** Of either channel version: a version 2 session's request may be a version 2 operation. */
  readonly op: AppOpV2;
  /** The change's `commands` record; undefined for a read, which is not recorded. */
  readonly command: CommandStamp | undefined;
  /** The record the request's decisions name as their cause. */
  readonly record: Seq;
  /** For `siren.test`: the decision that sounded the siren, which its reply names. */
  readonly decision: Seq | undefined;
}

export interface AppSlice {
  readonly timers: readonly TimerOf<"app">[];
  /** The live revision (section 5): rises by one at each step that sends an event. */
  readonly rev: number;
  /**
   * The step whose events carry `rev`, by its input's `now`: a step's handlers all see the one
   * `Now` the input came with, and the loop takes a new reading for every input (HD 4), so a new
   * object is a new step. Compared by identity, so an input that sends no event changes nothing.
   */
  readonly revStep: Now | undefined;
  readonly sessions: ReadonlyMap<ConnId, Session>;
  /** Requests waiting for their answer, by `conn:id`. */
  readonly pending: ReadonlyMap<string, PendingRequest>;
  /** The request numbers given to M1a's modules (from 2⁴⁰, section 2), to their `conn:id`. */
  readonly m1a: ReadonlyMap<RequestId, string>;
  /** The next request number, as an offset from `APP_REQUEST_BASE`. */
  readonly nextRequest: number;
  /**
   * Retries of a change whose reply is still pending, by `client:seq`: each is answered with the
   * reply when it comes (section 2, "Requests for M1a's modules").
   */
  readonly waiting: ReadonlyMap<string, readonly AppAnswerTo[]>;
  /** When each device's last `reading` event went, for once a minute ‡. */
  readonly readings: ReadonlyMap<DeviceId, Mono>;
  /** What app last told sessions of people and clients, to send only what changed. */
  readonly seen: PeopleSeen | undefined;
  /** The registry's slice and its devices as app last saw them, for `device` events. */
  readonly registrySeen: unknown;
  /** The immutable update entries last checked for changes to device objects. */
  readonly firmwareSeen: HubState["firmware"]["updates"];
  /**
   * The alarm's countdowns and the site's row as app last saw them (by identity), and the site as
   * last told: each change becomes its event, whatever caused it (`changes.ts`).
   */
  readonly countdownsSeen: ReadonlyMap<DeviceId, unknown> | undefined;
  readonly siteRowSeen: unknown;
  readonly siteSent: string | undefined;
  readonly devicesSeen: ReadonlyMap<DeviceId, DeviceRow>;
  /** Handshakes refused in the last hour, by address (`clientRefused`): memory only. */
  readonly refused: ReadonlyMap<
    string,
    { readonly since: Mono; readonly count: number; readonly warned: boolean }
  >;
  /** Today's sessions per client (`sessions-day.ts`): memory only; undefined before the first. */
  readonly sessionDay:
    | {
        readonly date: string;
        /** The wall time of the next local midnight, when the calendar can tell. */
        readonly endsMs: number | undefined;
        readonly counts: ReadonlyMap<ClientId, ClientDay>;
      }
    | undefined;
  /** A run of failed commits is under way: told once at its start, and once when it ends. */
  readonly databaseFailing: boolean;
  /** The shell's `hubFacts`, the latest (section 2): undefined until the first. */
  readonly facts: HubFacts | undefined;
  /**
   * Configuration operations on their way to their owner, from anyone (an app, `hsn`, a
   * schedule), by where their answer goes: each answered with success is a `config` event.
   */
  readonly configAsked: ReadonlyMap<string, AppOp>;
  /** What each phone last said of its presence (`presence.ts`): memory only. */
  readonly presence: PresenceMap;
  /**
   * The relay's status as last told, for version 2's `hub` event `relay` (`v2-live.ts`):
   * undefined until the boot step.
   */
  readonly relaySent: string | undefined;
}

/** One client's sessions today: how many, the first one's start, the last moment seen. */
export interface ClientDay {
  readonly sessions: number;
  readonly firstMs: number;
  readonly lastMs: number;
}

/** The hub's facts, as the shell gives them (`hubFacts`, section 2). */
export type HubFacts = Omit<Extract<HubEvent, { readonly kind: "hubFacts" }>, "kind">;

/** The people slice's parts as app last saw them, compared by identity (immutable rows). */
export interface PeopleSeen {
  readonly userManagement: boolean;
  readonly people: ReadonlyMap<number, unknown>;
  readonly roles: ReadonlyMap<number, unknown>;
  readonly permissions: ReadonlyMap<number, unknown>;
  readonly clients: ReadonlyMap<number, unknown>;
}

/** The slice before the boot event. */
export const EMPTY_APP_SLICE: AppSlice = {
  timers: [],
  rev: 0,
  revStep: undefined,
  sessions: new Map(),
  pending: new Map(),
  m1a: new Map(),
  nextRequest: 0,
  waiting: new Map(),
  readings: new Map(),
  seen: undefined,
  registrySeen: undefined,
  firmwareSeen: new Map(),
  countdownsSeen: undefined,
  siteRowSeen: undefined,
  siteSent: undefined,
  devicesSeen: new Map(),
  refused: new Map(),
  sessionDay: undefined,
  databaseFailing: false,
  facts: undefined,
  configAsked: new Map(),
  presence: new Map(),
  relaySent: undefined,
};

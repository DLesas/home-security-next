/**
 * The relay role (docs/m4-design.md section 3): hub links, phone streams, presence and the
 * hub-unreachable alerts, the push hand-off, and D142's layer 1, put together around the pure
 * core (`../core/`). It does what the core decides and keeps what it must in `RelayStore`.
 *
 * - **Hub links** (`hub-link.ts`): one per identity, the newest wins (the older is closed with
 *   4001); refused keys 4403; layer 1's caps and new-identity limits at message 3 (`Admission`).
 * - **Phone streams** (`phone-stream.ts`): a phone names its hub by identity and path; the relay
 *   checks the identity's form, that the hub's link is up, and the limits; then sends `open
 *   {stream, path, peer}` and carries every binary message both ways unchanged. Stream numbers
 *   count up from 0 on each link and are never reused on it.
 * - **Presence** (`../core/presence-core.ts`): every frame on a joined link is a contact; the
 *   core is handed only the hubs an input concerns, and woken by one timer at the earliest
 *   deadline (`Deadlines`). Its alerts go out through `PushSender`, each target's pre-sealed `h`
 *   as it is; an alert whose items fail is tried again on `RELAY_BACKOFF`'s steps while it still
 *   holds (the hub still `alerted` for `unreachable`, back for `back`), then given up.
 * - **Pushes**: a hub's `push` items are turned into the push service's items through its roster
 *   (`../core/roster.ts`) and answered `pushResult` with one outcome per item; a link may have
 *   `PUSH_SERVICE_LIMITS.framesInHand` push frames in hand, another is answered `limited`.
 * - **Releases**: `release.check` and `release.get` go to the releases role when it runs (only
 *   after message 3, so never on an unauthenticated connection), at most
 *   `RELAY_LIMITS.maxReleasePiecesInFlight` pieces in hand per link; without the role, `release.offer
 *   {releases: []}` and `release.error {reason: "unavailable"}`.
 * - **Retention**: at start and at every midnight UTC, identities past their retention are
 *   deleted with their targets (`../core/identities.ts`); never one whose link is up, by
 *   construction (`sweep`).
 */
import {
  type HubPushItem,
  type HubToRelayFrame,
  PHONE_CLOSE,
  type PushOutcome,
  RELAY_BACKOFF,
  RELAY_BINARY_KIND,
  RELAY_CLOSE,
  RELAY_LIMITS,
  relayBinaryCodec,
  type RelayPushItem,
  type RelayWelcome,
  readPhoneRequest,
  type RosterTarget,
  splitRelayPushItems,
} from "@hsn/protocol/relay";
import { err, ok, type Result } from "neverthrow";
import { Admission } from "../core/admission.ts";
import { Deadlines } from "../core/deadlines.ts";
import { type HubRecord, isExpired, linkClosed, newRecord, seenOn } from "../core/identities.ts";
import { presenceDeadline, stepPresence } from "../core/presence-core.ts";
import type { HubPresence, PresenceCore, PresenceInput, PresenceOutput } from "../core/presence.ts";
import type { ReleasePeer } from "../core/release-budget.ts";
import { alertItems, type ResolvedItem, resolvePush, targetsOf } from "../core/roster.ts";
import { PRESENCE_RULES, PROTECTION_LIMITS } from "../core/rules.ts";
import { TIME, untilNextUtcDay, utcDay } from "../core/time.ts";
import { PUSH_SERVICE_LIMITS } from "../push/limits.ts";
import type { PushSender } from "../push/sender.ts";
import { checkOf, type ReleaseAnswers, requestOf } from "../releases/service.ts";
import type { RelayClock } from "./clock.ts";
import type { RelayError } from "./errors.ts";
import { HubLink, type HubLinkHost } from "./hub-link.ts";
import type { RelayLog } from "./log.ts";
import { PhoneStream, type StreamHost } from "./phone-stream.ts";
import type { Pseudonyms } from "./pseudonym.ts";
import type { RelaySocket } from "./safe/websocket.ts";
import type { RelayStore } from "./storage/store.ts";

/** How long the presence timer waits when a tick made no progress, instead of waking at once. */
export const STALL_FLOOR_MS = TIME.SECOND;

/** The code a hub hears for a phone that left without a close code of its own (RFC 6455). */
const ABNORMAL_CLOSE = 1006;

export interface RelayOptions {
  readonly clock: RelayClock;
  readonly log: RelayLog;
  readonly store: RelayStore;
  readonly push: PushSender;
  /** The relay program's version, `MAJOR.MINOR.PATCH`. */
  readonly version: string;
  /** The roles this program runs, as message 2 announces them. */
  readonly roles: RelayWelcome["roles"];
  readonly pseudonyms: Pseudonyms;
  /** The releases role, when it runs. */
  readonly releases?: ReleaseAnswers;
  /** Hub identities the operator refuses (4403). */
  readonly refused?: ReadonlySet<string>;
  /** The presence core; `stepPresence` but in the test of a core that makes no progress. */
  readonly presenceCore?: PresenceCore;
}

/** What `deliver` learned: an outcome per relay item id, and a `limit` to pass on. */
interface Delivered {
  readonly outcomes: ReadonlyMap<number, PushOutcome>;
  readonly limitedForMs: number | undefined;
}

export class Relay implements HubLinkHost, StreamHost {
  readonly clock: RelayClock;
  readonly log: RelayLog;
  private readonly store: RelayStore;
  private readonly push: PushSender;
  private readonly admission = new Admission();
  private readonly links = new Set<HubLink>();
  private readonly byIdentity = new Map<string, HubLink>();
  private readonly records = new Map<string, HubRecord>();
  private readonly presence = new Map<string, HubPresence>();
  private readonly deadlines = new Deadlines();
  private readonly rosters = new Map<string, Map<string, RosterTarget>>();
  private readonly streams = new Map<HubLink, Map<number, PhoneStream>>();
  private readonly streamLink = new Map<PhoneStream, HubLink>();
  private readonly nextStream = new Map<HubLink, number>();
  private readonly pushesInHand = new Map<HubLink, number>();
  private readonly piecesInHand = new Map<HubLink, number>();
  private refused: ReadonlySet<string>;
  private nextPushId = 1;
  private armedAt: number | null = null;
  private cancelWake: () => void = () => undefined;
  private cancelSweep: () => void = () => undefined;
  private stopped = false;
  /** A tick left a deadline due: the core made no progress (logged once per stall). */
  private stalled = false;
  /** The UTC day the stored-identity cap was last reported to the operator. */
  private capAlertedDay = -1;
  private readonly core: PresenceCore;

  private constructor(private readonly options: RelayOptions) {
    this.clock = options.clock;
    this.log = options.log;
    this.store = options.store;
    this.push = options.push;
    this.refused = options.refused ?? new Set();
    this.core = options.presenceCore ?? stepPresence;
  }

  /** Loads what is stored, starts every clock afresh (D96) and sweeps what is past retention. */
  static start(options: RelayOptions): Result<Relay, RelayError> {
    const relay = new Relay(options);
    const loaded = options.store.load();
    if (loaded.isErr()) return err(loaded.error);
    for (const hub of loaded.value) {
      relay.records.set(hub.record.identity, hub.record);
      relay.presence.set(hub.presence.identity, hub.presence);
    }
    relay.present({ kind: "relayStarted", atMs: options.clock.now() });
    relay.sweep();
    return ok(relay);
  }

  // ----- Layer 1 before any state: the server asks these before an upgrade -----

  /** An upgrade to `/v1/hub`: `ok`, or HTTP 429 (`rate`) or 503 (`busy`). */
  hubUpgrade(address: string): "ok" | "rate" | "busy" {
    const answer = this.admission.hubUpgrade(address, this.clock.now());
    if (answer !== "ok") this.log.write("warning", "upgradeRefused", { link: "hub", why: answer });
    return answer;
  }

  /** An upgrade to `/v1/phone/…`: `ok`, or HTTP 429. */
  phoneUpgrade(address: string): "ok" | "rate" {
    const answer = this.admission.phoneUpgrade(address, this.clock.now());
    if (answer !== "ok") {
      this.log.write("warning", "upgradeRefused", { link: "phone", why: "rate" });
      return "rate";
    }
    return "ok";
  }

  /** An upgraded hub socket: its link, or undefined when it was closed at once (4429). */
  openHub(socket: RelaySocket, address: string): HubLink | undefined {
    if (this.stopped) {
      socket.close(RELAY_CLOSE.stopping);
      return undefined;
    }
    if (!this.admission.handshakeStarts(address)) {
      this.log.write("warning", "hubRefused", { why: "overLimit" });
      socket.close(RELAY_CLOSE.overLimit);
      return undefined;
    }
    const link = new HubLink(socket, this, address);
    this.links.add(link);
    return link;
  }

  /** An upgraded phone socket at `url`: its stream, or undefined when it was closed at once. */
  openPhone(socket: RelaySocket, address: string, url: string): PhoneStream | undefined {
    const refuse = (code: number, why: "badPath" | "notConnected" | "overLimit"): void => {
      this.log.write("warning", "streamRefused", { why });
      socket.close(code);
    };
    if (this.stopped) {
      refuse(PHONE_CLOSE.stopping, "overLimit");
      return undefined;
    }
    const path = readPhoneRequest(url);
    if (path === undefined) {
      refuse(PHONE_CLOSE.badPath, "badPath");
      return undefined;
    }
    const link = this.byIdentity.get(path.identity);
    if (link === undefined) {
      refuse(PHONE_CLOSE.hubNotConnected, "notConnected");
      return undefined;
    }
    const number = this.nextStream.get(link) ?? 0;
    if (number > RELAY_LIMITS.maxStream) {
      refuse(PHONE_CLOSE.overLimit, "overLimit");
      return undefined;
    }
    const answer = this.admission.streamOpens(path.identity, address, this.clock.now());
    if (answer !== "ok") {
      this.log.write("warning", "streamRefused", { why: answer });
      socket.close(PHONE_CLOSE.overLimit);
      return undefined;
    }
    const peer = this.options.pseudonyms.of(address);
    if (peer.isErr()) {
      this.admission.streamClosed(path.identity, address);
      this.log.write("error", "streamRefused", { why: "overLimit" }, peer.error);
      socket.close(PHONE_CLOSE.tryLater);
      return undefined;
    }
    this.nextStream.set(link, number + 1);
    const stream = new PhoneStream(socket, this, number, path.identity, path.path, address);
    let open = this.streams.get(link);
    if (open === undefined) {
      open = new Map();
      this.streams.set(link, open);
    }
    open.set(number, stream);
    this.streamLink.set(stream, link);
    if (!link.send({ t: "open", stream: number, path: path.path, peer: peer.value })) {
      stream.hubGone();
    }
    return stream;
  }

  // ----- HubLinkHost -----

  welcome(): Omit<RelayWelcome, "proto"> {
    return {
      relay: this.options.version,
      roles: this.options.roles,
      limits: {
        maxRosterBytes: PROTECTION_LIMITS.memory.rosterBytes,
        maxPushItemsPerFrame: RELAY_LIMITS.maxPushItemsPerFrame,
        maxReleasePieceBytes: RELAY_LIMITS.maxReleasePieceBytes,
        maxRestartWithinMs: PRESENCE_RULES.graceMaxMs,
      },
    };
  }

  join(link: HubLink, identity: string): "ok" | { readonly close: number } {
    if (this.stopped) return { close: RELAY_CLOSE.stopping };
    if (this.refused.has(identity)) {
      this.log.write("warning", "hubRefused", { why: "refused" });
      return { close: RELAY_CLOSE.refused };
    }
    const nowMs = this.clock.now();
    const older = this.byIdentity.get(identity);
    const known = this.records.get(identity);
    const answer = this.admission.join(
      link.address,
      nowMs,
      { known: known !== undefined, stored: this.records.size },
      older?.address,
    );
    if (answer.kind === "full") {
      this.log.write("warning", "hubRefused", { why: "full" });
      return { close: RELAY_CLOSE.overLimit };
    }
    if (answer.kind === "newIdentity") {
      // The operator is told once a UTC day at most, however many identities are refused.
      if (answer.stored && this.capAlertedDay !== utcDay(nowMs)) {
        this.capAlertedDay = utcDay(nowMs);
        this.log.write("warning", "operatorAlert", {
          what: "storedIdentities",
          stored: this.records.size,
        });
      }
      this.log.write("warning", "hubRefused", { why: "newIdentity" });
      link.send({ t: "limit", what: "newIdentity", retryAfterMs: answer.retryAfterMs });
      return { close: RELAY_CLOSE.overLimit };
    }
    if (known === undefined) {
      const record = newRecord(identity, nowMs);
      this.records.set(identity, record);
      const presence: HubPresence = {
        identity,
        lastContactMs: nowMs,
        state: "online",
        graceEndMs: 0,
        hasTargets: false,
      };
      this.written(this.store.addHub(record, presence));
    } else {
      this.noteDay(known, nowMs);
    }
    this.byIdentity.set(identity, link);
    if (older !== undefined) older.close(RELAY_CLOSE.replaced);
    const roster = this.store.targets(identity);
    this.written(roster.map(() => undefined));
    this.rosters.set(identity, new Map(targetsOf(roster.unwrapOr([]))));
    this.log.write("info", "hubJoined", {
      new: known === undefined,
      replaced: older !== undefined,
      links: this.admission.counts.authenticated,
    });
    this.present({ kind: "linkJoined", identity, atMs: nowMs });
    return "ok";
  }

  heard(link: HubLink): void {
    const identity = link.identity;
    if (identity === undefined || this.byIdentity.get(identity) !== link) return;
    const nowMs = this.clock.now();
    const record = this.records.get(identity);
    if (record !== undefined) this.noteDay(record, nowMs);
    this.present({ kind: "frame", identity, atMs: nowMs });
  }

  text(link: HubLink, frame: HubToRelayFrame): void {
    const identity = link.identity;
    if (identity === undefined) return;
    switch (frame.t) {
      case "ping":
        link.send({ t: "pong", n: frame.n });
        return;
      case "close":
        this.streams.get(link)?.get(frame.stream)?.closedByHub(frame.code);
        return;
      case "roster":
        this.roster(link, identity, frame.rev, frame.targets);
        return;
      case "push":
        this.hubPush(link, identity, frame.items);
        return;
      case "restarting":
        this.present({
          kind: "restarting",
          identity,
          reason: frame.reason,
          withinMs: frame.withinMs,
          atMs: this.clock.now(),
        });
        return;
      case "release.check": {
        const releases =
          this.options.releases?.check(this.peerOf(link, identity), checkOf(frame)) ?? [];
        link.send({ t: "release.offer", releases: [...releases] });
        return;
      }
      case "release.get":
        this.releaseGet(link, identity, frame);
        return;
    }
  }

  streamData(link: HubLink, stream: number, message: Uint8Array): void {
    this.streams.get(link)?.get(stream)?.fromHub(message);
  }

  gone(link: HubLink): void {
    if (!this.links.delete(link)) return;
    const identity = link.identity;
    if (link.everJoined && identity !== undefined) {
      this.admission.linkClosed(link.address);
      if (this.byIdentity.get(identity) === link) {
        this.byIdentity.delete(identity);
        this.rosters.delete(identity);
        const record = this.records.get(identity);
        if (record !== undefined) {
          const closed = linkClosed(record, link.lastFrameMs);
          if (closed !== record) {
            this.records.set(identity, closed);
            this.written(this.store.putRecord(closed));
          }
        }
      }
      this.log.write("info", "hubClosed", { links: this.admission.counts.authenticated });
    } else {
      this.admission.handshakeEnded(link.address);
    }
    for (const stream of this.streams.get(link)?.values() ?? []) stream.hubGone();
    this.streams.delete(link);
    this.nextStream.delete(link);
    this.pushesInHand.delete(link);
    this.piecesInHand.delete(link);
  }

  // ----- StreamHost -----

  toHub(stream: PhoneStream, frame: Uint8Array): boolean {
    return this.streamLink.get(stream)?.sendBinary(frame) ?? false;
  }

  closedToHub(stream: PhoneStream, code: number): void {
    const valid = Number.isInteger(code) && code >= 1000 && code <= 4999;
    this.streamLink
      .get(stream)
      ?.send({ t: "close", stream: stream.stream, code: valid ? code : ABNORMAL_CLOSE });
  }

  carried(stream: PhoneStream, bytes: number): void {
    this.admission.carried(stream.hub, bytes, this.clock.now());
  }

  streamGone(stream: PhoneStream): void {
    const link = this.streamLink.get(stream);
    this.streamLink.delete(stream);
    this.admission.streamClosed(stream.hub, stream.address);
    if (link !== undefined) this.streams.get(link)?.delete(stream.stream);
    this.log.write("info", "streamClosed", { streams: this.admission.counts.streams });
  }

  // ----- The operator -----

  /** The operator's refused hub keys changed: joined links of those keys close at once (4403). */
  setRefused(identities: ReadonlySet<string>): void {
    this.refused = identities;
    for (const [identity, link] of this.byIdentity) {
      if (identities.has(identity)) link.close(RELAY_CLOSE.refused);
    }
    this.log.write("info", "refusedHubs", { count: identities.size });
  }

  /** Stops: every phone hears 1001, every hub link closes with 1001; timers end. */
  stop(): void {
    this.stopped = true;
    this.cancelWake();
    this.cancelSweep();
    for (const streams of this.streams.values()) {
      for (const stream of streams.values()) stream.stopping();
    }
    for (const link of [...this.links]) link.close(RELAY_CLOSE.stopping);
  }

  /** Counts, for the tests and the load test. */
  get counts() {
    return {
      ...this.admission.counts,
      hubs: this.records.size,
      joined: this.byIdentity.size,
      deadlines: this.deadlines.size,
    };
  }

  /** A hub's presence as the relay holds it, for the tests. */
  presenceOf(identity: string): HubPresence | undefined {
    return this.presence.get(identity);
  }

  /** A hub's record, for the tests. */
  recordOf(identity: string): HubRecord | undefined {
    return this.records.get(identity);
  }

  // ----- Inside -----

  private peerOf(link: HubLink, identity: string): ReleasePeer {
    return { kind: "hub", identity, address: link.address };
  }

  /** A storage write that failed is logged; the relay goes on from memory. */
  private written(result: Result<void, RelayError>): void {
    if (result.isErr()) this.log.write("error", "storage", {}, result.error);
  }

  /** A frame on a new UTC day counts one more day seen, stored. */
  private noteDay(record: HubRecord, nowMs: number): void {
    const next = seenOn(record, nowMs);
    if (!next.store) return;
    this.records.set(record.identity, next.record);
    this.written(this.store.putRecord(next.record));
  }

  private roster(
    link: HubLink,
    identity: string,
    rev: number,
    list: readonly RosterTarget[],
  ): void {
    const stored = this.store.replaceTargets(identity, list);
    this.rosters.set(identity, new Map(targetsOf(list)));
    this.present({
      kind: "roster",
      identity,
      hasTargets: list.length > 0,
      atMs: this.clock.now(),
    });
    this.log.write("info", "roster", { targets: list.length });
    if (stored.isErr()) {
      // Not acknowledged: the hub sends its roster again.
      this.log.write("error", "storage", {}, stored.error);
      return;
    }
    link.send({ t: "rosterAck", rev });
  }

  private hubPush(link: HubLink, identity: string, items: readonly HubPushItem[]): void {
    const inHand = this.pushesInHand.get(link) ?? 0;
    if (inHand >= PUSH_SERVICE_LIMITS.framesInHand) {
      link.send({
        t: "pushResult",
        results: items.map((item) => ({ id: item.id, outcome: "limited" })),
      });
      return;
    }
    this.pushesInHand.set(link, inHand + 1);
    const resolved = resolvePush(identity, items, this.rosters.get(identity) ?? new Map());
    const byRelayId = new Map<number, ResolvedItem>();
    const relayItems = resolved.send.map((r) => {
      const id = this.nextPushId++;
      byRelayId.set(id, r);
      return { id, ...r.item };
    });
    void this.deliver(relayItems).then((delivered) => {
      this.pushesInHand.set(link, (this.pushesInHand.get(link) ?? 1) - 1);
      const outcomes = new Map<number, PushOutcome>();
      for (const id of resolved.unknown) outcomes.set(id, "failed");
      for (const [relayId, outcome] of delivered.outcomes) {
        const r = byRelayId.get(relayId);
        if (r?.hubId === null || r === undefined) continue;
        outcomes.set(r.hubId, outcome);
        if (outcome === "badToken") this.dropTarget(identity, r.key);
      }
      let accepted = 0;
      let failed = 0;
      const results = items.map((item) => {
        const outcome = outcomes.get(item.id) ?? "failed";
        if (outcome === "accepted") accepted += 1;
        if (outcome === "failed") failed += 1;
        return { id: item.id, outcome };
      });
      this.log.write("info", "pushFrame", { items: items.length, accepted, failed });
      if (!link.joined) return;
      if (delivered.limitedForMs !== undefined) {
        link.send({ t: "limit", what: "pushes", retryAfterMs: delivered.limitedForMs });
      }
      link.send({ t: "pushResult", results });
    });
  }

  /** Hands items to the push service, in frames that fit; every item gets an outcome. */
  private async deliver(items: readonly RelayPushItem[]): Promise<Delivered> {
    const outcomes = new Map<number, PushOutcome>();
    if (items.length === 0) return { outcomes, limitedForMs: undefined };
    const split = splitRelayPushItems(items);
    if (!split.ok) {
      for (const item of items) outcomes.set(item.id, "failed");
      return { outcomes, limitedForMs: undefined };
    }
    let limitedForMs: number | undefined;
    await Promise.all(
      split.value.map(async (frame) => {
        const sent = await this.push.send(frame.items);
        if (sent.isOk()) {
          for (const result of sent.value) outcomes.set(result.id, result.outcome);
          return;
        }
        const outcome: PushOutcome = sent.error.kind === "limited" ? "limited" : "failed";
        if (sent.error.kind === "limited") {
          limitedForMs = Math.max(limitedForMs ?? 0, sent.error.retryAfterMs);
        }
        for (const item of frame.items) outcomes.set(item.id, outcome);
      }),
    );
    for (const item of items) if (!outcomes.has(item.id)) outcomes.set(item.id, "failed");
    return { outcomes, limitedForMs };
  }

  private dropTarget(identity: string, key: string): void {
    const roster = this.rosters.get(identity);
    roster?.delete(key);
    this.written(this.store.dropTarget(identity, key));
    if (roster?.size === 0) {
      this.present({ kind: "roster", identity, hasTargets: false, atMs: this.clock.now() });
    }
  }

  /** The hub's targets: its roster when linked, else as stored. */
  private targetsFor(identity: string): Map<string, RosterTarget> {
    const linked = this.rosters.get(identity);
    if (linked !== undefined) return linked;
    const stored = this.store.targets(identity);
    this.written(stored.map(() => undefined));
    return new Map(targetsOf(stored.unwrapOr([])));
  }

  /**
   * Sends a hub's `unreachable` or `back` to `keys` of its targets (all when undefined), and tries
   * the ones that fail again on `RELAY_BACKOFF`'s steps while the alert still holds.
   */
  private alert(
    identity: string,
    which: "unreachable" | "back",
    keys?: ReadonlySet<string>,
    tries = 0,
  ): void {
    const targets = this.targetsFor(identity);
    const items = alertItems(identity, targets, which).filter(
      (r) => keys === undefined || keys.has(r.key),
    );
    if (items.length === 0) return;
    const byRelayId = new Map<number, ResolvedItem>();
    const relayItems = items.map((r) => {
      const id = this.nextPushId++;
      byRelayId.set(id, r);
      return { id, ...r.item };
    });
    void this.deliver(relayItems).then((delivered) => {
      const again = new Set<string>();
      let accepted = 0;
      for (const [relayId, outcome] of delivered.outcomes) {
        const r = byRelayId.get(relayId);
        if (r === undefined) continue;
        if (outcome === "accepted") accepted += 1;
        else if (outcome === "badToken") this.dropTarget(identity, r.key);
        else again.add(r.key);
      }
      this.log.write("info", "alertSent", {
        alert: which,
        targets: items.length,
        accepted,
        failed: again.size,
      });
      const wait = RELAY_BACKOFF.stepsMs[tries];
      if (again.size === 0 || wait === undefined || this.stopped) return;
      this.clock.after(wait, () => {
        const state = this.presence.get(identity)?.state;
        const holds = which === "unreachable" ? state === "alerted" : state === "online";
        if (holds && !this.stopped) this.alert(identity, which, again, tries + 1);
      });
    });
  }

  /** Runs the presence core over the hubs `input` concerns, and does what it asks. */
  private present(input: PresenceInput): void {
    let subset: Map<string, HubPresence>;
    switch (input.kind) {
      case "frame":
      case "linkJoined":
      case "restarting":
      case "roster": {
        const hub = this.presence.get(input.identity);
        subset = new Map<string, HubPresence>(hub === undefined ? [] : [[hub.identity, hub]]);
        break;
      }
      case "tick":
        subset = new Map();
        for (const identity of this.deadlines.takeDue(input.atMs)) {
          const hub = this.presence.get(identity);
          if (hub !== undefined) subset.set(identity, hub);
        }
        break;
      case "relayStarted":
        subset = new Map(this.presence);
        break;
    }
    const step = this.core(subset, input);
    for (const hub of step.hubs.values()) {
      this.presence.set(hub.identity, hub);
      this.deadlines.set(hub.identity, presenceDeadline(hub));
    }
    for (const out of step.out) this.perform(out);
    if (input.kind !== "tick") {
      this.arm();
      return;
    }
    const next = this.deadlines.next;
    const stalled = next !== null && next <= input.atMs;
    if (!stalled) this.stalled = false;
    this.arm(stalled);
  }

  private perform(out: PresenceOutput): void {
    switch (out.kind) {
      case "sendUnreachable":
        this.alert(out.identity, "unreachable");
        return;
      case "sendBack":
        this.alert(out.identity, "back");
        return;
      case "closeLink":
        this.byIdentity.get(out.identity)?.close(RELAY_CLOSE.handshakeTimeout);
        return;
      case "restartingAck":
        this.byIdentity.get(out.identity)?.send({ t: "restartingAck" });
        return;
      case "store":
        if (this.records.has(out.hub.identity)) this.written(this.store.putPresence(out.hub));
        return;
    }
  }

  /** One timer, at the earliest deadline. */
  /**
   * One timer, at the earliest deadline. A tick at `t` leaves every deadline after `t` when the
   * core is right; if one is still due (`stalled`), the core made no progress on it, and waking
   * again at once would spin the relay's only thread. Then the timer waits `STALL_FLOOR_MS`, and
   * the stall is logged once until a tick makes progress again.
   */
  private arm(stalled = false): void {
    const next = this.deadlines.next;
    if (stalled) {
      if (!this.stalled) {
        this.log.write("error", "presenceStalled", { hubs: this.deadlines.size });
      }
      this.stalled = true;
    }
    if ((next === this.armedAt && !stalled) || this.stopped) return;
    this.cancelWake();
    this.armedAt = next;
    if (next === null) {
      this.cancelWake = () => undefined;
      return;
    }
    const wait = stalled ? STALL_FLOOR_MS : Math.max(0, next - this.clock.now());
    this.cancelWake = this.clock.after(wait, () => {
      this.armedAt = null;
      this.present({ kind: "tick", atMs: this.clock.now() });
    });
  }

  /**
   * Deletes identities past their retention, with their targets; again at the next midnight UTC.
   *
   * A hub whose link is up is never among them, by construction, so nothing here checks for one:
   * its record's `seenMs` is set when it joins and again at its first frame of each UTC day, and a
   * link stays up only while a frame comes every `silentCloseMs` (the presence core closes it
   * otherwise, at a deadline earlier than any sweep that could find it expired). So at any sweep a
   * linked hub was seen within the last UTC day and 75 s, far inside the shortest retention
   * (`unsettledHubMs`, 7 days); `storage.test.ts` holds a hub linked across midnight to this.
   */
  private sweep(): void {
    const nowMs = this.clock.now();
    const expired = [...this.records.values()]
      .filter((record) => isExpired(record, nowMs))
      .map((record) => record.identity);
    const deleted = this.store.deleteHubs(expired);
    if (deleted.isErr()) {
      this.log.write("error", "storage", {}, deleted.error);
    } else {
      for (const identity of expired) {
        this.records.delete(identity);
        this.presence.delete(identity);
        this.deadlines.set(identity, null);
      }
      this.log.write("info", "sweep", { deleted: deleted.value, kept: this.records.size });
    }
    this.cancelSweep = this.clock.after(untilNextUtcDay(nowMs), () => {
      this.sweep();
    });
  }

  private releaseGet(
    link: HubLink,
    identity: string,
    frame: Extract<HubToRelayFrame, { t: "release.get" }>,
  ): void {
    const releases = this.options.releases;
    if (releases === undefined) {
      link.send({ t: "release.error", id: frame.id, reason: "unavailable" });
      return;
    }
    const inHand = this.piecesInHand.get(link) ?? 0;
    if (inHand >= RELAY_LIMITS.maxReleasePiecesInFlight) {
      link.send({ t: "release.error", id: frame.id, reason: "limit" });
      return;
    }
    this.piecesInHand.set(link, inHand + 1);
    void releases.get(this.peerOf(link, identity), requestOf(frame)).then((answer) => {
      this.piecesInHand.set(link, (this.piecesInHand.get(link) ?? 1) - 1);
      if (!link.joined) return;
      if (!answer.ok) {
        link.send({
          t: "release.error",
          id: frame.id,
          reason: answer.reason,
          ...(answer.retryAfterMs === undefined ? {} : { retryAfterMs: answer.retryAfterMs }),
        });
        return;
      }
      const piece = relayBinaryCodec.encode({
        kind: RELAY_BINARY_KIND.releasePiece,
        id: frame.id,
        bytes: answer.bytes,
      });
      if (piece.ok) link.sendBinary(piece.value);
      else link.send({ t: "release.error", id: frame.id, reason: "unavailable" });
    });
  }
}

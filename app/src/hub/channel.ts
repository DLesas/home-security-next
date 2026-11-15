/**
 * The channel client (m2-design.md sections 5 and 8): one session per hub, kept open, and the
 * requests, replies and events inside it.
 *
 * - **Connection.** On a drop the client reconnects after 1, 2, 4, then every 10 s ‡
 *   (`APP_RECONNECT_MS`), takes a new snapshot, and the store shows that it is out of touch.
 *   After `HubHello` it asks for `snapshot`, then `subscribe`s; events at or below the snapshot's
 *   `rev` are already in it and are dropped. A gap in `rev` means nothing; a new snapshot comes
 *   only with a new session (section 5).
 * - **Requests** carry an `id` per connection. A change carries a `seq`, written to storage before
 *   the request is sent (section 8). Requests made while out of touch are not queued: they fail at
 *   once, in words. A change already sent whose reply was lost with the session is sent again,
 *   with the **same** `seq`, on the next session, so the hub does it once (section 5); a read
 *   whose reply was lost fails.
 * - **`seqTooLow {last}`**: the change was not made; the stored last `seq` moves up to the hub's
 *   and the change is sent once more with a new number (section 5; after a restore, section 9).
 * - **Liveness** is inside Noise: the hub's `ping` is answered with `pong`; a session from which
 *   nothing has come for 60 s ‡ is closed by the client too, and opened again.
 * - **Failure**: any message that does not decrypt, or that is not a frame of the channel, closes
 *   the socket; the client reconnects with a new handshake.
 * - A `session` event says this client was removed: the client stops, and says so.
 *
 * The hub decides what a person may do; the client never skips asking because it thinks the
 * answer would be no, and shows each refusal as the hub gave it.
 */
import {
  APP_OPS,
  APP_RECONNECT_MS,
  type AppError,
  type AppEvent,
  type AppOpBody,
  type AppOpName,
  type AppOpReply,
  appReply,
  type HubHello,
  parseEvent,
  SESSION_LIMITS,
  type SnapshotObject,
  TOPICS,
  type TransportSession,
} from "@hsn/protocol/app";
import type { LocalFault } from "./faults";
import { decodeJson, encodeJson } from "./codec";
import { openSession, type SessionFailure } from "./handshake";
import { raiseSeq, type RecordStore, reserveSeq, type StoredClient } from "../platform/client-key";
import { CLOSE, type Connect, type Timers, type Wire } from "./wire";

export type RequestOutcome<N extends AppOpName> =
  | { readonly ok: true; readonly body: AppOpReply<N>; readonly repeat: boolean }
  | { readonly ok: false; readonly error: AppError }
  | { readonly ok: false; readonly local: LocalFault };

type AnyOutcome =
  | { readonly ok: true; readonly body: unknown; readonly repeat: boolean }
  | { readonly ok: false; readonly error: AppError }
  | { readonly ok: false; readonly local: LocalFault };

export type ChannelStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "notLinked" }
  /** The browser's storage cannot be used, so it cannot be linked (section 5). */
  | { readonly kind: "noStorage" }
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "open"; readonly hello: HubHello }
  | {
      readonly kind: "waiting";
      readonly attempt: number;
      readonly failure: SessionFailure | "closed";
      readonly retryInMs: number;
      /** Five refusals before message 2 in a row, over at least a minute ‡: perhaps removed. */
      readonly mayBeRemoved: boolean;
    }
  | { readonly kind: "removed" };

/** What the channel tells the store. */
export interface ChannelListener {
  status(status: ChannelStatus): void;
  snapshot(snapshot: SnapshotObject, hello: HubHello): void;
  event(event: AppEvent): void;
}

/** A request's maker, as the screens see it: the channel, or another tab's (`tabs.ts`). */
export interface Requester {
  request<N extends AppOpName>(op: N, body: AppOpBody<N>): Promise<RequestOutcome<N>>;
}

interface Pending {
  readonly op: AppOpName;
  readonly body: unknown;
  readonly seq: number | undefined;
  readonly resolve: (outcome: AnyOutcome) => void;
  readonly retriedTooLow: boolean;
}

/** A lost change is sent again with its `seq` only this long after it was lost ‡ (section 8). */
export const RETRY_WINDOW_MS = 30_000;

/** Refusals before message 2, in a row and over at least this long, before "may have been removed" ‡. */
export const REFUSALS_BEFORE_DOUBT = 5;
export const REFUSALS_OVER_MS = 60_000;

/** A session that nothing has come from for this long is closed by the client ‡. */
export const CLIENT_LIVENESS_MS = SESSION_LIMITS.livenessMs;

class Session {
  private ended = false;
  constructor(
    readonly hello: HubHello,
    private readonly transport: TransportSession,
    private readonly wire: Wire,
  ) {}

  /** Encrypts and sends one frame, in order; false when the session has ended. */
  send(frame: unknown): boolean {
    if (this.ended) return false;
    const sealed = this.transport.encrypt(encodeJson(frame));
    if (!sealed.ok) {
      this.close(CLOSE.protocol);
      return false;
    }
    this.wire.send(sealed.value);
    return true;
  }

  /** The frame a message carries, or undefined after closing the socket for it. */
  open(data: Uint8Array): { readonly value: unknown } | undefined {
    if (this.ended) return undefined;
    const opened = this.transport.decrypt(data);
    const json = opened.ok ? decodeJson(opened.value) : undefined;
    if (json === undefined) this.close(CLOSE.protocol);
    return json;
  }

  close(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.wire.close(code);
  }

  get isOpen(): boolean {
    return !this.ended;
  }
}

export class Channel implements Requester {
  private session: Session | undefined;
  private record: StoredClient | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private retry: { readonly pending: Pending; readonly lostAt: number }[] = [];
  private refusals: { count: number; since: number } | undefined;
  private attempt = 0;
  private snapshotRev: number | undefined;
  private early: AppEvent[] = [];
  private lastHeard = 0;
  private stopped = false;
  private removed = false;
  private cancelTimer: (() => void) | undefined;
  private cancelLiveness: (() => void) | undefined;

  constructor(
    private readonly deps: {
      readonly connect: Connect;
      readonly store: RecordStore;
      readonly timers: Timers;
      readonly app: string;
      readonly listener: ChannelListener;
    },
  ) {}

  /** Loads this browser's record and connects, or says it is not linked. */
  async start(): Promise<void> {
    this.stopped = false;
    this.deps.listener.status({ kind: "loading" });
    const read = await this.deps.store.read();
    if (!read.ok) {
      this.deps.listener.status({ kind: "noStorage" });
      return;
    }
    this.record = read.value;
    if (this.record === undefined) {
      this.deps.listener.status({ kind: "notLinked" });
      return;
    }
    this.removed = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelLiveness?.();
    this.session?.close(CLOSE.normal);
    this.session = undefined;
  }

  async request<N extends AppOpName>(op: N, body: AppOpBody<N>): Promise<RequestOutcome<N>> {
    // The reply was checked against `op`'s reply schema before it resolves (`reply` below).
    return (await this.requestAny(op, body)) as RequestOutcome<N>;
  }

  /** Another tab's request (`tabs.ts`), sent as it came: the hub checks its body. */
  forward(op: AppOpName, body: unknown): Promise<AnyOutcome> {
    return this.requestAny(op, body);
  }

  private async requestAny(op: AppOpName, body: unknown): Promise<AnyOutcome> {
    if (this.removed) return { ok: false, local: "removed" };
    if (this.record === undefined) return { ok: false, local: "notLinked" };
    if (!this.isOpen()) return { ok: false, local: "offline" };
    let seq: number | undefined;
    if (APP_OPS[op].change) {
      // Written before it is sent (section 8): a crash in between skips a number, never reuses one.
      seq = await reserveSeq(this.deps.store);
      if (seq === undefined) return { ok: false, local: "storage" };
      if (!this.isOpen()) return { ok: false, local: "offline" };
    }
    return new Promise((resolve) => {
      this.send({ op, body, seq, resolve, retriedTooLow: false });
    });
  }

  /** Read through methods: the session and the stop can change while a request awaits. */
  private isOpen(): boolean {
    return this.session?.isOpen === true;
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private send(pending: Pending): void {
    const session = this.session;
    if (session === undefined) {
      if (pending.seq === undefined) pending.resolve({ ok: false, local: "offline" });
      else this.keepForRetry(pending);
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, pending);
    const frame = {
      t: "req",
      id,
      ...(pending.seq === undefined ? {} : { seq: pending.seq }),
      op: pending.op,
      body: pending.body,
    };
    session.send(frame);
  }

  private async connect(): Promise<void> {
    const record = this.record;
    if (record === undefined || this.stopped || this.removed) return;
    this.deps.listener.status({ kind: "connecting", attempt: this.attempt });
    const opened = await openSession(this.deps.connect, record, this.deps.app, this.deps.timers);
    if (this.isStopped()) {
      if (opened.ok) opened.value.wire.close(CLOSE.normal);
      return;
    }
    if (!opened.ok) {
      this.waitThenConnect(opened.fault);
      return;
    }
    this.attempt = 0;
    this.refusals = undefined;
    const session = new Session(opened.value.hello, opened.value.transport, opened.value.wire);
    this.session = session;
    this.nextId = 1;
    this.snapshotRev = undefined;
    this.early = [];
    this.lastHeard = this.deps.timers.now();
    this.deps.listener.status({ kind: "open", hello: session.hello });
    opened.value.inbox.forward({
      message: (data) => {
        this.receive(session, data);
      },
      closed: () => {
        this.ended(session);
      },
    });
    this.watchLiveness(session);
    // The first transport message proves the key (section 5): the snapshot, then the topics.
    this.send({
      op: "snapshot",
      body: {},
      seq: undefined,
      retriedTooLow: false,
      resolve: (outcome) => {
        if (outcome.ok) this.snapshotTaken(session, outcome.body as SnapshotObject);
        else session.close(CLOSE.protocol);
      },
    });
    this.send({
      op: "subscribe",
      body: { topics: TOPICS },
      seq: undefined,
      retriedTooLow: false,
      resolve: () => undefined,
    });
    // A lost change goes again with its `seq` if this comes within its window (`keepForRetry`).
    for (const { pending } of this.retry.splice(0)) this.send(pending);
  }

  /** Kept for the next session, for 30 s ‡ at most; then not confirmed (wave 2's ruling). */
  private keepForRetry(pending: Pending): void {
    const entry = { pending, lostAt: this.deps.timers.now() };
    this.retry.push(entry);
    this.deps.timers.after(RETRY_WINDOW_MS, () => {
      const at = this.retry.indexOf(entry);
      if (at < 0) return;
      this.retry.splice(at, 1);
      pending.resolve({ ok: false, local: "unconfirmed" });
    });
  }

  private snapshotTaken(session: Session, snapshot: SnapshotObject): void {
    if (this.session !== session) return;
    this.snapshotRev = snapshot.rev;
    this.deps.listener.snapshot(snapshot, session.hello);
    for (const event of this.early.splice(0)) this.deliver(event);
  }

  private deliver(event: AppEvent): void {
    if (this.snapshotRev === undefined) {
      this.early.push(event);
      return;
    }
    // At or below the snapshot's revision: already in it (section 5).
    if (event.rev <= this.snapshotRev) return;
    this.deps.listener.event(event);
  }

  private receive(session: Session, data: Uint8Array): void {
    if (this.session !== session) return;
    const json = session.open(data);
    if (json === undefined) return;
    this.lastHeard = this.deps.timers.now();
    const frame = json.value;
    if (typeof frame === "object" && frame !== null && "t" in frame && frame.t === "res") {
      this.reply(session, frame);
      return;
    }
    const event = parseEvent(frame);
    if (!event.ok) {
      session.close(CLOSE.protocol);
      return;
    }
    if (event.value.ev === "ping") {
      this.send({
        op: "pong",
        body: {},
        seq: undefined,
        retriedTooLow: false,
        resolve: () => undefined,
      });
      return;
    }
    if (event.value.ev === "session") {
      // This client was removed, just before the close (section 6).
      this.removed = true;
      for (const pending of [
        ...this.pending.values(),
        ...this.retry.splice(0).map((r) => r.pending),
      ])
        pending.resolve({ ok: false, local: "removed" });
      this.pending.clear();
      this.deps.listener.status({ kind: "removed" });
      return;
    }
    this.deliver(event.value);
  }

  private reply(session: Session, frame: unknown): void {
    const parsed = appReply.safeParse(frame);
    if (!parsed.success) {
      session.close(CLOSE.protocol);
      return;
    }
    const pending = this.pending.get(parsed.data.id);
    if (pending === undefined) return;
    this.pending.delete(parsed.data.id);
    if (parsed.data.ok) {
      const body = APP_OPS[pending.op].reply.safeParse(parsed.data.body);
      pending.resolve(
        body.success
          ? { ok: true, body: body.data, repeat: parsed.data.repeat === true }
          : { ok: false, local: "badReply" },
      );
      return;
    }
    const error = parsed.data.error;
    if (error.code === "seqTooLow" && pending.seq !== undefined && !pending.retriedTooLow) {
      void this.resendAbove(pending, error.detail.last);
      return;
    }
    pending.resolve({ ok: false, error });
  }

  /** `seqTooLow`: the change was not made; again, once, above the hub's last. */
  private async resendAbove(pending: Pending, last: number): Promise<void> {
    const raised = await raiseSeq(this.deps.store, last);
    const seq = raised ? await reserveSeq(this.deps.store) : undefined;
    if (seq === undefined) {
      pending.resolve({ ok: false, local: "storage" });
      return;
    }
    if (!this.isOpen()) {
      pending.resolve({ ok: false, local: "offline" });
      return;
    }
    this.send({ ...pending, seq, retriedTooLow: true });
  }

  private ended(session: Session): void {
    if (this.session !== session) return;
    session.close(CLOSE.normal);
    this.session = undefined;
    this.cancelLiveness?.();
    for (const pending of this.pending.values()) {
      // A change's reply may have been lost after the hub made it: the same `seq` again (section 5).
      if (pending.seq !== undefined && !this.removed) this.keepForRetry(pending);
      else pending.resolve({ ok: false, local: this.removed ? "removed" : "lost" });
    }
    this.pending.clear();
    if (this.removed || this.stopped) return;
    this.waitThenConnect("closed");
  }

  private waitThenConnect(failure: SessionFailure | "closed"): void {
    const delays = APP_RECONNECT_MS;
    const retryInMs = delays[Math.min(this.attempt, delays.length - 1)] ?? delays[0];
    const now = this.deps.timers.now();
    // A close before message 2 tells nothing certain (wave 2's ruling): only a run of them does.
    this.refusals =
      failure === "refused"
        ? { count: (this.refusals?.count ?? 0) + 1, since: this.refusals?.since ?? now }
        : undefined;
    const mayBeRemoved =
      this.refusals !== undefined &&
      this.refusals.count >= REFUSALS_BEFORE_DOUBT &&
      now - this.refusals.since >= REFUSALS_OVER_MS;
    this.deps.listener.status({
      kind: "waiting",
      attempt: this.attempt,
      failure,
      retryInMs,
      mayBeRemoved,
    });
    this.attempt += 1;
    this.cancelTimer?.();
    this.cancelTimer = this.deps.timers.after(retryInMs, () => {
      void this.connect();
    });
  }

  private watchLiveness(session: Session): void {
    this.cancelLiveness?.();
    const check = () => {
      if (this.session !== session) return;
      if (this.deps.timers.now() - this.lastHeard >= CLIENT_LIVENESS_MS) {
        session.close(CLOSE.protocol);
        this.ended(session);
        return;
      }
      this.cancelLiveness = this.deps.timers.after(CLIENT_LIVENESS_MS / 4, check);
    };
    this.cancelLiveness = this.deps.timers.after(CLIENT_LIVENESS_MS / 4, check);
  }
}

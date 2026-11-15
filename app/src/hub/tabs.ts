/**
 * One session per browser (m2-design.md section 5, "One session per browser"): the tabs of one
 * browser share one key; one tab holds the session for all of them, chosen with Web Locks, and the
 * others talk to it through a BroadcastChannel ‡. A tab that takes over after the holder closes
 * opens a new session.
 *
 * What travels between tabs is the live store's state (plain data, nothing secret) and the
 * requests and their outcomes. Never a key, a code or a secret.
 */
import { APP_OPS, type AppEvent, type AppOpBody, type AppOpName } from "@hsn/protocol/app";
import type { Channel, ChannelListener, RequestOutcome, Requester } from "./channel";
import type { LiveState, LiveStore } from "../state/live";

/** The lock's name: one per origin, and so per hub. */
export const SESSION_LOCK = "hsn-hub-session";
export const TAB_CHANNEL = "hsn-tabs";

/** `navigator.locks`, as much of it as is used. */
export interface Locks {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
}

/** A BroadcastChannel, as much of it as is used. */
export interface Bus {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

type TabMessage =
  | { readonly t: "state"; readonly from: string; readonly state: LiveState }
  | { readonly t: "want"; readonly from: string }
  | {
      readonly t: "req";
      readonly from: string;
      readonly rid: number;
      readonly op: AppOpName;
      readonly body: unknown;
    }
  | { readonly t: "res"; readonly to: string; readonly rid: number; readonly outcome: unknown }
  | { readonly t: "leader"; readonly from: string }
  | { readonly t: "linked"; readonly from: string }
  /** An event the store does not keep (a file's chunk), from the tab that holds the session. */
  | { readonly t: "evt"; readonly from: string; readonly event: AppEvent };

/** A message from another tab, its request's operation one of the channel's. */
export function isTabMessage(value: unknown): value is TabMessage {
  if (typeof value !== "object" || value === null || !("t" in value) || typeof value.t !== "string")
    return false;
  return (
    value.t !== "req" ||
    ("op" in value && typeof value.op === "string" && Object.hasOwn(APP_OPS, value.op))
  );
}

export class Tabs implements Requester {
  private leading = false;
  private leader: string | undefined;
  private channel: Channel | undefined;
  private nextRid = 1;
  private release: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly waiting = new Map<number, (outcome: unknown) => void>();

  constructor(
    private readonly deps: {
      readonly id: string;
      readonly locks: Locks;
      readonly bus: Bus;
      readonly store: LiveStore;
      readonly makeChannel: (listener: ChannelListener) => Channel;
      readonly listener: (store: LiveStore, forward: (event: AppEvent) => void) => ChannelListener;
      readonly onEvent: (event: AppEvent) => void;
    },
  ) {}

  get isLeader(): boolean {
    return this.leading;
  }

  start(): void {
    this.deps.bus.addEventListener("message", (event) => {
      if (isTabMessage(event.data)) this.heard(event.data);
    });
    void this.deps.locks.request(SESSION_LOCK, () => this.lead());
    this.post({ t: "want", from: this.deps.id });
  }

  /** This tab holds the lock until it closes: it opens the session and shares what it learns. */
  private lead(): Promise<void> {
    this.leading = true;
    this.leader = this.deps.id;
    this.failWaiting();
    this.channel = this.deps.makeChannel(
      this.deps.listener(this.deps.store, (event) => {
        if (event.ev === "fileChunk" || event.ev === "fileFailed")
          this.post({ t: "evt", from: this.deps.id, event });
      }),
    );
    this.unsubscribe = this.deps.store.subscribe((state) => {
      this.post({ t: "state", from: this.deps.id, state });
    });
    this.post({ t: "leader", from: this.deps.id });
    void this.channel.start();
    // Held until this tab stops: a page going away, or kept in the browser's back-forward cache,
    // must not keep the lock, or a reloaded page would wait behind it with no session.
    return new Promise<void>((release) => {
      this.release = release;
    });
  }

  async request<N extends AppOpName>(op: N, body: AppOpBody<N>): Promise<RequestOutcome<N>> {
    if (this.channel !== undefined) return this.channel.request(op, body);
    if (this.leader === undefined) return { ok: false, local: "offline" };
    const rid = this.nextRid++;
    const outcome = await new Promise<unknown>((resolve) => {
      this.waiting.set(rid, resolve);
      this.post({ t: "req", from: this.deps.id, rid, op, body });
    });
    // Another tab's channel checked the reply against `op`'s schema before it answered.
    return outcome as RequestOutcome<N>;
  }

  /** This tab goes: its session closes; the lock passes on when the page is gone. */
  stop(): void {
    this.channel?.stop();
    this.channel = undefined;
    this.unsubscribe?.();
    this.leading = false;
    this.release?.();
    this.release = undefined;
  }

  /** This browser was just linked, in this tab or another: the session's holder connects. */
  linked(): void {
    if (this.channel !== undefined) {
      this.channel.stop();
      void this.channel.start();
    } else {
      this.post({ t: "linked", from: this.deps.id });
    }
  }

  private heard(message: TabMessage): void {
    switch (message.t) {
      case "state":
        if (!this.leading) {
          this.leader = message.from;
          this.deps.store.setState(message.state, true);
        }
        return;
      case "want":
        if (this.leading)
          this.post({ t: "state", from: this.deps.id, state: this.deps.store.getState() });
        return;
      case "leader":
        if (message.from !== this.leader) this.failWaiting();
        this.leader = message.from;
        return;
      case "linked":
        if (this.leading) this.linked();
        return;
      case "req":
        if (this.channel !== undefined) {
          const asker = message.from;
          const rid = message.rid;
          // The other tab's request, through this tab's channel; the hub checks its body.
          void this.channel.forward(message.op, message.body).then((outcome) => {
            this.post({ t: "res", to: asker, rid, outcome });
          });
        }
        return;
      case "evt":
        if (
          !this.leading &&
          (message.event.ev === "fileChunk" || message.event.ev === "fileFailed")
        )
          this.deps.onEvent(message.event);
        return;
      case "res":
        if (message.to === this.deps.id) {
          this.waiting.get(message.rid)?.(message.outcome);
          this.waiting.delete(message.rid);
        }
        return;
    }
  }

  /** The tab that held the session closed: its answers will not come. */
  private failWaiting(): void {
    for (const resolve of this.waiting.values()) resolve({ ok: false, local: "tabClosed" });
    this.waiting.clear();
  }

  private post(message: TabMessage): void {
    this.deps.bus.postMessage(message);
  }
}

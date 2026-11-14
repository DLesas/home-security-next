/**
 * The bench's lockstep link (hub-design.md section 11, "Lockstep"): with `--bench-lockstep`,
 * the hub's links are carried on the bench's socket. This is the `Links` side of it: the
 * bench's `linkUp`, `linkDown` and `frame` messages become link events, released in time order
 * once the bench has advanced past their time, and every frame the hub sends is kept, with the
 * time it left, for the next `idle` answer. The socket, the clock and the turn are the loop's.
 */
import { fromHex, toHex } from "@hsn/protocol";
import { ok, type Result } from "neverthrow";
import type { LockstepToHub } from "../../control-protocol/index.ts";
import type { LinkId } from "../../core/model/ids.ts";
import type { LinkError } from "../../ports/links.ts";
import type { LinkRegistry } from "./registry.ts";

type FromBench = Extract<LockstepToHub, { readonly type: "frame" | "linkUp" | "linkDown" }>;

/** A frame the hub sent, as an `idle` answer lists it. */
export interface SentFrame {
  readonly link: string;
  readonly at: number;
  readonly bytes: string;
}

/** The lockstep link's adapter: the bench's link messages in, the hub's frames out. */
/** A link the hub closed, as `idle.closed` gives it. */
export interface ClosedLink {
  readonly link: string;
  readonly at: number;
  readonly reason: string;
}

export class LockstepLinks {
  readonly #registry: LinkRegistry;
  readonly #now: () => number;
  /** The bench's messages not yet released, in the order they came. */
  readonly #waiting: FromBench[] = [];
  readonly #byName = new Map<string, LinkId>();
  /** Links the hub closed, by name, while the controller has not said they are down. */
  readonly #closedByHub = new Map<string, LinkId>();
  readonly #closed: ClosedLink[] = [];
  readonly #sent: SentFrame[] = [];

  /** `now` is the bench's time the loop runs at, in microseconds. */
  constructor(registry: LinkRegistry, now: () => number) {
    this.#registry = registry;
    this.#now = now;
  }

  /** Takes one of the bench's link messages; it acts once the bench advances to its time. */
  accept(message: FromBench): void {
    this.#waiting.push(message);
  }

  /**
   * Releases every message with time ≤ `to`, earliest first (the order they came on a tie):
   * links open and close, frames go to the core. Returns the times released, for the loop to
   * stamp each turn with.
   */
  release(to: number): readonly number[] {
    const due = this.#waiting
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.at <= to)
      .toSorted((a, b) => a.message.at - b.message.at || a.index - b.index);
    const released = new Set(due.map(({ index }) => index));
    const kept = this.#waiting.filter((_, index) => !released.has(index));
    this.#waiting.length = 0;
    this.#waiting.push(...kept);
    for (const { message } of due) this.#apply(message);
    return due.map(({ message }) => message.at);
  }

  /** The links the hub closed since the last call, for the `idle` answer (version 2). */
  drainClosed(): readonly ClosedLink[] {
    return this.#closed.splice(0);
  }

  /** The frames sent since the last call, for the `idle` answer. */
  drainSent(): readonly SentFrame[] {
    return this.#sent.splice(0);
  }

  #apply(message: FromBench): void {
    switch (message.type) {
      case "linkUp": {
        if (this.#byName.has(message.link)) return;
        const name = message.link;
        const id = this.#registry.open(message.kind, name, {
          send: (bytes) => this.#send(name, bytes),
          close: (reason) => {
            // The hub closed it: told to the controller in the next `idle` (section 11); a frame
            // it sends on the link before its `linkDown` or `linkUp` is counted, not lost.
            this.#byName.delete(name);
            this.#closedByHub.set(name, id);
            this.#closed.push({ link: name, at: this.#now(), reason });
            return ok(undefined);
          },
        });
        this.#byName.set(name, id);
        this.#closedByHub.delete(name);
        return;
      }
      case "linkDown": {
        this.#closedByHub.delete(message.link);
        const id = this.#byName.get(message.link);
        if (id === undefined) return;
        this.#byName.delete(message.link);
        this.#registry.closed(id, "remote");
        return;
      }
      case "frame": {
        const id = this.#byName.get(message.link);
        if (id !== undefined) this.#registry.frame(id, fromHex(message.bytes));
        else {
          const closed = this.#closedByHub.get(message.link);
          if (closed !== undefined) this.#registry.frameAfterClose(closed);
        }
        return;
      }
    }
  }

  #send(link: string, bytes: Uint8Array): Result<void, LinkError> {
    this.#sent.push({ link, at: this.#now(), bytes: toHex(bytes) });
    return ok(undefined);
  }
}

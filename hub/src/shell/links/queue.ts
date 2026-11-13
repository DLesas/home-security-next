/**
 * A link's send queue (hub-design.md section 3, `Links`): frames leave in effect order, one write
 * at a time, and a link whose queue passes 64 frames drops the newest and reports it
 * (`queueFull`). A write that fails stops the queue and reports it once, with the references of
 * the frame that failed and of every frame still waiting, which will not leave either.
 */
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { SendRef } from "../../core/model/ids.ts";
import type { LinkError } from "../../ports/links.ts";
import { linkError } from "../safe/link-error.ts";
import { ORIGIN } from "./registry.ts";

/** Frames a link holds before it drops the newest (section 3). */
export const SEND_QUEUE_LIMIT = 64;

/** One link's queue of frames to write, in order, at most `SEND_QUEUE_LIMIT`. */
export class SendQueue {
  readonly #write: (bytes: Uint8Array) => ResultAsync<void, LinkError>;
  readonly #failed: (error: LinkError, refs: readonly SendRef[]) => void;
  readonly #limit: number;
  readonly #waiting: { readonly bytes: Uint8Array; readonly ref: SendRef }[] = [];
  #writing = false;
  #stopped = false;

  constructor(
    write: (bytes: Uint8Array) => ResultAsync<void, LinkError>,
    failed: (error: LinkError, refs: readonly SendRef[]) => void,
    limit = SEND_QUEUE_LIMIT,
  ) {
    this.#write = write;
    this.#failed = failed;
    this.#limit = limit;
  }

  /** Frames waiting, the one being written included. */
  get length(): number {
    return this.#waiting.length;
  }

  /** Queues one frame; a full queue refuses it (the newest is the one dropped). */
  push(bytes: Uint8Array, ref: SendRef): Result<void, LinkError> {
    if (this.#stopped) return err(linkError("closed", ORIGIN, "send on a closed link"));
    if (this.#waiting.length >= this.#limit) {
      return err(linkError("queueFull", ORIGIN, `send queue passed ${this.#limit} frames`));
    }
    this.#waiting.push({ bytes, ref });
    this.#pump();
    return ok(undefined);
  }

  /** No more writes; what waits is dropped. */
  stop(): void {
    this.#stopped = true;
    this.#waiting.length = 0;
  }

  #pump(): void {
    const next = this.#waiting[0];
    if (this.#writing || this.#stopped || next === undefined) return;
    this.#writing = true;
    void this.#write(next.bytes).match(
      () => {
        this.#writing = false;
        this.#waiting.shift();
        this.#pump();
      },
      (error) => {
        this.#writing = false;
        if (this.#stopped) return;
        const refs = this.#waiting.map((frame) => frame.ref);
        this.stop();
        this.#failed(error, refs);
      },
    );
  }
}

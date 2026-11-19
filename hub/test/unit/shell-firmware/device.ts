/**
 * A scripted device's side of a transfer (docs/m3-updates-design.md section 5, "Transfer frames"):
 * it pulls the file (the 128-byte header, then the image) with up to `window` Gets outstanding,
 * the header first and then in order, never more than two sectors ahead of what it holds, checks each Data's CRC-32, drops a Data that matches no
 * outstanding Get, asks again after `reaskMs`, and stops at a Gone, keeping what it holds up to its
 * checkpoint (its contiguous bytes) to resume from. Faults can be scripted: Gets lost on the way to
 * the hub, Data lost on the way back, Gets sent twice.
 */
import type { GoneReason } from "@hsn/protocol/update";
import {
  decodeTransferFrame,
  encodeTransferFrame,
  isIntact,
  TRANSFER_LIMITS,
  TransferKind,
} from "@hsn/protocol/update";

export interface DeviceFaults {
  /** Gets (by the count sent so far, from 1) that never reach the hub. */
  readonly loseGets?: ReadonlySet<number>;
  /** Data frames (by the count received, from 1) that never reach the device. */
  readonly loseData?: ReadonlySet<number>;
  /** Gets (by count) sent twice in a row. */
  readonly repeatGets?: ReadonlySet<number>;
}

export interface Transport {
  send(bytes: Uint8Array): void;
}

export class PullingDevice {
  readonly #imageId: Uint8Array;
  readonly #fileBytes: number;
  readonly #window: number;
  readonly #piece: number;
  readonly #reaskMs: number;
  readonly #faults: DeviceFaults;
  readonly file: Uint8Array;
  /** Bytes held from the start without a gap: the checkpoint a resume asks from. */
  held = 0;
  #got = new Set<number>();
  #outstanding = new Map<number, { readonly length: number; at: number }>();
  #next = 0;
  #transport: Transport | undefined;
  #getsSent = 0;
  #dataSeen = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** Every Gone received, with its reason. */
  readonly gones: GoneReason[] = [];
  /** Data that matched no outstanding Get, dropped. */
  dropped = 0;
  /** Called as the checkpoint moves, before the next Gets go: a test acts at an exact point. */
  watch: ((held: number) => void) | undefined;
  /** Data whose CRC did not match, dropped. */
  badCrc = 0;
  reasks = 0;
  #done: (() => void) | undefined;
  #stopped: (() => void) | undefined;

  constructor(
    imageId: Uint8Array,
    fileBytes: number,
    options: {
      readonly window?: number;
      readonly piece?: number;
      readonly reaskMs?: number;
      readonly faults?: DeviceFaults;
    } = {},
  ) {
    this.#imageId = imageId;
    this.#fileBytes = fileBytes;
    this.#window = options.window ?? TRANSFER_LIMITS.outstandingGetsLink;
    this.#piece = options.piece ?? TRANSFER_LIMITS.maxDataBytes;
    this.#reaskMs = options.reaskMs ?? 50;
    this.#faults = options.faults ?? {};
    this.file = new Uint8Array(fileBytes);
  }

  get complete(): boolean {
    return this.held === this.#fileBytes;
  }

  /** Pulls on `transport` from the checkpoint until the file is whole or a Gone stops it. */
  pull(transport: Transport): Promise<"done" | "gone"> {
    this.#transport = transport;
    this.#outstanding.clear();
    this.#next = this.held;
    // A device resumes from its checkpoint: what it held past it is asked again (section 5).
    this.#got = new Set([...this.#got].filter((offset) => offset < this.held));
    const finished = new Promise<"done" | "gone">((resolve) => {
      this.#done = () => {
        resolve("done");
      };
      this.#stopped = () => {
        resolve("gone");
      };
    });
    this.#timer = setInterval(
      () => {
        this.#reask();
      },
      Math.max(5, Math.floor(this.#reaskMs / 2)),
    );
    this.#fill();
    if (this.complete) this.#finish("done");
    return finished;
  }

  /** A frame from the source. */
  receive(bytes: Uint8Array): void {
    const frame = decodeTransferFrame(bytes);
    if (!frame.ok) return;
    const value = frame.value;
    if (value.kind === TransferKind.Gone) {
      this.gones.push(value.reason as GoneReason);
      this.#finish("gone");
      return;
    }
    if (value.kind !== TransferKind.Data) return;
    this.#dataSeen += 1;
    if (this.#faults.loseData?.has(this.#dataSeen) === true) return;
    const asked = this.#outstanding.get(value.offset);
    if (asked?.length !== value.data.length) {
      this.dropped += 1;
      return;
    }
    if (!isIntact(value)) {
      this.badCrc += 1;
      return;
    }
    this.#outstanding.delete(value.offset);
    this.file.set(value.data, value.offset);
    this.#got.add(value.offset);
    while (this.#got.has(this.held)) {
      const at = this.held;
      this.held = Math.min(this.#fileBytes, at + this.#lengthAt(at));
    }
    this.watch?.(this.held);
    if (this.complete) {
      this.#finish("done");
      return;
    }
    this.#fill();
  }

  /** The length of the piece at `offset`: the header whole, then pieces of the image. */
  #lengthAt(offset: number): number {
    if (offset < 128) return 128 - offset;
    return Math.min(this.#piece, this.#fileBytes - offset);
  }

  #finish(how: "done" | "gone"): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#outstanding.clear();
    const settle = how === "done" ? this.#done : this.#stopped;
    this.#done = undefined;
    this.#stopped = undefined;
    settle?.();
  }

  #fill(): void {
    // Never past the current sector and the next ahead: two 4 KB buffers hold all in flight.
    const ahead = this.held + 2 * TRANSFER_LIMITS.sectorBytes;
    while (
      this.#outstanding.size < this.#window &&
      this.#next < this.#fileBytes &&
      this.#next < ahead
    ) {
      const offset = this.#next;
      const length = this.#lengthAt(offset);
      this.#next += length;
      if (this.#got.has(offset)) continue;
      this.#get(offset, length);
    }
  }

  #get(offset: number, length: number): void {
    this.#outstanding.set(offset, { length, at: Date.now() });
    const frame = encodeTransferFrame({
      kind: TransferKind.Get,
      imageId: this.#imageId,
      offset,
      length,
    });
    if (!frame.ok) return;
    this.#getsSent += 1;
    const n = this.#getsSent;
    if (this.#faults.loseGets?.has(n) === true) return;
    this.#transport?.send(frame.value);
    if (this.#faults.repeatGets?.has(n) === true) this.#transport?.send(frame.value);
  }

  #reask(): void {
    const now = Date.now();
    for (const [offset, asked] of [...this.#outstanding]) {
      if (now - asked.at < this.#reaskMs) continue;
      this.reasks += 1;
      this.#get(offset, asked.length);
    }
  }

  stop(): void {
    this.#finish("gone");
  }
}

/** Waits until `condition` holds, or fails after `ms`. */
export async function until(condition: () => boolean, ms = 5000): Promise<boolean> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) return false;
    await Bun.sleep(2);
  }
  return true;
}

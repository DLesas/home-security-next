/**
 * A phone driven frame by frame, for tests that need to say exactly what reaches the board and
 * see exactly what comes back: it connects through a `ScriptedCentral`, subscribes to `tx`, keeps
 * every frame decoded, and writes whatever the test gives it.
 */
import type { GattLink } from "../../../../app/src/platform/ble.ts";
import {
  BLUETOOTH_UPDATE,
  bluetoothOpenTag,
} from "../../../../packages/protocol/src/update/bluetooth.ts";
import {
  decodeTransferFrame,
  encodeTransferFrame,
  type GetFrame,
  type HelloFrame,
  type TransferFrame,
  type TransferFrameToSend,
  TransferKind,
} from "../../../../packages/protocol/src/update/transfer.ts";
import type { ScriptedCentral } from "../../src/air/central.ts";
import type { ManualClock } from "../../src/clock.ts";

/** Runs the clock until `promise` settles; undefined if it does not within `limitMs`. */
export async function settled<T>(
  clock: ManualClock,
  promise: Promise<T>,
  limitMs = 60_000,
): Promise<T | undefined> {
  let box: { readonly value: T } | undefined;
  void promise.then((value) => {
    box = { value };
  });
  await clock.runUntil(() => box !== undefined, limitMs);
  return box?.value;
}

export class RawPhone {
  readonly frames: TransferFrame[] = [];
  closed: string | null | undefined;

  constructor(
    readonly clock: ManualClock,
    readonly link: GattLink,
  ) {
    link.onClosed((why) => {
      this.closed = why;
    });
    link.watch(BLUETOOTH_UPDATE.txUuid, (bytes) => {
      const decoded = decodeTransferFrame(bytes);
      if (decoded.ok) this.frames.push(decoded.value);
    });
  }

  static async connect(
    clock: ManualClock,
    central: ScriptedCentral,
    id: string,
    mtu = 185,
  ): Promise<RawPhone | undefined> {
    const connected = await settled(clock, central.connect(id, mtu));
    if (connected?.ok !== true) return undefined;
    const phone = new RawPhone(clock, connected.value);
    await clock.advance(1);
    return phone;
  }

  get hellos(): HelloFrame[] {
    return this.frames.filter((f): f is HelloFrame => f.kind === TransferKind.Hello);
  }

  get gets(): GetFrame[] {
    return this.frames.filter((f): f is GetFrame => f.kind === TransferKind.Get);
  }

  /** Writes a frame without response, as a phone does on `rx`. */
  async send(frame: TransferFrameToSend): Promise<void> {
    const bytes = encodeTransferFrame(frame);
    if (bytes.ok)
      await settled(this.clock, this.link.write(BLUETOOTH_UPDATE.rxUuid, bytes.value, false));
  }

  async sendBytes(bytes: Uint8Array): Promise<void> {
    await settled(this.clock, this.link.write(BLUETOOTH_UPDATE.rxUuid, bytes, false));
  }

  /** Open with the tag for the latest Hello. */
  async open(sessionKey: Uint8Array, address: number, flip = false): Promise<void> {
    const hello = this.hellos.at(-1);
    if (hello === undefined) return;
    const tag = bluetoothOpenTag(sessionKey, address, hello.deviceRandom, hello.imageId);
    const value = tag.ok ? tag.value : new Uint8Array(16);
    if (flip) value[15] = (value[15] ?? 0) ^ 0x01;
    await this.send({ kind: TransferKind.Open, tag: value });
  }

  /** Answers a Get from the file. */
  async serve(file: Uint8Array, get: GetFrame): Promise<void> {
    await this.send({
      kind: TransferKind.Data,
      imageId: get.imageId,
      offset: get.offset,
      data: file.slice(get.offset, get.offset + get.length),
    });
  }

  /** Gets not yet answered by the test, as the board asked them. */
  pending(answered: ReadonlySet<number>): GetFrame[] {
    return this.gets.filter((g) => !answered.has(g.offset));
  }
}

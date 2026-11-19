/**
 * The phone's part of a Bluetooth update for the bench's own tests: a TypeScript mirror of the
 * firmware host bench's `ScriptPhone` (`firmware/platform/host/src/script_phone.cpp`), over a
 * `BleCentral` as the app's code is. It finds the board by its update name, connects, subscribes
 * to `tx`, answers Hello with Open and the tag, each Get with exactly the bytes asked from the
 * file and their CRC-32 (a Get outside the file with Gone out of range, one for another image
 * with Gone not available), reconnects after a lost link until Done, and keeps what it saw. It
 * sends nothing unasked. Its options are `ScriptPhoneOptions`' own, so the comparison with the
 * firmware's bench (`firmware-compare.test.ts`) runs the same phone on both sides.
 *
 * It is not the app's `FirmwareServer` (P4's): it is the bench's own phone, as the firmware's is: for the
 * tests and the simulator smoke page.
 */
import type { BleCentral, GattLink } from "../../../app/src/platform/ble.ts";
import {
  BLUETOOTH_UPDATE,
  bluetoothOpenTag,
  bluetoothUpdateName,
} from "../../../packages/protocol/src/update/bluetooth.ts";
import {
  decodeTransferFrame,
  type DoneFrame,
  encodeTransferFrame,
  GoneReason,
  type HelloFrame,
  TransferKind,
} from "../../../packages/protocol/src/update/transfer.ts";
import type { Clock } from "./clock.ts";

export interface PhoneSession {
  readonly address: number;
  readonly sessionKey: Uint8Array;
  readonly imageId: Uint8Array;
  /** The header and the image. */
  readonly file: Uint8Array;
}

export interface ScriptPhoneOptions {
  /** The MTU the phone asks for. */
  readonly mtu?: number;
  /** The first this many Opens carry a wrong tag (their first byte's top bit flipped). */
  readonly wrongTags?: number;
  /** After serving this many Data frames (0: never), Gets go unanswered (the air drops the link). */
  readonly dropAfterData?: number;
  /** After a lost link, the phone looks for the board again this long after. */
  readonly reconnectAfterMs?: number;
  /** The Nth Data frame (from 1; 0 none) carries a wrong CRC-32. */
  readonly corruptData?: number;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export class ScriptPhone {
  readonly hellos: HelloFrame[] = [];
  opens = 0;
  wrongOpens = 0;
  connections = 0;
  disconnections = 0;
  dataFrames = 0;
  goneFrames = 0;
  servedTo = 0;
  /** Frames from the board longer than the link allows. */
  oversize = 0;
  /** Frames from the board that did not decode, or that a phone never receives. */
  unexpected = 0;
  done: DoneFrame | undefined;
  /** Every frame each way, in order, for the comparison. */
  readonly toBoard: Uint8Array[] = [];
  readonly fromBoard: Uint8Array[] = [];

  readonly #options: Required<ScriptPhoneOptions>;
  #dropping = false;
  #droppedOnce = false;
  #link: GattLink | undefined;
  #stopScan: (() => void) | undefined;
  #stopped = false;

  constructor(
    readonly central: BleCentral,
    readonly clock: Clock,
    readonly session: PhoneSession,
    options: ScriptPhoneOptions = {},
  ) {
    this.#options = {
      mtu: options.mtu ?? 185,
      wrongTags: options.wrongTags ?? 0,
      dropAfterData: options.dropAfterData ?? 0,
      reconnectAfterMs: options.reconnectAfterMs ?? 2000,
      corruptData: options.corruptData ?? 0,
    };
  }

  /** Starts looking for the board. */
  start(): void {
    if (this.#stopped || this.#stopScan !== undefined || this.#link !== undefined) return;
    const name = bluetoothUpdateName(this.session.address);
    let connecting = false;
    this.#stopScan = this.central.scan(BLUETOOTH_UPDATE.serviceUuid, (advert) => {
      if (connecting || advert.name !== name) return;
      connecting = true;
      this.#stopScan?.();
      this.#stopScan = undefined;
      void this.#connect(advert.id);
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#stopScan?.();
    this.#link?.close();
  }

  async #connect(id: string): Promise<void> {
    const connected = await this.central.connect(id, this.#options.mtu);
    if (!connected.ok) {
      this.clock.after(this.#options.reconnectAfterMs, () => {
        this.start();
      });
      return;
    }
    const link = connected.value;
    this.#link = link;
    this.connections += 1;
    link.onClosed(() => {
      this.disconnections += 1;
      this.#link = undefined;
      if (this.done === undefined && !this.#stopped) {
        this.clock.after(this.#options.reconnectAfterMs, () => {
          this.start();
        });
      }
    });
    link.watch(BLUETOOTH_UPDATE.txUuid, (bytes) => {
      this.#received(link, bytes);
    });
  }

  #send(link: GattLink, frame: Uint8Array): void {
    if (frame.length + 3 > link.mtu) this.oversize += 1;
    this.toBoard.push(frame);
    void link.write(BLUETOOTH_UPDATE.rxUuid, frame, false);
  }

  #received(link: GattLink, bytes: Uint8Array): void {
    this.fromBoard.push(bytes);
    if (bytes.length + 3 > link.mtu) this.oversize += 1;
    const decoded = decodeTransferFrame(bytes);
    if (!decoded.ok) {
      this.unexpected += 1;
      return;
    }
    const frame = decoded.value;
    if (frame.kind === TransferKind.Hello) {
      this.hellos.push(frame);
      // The address is the one the hub named, not the one the board claims.
      const tag = bluetoothOpenTag(
        this.session.sessionKey,
        this.session.address,
        frame.deviceRandom,
        frame.imageId,
      );
      const value = tag.ok ? tag.value : new Uint8Array(16);
      this.opens += 1;
      if (this.wrongOpens < this.#options.wrongTags) {
        this.wrongOpens += 1;
        value[0] = (value[0] ?? 0) ^ 0x80;
      }
      const open = encodeTransferFrame({ kind: TransferKind.Open, tag: value });
      if (open.ok) this.#send(link, open.value);
    } else if (frame.kind === TransferKind.Get) {
      if (!this.#dropping) this.#onGet(link, frame.imageId, frame.offset, frame.length);
    } else if (frame.kind === TransferKind.Done) {
      this.done = frame;
    } else {
      this.unexpected += 1;
    }
  }

  #onGet(link: GattLink, imageId: Uint8Array, offset: number, length: number): void {
    const file = this.session.file;
    if (!same(imageId, this.session.imageId) || offset >= file.length) {
      const gone = encodeTransferFrame({
        kind: TransferKind.Gone,
        imageId,
        reason: same(imageId, this.session.imageId)
          ? GoneReason.OutOfRange
          : GoneReason.NotAvailable,
      });
      this.goneFrames += 1;
      if (gone.ok) this.#send(link, gone.value);
      return;
    }
    const data = file.slice(offset, Math.min(file.length, offset + length));
    const frame = encodeTransferFrame({ kind: TransferKind.Data, imageId, offset, data });
    if (!frame.ok) return;
    this.dataFrames += 1;
    const bytes = frame.value;
    if (this.#options.corruptData !== 0 && this.dataFrames === this.#options.corruptData) {
      // The CRC field's lowest bit (bytes 14 to 17, little-endian).
      bytes[14] = (bytes[14] ?? 0) ^ 0x01;
    }
    this.servedTo = Math.max(this.servedTo, offset + data.length);
    this.#send(link, bytes);
    if (
      this.#options.dropAfterData !== 0 &&
      this.dataFrames === this.#options.dropAfterData &&
      !this.#droppedOnce
    ) {
      // Nothing more is answered; the air drops the link once this frame has reached the board.
      this.#droppedOnce = true;
      this.#dropping = true;
      link.onClosed(() => {
        this.#dropping = false;
      });
    }
  }
}

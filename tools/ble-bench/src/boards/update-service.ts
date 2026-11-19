/**
 * The device's side of the update service over Bluetooth (m3-updates-design.md section 5;
 * protocol.md section 10, "The update service over Bluetooth" and "Firmware transfer frames"), as
 * the firmware's real service does it: a TypeScript reading of `firmware/core/src/device/`
 * `update_session.cpp` (the session), `update_transfer.cpp` (the pull, the header's checks, the
 * sectors and the hash) and the parts of `update.cpp` they use (refusals, the record). Where this
 * and the firmware could differ, the firmware wins, and `test/firmware-compare.test.ts` checks
 * the frames byte for byte against the firmware's host bench for the same image, key and nonce.
 *
 * - **The window** opens only on the hub's offer (action 3): it advertises the update service for
 *   the offer's units of 10 s (120 s when it gives none). The session lives 15 minutes.
 * - **Hello** goes when a phone has connected and subscribed to `tx`: the address, a fresh device
 *   random, the image id, the bytes held, and the largest data a piece carries on this link (the
 *   agreed MTU less 3 and the Data frame's 18 bytes, at most 1,000; 164 when the link says
 *   nothing useful).
 * - **Open** must carry the tag; a wrong one closes the connection and the window stays open for
 *   another try; the fifth ends it (`sessionRefused`).
 * - **The pull**: the header alone first, checked in protocol.md's order (`checkImageHeader`, and
 *   the image id the offer named) before a byte is written; then pieces that never cross a 4 KB
 *   sector, never past the sector after the current one, at most 8 Gets out, each asked again after
 *   3 s; a Data that matches no Get is dropped, one whose CRC-32 (or length) is wrong is asked again
 *   at once. Whole sectors are written in order; the record is written before the first, at every
 *   64 KB and when verified, so a reconnection resumes at the first sector not written.
 * - **The end**: the image read back and hashed; equal, Done verified; else `hashMismatch`, and the
 *   part is forgotten. A Gone from the phone ends it (`linkLost`).
 * - **The stops**: Done sent; the window's end with nobody having opened; 30 s without progress
 *   once a phone has opened (or while one is connected); the session's life. Each refusal sends
 *   Done refused (when open) and an Update status refused for LoRa.
 *
 * The device's other paths (Wi-Fi, USB, install, the trial) are not here: this is the Bluetooth
 * session alone, and what it reports over LoRa is handed to `report`.
 */
import { constantTimeEqual } from "../../../../packages/protocol/src/crypto/ccm.ts";
import { Role } from "../../../../packages/protocol/src/messages/common.ts";
import {
  IMAGE_ID_LENGTH,
  UpdateReason,
  UpdateStage,
} from "../../../../packages/protocol/src/messages/update.ts";
import {
  bluetoothOpenTag,
  bluetoothSessionKey,
} from "../../../../packages/protocol/src/update/bluetooth.ts";
import { crc32 } from "../../../../packages/protocol/src/update/crc32.ts";
import {
  checkImageHeader,
  decodeImageHeader,
  IMAGE_HEADER,
  type ImageHeader,
  imageIdOf,
} from "../../../../packages/protocol/src/update/image-header.ts";
import {
  type DataFrame,
  decodeTransferFrame,
  encodeTransferFrame,
  type GoneFrame,
  type OpenFrame,
  TRANSFER_LIMITS,
  TransferKind,
  TransferResult,
  type TransferFrameToSend,
} from "../../../../packages/protocol/src/update/transfer.ts";
import { createHash } from "node:crypto";
import type { Clock } from "../clock.ts";

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

const HEADER = IMAGE_HEADER.bytes;
const SECTOR = TRANSFER_LIMITS.sectorBytes;
const NEVER = Number.POSITIVE_INFINITY;

/** The firmware's own values (`update.hpp`'s private constants ‡). */
export const UPDATE_SESSION = {
  getsOutstanding: TRANSFER_LIMITS.outstandingGetsBluetooth,
  reaskMs: TRANSFER_LIMITS.reaskBluetoothMs,
  /** A piece when the link says nothing useful: an ATT payload at MTU 185, less 18. */
  defaultPiece: 164,
  /** The largest piece on any link. */
  maxPiece: TRANSFER_LIMITS.maxDataBytes,
  checkpointBytes: TRANSFER_LIMITS.checkpointBytes,
  /** A Get the link would not take is offered to it again after this. */
  sendRetryMs: 100,
  windowDefaultMs: 120_000,
  windowUnitMs: 10_000,
  sessionLifeMs: 15 * 60_000,
  noProgressMs: 30_000,
  wrongTagsAllowed: 5,
} as const;

/** What the hub's offer with action 3 carries (§6, Update offer). */
export interface BluetoothOffer {
  readonly imageId: Uint8Array;
  /** The Bluetooth session nonce, 8 bytes. */
  readonly nonce: Uint8Array;
  /** The window in units of 10 s; 0 means the default 120 s. */
  readonly windowUnits: number;
}

/** An Update status (0x07) the device would send over LoRa. */
export interface UpdateStatusReport {
  readonly imageId: Uint8Array;
  readonly stage: UpdateStage;
  readonly reason: UpdateReason;
  readonly bytesWritten: number;
}

/** What the service needs of the board it runs on: its pairing, its role, its flash. */
export interface UpdateHost {
  readonly address: number;
  readonly deviceKey: Uint8Array;
  readonly hubIdentity: Uint8Array;
  readonly signingKey: Uint8Array;
  readonly role: Role;
  /** Bytes of the slot not running. */
  readonly capacity: number;
  /** The device's random number generator: Hello's device random. */
  random(bytes: number): Uint8Array;
  /** Starts (true) or stops (false) advertising the update service. */
  advertise(on: boolean): void;
  /** Notifies a frame on `tx`; false when the link would not take it. */
  notify(frame: Uint8Array): boolean;
  /** Ends the phone's connection. */
  disconnect(): void;
  /** An Update status for LoRa. */
  report(status: UpdateStatusReport): void;
}

/** The update record (StoreKey::update): the header, the stage, the bytes written. */
interface UpdateRecord {
  readonly header: Uint8Array;
  readonly stage: "partial" | "verified";
  readonly bytesWritten: number;
}

interface Ask {
  offset: number;
  length: number;
  sent: boolean;
  at: number;
}

type Session = "closed" | "advertising" | "connected" | "open";
type Phase = "idle" | "header" | "image";

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export class UpdateService {
  readonly #clock: Clock;
  readonly #host: UpdateHost;

  // What a test may look at.
  /** Every refusal, in order. */
  readonly refusals: UpdateReason[] = [];
  /** Sectors written, in order (their numbers). */
  readonly sectorsWritten: number[] = [];
  /** Data frames dropped: not asked for, or damaged. */
  dropped = { notAsked: 0, damaged: 0, notFrames: 0 };

  // The flash: the slot not running, and the record.
  readonly #slot: Uint8Array;
  #record: UpdateRecord | undefined;

  #session: Session = "closed";
  #phase: Phase = "idle";
  #imageId: Uint8Array = new Uint8Array(IMAGE_ID_LENGTH);
  #header: ImageHeader | undefined;
  #headerBytes = new Uint8Array(HEADER);
  #haveHeader = false;
  #sector = 0;
  #nextOffset = 0;

  #piece: number = UPDATE_SESSION.defaultPiece;
  #bluetoothPiece: number = UPDATE_SESSION.defaultPiece;
  #asks: Ask[] = [];
  #sendRetryAt = NEVER;
  #lastProgress = 0;
  readonly #sectors = [new Uint8Array(SECTOR), new Uint8Array(SECTOR)];
  #received = [0, 0];

  #nonce: Uint8Array = new Uint8Array(8);
  #sessionKey: Uint8Array = new Uint8Array(32);
  #deviceRandom: Uint8Array = new Uint8Array(8);
  #windowEnd = NEVER;
  #sessionEnd = NEVER;
  #sessionOpened = false;
  #wrongTags = 0;

  #cancelWake: () => void = () => undefined;

  constructor(clock: Clock, host: UpdateHost) {
    this.#clock = clock;
    this.#host = host;
    this.#slot = new Uint8Array(host.capacity);
  }

  // ----- What a test may read -----

  get session(): Session {
    return this.#session;
  }

  get wrongTags(): number {
    return this.#wrongTags;
  }

  /** The record as stored: its stage and bytes, or undefined. */
  get record():
    { readonly stage: "partial" | "verified"; readonly bytesWritten: number } | undefined {
    const record = this.#record;
    return record === undefined
      ? undefined
      : { stage: record.stage, bytesWritten: record.bytesWritten };
  }

  /** The image bytes written to the slot so far (whole sectors). */
  writtenImage(): Uint8Array {
    return this.#slot.slice(0, this.#writtenBytes());
  }

  /** The next instant the service must run, for a test: undefined when nothing is under way. */
  get nextWake(): number | undefined {
    const due = this.#due();
    return due === NEVER ? undefined : due;
  }

  // ----- From the board -----

  /** The hub's offer with action 3, over LoRa. */
  offer(offer: BluetoothOffer): void {
    this.#event((now) => {
      this.#offerBluetooth(offer, now);
    });
  }

  /** A phone connected and subscribed to `tx` (the link is "up"), with the MTU agreed. */
  linkUp(mtu: number): void {
    this.#event((now) => {
      this.#sessionUp(mtu, now);
    });
  }

  /** The phone's connection went (or it unsubscribed). */
  linkDown(): void {
    this.#event(() => {
      this.#sessionDown();
    });
  }

  /** A write on `rx`. Anything not a transfer frame is ignored, as the device does. */
  frame(bytes: Uint8Array): void {
    this.#event((now) => {
      if (bytes[0] !== 0xf2) {
        this.dropped.notFrames += 1;
        return;
      }
      const decoded = decodeTransferFrame(bytes);
      if (!decoded.ok) {
        this.dropped.notFrames += 1;
        return;
      }
      const frame = decoded.value;
      if (frame.kind === TransferKind.Data) this.#onData(frame, now);
      else if (frame.kind === TransferKind.Gone) this.#onGone(frame);
      else if (frame.kind === TransferKind.Open) this.#onOpen(frame, now);
      // Get, Hello and Done go from the device, never to it: an echo, dropped.
    });
  }

  /** Everything is forgotten but the flash: a reset or a power cut. */
  reset(): void {
    this.#cancelWake();
    this.#session = "closed";
    this.#phase = "idle";
    this.#asks = [];
    this.#received = [0, 0];
    this.#sendRetryAt = NEVER;
    this.#sessionKey.fill(0);
    this.#windowEnd = NEVER;
    this.#sessionEnd = NEVER;
    this.#forgetProgress();
    if (this.#record !== undefined) this.#selectImage(imageIdOf(this.#record.header));
  }

  // ----- Every event: the due deadlines first, as Device::handle calls poll() -----

  #event(handle: (now: number) => void): void {
    const now = this.#clock.now();
    this.#poll(now);
    handle(now);
    this.#rewake();
  }

  #rewake(): void {
    this.#cancelWake();
    const due = this.#due();
    if (due === NEVER) return;
    this.#cancelWake = this.#clock.after(due - this.#clock.now(), () => {
      this.#poll(this.#clock.now());
      this.#rewake();
    });
  }

  #due(): number {
    let due = NEVER;
    if (this.#phase === "header" || this.#phase === "image") {
      for (const ask of this.#asks) {
        due = Math.min(due, ask.sent ? ask.at + UPDATE_SESSION.reaskMs : this.#sendRetryAt);
      }
    }
    if (this.#session !== "closed") {
      due = Math.min(due, this.#sessionEnd);
      if (this.#session === "advertising" && !this.#sessionOpened) {
        due = Math.min(due, this.#windowEnd);
      }
      if (this.#session !== "advertising" || this.#sessionOpened) {
        due = Math.min(due, this.#lastProgress + UPDATE_SESSION.noProgressMs);
      }
    }
    return due;
  }

  #poll(now: number): void {
    if (this.#phase === "header" || this.#phase === "image") this.#reask(now);
    this.#pollSession(now);
  }

  // ----- The record and the image (update.cpp) -----

  #recordHolds(id: Uint8Array): boolean {
    return this.#record !== undefined && sameBytes(imageIdOf(this.#record.header), id);
  }

  #recordVerified(id: Uint8Array): boolean {
    return this.#recordHolds(id) && this.#record?.stage === "verified";
  }

  #recordBytes(): number {
    return this.#record?.bytesWritten ?? 0;
  }

  #writeRecord(stage: "partial" | "verified", bytesWritten: number): void {
    this.#record = { header: this.#headerBytes.slice(), stage, bytesWritten };
  }

  #selectImage(id: Uint8Array): void {
    if (this.#haveHeader && sameBytes(this.#imageId, id)) return;
    this.#imageId = id.slice();
    this.#forgetProgress();
    const record = this.#record;
    if (record === undefined || !this.#recordHolds(id)) return;
    const decoded = decodeImageHeader(record.header);
    if (!decoded.ok) return;
    this.#header = decoded.value;
    this.#headerBytes = record.header.slice();
    this.#haveHeader = true;
    this.#sector =
      record.stage === "verified"
        ? this.#sectorCount()
        : Math.floor((record.bytesWritten - HEADER) / SECTOR);
  }

  #forgetProgress(): void {
    this.#haveHeader = false;
    this.#header = undefined;
    this.#sector = 0;
  }

  #imageBytes(): number {
    return this.#haveHeader ? (this.#header?.imageBytes ?? 0) : 0;
  }

  #sectorCount(): number {
    return Math.ceil(this.#imageBytes() / SECTOR);
  }

  #sectorLength(sector: number): number {
    const start = sector * SECTOR;
    const image = this.#imageBytes();
    return image > start ? Math.min(SECTOR, image - start) : 0;
  }

  #fileBytes(): number {
    return HEADER + this.#imageBytes();
  }

  #writtenBytes(): number {
    return this.#haveHeader ? Math.min(this.#sector * SECTOR, this.#imageBytes()) : 0;
  }

  #refuse(reason: UpdateReason, keepPart: boolean): void {
    this.refusals.push(reason);
    if (this.#session === "open") this.#sendDone(TransferResult.Refused, reason);
    this.#closeSession();
    this.#stopTransfer();
    this.#phase = "idle";
    let bytes = 0;
    if (keepPart && this.#recordHolds(this.#imageId)) {
      bytes = this.#recordBytes();
    } else if (!keepPart) {
      if (this.#recordHolds(this.#imageId)) this.#record = undefined;
      this.#forgetProgress();
    }
    if (!this.#recordHolds(this.#imageId)) this.#forgetProgress();
    this.#host.report({
      imageId: this.#imageId.slice(),
      stage: UpdateStage.Refused,
      reason,
      bytesWritten: bytes,
    });
  }

  #stopTransfer(): void {
    this.#asks = [];
    this.#received = [0, 0];
    this.#sendRetryAt = NEVER;
    if (this.#phase === "header" || this.#phase === "image") this.#phase = "idle";
  }

  // ----- The session (update_session.cpp) -----

  #offerBluetooth(offer: BluetoothOffer, now: number): void {
    if (
      this.#session !== "closed" &&
      sameBytes(this.#nonce, offer.nonce) &&
      sameBytes(this.#imageId, offer.imageId)
    ) {
      // The same session offered again: it goes on.
      return;
    }
    // One nonce serves one session; a new offer replaces it.
    this.#closeSession();
    this.#stopTransfer();
    this.#selectImage(offer.imageId);
    const key = bluetoothSessionKey(this.#host.deviceKey, offer.nonce, this.#host.address);
    if (!key.ok) {
      this.refusals.push(UpdateReason.SessionRefused);
      this.#host.report({
        imageId: offer.imageId.slice(),
        stage: UpdateStage.Refused,
        reason: UpdateReason.SessionRefused,
        bytesWritten: 0,
      });
      return;
    }
    this.#sessionKey = key.value;
    this.#host.advertise(true);
    this.#nonce = offer.nonce.slice();
    const window =
      offer.windowUnits === 0
        ? UPDATE_SESSION.windowDefaultMs
        : UPDATE_SESSION.windowUnitMs * offer.windowUnits;
    this.#windowEnd = now + window;
    this.#sessionEnd = now + UPDATE_SESSION.sessionLifeMs;
    this.#sessionOpened = false;
    this.#wrongTags = 0;
    this.#session = "advertising";
  }

  #sessionUp(mtu: number, now: number): void {
    if (this.#session !== "advertising") return;
    this.#session = "connected";
    // The piece this connection carries: what the phone agreed, less the Data frame's header.
    const largest = mtu - 3;
    const header = TRANSFER_LIMITS.dataHeaderBytes;
    this.#bluetoothPiece = Math.min(
      largest > header ? largest - header : UPDATE_SESSION.defaultPiece,
      UPDATE_SESSION.maxPiece,
    );
    this.#deviceRandom = this.#host.random(8);
    this.#lastProgress = now;
    const bytesHeld = this.#recordVerified(this.#imageId)
      ? this.#recordBytes()
      : this.#haveHeader
        ? HEADER + this.#writtenBytes()
        : 0;
    this.#send({
      kind: TransferKind.Hello,
      address: this.#host.address,
      deviceRandom: this.#deviceRandom,
      imageId: this.#imageId,
      bytesHeld,
      largestData: this.#bluetoothPiece,
    });
  }

  #sessionDown(): void {
    if (this.#session === "closed") return;
    // What is written stays; the phone may connect again and the device asks from there.
    this.#stopTransfer();
    this.#session = "advertising";
  }

  #onOpen(open: OpenFrame, now: number): void {
    if (this.#session !== "connected") return;
    const tag = bluetoothOpenTag(
      this.#sessionKey,
      this.#host.address,
      this.#deviceRandom,
      this.#imageId,
    );
    // Every byte is compared, so the time says nothing about where a wrong tag differs.
    if (!tag.ok || !constantTimeEqual(tag.value, open.tag)) {
      this.#wrongTags += 1;
      if (this.#wrongTags >= UPDATE_SESSION.wrongTagsAllowed) {
        this.#refuse(UpdateReason.SessionRefused, true);
        return;
      }
      // A wrong tag closes the connection; the window stays open for another try.
      this.#host.disconnect();
      this.#host.advertise(true);
      this.#session = "advertising";
      return;
    }
    this.#session = "open";
    this.#sessionOpened = true;
    this.#lastProgress = now;
    if (this.#recordVerified(this.#imageId)) {
      this.#sendDone(TransferResult.Verified, UpdateReason.None);
      this.#closeSession();
      this.#host.report({
        imageId: this.#imageId.slice(),
        stage: UpdateStage.Verified,
        reason: UpdateReason.None,
        bytesWritten: this.#recordBytes(),
      });
      return;
    }
    this.#startFetch(now);
  }

  #sendDone(result: TransferResult, reason: UpdateReason): void {
    this.#send({ kind: TransferKind.Done, imageId: this.#imageId, result, reason });
  }

  #send(frame: TransferFrameToSend): boolean {
    const bytes = encodeTransferFrame(frame);
    return bytes.ok && this.#host.notify(bytes.value);
  }

  #closeSession(): void {
    if (this.#session === "closed") return;
    this.#host.disconnect();
    this.#host.advertise(false);
    this.#stopTransfer();
    this.#sessionKey.fill(0);
    this.#nonce = new Uint8Array(8);
    this.#deviceRandom = new Uint8Array(8);
    this.#windowEnd = NEVER;
    this.#sessionEnd = NEVER;
    this.#sessionOpened = false;
    this.#session = "closed";
  }

  #pollSession(now: number): void {
    if (this.#session === "closed") return;
    if (now >= this.#sessionEnd) {
      this.#refuse(UpdateReason.WindowEnded, true);
    } else if (this.#session === "advertising" && !this.#sessionOpened && now >= this.#windowEnd) {
      // The window ended with nobody having opened.
      this.#refuse(UpdateReason.WindowEnded, true);
    } else if (
      (this.#session !== "advertising" || this.#sessionOpened) &&
      now - this.#lastProgress >= UPDATE_SESSION.noProgressMs
    ) {
      this.#refuse(UpdateReason.LinkLost, true);
    }
  }

  // ----- The pull (update_transfer.cpp) -----

  #startFetch(now: number): void {
    this.#stopTransfer();
    this.#selectImage(this.#imageId);
    this.#piece = this.#bluetoothPiece;
    this.#lastProgress = now;
    if (!this.#haveHeader) {
      this.#phase = "header";
      this.#nextOffset = 0;
    } else if (this.#sector >= this.#sectorCount()) {
      // Everything is written: only the hash is left.
      this.#startHash();
      return;
    } else {
      // Resume at the first sector not written.
      this.#phase = "image";
      this.#nextOffset = HEADER + this.#sector * SECTOR;
    }
    this.#fill(now);
  }

  #sendGet(ask: Ask, now: number): boolean {
    const sent = this.#send({
      kind: TransferKind.Get,
      imageId: this.#imageId,
      offset: ask.offset,
      length: ask.length,
    });
    if (!sent) {
      ask.sent = false;
      this.#sendRetryAt = now + UPDATE_SESSION.sendRetryMs;
      return false;
    }
    ask.sent = true;
    ask.at = now;
    return true;
  }

  #fill(now: number): void {
    for (const ask of this.#asks) {
      if (!ask.sent && !this.#sendGet(ask, now)) return;
    }
    if (this.#phase === "header") {
      if (this.#asks.length === 0) {
        const ask: Ask = { offset: 0, length: HEADER, sent: false, at: now };
        this.#asks.push(ask);
        this.#nextOffset = HEADER;
        this.#sendGet(ask, now);
      }
      return;
    }
    if (this.#phase !== "image") return;
    // Never past the sector after the current one: two buffers hold everything asked for.
    const ahead = HEADER + (this.#sector + 2) * SECTOR;
    const limit = Math.min(this.#fileBytes(), ahead);
    if (this.#asks.length === 0 && this.#nextOffset < limit) {
      // Nothing was out: a silent source counts from now.
      this.#lastProgress = now;
    }
    while (this.#asks.length < UPDATE_SESSION.getsOutstanding && this.#nextOffset < limit) {
      const sector = Math.floor((this.#nextOffset - HEADER) / SECTOR);
      const sectorEnd = HEADER + sector * SECTOR + this.#sectorLength(sector);
      const length = Math.min(this.#piece, sectorEnd - this.#nextOffset);
      const ask: Ask = { offset: this.#nextOffset, length, sent: false, at: now };
      this.#asks.push(ask);
      this.#nextOffset += length;
      if (!this.#sendGet(ask, now)) return;
    }
  }

  #reask(now: number): void {
    for (const ask of this.#asks) {
      if (ask.sent && now - ask.at >= UPDATE_SESSION.reaskMs) ask.sent = false;
    }
    if (now >= this.#sendRetryAt) this.#sendRetryAt = NEVER;
    this.#fill(now);
  }

  #onData(data: DataFrame, now: number): void {
    const pulling = this.#phase === "header" || this.#phase === "image";
    const sessionOk = this.#session === "open";
    let index = -1;
    if (pulling && sessionOk && sameBytes(data.imageId, this.#imageId)) {
      this.#asks.forEach((ask, i) => {
        if (ask.offset === data.offset) index = i;
      });
    }
    const ask = this.#asks[index];
    if (ask === undefined) {
      this.dropped.notAsked += 1;
      return;
    }
    const header = this.#phase === "header";
    if (crc32(data.data) !== data.crc32 || (!header && data.data.length !== ask.length)) {
      // Dropped and asked again at once (protocol.md, check 6).
      this.dropped.damaged += 1;
      ask.sent = false;
      this.#fill(now);
      return;
    }
    this.#asks.splice(index, 1);
    this.#lastProgress = now;
    if (header) {
      this.#onHeader(data.data, now);
      return;
    }
    const imageOffset = ask.offset - HEADER;
    const sector = Math.floor(imageOffset / SECTOR);
    const buffer = this.#sectors[sector % 2];
    if (buffer === undefined) return;
    buffer.set(data.data, imageOffset % SECTOR);
    this.#received[sector % 2] = (this.#received[sector % 2] ?? 0) + data.data.length;
    this.#advance(now);
  }

  #advance(now: number): void {
    while (
      this.#phase === "image" &&
      this.#sector < this.#sectorCount() &&
      this.#received[this.#sector % 2] === this.#sectorLength(this.#sector)
    ) {
      this.#flushSector();
    }
    if (this.#phase !== "image") return;
    if (this.#sector >= this.#sectorCount()) {
      this.#startHash();
      return;
    }
    this.#fill(now);
  }

  #onGone(gone: GoneFrame): void {
    if (
      (this.#phase !== "header" && this.#phase !== "image") ||
      !sameBytes(gone.imageId, this.#imageId)
    ) {
      return;
    }
    // The phone cannot serve the file: the session cannot go on.
    this.#refuse(UpdateReason.LinkLost, true);
  }

  #checkHeader(bytes: Uint8Array): UpdateReason {
    // 1. Magic, format, target, zero bytes, and the image offered.
    if (bytes.length !== HEADER || !sameBytes(imageIdOf(bytes), this.#imageId)) {
      return UpdateReason.BadHeader;
    }
    // 1 to 5, in protocol.md's order.
    return checkImageHeader(bytes, {
      hubIdentity: this.#host.hubIdentity,
      signingKey: this.#host.signingKey,
      role: this.#host.role,
      capacity: this.#host.capacity,
    });
  }

  #onHeader(bytes: Uint8Array, now: number): void {
    const reason = this.#checkHeader(bytes);
    if (reason !== UpdateReason.None) {
      // Nothing of this image has been written: a part of another image, if held, stays.
      this.#refuse(reason, true);
      return;
    }
    const decoded = decodeImageHeader(bytes);
    if (!decoded.ok) return;
    // The record comes first, before the first sector, so a reset resumes this image.
    this.#header = decoded.value;
    this.#headerBytes = bytes.slice();
    this.#haveHeader = true;
    this.#sector = 0;
    this.#writeRecord("partial", HEADER);
    this.#received = [0, 0];
    this.#phase = "image";
    this.#nextOffset = HEADER;
    if (this.#sectorCount() === 0) {
      this.#startHash();
      return;
    }
    this.#fill(now);
  }

  #flushSector(): void {
    const length = this.#sectorLength(this.#sector);
    const buffer = this.#sectors[this.#sector % 2];
    if (buffer !== undefined) this.#slot.set(buffer.subarray(0, length), this.#sector * SECTOR);
    this.sectorsWritten.push(this.#sector);
    this.#received[this.#sector % 2] = 0;
    this.#sector += 1;
    const written = this.#writtenBytes();
    if (this.#sector >= this.#sectorCount()) return;
    if (written % UPDATE_SESSION.checkpointBytes === 0)
      this.#writeRecord("partial", HEADER + written);
  }

  #startHash(): void {
    this.#asks = [];
    this.#received = [0, 0];
    this.#sendRetryAt = NEVER;
    const digest = sha256(this.#slot.subarray(0, this.#imageBytes()));
    const expected = this.#header?.imageSha256 ?? new Uint8Array(32);
    this.#hashed(sameBytes(digest, expected));
  }

  #hashed(equal: boolean): void {
    if (!equal) {
      // Check 7: the download starts again from zero.
      this.#refuse(UpdateReason.HashMismatch, false);
      return;
    }
    this.#writeRecord("verified", this.#fileBytes());
    this.#phase = "idle";
    if (this.#session === "open") {
      this.#sendDone(TransferResult.Verified, UpdateReason.None);
      this.#closeSession();
    }
    this.#host.report({
      imageId: this.#imageId.slice(),
      stage: UpdateStage.Verified,
      reason: UpdateReason.None,
      bytesWritten: this.#fileBytes(),
    });
  }
}

export { Role };

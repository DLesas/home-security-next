/** Sealing and opening packets (section 3): AES-128-CCM with an 8-byte tag. */
import { ByteWriter, concatBytes } from "../bytes.ts";
import { type BlockCipher, type BlockCipherFactory, nodeAes128 } from "../crypto/blockCipher.ts";
import { createAesCcm } from "../crypto/ccm.ts";
import { decodeMessage, encodeMessage, type Message } from "../messages/message.ts";
import { MessageType, messageDirection } from "../messages/messageType.ts";
import {
  decodeStartedImage,
  encodeStartedWithImage,
  type StartedImage,
} from "../messages/started.ts";
import { fail, ok, type Result } from "../result.ts";
import { isValidBindingLength } from "./binding.ts";
import {
  CLEAR_HEADER_LENGTH,
  type Direction,
  headerByte,
  isValidAddress,
  isValidCounter,
  KEY_LENGTH,
  type MaxPacketLength,
  type PacketHeader,
  readPacketHeader,
  TAG_LENGTH,
} from "./header.ts";

const NONCE_PADDING = new Uint8Array(4);

/** Nonce: address (4, LE) · direction byte · counter (4, LE) · four zero bytes. */
export function packetNonce(address: number, direction: Direction, counter: number): Uint8Array {
  const prefix = new ByteWriter().u32(address).u8(direction).u32(counter).finish();
  return concatBytes(prefix, NONCE_PADDING);
}

/**
 * The block cipher factory for one call: the caller's cipher when it gave one, so a cipher keyed
 * once can serve many packets, and otherwise a new one on the runtime's AES (D94).
 */
function blockCipherFor(cipher: BlockCipher | undefined): BlockCipherFactory {
  return cipher === undefined ? nodeAes128 : () => cipher;
}

/** The caller's key and binding are programmer inputs, so a bad one throws. */
function checkKeyAndBinding(key: Uint8Array, binding: Uint8Array): void {
  if (key.length !== KEY_LENGTH) throw new RangeError("device keys are 16 bytes");
  if (!isValidBindingLength(binding.length)) {
    throw new RangeError("binding must be 0, 4, 8 or 16 bytes");
  }
}

export interface SealOptions {
  /** The device's 16-byte key. */
  readonly key: Uint8Array;
  readonly direction: Direction;
  /** The device's address, also in packets from the hub. */
  readonly address: number;
  /** The sender's counter for this key and direction; never 0 or reused. */
  readonly counter: number;
  /** Built with the binding helpers; NO_BINDING where section 4 asks for none. */
  readonly binding: Uint8Array;
  readonly maxLength: MaxPacketLength;
  /**
   * The AES block cipher already keyed with `key`: the D94 seam, which also saves making a
   * cipher per packet. Without it, one is made on the runtime's AES for this call.
   */
  readonly cipher?: BlockCipher;
  /**
   * A Started only: the M3 fields written after its version-1 body (m3-updates-design.md section
   * 5), as an M3 device sends them. Given with any other type, a programmer error.
   */
  readonly startedImage?: StartedImage;
}

/**
 * Encrypts and authenticates a message. Throws on a programmer error, such as a bad key or a
 * message type that does not travel in `direction`.
 */
export function sealPacket(message: Message, options: SealOptions): Uint8Array {
  const { key, direction, address, counter, binding, maxLength, cipher } = options;
  if (!isValidAddress(address)) throw new RangeError("address must not be 0 or 0xFFFFFFFF");
  if (!isValidCounter(counter)) throw new RangeError("counter must be from 1 to 0xFFFFFFFF");
  checkKeyAndBinding(key, binding);
  if (messageDirection(message.type) !== direction) {
    throw new RangeError(`message type ${message.type} does not travel in this direction`);
  }
  const version1 = encodeMessage(message);
  if (options.startedImage !== undefined && message.type !== MessageType.Started) {
    throw new RangeError("only a Started carries image fields");
  }
  const plaintext =
    options.startedImage === undefined
      ? version1
      : encodeStartedWithImage(version1, options.startedImage);
  if (CLEAR_HEADER_LENGTH + plaintext.length + TAG_LENGTH > maxLength) {
    throw new RangeError(`packet would exceed ${maxLength} bytes`);
  }
  const clearHeader = new ByteWriter().u8(headerByte(direction)).u32(address).u32(counter).finish();
  const sealed = createAesCcm(key, TAG_LENGTH, blockCipherFor(cipher)).seal(
    packetNonce(address, direction, counter),
    concatBytes(clearHeader, binding),
    plaintext,
  );
  return concatBytes(clearHeader, sealed);
}

export interface OpenOptions {
  /** The key found for the header's address. */
  readonly key: Uint8Array;
  /** ToHub on the hub, FromHub on devices. */
  readonly expectedDirection: Direction;
  /** The binding this packet must carry; NO_BINDING where section 4 asks for none. */
  readonly binding: Uint8Array;
  readonly maxLength: MaxPacketLength;
  /** As for sealing: the AES block cipher already keyed with `key`, or none for a new one. */
  readonly cipher?: BlockCipher;
}

export interface OpenedPacket {
  readonly header: PacketHeader;
  readonly message: Message;
  /**
   * A Started whose body carries the M3 fields (12 bytes or more): those fields. Absent for any
   * other packet and for an 8-byte Started from a device older than M3.
   */
  readonly startedImage?: StartedImage;
}

/**
 * Checks and decrypts a packet. Nothing from the encrypted part is used before the tag
 * verifies; a type that does not match the direction is then `wrongDirection`. Counter acceptance (replay) is left to the caller, which holds the state.
 * Never throws on the packet bytes.
 */
export function openPacket(packet: Uint8Array, options: OpenOptions): Result<OpenedPacket> {
  const { key, expectedDirection, binding, maxLength, cipher } = options;
  checkKeyAndBinding(key, binding);
  const header = readPacketHeader(packet, maxLength);
  if (!header.ok) return header;
  const { direction, address, counter } = header.value;
  if (direction !== expectedDirection) return fail("wrongDirection");

  const clearHeader = packet.subarray(0, CLEAR_HEADER_LENGTH);
  const plaintext = createAesCcm(key, TAG_LENGTH, blockCipherFor(cipher)).open(
    packetNonce(address, direction, counter),
    concatBytes(clearHeader, binding),
    packet.subarray(CLEAR_HEADER_LENGTH),
  );
  if (plaintext === undefined) return fail("badTag");

  const message = decodeMessage(plaintext);
  if (!message.ok) return message;
  // Section 5: the type must match the direction, even though the tag checked.
  if (messageDirection(message.value.type) !== direction) return fail("wrongDirection");
  if (message.value.type !== MessageType.Started) {
    return ok({ header: header.value, message: message.value });
  }
  const image = decodeStartedImage(plaintext);
  if (!image.ok) return image;
  return image.value === null
    ? ok({ header: header.value, message: message.value })
    : ok({ header: header.value, message: message.value, startedImage: image.value });
}

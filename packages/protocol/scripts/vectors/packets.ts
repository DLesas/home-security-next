/** Builds the per-message-type vector files from the packet cases. */
import {
  CLEAR_HEADER_LENGTH,
  concatBytes,
  createAesCcm,
  decodeMessage,
  type Direction,
  encodeMessage,
  headerByte,
  messageDirection,
  MessageType,
  packetNonce,
  sealPacket,
  TAG_LENGTH,
  toHex,
  ByteWriter,
} from "../../src/index.ts";
import type { Device } from "./devices.ts";
import { fieldsJson, type Json, type JsonObject, toJson } from "./json.ts";
import { type PacketCase, packetCases } from "./packetCases.ts";

export interface RawSeal {
  readonly device: Device;
  readonly direction: Direction;
  readonly counter: number;
  readonly binding: Uint8Array;
  readonly plaintext: Uint8Array;
  /** Header byte as sent; the canonical one unless a case sets other bits. */
  readonly header?: number;
  /** Address in the clear header and nonce; the device's own unless a case overrides it. */
  readonly address?: number;
}

export interface Sealed {
  readonly nonce: Uint8Array;
  readonly associatedData: Uint8Array;
  readonly packet: Uint8Array;
}

/**
 * Seals any plaintext with any header, without the encoder's checks, so the vectors can hold
 * packets the encoder refuses to make. Written out step by step as section 3 describes it.
 */
export function sealRaw(input: RawSeal): Sealed {
  const address = input.address ?? input.device.address;
  const clearHeader = new ByteWriter()
    .u8(input.header ?? headerByte(input.direction))
    .u32(address)
    .u32(input.counter)
    .finish();
  const nonce = packetNonce(address, input.direction, input.counter);
  const associatedData = concatBytes(clearHeader, input.binding);
  const sealed = createAesCcm(input.device.key, TAG_LENGTH).seal(
    nonce,
    associatedData,
    input.plaintext,
  );
  return { nonce, associatedData, packet: concatBytes(clearHeader, sealed) };
}

function packetCaseJson(c: PacketCase): Json {
  const direction = messageDirection(c.message.type);
  const canonical = c.variation === undefined;
  const plaintext =
    c.variation?.plaintext ??
    concatBytes(encodeMessage(c.message), c.variation?.extraBodyBytes ?? new Uint8Array(0));
  assertDecodesTo(c, plaintext);
  const sealed = sealRaw({
    device: c.device,
    direction,
    counter: c.counter,
    binding: c.binding,
    plaintext,
    header: headerByte(direction) | (c.variation?.headerLowBits ?? 0),
  });
  if (canonical) assertSameAsEncoder(c, sealed.packet);
  if (sealed.packet.length !== CLEAR_HEADER_LENGTH + plaintext.length + TAG_LENGTH) {
    throw new Error(`unexpected packet length in "${c.name}"`);
  }
  return {
    name: c.name,
    canonical,
    key: toHex(c.device.key),
    direction,
    address: c.device.address,
    counter: c.counter,
    binding: toHex(c.binding),
    maxLength: c.maxLength,
    messageType: c.message.type,
    fields: fieldsJson(c.message),
    plaintext: toHex(plaintext),
    nonce: toHex(sealed.nonce),
    associatedData: toHex(sealed.associatedData),
    packet: toHex(sealed.packet),
  };
}

/** Every case's plaintext must decode to exactly its message, variations included. */
function assertDecodesTo(c: PacketCase, plaintext: Uint8Array): void {
  const decoded = decodeMessage(plaintext);
  if (!decoded.ok || JSON.stringify(toJson(decoded.value)) !== JSON.stringify(toJson(c.message))) {
    throw new Error(`plaintext of "${c.name}" does not decode to its message`);
  }
}

/** The step-by-step sealing above and the library's sealPacket must agree byte for byte. */
function assertSameAsEncoder(c: PacketCase, packet: Uint8Array): void {
  const fromEncoder = sealPacket(c.message, {
    key: c.device.key,
    direction: messageDirection(c.message.type),
    address: c.device.address,
    counter: c.counter,
    binding: c.binding,
    maxLength: c.maxLength,
  });
  if (toHex(fromEncoder) !== toHex(packet)) throw new Error(`encoder differs in "${c.name}"`);
}

/** "DoorChanged" becomes "door-changed". */
function kebabCase(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/** One file per message type, named after it, holding that type's cases in order. */
export function messageVectorFiles(): Map<string, JsonObject> {
  const files = new Map<string, JsonObject>();
  for (const [name, type] of Object.entries(MessageType)) {
    const cases = packetCases.filter((c) => c.message.type === type);
    if (cases.length === 0) throw new Error(`no vector cases for ${name}`);
    files.set(`${kebabCase(name)}.json`, {
      messageType: type,
      name,
      direction: messageDirection(type),
      cases: cases.map(packetCaseJson),
    });
  }
  return files;
}

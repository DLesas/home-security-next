/** Every message type with its body, as one discriminated union keyed by `type`. */
import { ByteReader, ByteWriter } from "../bytes.ts";
import { taggedUnion, type VariantOf } from "../codec/layout.ts";
import type { Result } from "../result.ts";
import {
  forwardedPacketLayout,
  gatewaySettingsLayout,
  gatewayStatusLayout,
  helloLayout,
  interferenceLayout,
  transmitRequestLayout,
  transmitResultLayout,
  welcomeLayout,
} from "./gateway.ts";
import { logEntriesLayout } from "./logEntries.ts";
import { MessageType } from "./messageType.ts";
import { buttonLayout, disarmedNoticeLayout, replyLayout, sensorStatusLayout } from "./sensor.ts";
import { sirenCommandLayout, sirenReportLayout, sirenSettingsLayout } from "./siren.ts";
import { startedLayout } from "./started.ts";
import {
  keyChangeLayout,
  updateOfferLayout,
  updateQueryLayout,
  updateStatusLayout,
} from "./update.ts";

const bodyLayouts = {
  [MessageType.Heartbeat]: sensorStatusLayout,
  [MessageType.DoorChanged]: sensorStatusLayout,
  [MessageType.CoverChanged]: sensorStatusLayout,
  [MessageType.Button]: buttonLayout,
  [MessageType.Started]: startedLayout,
  [MessageType.UpdateQuery]: updateQueryLayout,
  [MessageType.UpdateStatus]: updateStatusLayout,
  [MessageType.SirenReport]: sirenReportLayout,
  [MessageType.Hello]: helloLayout,
  [MessageType.ForwardedPacket]: forwardedPacketLayout,
  [MessageType.GatewayStatus]: gatewayStatusLayout,
  [MessageType.TransmitResult]: transmitResultLayout,
  [MessageType.Interference]: interferenceLayout,
  [MessageType.LogEntries]: logEntriesLayout,
  [MessageType.Reply]: replyLayout,
  [MessageType.DisarmedNotice]: disarmedNoticeLayout,
  [MessageType.UpdateOffer]: updateOfferLayout,
  [MessageType.KeyChange]: keyChangeLayout,
  [MessageType.SirenCommand]: sirenCommandLayout,
  [MessageType.SirenSettings]: sirenSettingsLayout,
  [MessageType.Welcome]: welcomeLayout,
  [MessageType.TransmitRequest]: transmitRequestLayout,
  [MessageType.GatewaySettings]: gatewaySettingsLayout,
} as const;

const messageCodec = taggedUnion(bodyLayouts);

/** A decoded message: its `type` and the fields of its body (section 6). */
export type Message = VariantOf<typeof bodyLayouts>;

/** The message variant for one type, for example `MessageOf<typeof MessageType.Reply>`. */
export type MessageOf<T extends MessageType> = Extract<Message, { readonly type: T }>;

/** The plaintext of a packet: the type byte followed by the body. */
export function encodeMessage(message: Message): Uint8Array {
  const writer = new ByteWriter();
  messageCodec.encode(writer, message);
  return writer.finish();
}

/**
 * Decodes a packet's plaintext. A body shorter than its fields is `truncated`, bytes after the
 * known fields are ignored, and an unknown type gives `unknownType` with the type byte.
 * Enumerated bytes are returned as read, listed or not (section 3); see isEnumValue.
 */
export function decodeMessage(plaintext: Uint8Array): Result<Message> {
  return messageCodec.decode(new ByteReader(plaintext));
}

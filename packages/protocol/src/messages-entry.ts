/**
 * `@hsn/protocol/messages`: the device protocol's message decoders and their enums, without any
 * crypto, so a browser can decode packet bodies (m2-design.md section 7, "Decoding packets in the
 * browser"). Its import graph holds no `node:` module; a test checks it.
 */
/** Bytes as hex and back, as the records carry bodies (`fromHex` throws on malformed hex). */
export { fromHex, toHex } from "./bytes.ts";
export { messageDirection, MessageType } from "./messages/messageType.ts";
export { decodeMessage, encodeMessage, type Message, type MessageOf } from "./messages/message.ts";
export { Role } from "./messages/common.ts";
export {
  ButtonAction,
  NEXT_SETTING_UNCHANGED,
  REPLY_FLAGS,
  SENSOR_STATUS_FLAGS,
} from "./messages/sensor.ts";
export {
  SIREN_REPORT_FLAGS,
  SirenAction,
  SirenReportReason,
  SirenState,
} from "./messages/siren.ts";
export {
  CONNECTION_RANDOM_LENGTH,
  GATEWAY_STATUS_FLAGS,
  InterferenceEvent,
  TransmitPriority,
  TransmitResultCode,
  TransmitWhen,
} from "./messages/gateway.ts";
export { MAX_LOG_TEXT_BYTES } from "./messages/logEntries.ts";
export {
  decodeStartedImage,
  encodeStartedWithImage,
  NO_FAILED_VERSION,
  STARTED_IMAGE_FLAGS,
  STARTED_IMAGE_OFFSET,
  STARTED_WITH_IMAGE_LENGTH,
  type StartedImage,
} from "./messages/started.ts";
export {
  BLUETOOTH_NONCE_LENGTH,
  IMAGE_ID_LENGTH,
  UPDATE_QUERY_FLAGS,
  UpdateAction,
  UpdateHolding,
  UpdateReason,
  UpdateStage,
} from "./messages/update.ts";
export {
  airtimePercent,
  batteryCode,
  batteryMillivolts,
  fifteenSecondUnitsFromSeconds,
  millisecondsFromTenths,
  ppmFromTenPpmUnits,
  secondsFromFifteenSecondUnits,
  snrDecibels,
  tenPpmUnitsFromPpm,
  tenthsFromMilliseconds,
} from "./messages/units.ts";

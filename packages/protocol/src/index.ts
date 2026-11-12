/**
 * @hsn/protocol: the device protocol, version 1 (docs/protocol.md). The reference the hub,
 * the command-line tool, the simulated radio and the C++ firmware are checked against.
 */

export { type ErrorCode, type ProtocolError, type Result } from "./result.ts";
export { isEnumValue } from "./enum.ts";
export {
  ByteReader,
  ByteWriter,
  concatBytes,
  fromHex,
  isU32,
  MAX_U16,
  MAX_U32,
  MAX_U8,
  toHex,
} from "./bytes.ts";

export { type BlockCipher, type BlockCipherFactory, nodeAes128 } from "./crypto/blockCipher.ts";
export { nodeSha256, type Sha256 } from "./crypto/sha256.ts";
export { type AesCcm, CCM_NONCE_LENGTH, constantTimeEqual, createAesCcm } from "./crypto/ccm.ts";

export {
  CLEAR_HEADER_LENGTH,
  Direction,
  headerByte,
  isValidAddress,
  isValidCounter,
  KEY_LENGTH,
  MaxPacketLength,
  MIN_PACKET_LENGTH,
  type PacketHeader,
  PROTOCOL_VERSION,
  readPacketHeader,
  TAG_LENGTH,
} from "./packet/header.ts";
export {
  counterBinding,
  isValidBindingLength,
  NO_BINDING,
  sessionBinding,
  welcomeBinding,
} from "./packet/binding.ts";
export {
  type OpenedPacket,
  openPacket,
  type OpenOptions,
  packetNonce,
  sealPacket,
  type SealOptions,
} from "./packet/packet.ts";

export { messageDirection, MessageType } from "./messages/messageType.ts";
export { decodeMessage, encodeMessage, type Message, type MessageOf } from "./messages/message.ts";
export { Role } from "./messages/common.ts";
export { ButtonAction, REPLY_FLAGS, SENSOR_STATUS_FLAGS } from "./messages/sensor.ts";
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
  airtimePercent,
  batteryCode,
  batteryMillivolts,
  fifteenSecondUnitsFromSeconds,
  millisecondsFromTenths,
  secondsFromFifteenSecondUnits,
  snrDecibels,
  tenthsFromMilliseconds,
} from "./messages/units.ts";

export { type CounterCheck, type CounterRejection } from "./counters/check.ts";
export {
  newSendCounter,
  RESTORE_COUNTER_JUMP,
  restoreSendCounter,
  ResumeStep,
  resumeSendCounter,
  type SendCounter,
  takeSendCounter,
  type TakenCounter,
} from "./counters/sendCounter.ts";
export {
  checkReplayWindow,
  decodeReplayWindow,
  EMPTY_REPLAY_WINDOW,
  encodeReplayWindow,
  REPLAY_WINDOW_BYTES,
  REPLAY_WINDOW_SIZE,
  type ReplayWindow,
} from "./counters/replayWindow.ts";
export { checkStrictlyHigher } from "./counters/strictCounter.ts";

export { cobsDecode, cobsEncode, maxCobsEncodedLength } from "./usb/cobs.ts";
export { encodeUsbFrame, UsbFrameDecoder } from "./usb/frames.ts";
export {
  CHIP_ID_LENGTH,
  decodeSetupMessage,
  encodeSetupMessage,
  isSetupMessage,
  ProvisionResultCode,
  SETUP_MARKER,
  type SetupMessage,
  SetupType,
} from "./usb/setup.ts";
export {
  decodePairingData,
  encodePairingData,
  HUB_IDENTITY_LENGTH,
  hubIdentity,
  MAX_WIFI_NAME_BYTES,
  MAX_WIFI_PASSWORD_BYTES,
  PAIRING_FORMAT_VERSION,
  type PairingData,
  SIGNING_KEY_LENGTH,
  wifiBytes,
} from "./pairing.ts";

export {
  DATA_RATE_COUNT,
  DataRate,
  dataRateMask,
  dataRatesInMask,
  SiteChannel,
  spreadingFactor,
  timeOnAirMs,
} from "./radio.ts";

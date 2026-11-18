/**
 * `@hsn/protocol/update`: firmware updates' transfer format (m3-updates-design.md sections 3 and
 * 5): transfer frames and their CRC-32, the signed image header, and the Bluetooth update
 * service's session key and tag. Frozen by the joint step 0 (docs/m3-m4-plan.md, row 0a). The
 * update messages themselves (0x06, 0x07, 0x83, 0x84) and Started's new fields are packets, in
 * `@hsn/protocol`.
 */
export { crc32 } from "./crc32.ts";
export {
  bluetoothMaxData,
  type DataFrame,
  decodeTransferFrame,
  DEVICE_RANDOM_LENGTH,
  type DoneFrame,
  encodeTransferFrame,
  type GetFrame,
  GoneReason,
  type GoneFrame,
  type HelloFrame,
  isIntact,
  isTransferFrame,
  OPEN_TAG_LENGTH,
  type OpenFrame,
  type TransferFrame,
  type TransferFrameToSend,
  TransferKind,
  TRANSFER_LIMITS,
  TRANSFER_PREFIX,
  TransferResult,
} from "./transfer.ts";
export {
  ALL_ROLES_MASK,
  checkImageHeader,
  decodeImageHeader,
  encodeImageHeaderBody,
  type HeaderExpectations,
  IMAGE_HEADER,
  IMAGE_HEADER_FLAGS,
  type ImageHeader,
  type ImageHeaderFields,
  imageHeaderSignedBytes,
  imageIdOf,
  ImageTarget,
  roleBit,
  signImageHeader,
  signingKeyIdentity,
  signingKeyOf,
  verifyImageHeader,
} from "./image-header.ts";
export {
  BLUETOOTH_UPDATE,
  bluetoothOpenTag,
  bluetoothSessionKey,
  bluetoothUpdateName,
} from "./bluetooth.ts";
export {
  BLUETOOTH_NONCE_LENGTH,
  IMAGE_ID_LENGTH,
  UpdateAction,
  UpdateHolding,
  UpdateReason,
  UpdateStage,
} from "../messages/update.ts";

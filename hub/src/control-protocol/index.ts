/**
 * The control socket's requests and replies, the bench's lockstep messages and manifest, as Zod
 * schemas (hub-design.md sections 9 and 11). Shared by the hub's control module, its socket
 * server and the `hsn` CLI. Imports only `zod`, and `@hsn/protocol/app` for M2's operations.
 */
export {
  CONTROL_LINE_BYTES,
  CONTROL_OPS,
  CONTROL_OPS_V2,
  controlCommand,
  type ControlCommand,
  type ControlCommandKind,
  type FileChunkCommand,
  logKind,
  type ParsedControlCommand,
  sensorTarget,
  typedCommand,
} from "./commands.ts";
export {
  type CommandResult,
  commandResult,
  controlError,
  type ControlError,
  controlErrorCode,
  controlReply,
  type ControlReply,
} from "./replies.ts";
export { recordJson, type RecordJson } from "./records.ts";
export {
  chunkLine,
  type ChunkLine,
  fileFailedLine,
  type FileFailedLine,
  replyLine,
  type ReplyLine,
  requestLine,
  type RequestLine,
  streamLine,
  type StreamLine,
} from "./envelope.ts";
export {
  LOCKSTEP_VERSION,
  lockstepFromHub,
  type LockstepFromHub,
  type LockstepIdle,
  lockstepToHub,
  type LockstepToHub,
} from "./lockstep.ts";
export { benchManifest, type BenchManifest, MANIFEST_VERSION } from "./manifest.ts";

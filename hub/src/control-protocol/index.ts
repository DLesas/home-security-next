/**
 * The control socket's requests and replies, the bench's lockstep messages and manifest, as Zod
 * schemas (hub-design.md sections 9 and 11). Shared by the hub's control module, its socket
 * server and the `hsn` CLI. Imports only `zod`.
 */
export {
  controlCommand,
  type ControlCommand,
  type ControlCommandKind,
  logKind,
  sensorTarget,
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
  replyLine,
  type ReplyLine,
  requestLine,
  type RequestLine,
  streamLine,
  type StreamLine,
} from "./envelope.ts";
export {
  lockstepFromHub,
  type LockstepFromHub,
  lockstepToHub,
  type LockstepToHub,
} from "./lockstep.ts";
export { benchManifest, type BenchManifest, MANIFEST_VERSION } from "./manifest.ts";

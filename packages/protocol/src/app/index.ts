/**
 * `@hsn/protocol/app`: the app channel, versions 1 and 2 (docs/m2-design.md sections 5 and 6;
 * version 2 by the joint step 0 of docs/m3-m4-plan.md). Frozen by step 0: every type and schema
 * here changes only through the step 0 owner (section 11). `noise.ts` and `backup.ts`, the
 * implementations of the two interfaces, are owner A1's; XN in `noise.ts` is B1's.
 */
export * from "./constants.ts";
export * from "./values.ts";
export * from "./errors.ts";
export * from "./errors-v2.ts";
export * from "./objects.ts";
export * from "./ops.ts";
export * from "./events.ts";
export * from "./objects-v2.ts";
export * from "./ops-v2.ts";
export * from "./events-v2.ts";
export * from "./versions.ts";
export * from "./refusals-v2.ts";
export * from "./envelope.ts";
export * from "./handshake.ts";
export * from "./linking.ts";
export * from "./noise-interface.ts";
export * from "./backup-interface.ts";
export * from "./vector-formats.ts";
export * from "./csp.ts";
export { matchesIdentity, startHandshake, x25519StaticKey } from "./noise.ts";
export { backupCodec, backupOpener, backupSealer } from "./backup.ts";
/**
 * The relay's types that channel version 2 and the hub's core name (m4-design sections 4 to 6),
 * here too, since the core may import only `@hsn/protocol`, `/app` and `/records` (hub-design
 * section 1). Their home is `@hsn/protocol/relay`. With them, three pure functions the core uses
 * as the protocol has them: the push key id and key as `push.register` carries them, and the
 * relay's two alerts' content (D127). None reads, writes, throws or keeps a key; sealing stays the
 * shell's.
 */
export {
  parsePushKey,
  parsePushKeyId,
  pushContent,
  pushEnvironment,
  pushOutcome,
  pushPlatform,
  relayAlertContent,
  releaseOffer,
  type PushContent,
  type PushEnvironment,
  type PushOutcome,
  type PushPlatform,
  type RelayAlert,
  type ReleaseOffer,
} from "../relay/index.ts";

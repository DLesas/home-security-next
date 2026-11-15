/**
 * `@hsn/protocol/app`: the app channel, version 1 (docs/m2-design.md sections 5 and 6). Frozen
 * by step 0: every type and schema here changes only through the step 0 owner (section 11).
 * `noise.ts` and `backup.ts`, the implementations of the two interfaces, are owner A1's.
 */
export * from "./constants.ts";
export * from "./values.ts";
export * from "./errors.ts";
export * from "./objects.ts";
export * from "./ops.ts";
export * from "./events.ts";
export * from "./envelope.ts";
export * from "./handshake.ts";
export * from "./linking.ts";
export * from "./noise-interface.ts";
export * from "./backup-interface.ts";
export * from "./vector-formats.ts";
export * from "./csp.ts";
export { matchesIdentity, startHandshake, x25519StaticKey } from "./noise.ts";
export { backupCodec, backupOpener, backupSealer } from "./backup.ts";

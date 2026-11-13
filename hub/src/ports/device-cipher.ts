/**
 * The deterministic cipher (hub-design.md section 3): a thin wrapper over `@hsn/protocol`'s
 * `sealPacket` and `openPacket` with keys from the `KeyStore`. Declared in the core's model,
 * because `CoreDeps` carries it, and re-exported here with the other ports.
 */
export type { DeviceCipher, OpenRequest, SealRequest } from "../core/model/cipher.ts";

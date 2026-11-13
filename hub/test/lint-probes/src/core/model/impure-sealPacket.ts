// Lint probe: core/model may not use sealPacket.
// Expect: no-restricted-imports "[core-impure]"
export { sealPacket } from "@hsn/protocol";

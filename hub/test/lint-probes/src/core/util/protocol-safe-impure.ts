// Lint probe: not even protocol-safe.ts's neighbours may use sealPacket.
// Expect: no-restricted-imports "[core-impure]"
export { sealPacket } from "@hsn/protocol";

// Lint probe: the core may not use sealPacket.
// Expect: no-restricted-imports "[core-impure]"
export { sealPacket } from "@hsn/protocol";

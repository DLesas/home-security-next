// Lint probe: the core may not use openPacket.
// Expect: no-restricted-imports "[core-impure]"
export { openPacket } from "@hsn/protocol";

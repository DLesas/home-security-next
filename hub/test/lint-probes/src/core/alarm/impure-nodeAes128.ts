// Lint probe: the core may not use nodeAes128.
// Expect: no-restricted-imports "[core-impure]"
export { nodeAes128 } from "@hsn/protocol";

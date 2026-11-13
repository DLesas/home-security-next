// Lint probe: the core may not use nodeSha256.
// Expect: no-restricted-imports "[core-impure]"
export { nodeSha256 } from "@hsn/protocol";

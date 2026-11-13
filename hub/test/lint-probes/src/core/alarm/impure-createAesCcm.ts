// Lint probe: the core may not use createAesCcm.
// Expect: no-restricted-imports "[core-impure]"
export { createAesCcm } from "@hsn/protocol";

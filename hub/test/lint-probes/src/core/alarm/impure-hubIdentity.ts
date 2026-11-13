// Lint probe: the core may not use hubIdentity.
// Expect: no-restricted-imports "[core-impure]"
export { hubIdentity } from "@hsn/protocol";

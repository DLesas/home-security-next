// Lint probe: the core calls encodeMessage, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { encodeMessage } from "@hsn/protocol";

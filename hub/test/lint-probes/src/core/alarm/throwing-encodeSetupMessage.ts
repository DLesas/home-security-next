// Lint probe: the core calls encodeSetupMessage, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { encodeSetupMessage } from "@hsn/protocol";

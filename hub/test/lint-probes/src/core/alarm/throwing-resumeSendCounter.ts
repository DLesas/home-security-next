// Lint probe: the core calls resumeSendCounter, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { resumeSendCounter } from "@hsn/protocol";

// Lint probe: the core calls restoreSendCounter, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { restoreSendCounter } from "@hsn/protocol";

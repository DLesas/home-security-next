// Lint probe: the core calls counterBinding, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { counterBinding } from "@hsn/protocol";

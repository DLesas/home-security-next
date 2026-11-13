// Lint probe: the core calls sessionBinding, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { sessionBinding } from "@hsn/protocol";

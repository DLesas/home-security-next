// Lint probe: the core calls checkStrictlyHigher, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { checkStrictlyHigher } from "@hsn/protocol";

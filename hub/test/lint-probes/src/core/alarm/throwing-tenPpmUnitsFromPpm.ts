// Lint probe: the core calls tenPpmUnitsFromPpm, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { tenPpmUnitsFromPpm } from "@hsn/protocol";

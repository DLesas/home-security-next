// Lint probe: the core calls dataRateMask, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { dataRateMask } from "@hsn/protocol";

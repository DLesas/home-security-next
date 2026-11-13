// Lint probe: the core calls tenthsFromMilliseconds, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { tenthsFromMilliseconds } from "@hsn/protocol";

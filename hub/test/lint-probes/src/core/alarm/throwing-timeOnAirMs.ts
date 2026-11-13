// Lint probe: the core calls timeOnAirMs, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { timeOnAirMs } from "@hsn/protocol";

// Lint probe: core/util outside protocol-safe.ts may not use throwing names.
// Expect: no-restricted-imports "[core-throwing]"
export { timeOnAirMs } from "@hsn/protocol";

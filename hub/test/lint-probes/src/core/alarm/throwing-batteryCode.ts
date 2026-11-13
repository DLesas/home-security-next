// Lint probe: the core calls batteryCode, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { batteryCode } from "@hsn/protocol";

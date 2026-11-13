// Lint probe: the core calls fifteenSecondUnitsFromSeconds, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { fifteenSecondUnitsFromSeconds } from "@hsn/protocol";

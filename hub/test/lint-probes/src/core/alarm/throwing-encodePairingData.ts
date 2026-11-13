// Lint probe: the core calls encodePairingData, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { encodePairingData } from "@hsn/protocol";

// Lint probe: the core calls fromHex, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { fromHex } from "@hsn/protocol";

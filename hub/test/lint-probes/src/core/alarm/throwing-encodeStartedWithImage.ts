// Lint probe: the core calls encodeStartedWithImage, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { encodeStartedWithImage } from "@hsn/protocol";

// Lint probe: the core calls welcomeBinding, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { welcomeBinding } from "@hsn/protocol";

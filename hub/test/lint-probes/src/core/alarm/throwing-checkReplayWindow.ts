// Lint probe: the core calls checkReplayWindow, which can throw, only through protocol-safe.ts.
// Expect: no-restricted-imports "[core-throwing]"
export { checkReplayWindow } from "@hsn/protocol";

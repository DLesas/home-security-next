// Lint probe: the core may not use the global process.
// Expect: no-restricted-globals "[core-global] process:"
export const pid = (): number => process.pid;

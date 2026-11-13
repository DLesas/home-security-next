// Lint probe: the core may not use the global Bun.
// Expect: no-restricted-globals "[core-global] Bun:"
export const version = (): string => Bun.version;

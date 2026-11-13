// Lint probe: the core may not use the global performance.
// Expect: no-restricted-globals "[core-global] performance:"
export const now = (): number => performance.now();

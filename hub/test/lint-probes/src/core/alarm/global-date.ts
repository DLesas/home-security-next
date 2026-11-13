// Lint probe: the core may not use the global Date.
// Expect: no-restricted-globals "[core-global] Date:"
export const now = (): number => Date.now();

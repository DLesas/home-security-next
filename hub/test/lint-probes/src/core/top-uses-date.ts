// Lint probe: the core's top level may not use Date either.
// Expect: no-restricted-globals "[core-global] Date:"
export const now = (): number => Date.now();

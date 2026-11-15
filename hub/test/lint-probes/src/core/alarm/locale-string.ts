// Lint probe: the core may not format by locale.
// Expect: no-restricted-properties "[core-locale] toLocaleString"
export const text = (n: number): string => n.toLocaleString();

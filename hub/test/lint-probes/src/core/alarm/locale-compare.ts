// Lint probe: the core may not compare by locale.
// Expect: no-restricted-properties "[core-locale] localeCompare"
export const order = (a: string, b: string): number => a.localeCompare(b);

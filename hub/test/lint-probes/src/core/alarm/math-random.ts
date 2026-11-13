// Lint probe: the core may not use Math.random.
// Expect: no-restricted-properties "[core-random]"
export const roll = (): number => Math.random();

// Lint probe: the core may not use the global crypto.
// Expect: no-restricted-globals "[core-global] crypto:"
export const id = (): string => crypto.randomUUID();

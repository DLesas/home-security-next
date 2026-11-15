// Lint probe: the core may not use Intl.
// Expect: no-restricted-globals "[core-global] Intl:"
export const names = (): string[] => Intl.getCanonicalLocales("en");

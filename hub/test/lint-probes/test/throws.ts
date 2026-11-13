// Lint probe: tests may not throw either.
// Expect: no-restricted-syntax "[no-throw]"
export function fail(): never {
  throw new Error("probe");
}

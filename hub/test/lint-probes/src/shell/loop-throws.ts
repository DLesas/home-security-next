// Lint probe: the shell outside safe/ may not throw.
// Expect: no-restricted-syntax "[no-throw]"
export function fail(): never {
  throw new Error("probe");
}

// Lint probe: the relay may not throw outside shell/safe/.
// Expect: no-restricted-syntax "[no-throw]"
export function fail(): never {
  throw new Error("probe");
}

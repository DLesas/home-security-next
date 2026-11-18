// Lint probe: the deployment package may not throw.
// Expect: no-restricted-syntax "[no-throw]"
export function fail(): never {
  throw new Error("probe");
}

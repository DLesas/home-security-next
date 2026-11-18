// Lint probe: a safe folder two levels under a part of the relay is not a safe/ folder.
// Expect: no-restricted-syntax "[no-throw]"
export function fail(): never {
  throw new Error("probe");
}

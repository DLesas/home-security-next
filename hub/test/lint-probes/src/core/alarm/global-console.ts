// Lint probe: the core may not use the global console.
// Expect: no-restricted-globals "[core-global] console:"
export function say(): void {
  console.log("probe");
}

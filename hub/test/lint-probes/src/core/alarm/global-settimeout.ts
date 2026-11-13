// Lint probe: the core may not use the global setTimeout.
// Expect: no-restricted-globals "[core-global] setTimeout:"
export function later(run: () => void): void {
  setTimeout(run, 1);
}

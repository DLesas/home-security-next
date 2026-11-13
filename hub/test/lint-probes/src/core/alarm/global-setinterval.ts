// Lint probe: the core may not use the global setInterval.
// Expect: no-restricted-globals "[core-global] setInterval:"
export function often(run: () => void): void {
  setInterval(run, 1);
}

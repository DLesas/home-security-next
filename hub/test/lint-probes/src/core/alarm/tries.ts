// Lint probe: the core may not use try.
// Expect: no-restricted-syntax "[no-try]"
export function attempt(run: () => number): number {
  try {
    return run();
  } catch {
    return 0;
  }
}

// Lint probe: the relay may not use try outside shell/safe/.
// Expect: no-restricted-syntax "[no-try]"
export function attempt(run: () => number): number | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

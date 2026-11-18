// Lint probe: the relay's shell/safe/ may use try and throw.
// Expect: clean
export function attempt(run: () => number): number {
  try {
    return run();
  } catch {
    throw new Error("probe");
  }
}

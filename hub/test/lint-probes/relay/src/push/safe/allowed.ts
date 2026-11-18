// Lint probe: a safe/ folder directly under any part of the relay may use try and throw.
// Expect: clean
export function attempt(run: () => number): number {
  try {
    return run();
  } catch {
    throw new Error("probe");
  }
}

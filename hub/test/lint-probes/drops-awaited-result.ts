// Lint probe: a dropped Promise of a Result.
// Expect: hsn/must-use-result "Result is dropped"
import { ok, type Result } from "neverthrow";

export async function later(): Promise<Result<number, never>> {
  return Promise.resolve(ok(1));
}

export async function caller(): Promise<void> {
  await later();
}

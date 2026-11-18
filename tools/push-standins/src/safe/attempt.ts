/**
 * Every `try` of the stand-ins lives here (docs/m3-m4-plan.md, rule 3): a call that may throw,
 * turned into a result. The error is the thrown value's message, which the stand-ins use only in
 * their own answers and in test failures: they handle keys made for the test, never real ones.
 */
import { fail, ok, type Result } from "../result.ts";

/** Runs `run`; a thrown value becomes its message. */
export function attempt<T>(run: () => T): Result<T, string> {
  try {
    return ok(run());
  } catch (thrown) {
    return fail(thrown instanceof Error ? thrown.message : "a non-error value was thrown");
  }
}

/** `JSON.parse` behind a result. */
export function parseJson(text: string): Result<unknown, string> {
  return attempt((): unknown => JSON.parse(text));
}

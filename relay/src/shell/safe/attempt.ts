/**
 * The one way the relay's shell calls a library that throws (bun:sqlite and Drizzle, `node:fs`,
 * `node:crypto`, `Bun.serve`, `JSON.parse`): `attempt` runs it and answers a result, keeping only
 * the thrown value's code (`thrown.ts`). Every `try` of `relay/src/shell/` is in this folder.
 */
import { err, ok, type Result } from "neverthrow";
import type { RelayError, RelayErrorKind } from "../errors.ts";
import { errorFrom } from "./thrown.ts";

export function attempt<T>(
  kind: RelayErrorKind,
  origin: string,
  what: string,
  run: () => T,
): Result<T, RelayError> {
  try {
    return ok(run());
  } catch (thrown) {
    return err(errorFrom(kind, origin, what, thrown));
  }
}

/** As `attempt`, for a promise: a rejection is the error. */
export async function attemptAsync<T>(
  kind: RelayErrorKind,
  origin: string,
  what: string,
  run: () => Promise<T>,
): Promise<Result<T, RelayError>> {
  try {
    return ok(await run());
  } catch (thrown) {
    return err(errorFrom(kind, origin, what, thrown));
  }
}

/** `JSON.parse`, as a result; the text is never quoted in the error. */
export function parseJson(text: string, origin: string, what: string): Result<unknown, RelayError> {
  return attempt("config", origin, what, () => JSON.parse(text) as unknown);
}

/**
 * `JSON.parse` behind a result. Its message quotes the text it was given, which may be a
 * credential file or a frame holding push tokens, so only the error's kind is kept.
 */
import { err, ok, type Result } from "neverthrow";
import type { PushError, PushErrorKind } from "../errors.ts";
import { errorFrom } from "./thrown.ts";

/** Parses `text`; a malformed one is a `kind` error from `origin` saying `what` was not JSON. */
export function parseJson(
  text: string,
  kind: PushErrorKind,
  origin: string,
  what: string,
): Result<unknown, PushError> {
  try {
    const parsed: unknown = JSON.parse(text);
    return ok(parsed);
  } catch (thrown) {
    return err(errorFrom(kind, origin, `${what} is not JSON`, thrown, "codeOnly"));
  }
}

/**
 * `JSON.parse` behind a result (hub-design.md section 10): the control socket's lines, which
 * Zod's `safeParse` then checks for shape, and the hub's own `fatal.log` lines.
 */
import { err, ok, type Result } from "neverthrow";
import type { HubError, HubErrorKind } from "../../core/model/errors.ts";
import { errorFrom } from "./thrown.ts";

/** Parses `text` as JSON; a malformed text is an error of `kind` from `origin`. */
export function parseJson<K extends HubErrorKind>(
  text: string,
  kind: K,
  origin: string,
): Result<unknown, HubError & { readonly kind: K }> {
  try {
    const parsed: unknown = JSON.parse(text);
    return ok(parsed);
  } catch (thrown) {
    return err(errorFrom(kind, origin, "parse JSON", thrown));
  }
}

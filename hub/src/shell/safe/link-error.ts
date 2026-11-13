/** The `LinkError` the serial and WebSocket wrappers return (hub-design.md sections 3 and 10). */
import type { LinkErrorCode } from "../../core/model/events.ts";
import type { LinkError } from "../../ports/links.ts";
import { errorFrom } from "./thrown.ts";

/** A `LinkError` with `code` from `origin`, describing what failed and the thrown value if any. */
export function linkError(
  code: LinkErrorCode,
  origin: string,
  what: string,
  thrown?: unknown,
): LinkError {
  const base =
    thrown === undefined
      ? { kind: "link" as const, origin, message: what }
      : errorFrom("link", origin, what, thrown);
  return { ...base, code };
}

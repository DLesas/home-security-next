/**
 * Turning a thrown value into a typed `HubError` (hub-design.md section 10, "Where library
 * exceptions are wrapped"). Every wrapper in `shell/safe/` uses this, so a library's error reads
 * the same wherever it was caught: its message, and its code (SQLite's `SQLITE_FULL`, Node's
 * `ENOENT`) in the detail.
 */
import type { HubError, HubErrorKind } from "../../core/model/errors.ts";

/**
 * The error's own code, when the library gives one: `SQLITE_FULL`, `ENOENT`, `EACCES`; from the
 * error that caused it when the library wraps it (Drizzle wraps SQLite's errors).
 */
export function thrownCode(thrown: unknown): string | undefined {
  if (typeof thrown !== "object" || thrown === null) return undefined;
  const code: unknown = "code" in thrown ? thrown.code : undefined;
  if (typeof code === "string") return code;
  return "cause" in thrown && thrown.cause !== thrown ? thrownCode(thrown.cause) : undefined;
}

function thrownMessage(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  return typeof thrown === "string" ? thrown : "a non-error value was thrown";
}

/** A `HubError` of `kind` from `origin` describing `thrown`: `what` failed, and why. */
export function errorFrom<K extends HubErrorKind>(
  kind: K,
  origin: string,
  what: string,
  thrown: unknown,
): HubError & { readonly kind: K } {
  const code = thrownCode(thrown);
  const message = `${what}: ${thrownMessage(thrown)}`;
  return code === undefined
    ? { kind, origin, message }
    : { kind, origin, message, detail: { code } };
}

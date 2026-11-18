/**
 * `Bun.serve` behind a result, for the push role's two listeners: the local socket the operator's
 * relay opens, and the TLS listener self-hosted relays reach (docs/m4-design.md section 3).
 */
import type { Serve, Server } from "bun";
import { err, ok, type Result } from "neverthrow";
import type { PushError } from "../errors.ts";
import { errorFrom } from "./thrown.ts";

/** Starts a server; a busy port or path is an error. */
export function serve<T>(
  options: Serve.Options<T, never>,
  what: string,
): Result<Server<T>, PushError> {
  try {
    return ok(Bun.serve<T>(options));
  } catch (thrown) {
    return err(errorFrom("link", "push/safe/serve", `listen on ${what}`, thrown, "withMessage"));
  }
}

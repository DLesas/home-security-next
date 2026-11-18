/**
 * `Bun.serve` behind a result, for the relay's listener and the releases role's local socket.
 */
import type { Serve, Server } from "bun";
import type { Result } from "neverthrow";
import type { RelayError } from "../errors.ts";
import { attempt } from "./attempt.ts";

/** Starts a server; a busy port or path is an error. */
export function serve<T>(
  options: Serve.Options<T, never>,
  what: string,
): Result<Server<T>, RelayError> {
  return attempt("link", "shell/safe/serve", `listen on ${what}`, () => Bun.serve<T>(options));
}

/** Upgrades a request; false when Bun would not. */
export function upgrade<T extends object>(server: Server<T>, request: Request, data: T): boolean {
  const options: { data: T } = { data };
  return attempt("link", "shell/safe/serve", "upgrade", () =>
    (server.upgrade as (this: Server<T>, request: Request, options: { data: T }) => boolean).call(
      server,
      request,
      options,
    ),
  ).unwrapOr(false);
}

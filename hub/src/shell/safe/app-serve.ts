/**
 * `Bun.serve` for the two app listeners behind results (hub-design.md section 10; m2-design.md
 * section 5): opening throws when the port is taken or the TLS key and certificate do not load,
 * and stopping can throw on a server already stopped. Owner A2.
 */
import type { Server } from "bun";
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { errorFrom } from "./thrown.ts";

const ORIGIN = "shell/safe/app-serve";

/** Starts a server; the error names what was being opened, never a key. */
export function openServer<T>(
  what: string,
  options: Bun.Serve.Options<T>,
): Result<Server<T>, HubError> {
  try {
    return ok(Bun.serve<T>(options));
  } catch (thrown) {
    return err(errorFrom("link", ORIGIN, `open ${what}`, thrown));
  }
}

/** Stops a server; with `closeActive`, its open connections too. */
export function stopServer<T>(server: Server<T>, closeActive: boolean): Result<void, HubError> {
  try {
    void server.stop(closeActive);
    return ok(undefined);
  } catch (thrown) {
    return err(errorFrom("link", ORIGIN, "stop a listener", thrown));
  }
}

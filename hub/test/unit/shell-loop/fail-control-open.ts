/** A test preload that holds the control socket open attempt until the parent reports a failure. */
import { err, type Result, ResultAsync } from "neverthrow";
import type { HubError } from "../../../src/core/model/errors.ts";
import { UnixControlServer } from "../../../src/shell/control/server.ts";

UnixControlServer.open = () =>
  new ResultAsync(
    new Promise<Result<UnixControlServer, HubError>>((resolve) => {
      process.once("message", () => {
        resolve(err({ kind: "control", origin: "test", message: "injected open failure" }));
        // Report after the hub has handled the result.
        setImmediate(() => process.send?.("control-open-ended"));
      });
      process.send?.("control-opening");
    }),
  );

/**
 * The control socket on Windows (hub-design.md section 9: "on Windows a named pipe with the same
 * access rule ‡"), behind the same `Control` interface as `UnixControlServer`.
 *
 * WAITING: Node's `net` module can listen on a named pipe (`\\.\pipe\hsn-control`, cli/paths.ts)
 * but cannot set its access list, and a pipe created without one is open to every user of the
 * computer, which section 9 forbids. Section 13 lists "Named pipes for the control socket on
 * Windows under Bun" as a risk to check with the installer work (O7). Until a way to restrict the
 * pipe to the hub's account is chosen (a native helper, or running the hub as a service whose
 * pipe is made with a security descriptor), opening it is refused rather than left open.
 */
import { errAsync, type ResultAsync } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { UnixControlServer } from "./server.ts";

export function openWindowsControl(): ResultAsync<UnixControlServer, HubError> {
  return errAsync({
    kind: "control",
    origin: "shell/control/windows",
    message:
      "WAITING: the control pipe cannot yet be limited to the hub's account on Windows, so it is not opened",
  });
}

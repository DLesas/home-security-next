/**
 * A file job's call, wrapped (hub-design.md section 10; m2-design.md section 3, "Jobs in pieces,
 * the loop's contract"): the loop starts a job, takes its next piece and aborts it through this,
 * so a job that throws ends as a failed job and the loop goes on, rather than the hub stopping.
 */
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { errorFrom } from "./thrown.ts";

/** `call()`, or the `internal` error it threw, as `what` failed in `origin`. */
export function jobCall<T>(origin: string, what: string, call: () => T): Result<T, HubError> {
  try {
    return ok(call());
  } catch (thrown) {
    return err(errorFrom("internal", origin, what, thrown));
  }
}

/** Time for the shell (hub-design.md section 3; section 5, "The clock"). */
import type { Now } from "../core/model/time.ts";

/**
 * `now()`: the monotonic and wall clocks with the wall clock's trust. Never blocks, never fails.
 * `mono` never goes back; the core treats a smaller one as a `CoreFault`.
 */
export interface Clock {
  now(): Now;
}

/**
 * Whether the wall clock is set (section 5): on Linux, when systemd's time service reports it
 * synchronised, checked every 10 s until it is and then every hour; on macOS and Windows, which
 * have a battery-backed clock, trusted. Never trusted while it reads earlier than the build time
 * or the last commit mark. Never blocks: it returns the cached answer and refreshes in the
 * background. A probe that fails leaves the clock untrusted and is recorded once.
 */
export interface TimeTrust {
  wallTrusted(): boolean;
}

/**
 * Whether the wall clock can be trusted (hub-design.md section 5, "Raspberry Pi", "The clock").
 *
 * - On Linux it is set once systemd's time service reports it synchronised, by creating
 *   `/run/systemd/timesync/synchronized`. The shell looks for that file every 10 s until it is
 *   there, then every hour, and never more often: one `stat` of a file in memory, no process.
 * - On macOS and Windows, which have a battery-backed clock, it is trusted, and nothing is polled.
 * - On every system it is untrusted while it reads earlier than the hub's build time or than the
 *   last commit mark.
 *
 * `wallTrusted` never blocks: it answers from the last probe. A probe that fails (anything but
 * the file not being there) leaves the clock untrusted and is reported once.
 */
import type { HubError } from "../../core/model/errors.ts";
import type { TimeTrust } from "../../ports/clock.ts";
import { pathExists } from "../safe/fs.ts";

const ORIGIN = "shell/clock/time-trust";
const SECOND_MS = 1000;
const HOUR_MS = 3600 * SECOND_MS;

/** systemd-timesyncd's mark of a synchronised clock (section 5). */
export const SYSTEMD_SYNCHRONIZED = "/run/systemd/timesync/synchronized";
/** Probe every 10 s while the clock is not yet synchronised (section 5) ... */
export const PROBE_UNTRUSTED_MS = 10 * SECOND_MS;
/** ... and every hour once it is (section 5). */
export const PROBE_TRUSTED_MS = HOUR_MS;
/**
 * No wall clock reading earlier than this is trusted (section 5: "earlier than the hub's build
 * time"). SPEC-QUESTION: the hub has no build step that could stamp it; this is the day the
 * design was agreed, and a release should set it.
 */
export const HUB_BUILD_TIME_MS = Date.UTC(2026, 10, 13);

/** Runs `run` after `ms`; the default does not keep the process alive for it. */
export type Scheduler = (ms: number, run: () => void) => { cancel(): void };

export const systemScheduler: Scheduler = (ms, run) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
};

/** Whether the system says its clock is synchronised; an error is a failed probe. */
export type SyncProbe = () =>
  | { readonly ok: true; readonly synced: boolean }
  | { readonly ok: false; readonly error: HubError };

/** The probe for a platform, or undefined for one whose clock is trusted without asking. */
export function probeFor(
  platform: NodeJS.Platform,
  path = SYSTEMD_SYNCHRONIZED,
): SyncProbe | undefined {
  if (platform === "darwin" || platform === "win32") return undefined;
  return () =>
    pathExists({ kind: "config", origin: ORIGIN }, path).match(
      (synced) => ({ ok: true as const, synced }),
      (error) => ({ ok: false as const, error }),
    );
}

export interface TimeTrustOptions {
  /** The platform's probe; undefined: trusted without asking (macOS, Windows). */
  readonly probe: SyncProbe | undefined;
  readonly scheduler: Scheduler;
  readonly wall: () => number;
  readonly notBeforeMs: number;
  /** Told the first failed probe only. */
  readonly onProbeFailed: (error: HubError) => void;
}

export class SystemTimeTrust implements TimeTrust {
  readonly #options: TimeTrustOptions;
  #synced: boolean;
  #floorMs: number;
  #reported = false;
  #pending: { cancel(): void } | undefined;

  constructor(options: TimeTrustOptions) {
    this.#options = options;
    this.#synced = options.probe === undefined;
    this.#floorMs = options.notBeforeMs;
  }

  /** Probes once now, then on the schedule of section 5. */
  start(): void {
    this.#probe();
  }

  stop(): void {
    this.#pending?.cancel();
    this.#pending = undefined;
  }

  /** The last commit mark's wall time, read at start: earlier readings are not trusted. */
  setFloor(wallMs: number): void {
    this.#floorMs = Math.max(this.#floorMs, wallMs);
  }

  wallTrusted(): boolean {
    return this.#synced && this.#options.wall() >= this.#floorMs;
  }

  #probe(): void {
    const { probe, scheduler, onProbeFailed } = this.#options;
    if (probe === undefined) return;
    const result = probe();
    this.#synced = result.ok && result.synced;
    if (!result.ok && !this.#reported) {
      this.#reported = true;
      onProbeFailed(result.error);
    }
    this.#pending = scheduler(this.#synced ? PROBE_TRUSTED_MS : PROBE_UNTRUSTED_MS, () => {
      this.#probe();
    });
  }
}

/**
 * Time for the relay's shell: the wall clock and timers, injected so tests drive them and nothing
 * is slept. The same shape as the push role's `LinkClock`, so one clock serves both.
 */
export interface RelayClock {
  now(): number;
  /** Runs `run` after `ms`; the function returned cancels it. */
  after(ms: number, run: () => void): () => void;
}

/** The largest delay a timer takes (2³¹ − 1 ms); longer waits are taken in steps. */
const MAX_TIMER_MS = 2_147_483_647;

export const SYSTEM_CLOCK: RelayClock = {
  now: () => Date.now(),
  after(ms, run) {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = Date.now() + ms;
    const arm = (wait: number) => {
      timer = setTimeout(
        () => {
          if (cancelled) return;
          const left = end - Date.now();
          if (left > 0) arm(left);
          else run();
        },
        Math.max(0, Math.min(wait, MAX_TIMER_MS)),
      );
    };
    arm(ms);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  },
};

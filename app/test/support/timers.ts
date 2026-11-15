/** Timers the tests move by hand; the in-memory sockets still deliver on the real event loop. */
import type { Timers } from "../../src/hub/wire";

export interface ManualTimers extends Timers {
  /** Moves time on, running every timer that falls due, in order. */
  advance(ms: number): void;
  /** The delays asked for, in order. */
  readonly asked: number[];
}

export function manualTimers(start = 1_000_000): ManualTimers {
  let now = start;
  let nextId = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  const asked: number[] = [];
  return {
    asked,
    now: () => now,
    after: (ms, run) => {
      const id = nextId++;
      asked.push(ms);
      due.set(id, { at: now + ms, run });
      return () => {
        due.delete(id);
      };
    },
    advance: (ms) => {
      const until = now + ms;
      for (;;) {
        const next = [...due.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (next === undefined) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].run();
      }
      now = until;
    },
  };
}

/** Lets the sockets' messages and the awaits behind them run. */
export async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

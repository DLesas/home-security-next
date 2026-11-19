/** Shared, clock-driven Bluetooth discovery and cancellation for the phone's two flows. */
import type { Advert, BleCentral, BleFault } from "../platform/ble";
import type { Outcome } from "../platform/split";

export interface RadioClock {
  now(): number;
  after(ms: number, run: () => void): () => void;
}

/** Uses the same monotonic time for deadlines and retry windows. */
export const radioClock: RadioClock = {
  now: () => performance.now(),
  after: (ms, run) => {
    const timeout = setTimeout(run, Math.max(0, ms));
    return () => {
      clearTimeout(timeout);
    };
  },
};

/** Reads cancellation again after a callback or asynchronous Bluetooth operation. */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Maps a radio state into the connection result shape used by both flows. */
export async function radioFault(central: BleCentral): Promise<BleFault | undefined> {
  const state = await central.state();
  return state === "on" ? undefined : state === "unsupported" ? "failed" : state;
}

/** Waits for a matching advert and collects nearby candidates if a collection time is given. */
export async function discover(
  central: BleCentral,
  clock: RadioClock,
  service: string,
  accepts: (advert: Advert) => boolean,
  duration: number,
  signal: AbortSignal,
  collectMs = 0,
): Promise<Outcome<readonly Advert[], BleFault>> {
  const radio = await radioFault(central);
  if (radio !== undefined || signal.aborted) return { ok: false, fault: radio ?? "lost" };
  return new Promise((resolve) => {
    const found = new Map<string, Advert>();
    const cleanups: (() => void)[] = [];
    let finished = false;
    /** The central may report its first advertisement during scan registration. */
    const isFinished = () => finished;
    /** Stops scan and timers as soon as one terminal result wins. */
    function finish(fault?: BleFault) {
      if (finished) return;
      finished = true;
      for (const cleanup of cleanups) cleanup();
      resolve(
        fault === undefined ? { ok: true, value: [...found.values()] } : { ok: false, fault },
      );
    }
    /** Aborts discovery without waiting for the timer. */
    const cancel = () => {
      finish("lost");
    };
    signal.addEventListener("abort", cancel, { once: true });
    cleanups.push(() => {
      signal.removeEventListener("abort", cancel);
    });
    cleanups.push(
      clock.after(duration, () => {
        finish(found.size ? undefined : "notFound");
      }),
    );
    /** Checks for changes while the frozen scan interface supplies advertisements only. */
    function poll() {
      void radioFault(central).then((failure) => {
        if (finished) return;
        if (failure !== undefined) finish(failure);
        else cancelPoll = clock.after(500, poll);
      });
    }
    let cancelPoll = clock.after(500, poll);
    cleanups.push(() => {
      cancelPoll();
    });
    const stop = central.scan(service, (advert) => {
      if (finished || !accepts(advert)) return;
      const first = found.size === 0;
      found.set(advert.id, advert);
      if (!first) return;
      if (collectMs === 0) finish();
      else
        cleanups.push(
          clock.after(collectMs, () => {
            finish();
          }),
        );
    });
    if (isFinished()) stop();
    else cleanups.push(stop);
  });
}

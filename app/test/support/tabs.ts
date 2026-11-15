/** A lock manager and a broadcast channel in memory, standing in for the browser's (`hub/tabs.ts`). */
import type { Bus, Locks } from "../../src/hub/tabs";

/**
 * A lock manager as Web Locks behave: the first asker holds the lock until the promise its
 * callback returned settles; then the next waiting asker is given it.
 */
export function lockManager() {
  const queue: (() => void)[] = [];
  let held = false;
  const next = () => {
    const grant = queue.shift();
    if (grant === undefined) held = false;
    else grant();
  };
  return (): Locks => ({
    request: (_name, callback) =>
      new Promise((resolve) => {
        const grant = () => {
          held = true;
          void callback().then(() => {
            resolve(undefined);
            next();
          });
        };
        if (held) queue.push(grant);
        else grant();
      }),
  });
}

/** A broadcast channel: every message to every other tab, a turn later. */
export function busHub() {
  const tabs = new Map<string, ((event: MessageEvent<unknown>) => void)[]>();
  return (tab: string): Bus & { close(): void } => ({
    postMessage: (message) => {
      const copy = structuredClone(message);
      for (const [other, listeners] of tabs)
        if (other !== tab)
          setTimeout(() => {
            for (const l of listeners) l(new MessageEvent("message", { data: copy }));
          }, 0);
    },
    addEventListener: (_type, listener) => {
      tabs.set(tab, [...(tabs.get(tab) ?? []), listener]);
    },
    close: () => {
      tabs.delete(tab);
    },
  });
}

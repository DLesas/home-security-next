/**
 * Diagnostic only: what the hub's own thread spends time in, without changing the product: the
 * loop's turn, the writer's flush (`hub.db`'s commit) and an upload's chunk (written from the
 * control socket's handler, outside a turn), each over 5 ms written to standard error with its
 * epoch end time, wall and thread CPU.
 */
import { HubLoop } from "../src/shell/loop.ts";
import { SqliteWriter } from "../src/shell/storage/writer.ts";
import { UploadStore } from "../src/shell/app/uploads.ts";

const cpuNow = (): number => {
  const used = process.threadCpuUsage();
  return (used.user + used.system) / 1000;
};
type Fn = (...args: unknown[]) => unknown;
function wrap(proto: object, name: string, what: string, more?: (result: unknown, args: unknown[]) => object): void {
  const record = proto as Record<string, Fn>;
  const original = record[name];
  if (original === undefined) throw new Error(`no ${name}`);
  record[name] = function (this: unknown, ...args: unknown[]): unknown {
    const c0 = cpuNow();
    const t0 = performance.now();
    const result = original.apply(this, args);
    const ms = performance.now() - t0;
    if (ms > 5)
      process.stderr.write(
        `DIAG-CALL ${JSON.stringify({ what, t: performance.timeOrigin + performance.now(), ms, cpu: cpuNow() - c0, ...(more?.(result, args) ?? {}) })}\n`,
      );
    return result;
  };
}
wrap(HubLoop.prototype, "turn", "turn", (result) => {
  const r = result as { inputs: number; effects: { kind: string }[] };
  return { inputs: r.inputs, effects: [...new Set(r.effects.map((e) => e.kind))].join(",") };
});
wrap(SqliteWriter.prototype, "flush", "hub.db commit", (_r, args) => ({ reason: args[0] }));
wrap(UploadStore.prototype, "chunk", "upload chunk");

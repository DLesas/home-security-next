/** Diagnostics for the real-hub budget test. Record timings without logging event contents. */
import { HubLoop, type TurnSummary } from "../../src/shell/loop.ts";

const limit = Number(process.env.HSN_TEST_TURN_LIMIT_MS ?? 250);
const turn = Object.getOwnPropertyDescriptor(HubLoop.prototype, "turn")?.value as (
  this: HubLoop,
) => TurnSummary;

/** Distinguishes time on the turn's thread from elapsed time in a slow turn. */
HubLoop.prototype.turn = function (this: HubLoop): TurnSummary {
  const started = process.threadCpuUsage();
  const result = turn.call(this);
  if (result.durationMs > limit) {
    const cpu = process.threadCpuUsage(started);
    process.stderr.write(
      `Slow hub turn: at ${Date.now()} ms, ${result.durationMs} ms elapsed, ` +
        `${(cpu.user + cpu.system) / 1000} ms thread CPU, ` +
        `${result.inputs} inputs, effects ${result.effects.map((effect) => effect.kind).join(",") || "none"}\n`,
    );
  }
  return result;
};

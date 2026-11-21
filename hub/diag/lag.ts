/**
 * Diagnostic only: on the thread that imports it first (the hub's own), a 10 ms timer's lateness,
 * written to standard error with the epoch time: every gap over 5 ms at once, with the thread CPU
 * across it and the heap; and each second, the second's worst gap.
 */
const cpuNow = (): number => {
  const used = process.threadCpuUsage();
  return (used.user + used.system) / 1000;
};
const epoch = (): number => performance.timeOrigin + performance.now();
let last = performance.now();
let lastCpu = cpuNow();
let worst = 0;
let secondEnds = last + 1000;
const tick = (): void => {
  const now = performance.now();
  const c = cpuNow();
  const late = now - last - 10;
  if (late > 5)
    process.stderr.write(
      `DIAG-LAG ${JSON.stringify({ t: epoch(), late, cpu: c - lastCpu, heap: process.memoryUsage().heapUsed })}\n`,
    );
  if (late > worst) worst = late;
  if (now >= secondEnds) {
    process.stderr.write(`DIAG-SEC ${JSON.stringify({ t: epoch(), worst, heap: process.memoryUsage().heapUsed })}\n`);
    worst = 0;
    secondEnds = now + 1000;
  }
  last = performance.now();
  lastCpu = cpuNow();
  setTimeout(tick, 10).unref();
};
setTimeout(tick, 10).unref();

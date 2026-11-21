/**
 * Diagnostic only: reads a `BUN_JSC_logGC=1` test run's output on standard input and keeps the
 * diagnostic lines, the test files' headers, and the collections: every one that ended while
 * stage-job.test.ts ran, and any over 20 ms elsewhere, each as one line naming its VM (the test
 * process's own, the first seen, or a worker's), kind, heap, pause and cycle.
 */
const starts = new Map<string, { kind: string; heapMb: number }>();
let mainVm: string | undefined;
let inStageJob = process.env.GCFILTER_ALL === "1";
let rest = "";
const decoder = new TextDecoder();
const out = (s: string) => process.stdout.write(`${s}\n`);
function line(raw: string): void {
  const l = raw.replace(/\r$/u, "");
  if (/\.test\.ts:$/u.test(l)) {
    inStageJob = l.includes("stage-job.test.ts");
    out(l);
    return;
  }
  if (l.includes("DIAG-") || /^\s*\(fail\)/u.test(l) || /^\s*[0-9]+ (pass|fail|skip)$/u.test(l)) {
    out(l);
    return;
  }
  const vm = /\[GC<(0x[0-9a-f]+)>/u.exec(l)?.[1];
  if (vm === undefined) return;
  mainVm ??= vm;
  const start = /START \w+ (\d+)kb => (\w+)/u.exec(l);
  if (start !== null) starts.set(vm, { heapMb: Number(start[1]) / 1024, kind: start[2] ?? "?" });
  const end = /p=([0-9.]+)ms \(max [0-9.]+(?:ms)?\), cycle ([0-9.]+)ms END\]/u.exec(l);
  if (end === null) return;
  const p = Number(end[1]);
  const cycle = Number(end[2]);
  if (!inStageJob && p <= 20 && cycle <= 20) return;
  const s = starts.get(vm) ?? { kind: "?", heapMb: 0 };
  out(`GC ${vm === mainVm ? "test-process" : `worker ${vm}`} ${s.kind} ${s.heapMb.toFixed(0)} MB: pause ${p.toFixed(1)} ms, cycle ${cycle.toFixed(1)} ms`);
}
for await (const chunk of Bun.stdin.stream()) {
  rest += decoder.decode(chunk, { stream: true });
  const lines = rest.split("\n");
  rest = lines.pop() ?? "";
  for (const l of lines) line(l);
}
if (rest !== "") line(rest);

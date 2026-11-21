/**
 * Diagnostic only: a real hub (the test-key hub, from source or compiled, `lag-hub.ts`) stages a
 * release `DIAG_STAGINGS` times through `hsn update install`; for each staging, the hub thread's
 * longest timer gap (`lag.ts`) and every collection JSC logged (`BUN_JSC_logGC=1`) that ended in
 * a gap, the hub's own VM told from the workers'.
 *
 * bun hub/diag/stagings.ts source | compiled <executable>
 */
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPaths } from "../launcher/src/layout.ts";
import { releaseOfFiles } from "../packaging/shared/make-release.ts";
import { HUB_VERSION } from "../src/shell/hub-facts.ts";
import { programName } from "../src/shell/update/program-name.ts";
import { platformOf } from "../src/shell/update/release.ts";
import { testCli } from "../test/world/processes.ts";
import { isWindows, shapeFolder } from "../test/unit/shell-control/windows-folders.ts";

const HUB = join(import.meta.dir, "..");
const [mode = "source", exe = ""] = process.argv.slice(2);
const N = Number(process.env.DIAG_STAGINGS ?? "60");
const KIND = process.env.DIAG_KIND ?? "stage";
const LABEL = `${process.env.DIAG_LABEL ?? "local"}-${mode}-${KIND}`;
const HERE = platformOf(process.platform, process.arch) ?? "linux-x64";
const root = mkdtempSync(join(process.env.DIAG_ROOT ?? tmpdir(), "hsn-stagings-"));
const prefix = join(root, "program");
mkdirSync(join(prefix, "staged", HUB_VERSION, "bin"), { recursive: true });
mkdirSync(join(prefix, "state"), { recursive: true });
writeFileSync(
  installPaths(prefix).launcherFile,
  JSON.stringify({ current: HUB_VERSION, previous: null, trial: null, rolledBack: null }),
);
const data = join(root, "data");
mkdirSync(data);
if (isWindows) shapeFolder(data);

const text = (s: string) => new TextEncoder().encode(s);
function release(version: string): string {
  const entries = [
    { path: `bin/${programName(HERE)}`, data: text("a program\n".repeat(100_000)) },
    { path: "drizzle/0000.sql", data: text("CREATE TABLE x (a);") },
    ...Array.from({ length: 40 }, (_, i) => ({ path: `web/f${i}.js`, data: text(`export const x${i} = 1;\n`) })),
  ]
    .map((e) => ({ ...e, executable: e.path.startsWith("bin/") }))
    .toSorted((a, b) => (a.path < b.path ? -1 : 1));
  const path = join(root, `release-${version}.hsnr`);
  writeFileSync(path, releaseOfFiles(entries, version, HERE, new Uint8Array(32).fill(7), 0)._unsafeUnwrap());
  return path;
}

interface Gc { readonly vm: string; readonly kind: string; readonly heapKb: number; readonly p: number; readonly cycle: number }
type Event =
  | { readonly kind: "lag"; readonly t: number; readonly late: number; readonly cpu: number; readonly heap: number }
  | { readonly kind: "sec"; readonly t: number; readonly worst: number; readonly heap: number }
  | { readonly kind: "gc"; readonly gc: Gc }
  | { readonly kind: "call"; readonly t: number; readonly ms: number; readonly cpu: number; readonly what: string; readonly effects?: string; readonly reason?: string };
const events: Event[] = [];
const starts = new Map<string, { kind: string; heapKb: number }>();
const vms: string[] = [];
const other: string[] = [];
function line(l: string): void {
  if (l.startsWith("DIAG-LAG ")) events.push({ kind: "lag", ...JSON.parse(l.slice(9)) });
  else if (l.startsWith("DIAG-SEC ")) events.push({ kind: "sec", ...JSON.parse(l.slice(9)) });
  else if (l.startsWith("DIAG-CALL ")) events.push({ kind: "call", ...JSON.parse(l.slice(10)) });
  else {
    const vm = /\[GC<(0x[0-9a-f]+)>/u.exec(l)?.[1];
    if (vm === undefined) {
      if (!l.startsWith("Requesting GC") && !l.startsWith("GC END") && l.trim() !== "") other.push(l);
      return;
    }
    if (!vms.includes(vm)) vms.push(vm);
    const start = /START \w+ (\d+)kb => (\w+)/u.exec(l);
    if (start !== null) starts.set(vm, { heapKb: Number(start[1]), kind: start[2] ?? "?" });
    const end = /p=([0-9.]+)ms \(max [0-9.]+(?:ms)?\), cycle ([0-9.]+)ms END\]/u.exec(l);
    if (end !== null) {
      const s = starts.get(vm) ?? { kind: "?", heapKb: 0 };
      events.push({ kind: "gc", gc: { vm, kind: s.kind, heapKb: s.heapKb, p: Number(end[1]), cycle: Number(end[2]) } });
    }
  }
}

// The compiled program where the launcher puts it, its migrations and web build beside it.
const installed = join(prefix, "staged", HUB_VERSION);
if (mode === "compiled") {
  copyFileSync(exe, join(installed, "bin", basename(exe)));
  cpSync(join(HUB, "drizzle"), join(installed, "drizzle"), { recursive: true });
  mkdirSync(join(installed, "web"), { recursive: true });
}
const command =
  mode === "compiled"
    ? [join(installed, "bin", basename(exe))]
    : [process.execPath, join(HUB, "diag", "lag-hub.ts")];
const hub = Bun.spawn(
  [...command, "--data", data, "--port", "0", "--no-usb-watch", "--app-ports", "0,0"],
  { stdout: "ignore", stderr: "pipe", env: { ...process.env, HSN_PROGRAM: prefix, BUN_JSC_logGC: "1" } },
);
void (async () => {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of hub.stderr) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) line(l.replace(/\r$/u, ""));
  }
})();
const ready = performance.now() + 60_000;
while (!existsSync(join(data, "control.sock")) && performance.now() < ready) await Bun.sleep(20);
await Bun.sleep(1000);
const mainVm = vms[0] ?? "?";
console.log(`${LABEL}: hub up; its VM ${mainVm}; ${vms.length} VM(s) seen so far`);

interface Row { readonly n: number; readonly ok: boolean; readonly ms: number; readonly worst: number; readonly worstCpu: number; readonly gcMain: number; readonly gcWorker: number; readonly gapGcs: string[]; readonly heapMb: number }
const rows: Row[] = [];
for (let n = 1; n <= N; n++) {
  // "stage": a newer release, staged; "refuse": the same upload, refused at once (notNewer);
  // "idle": no upload, the hub left alone as long.
  const path = KIND === "idle" ? "" : release(KIND === "refuse" ? `0.0.${n}` : `99.0.${n}`);
  const from = events.length;
  const t0 = performance.timeOrigin + performance.now();
  let out = "";
  if (KIND === "idle") await Bun.sleep(300);
  else {
    const cli = Bun.spawn([process.execPath, testCli, "--data", data, "update", "install", path], { stdout: "pipe", stderr: "pipe" });
    out = (await new Response(cli.stdout).text()) + (await new Response(cli.stderr).text());
    await cli.exited;
  }
  const t1 = performance.timeOrigin + performance.now();
  await Bun.sleep(150);
  const mine = events.slice(from);
  const lags = mine.filter((e): e is Extract<Event, { kind: "lag" }> => e.kind === "lag" && e.t >= t0 && e.t <= t1 + 100);
  const secs = mine.filter((e): e is Extract<Event, { kind: "sec" }> => e.kind === "sec" && e.t >= t0 && e.t <= t1 + 1100);
  const worstLag = lags.reduce<Extract<Event, { kind: "lag" }> | undefined>((a, b) => (a === undefined || b.late > a.late ? b : a), undefined);
  const worst = Math.max(worstLag?.late ?? 0, ...secs.map((s) => s.worst));
  const gcs = mine.filter((e): e is Extract<Event, { kind: "gc" }> => e.kind === "gc").map((e) => e.gc);
  // The collections that ended just before each gap over 15 ms was seen.
  const gapGcs: string[] = [];
  mine.forEach((e, i) => {
    if (e.kind !== "lag" || e.late <= 15) return;
    const before: string[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const b = mine[j];
      if (b === undefined || b.kind !== "gc") break;
      before.push(`${b.gc.vm === mainVm ? "hub" : "worker"} ${b.gc.kind} ${(b.gc.heapKb / 1024).toFixed(0)} MB p=${b.gc.p.toFixed(1)} cycle=${b.gc.cycle.toFixed(1)}`);
    }
    const from = e.t - e.late - 12;
    const calls = mine
      .filter((c): c is Extract<Event, { kind: "call" }> => c.kind === "call" && c.t >= from && c.t <= e.t + 1)
      .map((c) => `${c.what}${c.effects ? ` [${c.effects}]` : ""}${c.reason ? ` (${c.reason})` : ""} ${c.ms.toFixed(1)} ms, cpu ${c.cpu.toFixed(1)}`);
    gapGcs.push(`${e.late.toFixed(1)} ms (cpu ${e.cpu.toFixed(1)}): ${before.join(", ") || "no collection ended in it"}; in it: ${calls.join(" > ") || "no turn, commit or chunk over 5 ms"}`);
  });
  const row: Row = {
    n,
    ok: KIND === "idle" || (KIND === "refuse" ? out.includes("notNewer") || out.includes("not newer") : out.includes(`staged: version 99.0.${n}`)),
    ms: t1 - t0,
    worst,
    worstCpu: worstLag?.cpu ?? 0,
    gcMain: Math.max(0, ...gcs.filter((g) => g.vm === mainVm).map((g) => g.p)),
    gcWorker: Math.max(0, ...gcs.filter((g) => g.vm !== mainVm).map((g) => g.p)),
    gapGcs,
    heapMb:
      (events.findLast((e): e is Extract<Event, { kind: "sec" }> => e.kind === "sec")?.heap ?? 0) /
      2 ** 20,
  };
  rows.push(row);
  console.log(`DIAG-STAGING ${LABEL} ${JSON.stringify(row)}`);
  if (!row.ok) console.log(`  not staged: ${out.slice(0, 300)}`);
}
console.log(`${LABEL}: ${events.filter((e) => e.kind === "sec").length} once-a-second lines, ${events.filter((e) => e.kind === "lag").length} gaps over 5 ms, ${events.filter((e) => e.kind === "gc").length} collections logged (${vms.length} VMs)`);
hub.kill(9);
await hub.exited;

const q = (v: number[], p: number) => v.toSorted((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))] ?? Number.NaN;
const worsts = rows.map((r) => r.worst);
const summary = [
  `### Real hub, ${LABEL}: ${rows.length} rounds, ${rows.filter((r) => r.ok).length} as expected`,
  "",
  `- the hub thread's longest timer gap per staging (0 is 5 ms or less: only gaps over 5 ms are written): p50 ${q(worsts, 0.5).toFixed(1)} ms, p95 ${q(worsts, 0.95).toFixed(1)} ms, max ${Math.max(...worsts).toFixed(1)} ms; stagings with a gap over 20 ms: ${worsts.filter((w) => w > 20).length}`,
  `- the longest collection pause JSC logged per staging, the hub's VM: p50 ${q(rows.map((r) => r.gcMain), 0.5).toFixed(1)} ms, max ${Math.max(...rows.map((r) => r.gcMain)).toFixed(1)} ms; the workers' VMs: max ${Math.max(...rows.map((r) => r.gcWorker)).toFixed(1)} ms`,
  `- the hub's heap: ${Math.max(...rows.map((r) => r.heapMb)).toFixed(0)} MB at most; staging took p50 ${q(rows.map((r) => r.ms), 0.5).toFixed(0)} ms end to end (the CLI's upload included)`,
  `- gaps over 15 ms, with the collections that ended just before each: ${rows.flatMap((r) => r.gapGcs.map((g) => `#${r.n} ${g}`)).join("; ") || "none"}`,
  `- other hub output: ${other.slice(0, 5).join(" | ") || "none"}`,
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY !== undefined) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n`);

// Starts each variant, measures start time and memory, and records which checks pass.
// Usage: node measure.mjs '<json array of {name, cmd, args}>'  (defaults below are filled in by run-*.sh)
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const variants = JSON.parse(process.argv[2]);
const outFile = process.argv[3] ?? "results.json";
const RUNS = 3, SOCKETS = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

function rssMb(pid) {
  if (process.platform === "linux") {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) / 1024 : NaN;
  }
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024;
}
function footprintMb(pid) { // macOS "Memory" column in Activity Monitor
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("/usr/bin/footprint", [String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const m = /phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(out);
    if (!m) return null;
    return Number(m[1]) * (m[2] === "KB" ? 1 / 1024 : m[2] === "GB" ? 1024 : 1);
  } catch { return null; }
}

async function oneRun(v, port, wantChecks) {
  const t0 = performance.now();
  const child = spawn(v.cmd, v.args, { env: { ...process.env, PORT: String(port), DB: ":memory:" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => (stderr += d));
  const base = `http://127.0.0.1:${port}`;
  let startMs = NaN;
  for (let i = 0; i < 4000; i++) {
    if (child.exitCode !== null) throw new Error(`${v.name} exited: ${stderr.slice(0, 300)}`);
    try { const r = await fetch(`${base}/health`); if (r.ok) { startMs = performance.now() - t0; break; } } catch {}
    await sleep(5);
  }
  if (Number.isNaN(startMs)) { child.kill("SIGKILL"); throw new Error(`${v.name} never answered: ${stderr.slice(0, 300)}`); }
  await sleep(3000);
  const idle = rssMb(child.pid), idleFoot = footprintMb(child.pid);

  const sockets = [];
  for (let i = 0; i < SOCKETS; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    sockets.push(ws);
  }
  let echoed = 0;
  await Promise.all(sockets.map((ws) => new Promise((res) => { ws.once("message", () => { echoed++; res(); }); ws.send("ping"); })));
  for (let i = 0; i < 5; i++) await fetch(`${base}/load`, { method: "POST" });
  const rows = (await (await fetch(`${base}/load`, { method: "POST" })).json()).rows;
  await sleep(2000);
  const busy = rssMb(child.pid), busyFoot = footprintMb(child.pid);

  let checks = null, all = null;
  if (wantChecks) {
    checks = await (await fetch(`${base}/checks`)).json();
    await sleep(1000);
    all = rssMb(child.pid);
  }
  sockets.forEach((ws) => ws.terminate());
  child.kill("SIGKILL");
  await sleep(300);
  return { startMs, idle, idleFoot, busy, busyFoot, all, echoed, rows, checks };
}

const results = [];
let port = 45910;
for (const v of variants) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    try { runs.push(await oneRun(v, port++, i === 0)); }
    catch (e) { runs.push({ error: String(e.message ?? e) }); break; }
  }
  const good = runs.filter((r) => !r.error);
  const row = { name: v.name, runs: good.length, error: runs.find((r) => r.error)?.error ?? null };
  if (good.length) {
    Object.assign(row, {
      startMs: Math.round(median(good.map((r) => r.startMs))),
      idleRssMb: +median(good.map((r) => r.idle)).toFixed(1),
      idleFootprintMb: good[0].idleFoot === null ? null : +median(good.map((r) => r.idleFoot)).toFixed(1),
      busyRssMb: +median(good.map((r) => r.busy)).toFixed(1),
      busyFootprintMb: good[0].busyFoot === null ? null : +median(good.map((r) => r.busyFoot)).toFixed(1),
      allLoadedRssMb: good[0].all === null ? null : +good[0].all.toFixed(1),
      socketsEchoed: good[0].echoed, rowsWritten: good[0].rows, checks: good[0].checks,
    });
  }
  results.push(row);
  console.log(JSON.stringify({ ...row, checks: undefined }));
  for (const c of row.checks ?? []) console.log(`   ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
}
writeFileSync(outFile, JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 2));

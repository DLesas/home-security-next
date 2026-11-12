// Where does the memory go? RSS after sockets only, then after database work only.
import { spawn, execFileSync } from "node:child_process";
import WebSocket from "ws";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rss = (pid) => +(Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024).toFixed(1);
const variants = JSON.parse(process.argv[2]);
let port = 45950;
for (const v of variants) {
  const p = port++;
  const child = spawn(v.cmd, v.args, { env: { ...process.env, PORT: String(p), DB: ":memory:" }, stdio: "ignore" });
  for (let i = 0; i < 2000; i++) { try { if ((await fetch(`http://127.0.0.1:${p}/health`)).ok) break; } catch {} await sleep(5); }
  await sleep(2000);
  const idle = rss(child.pid);
  const few = [];
  for (let i = 0; i < 5; i++) { const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, { perMessageDeflate: false }); await new Promise((r) => ws.once("open", r)); few.push(ws); }
  await sleep(1000);
  const fiveSockets = rss(child.pid);
  const socks = [];
  for (let i = 0; i < 195; i++) { const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, { perMessageDeflate: false }); await new Promise((r) => ws.once("open", r)); socks.push(ws); }
  await sleep(1500);
  const twoHundred = rss(child.pid);
  for (let i = 0; i < 6; i++) await fetch(`http://127.0.0.1:${p}/load`, { method: "POST" });
  await sleep(1500);
  const afterDb = rss(child.pid);
  await sleep(20000);
  const settled = rss(child.pid);
  console.log(JSON.stringify({ name: v.name, idle, fiveSockets, twoHundredSockets: twoHundred, after60kRows: afterDb, after20sQuiet: settled }));
  [...few, ...socks].forEach((w) => w.terminate()); child.kill("SIGKILL"); await sleep(200);
}

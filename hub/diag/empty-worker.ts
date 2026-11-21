/** Diagnostic only: a worker that posts once and ends; spins `spinMs` first if asked. */
import { parentPort, workerData } from "node:worker_threads";

const spinMs = (workerData as { spinMs?: number } | null)?.spinMs ?? 0;
const end = performance.now() + spinMs;
while (performance.now() < end);
parentPort?.postMessage("up");

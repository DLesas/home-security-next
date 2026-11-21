/**
 * The one worker entry of the hub's file jobs (D145), embedded in the compiled program
 * (`packaging/shared/build-program.ts`, `hubWorkers`): it serves the job its data names. One entry
 * for every kind, so the program carries one embedded worker and `jobEntry` finds it by one path;
 * each kind's module is small, so a worker loading them all costs its start little.
 */
import { parentPort, workerData } from "node:worker_threads";
import { serveStaging } from "../update/stage-serve.ts";
import type { JobKind, JobKindData, KindData, WorkerData } from "./kinds.ts";
import type { WorkerReply } from "./serve.ts";

interface Port {
  postMessage(reply: WorkerReply): void;
}

/**
 * Each kind's server, by kind: a kind of `kinds.ts` missing here, or served with another kind's
 * data, does not compile (the mapped type is the dispatch's exhaustive check).
 */
const SERVERS: { readonly [K in JobKind]: (port: Port, data: WorkerData<KindData<K>>) => void } = {
  stageUpdate: serveStaging,
};

function served(kind: unknown): kind is JobKind {
  return typeof kind === "string" && Object.hasOwn(SERVERS, kind);
}

/** Whether `data` is what a job's worker is started with: a kind served, its data, the word. */
function isWorkerData(data: unknown): data is WorkerData<JobKindData> {
  if (typeof data !== "object" || data === null) return false;
  if (!("kind" in data) || !served(data.kind)) return false;
  if (!("inputs" in data) || typeof data.inputs !== "object" || data.inputs === null) return false;
  if (!("control" in data)) return false;
  const control = data.control;
  return (
    control instanceof Int32Array &&
    control.buffer instanceof SharedArrayBuffer &&
    control.length === 2
  );
}

/** Serves the job `data` names, by its kind's own module. */
function serve<K extends JobKind>(
  port: Port,
  data: WorkerData<KindData<K>> & { readonly kind: K },
) {
  SERVERS[data.kind](port, data);
}

// Data it does not take posts nothing: the job ends failed, the worker having stopped first.
const data: unknown = workerData;
if (parentPort !== null && isWorkerData(data)) serve(parentPort, data);

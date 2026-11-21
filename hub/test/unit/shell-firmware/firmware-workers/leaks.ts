/**
 * A firmware staging worker that throws an error spelling the signing key it was given, in every
 * way a careless message could (hex, base64, base64url, its bytes as numbers): what reaches the
 * job's outcome must hold none of them (`stage-job.test.ts`).
 */
import { workerData } from "node:worker_threads";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

const { signingKeys } = workerData as WorkerData<KindData<"stageFirmware">>;
const key = "keys" in signingKeys ? Buffer.from(signingKeys.keys.signingPrivate) : Buffer.alloc(0);
// An error left unhandled, as a thrown one is: the thread's `error` event carries its message.
void Promise.reject(
  new Error(
    `bad key ${key.toString("hex")} ${key.toString("base64")} ${key.toString("base64url")} ${JSON.stringify([...key])} ${[...key].join(", ")}`,
  ),
);

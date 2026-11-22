/**
 * Firmware staging's worker side (D145; the loop's side is `stage-job.ts`): the image staged by
 * `FirmwareStaging` (`stage.ts`), unchanged, a bounded piece after another on the worker's own
 * thread, so the work per piece and every outcome and refusal are what they were on the loop. The
 * hub's signing key's columns come as data, read from `hub.db` by the loop as the job started; the
 * worker makes the signer of them (the key parsed and checked against its public half, which on a
 * hub's first header costs 20 to 60 ms of CPU) where `FirmwareStaging` asks for it, after pass 1,
 * or gives why there was none there, so the refusals keep their order. Before every piece the
 * worker looks at the loop's word: a stop ends the job through `FirmwareStaging.abort`, which
 * removes the temporary file. The core never cancels a firmware staging, so no cancel comes. It
 * never touches `hub.db`. The key's columns are in its data and nowhere else: nothing the worker
 * posts but the outcome, and no code here writes a key into an error.
 */
import { err } from "neverthrow";
import type { KindData, WorkerData } from "../worker/kinds.ts";
import { serveJob, type WorkerReply } from "../worker/serve.ts";
import { signerOfKeys } from "./sign.ts";
import { FirmwareStaging } from "./stage.ts";

/** Stages to the end on this thread, then marks the control word and posts the outcome. */
export function serveFirmwareStaging(
  port: { postMessage(reply: WorkerReply): void },
  data: WorkerData<KindData<"stageFirmware">>,
): void {
  const read = data.signingKeys;
  serveJob(
    port,
    data.control,
    new FirmwareStaging({
      ...data.inputs,
      signer: () => ("keys" in read ? signerOfKeys(read.keys) : err(read.error)),
    }),
  );
}

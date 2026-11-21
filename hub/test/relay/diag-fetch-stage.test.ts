/**
 * Diagnostic only (throwaway branch): fetch and stage a signed release through the relay, again
 * and again, a fresh relay and real hub each time, printing any loop guard line whole.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { endProcesses } from "../world/processes.ts";
import { guardsEngaged } from "./leaks.ts";
import { HubProcess, PushRole, RelayProgram, shortFolder, waitFor } from "./processes.ts";
import { RELEASE_VERSION, standIns, writeTestRelease } from "./pushes.ts";

const ROUNDS = Number(process.env.DIAG_ROUNDS ?? "20");
const LABEL = process.env.DIAG_LABEL ?? "local";
const roots: string[] = [];
afterAll(async () => {
  await endProcesses();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function once(n: number): Promise<{ staged: boolean; guards: string[]; ms: number }> {
  const root = shortFolder("hsn-fs-");
  roots.push(root);
  const s = await standIns();
  const push = new PushRole(root, s);
  await push.start();
  const releases = join(root, "releases");
  mkdirSync(releases);
  writeTestRelease(releases, 4 * 1024 * 1024);
  const relay = new RelayProgram(root, { pushUrl: push.url, releases: { folder: releases } });
  await relay.start();
  const hub = new HubProcess(root, { programTree: true });
  await hub.start();
  const start = performance.now();
  let staged = false;
  try {
    if (!(await hub.op("relay.set", { url: relay.url })).ok) throw new Error("relay.set");
    if (!(await hub.relayState("up", 15_000))) throw new Error("not up");
    await waitFor(
      async () => {
        const offers = await hub.op("update.offers", {});
        return offers.ok && offers.body.offer !== null;
      },
      10_000,
      50,
    );
    if (!(await hub.op("update.fetch", { version: RELEASE_VERSION })).ok) throw new Error("fetch");
    staged = await waitFor(
      async () => {
        const status = await hub.op("update.status", {});
        return status.ok && status.body.staged === RELEASE_VERSION;
      },
      60_000,
      50,
    );
    // A little life after the staging, as M4 has.
    await Bun.sleep(2000);
  } finally {
    await hub.stop();
    await relay.stop();
    await push.stop();
    await s.close();
  }
  const ms = performance.now() - start;
  const guards = guardsEngaged([hub.out?.text ?? ""]);
  console.log(`DIAG-FS ${LABEL} round ${n}: staged ${staged}, ${ms.toFixed(0)} ms, guards ${guards.length}${guards.map((g) => `\n  GUARD ${g}`).join("")}`);
  return { staged, guards, ms };
}

test(
  "fetch and stage, again and again: no guard engaged",
  async () => {
    let engaged = 0;
    let stagedCount = 0;
    for (let n = 0; n < ROUNDS; n++) {
      const r = await once(n);
      if (r.staged) stagedCount += 1;
      if (r.guards.length > 0) engaged += 1;
    }
    console.log(`DIAG-FS ${LABEL} summary: ${ROUNDS} rounds, ${stagedCount} staged, ${engaged} with a guard engaged`);
    expect(engaged).toBe(0);
  },
  3_600_000,
);

/**
 * upkeep in the whole core (`step` over every module, in their order): the key made at the
 * first start in the boot's own step, and a person added by the hub computer (`hsn op
 * person.create`) followed in that same step by a backup job into the chosen folder, with the
 * person's row and the backup's due state in one "now" commit. This is where step 2 joins the
 * modules; a change elsewhere that stops a change reaching upkeep fails here.
 */
import { describe, expect, test } from "bun:test";
import { nodeSha256 } from "@hsn/protocol";
import type { Effect } from "../../../src/core/model/effects.ts";
import { bootId, jobId, requestId, connId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { BACKUP_STATE_DEFAULTS } from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { mono } from "../../../src/core/model/time.ts";
import { emptyState, step } from "../../../src/core/step.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { snapshot, UTC_CALENDAR, WALL0 } from "./support.ts";

const deps = {
  cipher: VectorCipher.fromVectors(),
  rules: DEFAULT_RULES,
  calendar: UTC_CALENDAR,
  sha256: nodeSha256,
  deepFreeze: true,
  checkDeadlines: true,
};

function run(state: HubState, t: number, event: Parameters<typeof step>[1]["event"]) {
  const result = step(
    state,
    {
      now: { mono: mono(t), wall: WALL0 + Math.floor(t / 1000), wallTrusted: true },
      entropy: new Uint8Array(32).fill(t & 0xff),
      event,
    },
    deps,
  );
  expect(result.isOk() ? "" : result.error.message).toBe("");
  return result._unsafeUnwrap();
}

describe("upkeep in the whole core", () => {
  test("first start: the key in the boot step; a person added: a backup job in the same step", () => {
    const booted = run(emptyState(), 0, {
      kind: "boot",
      snapshot: snapshot({ backupState: { ...BACKUP_STATE_DEFAULTS, folder: "/backups" } }),
      boot: { id: bootId(1), previousExit: "clean", cause: undefined },
    });
    const keyWrites = booted.effects.filter(
      (e) => e.kind === "write" && e.op.table === "backup_key",
    );
    expect(keyWrites).toHaveLength(1);
    const firstJob = booted.effects.find((e) => e.kind === "fileJob");
    expect(firstJob?.kind === "fileJob" ? firstJob.work.kind : undefined).toBe("backup");
    // The first backup is written; then a change comes a minute later.
    const done = run(booted.state, 1_000_000, {
      kind: "fileReady",
      job: firstJob?.kind === "fileJob" ? firstJob.job : jobId(0),
      outcome: { kind: "backupWritten", name: "hsn-x.hsnb", bytes: 1, sameDiskAsData: false },
    });
    const added = run(done.state, 61_000_000, {
      kind: "command",
      conn: connId(0),
      request: requestId(1),
      actor: "dimitri",
      command: { kind: "op", operation: { op: "person.create", body: { name: "Anna" } } },
    });
    const tables = added.effects.flatMap((e: Effect) =>
      e.kind === "write" && e.durability === "now" ? [e.op.table] : [],
    );
    expect(tables).toContain("people");
    expect(tables).toContain("backup_state");
    const job = added.effects.find((e) => e.kind === "fileJob");
    expect(job?.kind === "fileJob" ? job.work : undefined).toMatchObject({
      kind: "backup",
      folder: "/backups",
      epoch: 1,
    });
  });
});

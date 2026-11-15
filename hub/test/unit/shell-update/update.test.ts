/**
 * The shell's side of an update (m2-design.md section 9, "Hub updates"): the switch note the
 * launcher reads, held back when something started in the same turn, refused for a version that
 * is not installed or a hub the launcher did not start; the healthy note after `update_healthy`
 * is committed; and staging a release, which waits for the release format (SPEC-QUESTION).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ok } from "neverthrow";
import { installPaths, parseHealthyNote, parseSwitchNote } from "../../../launcher/src/layout.ts";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import { connId, jobId, RECORDS_PER_BOOT, seq } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { runToEnd } from "../../../src/shell/backup/jobs.ts";
import {
  healthyIn,
  markHealthy,
  prefixFrom,
  requestSwitch,
} from "../../../src/shell/update/notes.ts";

const folders: string[] = [];
afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

function install(): string {
  const prefix = mkdtempSync(join(tmpdir(), "hsn-update-"));
  folders.push(prefix);
  mkdirSync(join(prefix, "state"), { recursive: true });
  mkdirSync(join(prefix, "versions", "1.1.0", "bin"), { recursive: true });
  return prefix;
}

function deps(prefix: string | undefined, blocked?: string): Parameters<typeof runToEnd>[2] {
  return {
    db: new Database(":memory:"),
    dataDir: prefix ?? "/nowhere",
    migrationsFolder: "/nowhere",
    rules: DEFAULT_RULES,
    uploads: { pathOf: () => undefined },
    exports: { send: () => ok(undefined) },
    prefix,
    switchBlockedBy: () => blocked,
    nowMs: () => 0,
    salt: () => ok(new Uint8Array(8)),
  };
}

describe("the switch", () => {
  test("the note the launcher reads, then a clean stop and exit 70", () => {
    const prefix = install();
    const done = runToEnd(jobId(1), { kind: "switchUpdate", version: "1.1.0" }, deps(prefix));
    expect(done.kind).toBe("stopAndRestart");
    expect(parseSwitchNote(readFileSync(installPaths(prefix).switchFile, "utf8"))).toEqual({
      to: "1.1.0",
    });
  });

  test("held back when a countdown started in the same turn: failed, and no note", () => {
    const prefix = install();
    const done = runToEnd(
      jobId(1),
      { kind: "switchUpdate", version: "1.1.0" },
      deps(prefix, "countdown"),
    );
    expect(done).toMatchObject({ kind: "ready", outcome: { kind: "failed", reason: "io" } });
    expect(requestSwitch(prefix, "1.1.0", "alarm").isErr()).toBe(true);
    expect(existsSync(installPaths(prefix).switchFile)).toBe(false);
  });

  test("refused for a version not installed, a bad name, or a hub not started by the launcher", () => {
    const prefix = install();
    expect(requestSwitch(prefix, "2.0.0", undefined).isErr()).toBe(true);
    expect(requestSwitch(prefix, "../../x", undefined).isErr()).toBe(true);
    expect(requestSwitch(undefined, "1.1.0", undefined).isErr()).toBe(true);
    expect(prefixFrom({ HSN_PREFIX: prefix })).toBe(prefix);
    expect(prefixFrom({})).toBeUndefined();
  });
});

describe("health", () => {
  test("the version a committed update_healthy names, and the note the launcher reads", () => {
    const record: AuditRecord = {
      kind: "decision",
      row: {
        seq: seq(RECORDS_PER_BOOT + 1),
        atMs: 0,
        clockOk: true,
        kind: "update_healthy",
        deviceId: null,
        causeSeq: null,
        value: null,
        detail: new TextEncoder().encode("1.1.0"),
      },
    };
    expect(healthyIn([record])).toBe("1.1.0");
    expect(
      healthyIn([{ ...record, row: { ...record.row, kind: "update_staged" } }]),
    ).toBeUndefined();
    const prefix = install();
    expect(markHealthy(prefix, "1.1.0").isOk()).toBe(true);
    expect(parseHealthyNote(readFileSync(installPaths(prefix).healthyFile, "utf8"))).toEqual({
      version: "1.1.0",
    });
  });
});

describe("staging", () => {
  test("waits for the release format: answered failed, nothing unpacked", () => {
    const prefix = install();
    const done = runToEnd(
      jobId(1),
      { kind: "stageUpdate", upload: { conn: connId(1), job: 1 } },
      deps(prefix),
    );
    expect(done).toMatchObject({ kind: "ready", outcome: { kind: "failed" } });
  });
});

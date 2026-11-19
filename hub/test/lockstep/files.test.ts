/**
 * The lockstep hub's file work (`src/shell/lockstep/files.ts`; docs/m3-updates-design.md sections
 * 7 and 8): an own build uploaded in `fileChunk` lines and staged by `firmware.upload`, as `hsn
 * firmware add --own` does on the control socket; a backup written into a folder under the backup
 * key the hub made from the seed; `benchRestore` with that key building the restored database,
 * put in place at the next start; and its refusals: a wrong key, a missing file, and the core's
 * refusal of the command on any socket but the lockstep hub's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fromHex, toHex } from "@hsn/protocol";
import { BACKUP_FORMAT, FILE_CHUNK_BYTES } from "@hsn/protocol/app";
import { connId, requestId } from "../../src/core/model/ids.ts";
import { makeCore, MODULES } from "../../src/core/step.ts";
import type { ParsedControlCommand } from "../../src/control-protocol/index.ts";
import { seededKey } from "../../src/shell/lockstep/files.ts";
import { Driver, onlyReply, snapshot } from "../unit/setup/support/driver.ts";
import { espImage, sha256, tempFolder, type TempFolder } from "../unit/shell-firmware/support.ts";
import { type Controller, SECOND } from "./controller.ts";
import { InProcessEnd } from "./ends.ts";
import { provision, SEED, wallAt } from "./sessions.ts";

const folders: TempFolder[] = [];

afterEach(() => {
  InProcessEnd.closeAll();
  for (const folder of folders.splice(0)) folder.remove();
});

function folder(name: string): string {
  const made = tempFolder(name);
  folders.push(made);
  return made.path;
}

/** The `fileChunk` lines `hsn` sends for a file, as `hub/cli/files.ts` cuts it. */
function chunkCommands(job: number, file: Uint8Array): ParsedControlCommand[] {
  const out: ParsedControlCommand[] = [];
  const count = Math.max(1, Math.ceil(file.length / FILE_CHUNK_BYTES));
  for (let n = 0; n < count; n++) {
    const data = Buffer.from(file.subarray(n * FILE_CHUNK_BYTES, (n + 1) * FILE_CHUNK_BYTES))
      .toString("base64url")
      .replace(/=+$/u, "");
    out.push(
      n === count - 1
        ? { kind: "fileChunk", job, n, data, end: { chunks: count, sha256: toHex(sha256(file)) } }
        : { kind: "fileChunk", job, n, data },
    );
  }
  return out;
}

/** Sends a command now and runs a second on, returning its answer. */
async function ask(c: Controller, command: ParsedControlCommand) {
  const id = c.command(command);
  await c.runTo(c.now + SECOND);
  const reply = c.replies.get(id);
  expect(reply).toBeDefined();
  return reply;
}

function decisions(c: Controller, kind: string): number {
  return c.idles
    .flatMap((idle) => idle.records)
    .filter((r) => r.kind === "decision" && (r.row as { kind: string }).kind === kind).length;
}

/** The hub's critical events: the loop's deadline guard records one, which no run may raise. */
function critical(c: Controller): readonly unknown[] {
  return c.idles
    .flatMap((idle) => idle.records)
    .filter((r) => r.kind === "hubEvent" && (r.row as { level: string }).level === "critical");
}

function backupKeyText(): string {
  const key = seededKey(fromHex(SEED), "backup", BACKUP_FORMAT.keyBytes)._unsafeUnwrap();
  return Buffer.from(key).toString("base64url").replace(/=+$/u, "");
}

describe("the lockstep hub's file work", () => {
  test("an own build is uploaded in chunks and staged by firmware.upload", async () => {
    const data = folder("ls-stage");
    const c = await provision(new InProcessEnd(data));
    const image = espImage({ version: "1.4.0", size: 20_000 });
    for (const chunk of chunkCommands(7, image)) {
      const reply = await ask(c, chunk);
      expect(reply?.ok).toBe(true);
    }
    const staged = await ask(c, {
      kind: "op",
      op: "firmware.upload",
      body: { job: 7, own: { version: "1.4.0" }, confirmOwn: true },
    });
    expect(staged?.ok).toBe(true);
    if (staged?.ok !== true || staged.result.kind !== "op") return expect.unreachable("not staged");
    expect(staged.result.body).toMatchObject({ version: "1.4.0", kind: "ownBuild" });
    expect(decisions(c, "firmware_added")).toBe(1);
    // The payload is in the store, and the upload's file is gone with its job.
    expect(readdirSync(join(data, "firmware")).filter((n) => n.endsWith(".bin"))).toHaveLength(1);
    expect(readdirSync(join(data, "uploads"))).toEqual([]);
    // Without the confirmation the console asks for, refused (D35, D84).
    for (const chunk of chunkCommands(8, image)) await ask(c, chunk);
    const unconfirmed = await ask(c, {
      kind: "op",
      op: "firmware.upload",
      body: { job: 8, own: { version: "1.4.0" } },
    });
    expect(unconfirmed?.ok).toBe(false);
    expect(critical(c)).toEqual([]);
  });

  test("a backup under the seeded key is restored by benchRestore at the next start", async () => {
    const data = folder("ls-restore");
    const backups = folder("ls-backups");
    const end = new InProcessEnd(data);
    const c = await provision(end);
    expect(
      (await ask(c, { kind: "op", op: "backup.settings", body: { folder: backups } }))?.ok,
    ).toBe(true);
    expect((await ask(c, { kind: "op", op: "backup.now", body: {} }))?.ok).toBe(true);
    await c.runTo(c.now + 5 * SECOND);
    const files = readdirSync(backups).filter((n) => n.endsWith(".hsnb"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const file = join(backups, files.toSorted().at(-1) ?? "");

    // A wrong key, and a file that is not there: refused, and the hub goes on as it was.
    const wrong = Buffer.alloc(32, 1).toString("base64url").replace(/=+$/u, "");
    const refused = await ask(c, { kind: "benchRestore", file, key: wrong });
    expect(refused?.ok).toBe(false);
    const missing = await ask(c, {
      kind: "benchRestore",
      file: join(backups, "none.hsnb"),
      key: backupKeyText(),
    });
    expect(missing?.ok).toBe(false);
    expect(existsSync(join(data, "hub.db.restore"))).toBe(false);

    const restored = await ask(c, { kind: "benchRestore", file, key: backupKeyText() });
    expect(restored).toEqual({ ok: true, result: { kind: "benchRestore" } });
    expect(existsSync(join(data, "hub.db.restore"))).toBe(true);
    // The hub runs on its own database until the controller restarts it.
    expect(decisions(c, "restored")).toBe(0);
    const at = c.now + SECOND;
    await c.stop(at);
    await c.start(at + SECOND, wallAt(at + SECOND), true, SEED);
    await c.runTo(c.now + 10 * SECOND);
    expect(decisions(c, "restored")).toBe(1);
    expect(existsSync(join(data, "hub.db.restore"))).toBe(false);
    expect(existsSync(join(data, "hub.db.before-restore"))).toBe(true);
    // Every device is marked for its key change (D141): what it sends now is not acted on.
    const oldKey = c.idles
      .flatMap((idle) => idle.records)
      .filter((r) => r.kind === "rx" && (r.row as { oldKey?: boolean }).oldKey === true);
    expect(oldKey.length).toBeGreaterThan(0);
    expect(c.failure).toBeUndefined();
    expect(critical(c)).toEqual([]);
  });

  test("the core refuses benchRestore: no other socket takes it", () => {
    const driver = new Driver(makeCore(MODULES));
    driver.boot(snapshot());
    const reply = onlyReply(
      driver.input({
        kind: "command",
        request: requestId(1),
        conn: connId(2),
        actor: "someone",
        command: { kind: "benchRestore", file: "/tmp/b.hsnb", key: backupKeyText() },
      }),
    );
    expect(reply).toEqual({
      ok: false,
      error: {
        code: "badRequest",
        message: "benchRestore is the lockstep hub's alone (--bench-lockstep)",
      },
    });
  });
});

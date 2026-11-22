/**
 * A release fetched over the relay link, kept in the upload store (docs/m4-design.md section 6): an
 * upload of the relay link's own connection, written in order and hashed as it goes, finished only
 * when the whole is the offer's length and SHA-256, under the same cap as any upload, and deleted
 * when refused, released, or at the next start.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connId } from "../../../src/core/model/ids.ts";
import { UploadStore } from "../../../src/shell/app/uploads.ts";

const folders: string[] = [];
afterEach(() => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
});

/** Until `done`, at most 5 s: the store's removals are off the loop (`safe/off-loop.ts`). */
async function until(done: () => boolean): Promise<void> {
  const end = performance.now() + 5000;
  while (!done()) {
    expect(performance.now()).toBeLessThan(end);
    await Bun.sleep(5);
  }
}

function store(limits = { maxChunkBytes: 48 * 1024, maxUploadBytes: 1000 }): {
  store: UploadStore;
  folder: string;
} {
  const folder = mkdtempSync(join(tmpdir(), "hsn-fetched-"));
  folders.push(folder);
  const s = new UploadStore(folder, limits);
  expect(s.clearAll().isOk()).toBe(true);
  return { store: s, folder };
}

const sha = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const REF = { conn: connId(900), job: 4 };

describe("a fetched release in the upload store", () => {
  test("written in order, finished when it is the offer's length and hash, then released", async () => {
    const { store: s } = store();
    const file = s.beginFetch(REF)._unsafeUnwrap();
    const whole = Uint8Array.from({ length: 700 }, (_, i) => i % 251);
    expect((await file.append(whole.slice(0, 300))).isOk()).toBe(true);
    expect((await file.append(whole.slice(300))).isOk()).toBe(true);
    expect(file.bytes()).toBe(700);
    expect(s.finished(REF)).toBeUndefined();
    expect(await file.finish(700, sha(whole))).toBe(true);
    const done = s.finished(REF);
    expect(done?.bytes).toBe(700);
    expect(done?.sha256).toEqual(sha(whole));
    expect(new Uint8Array(readFileSync(done?.path ?? ""))).toEqual(whole);
    // Nothing more is written once finished.
    expect((await file.append(Uint8Array.of(1))).isErr()).toBe(true);
    s.release(REF);
    await until(() => !existsSync(done?.path ?? ""));
    expect(s.held).toBe(0);
  });

  test("a whole of the wrong hash, or the wrong length, is refused and deleted", async () => {
    const { store: s, folder } = store();
    const whole = Uint8Array.of(1, 2, 3);
    const wrong = sha(whole);
    wrong[31] = (wrong[31] ?? 0) ^ 1;
    const a = s.beginFetch(REF)._unsafeUnwrap();
    expect((await a.append(whole)).isOk()).toBe(true);
    expect(await a.finish(3, wrong)).toBe(false);
    expect(s.held).toBe(0);
    const b = s.beginFetch({ conn: REF.conn, job: 5 })._unsafeUnwrap();
    expect((await b.append(whole)).isOk()).toBe(true);
    expect(await b.finish(4, sha(whole))).toBe(false);
    expect(s.held).toBe(0);
    await until(() => readdirSync(join(folder, "uploads")).length === 0);
  });

  test("one per job, and never past the cap", async () => {
    const { store: s } = store();
    const file = s.beginFetch(REF)._unsafeUnwrap();
    expect(s.beginFetch(REF).isErr()).toBe(true);
    expect((await file.append(new Uint8Array(1000))).isOk()).toBe(true);
    expect((await file.append(new Uint8Array(1))).isErr()).toBe(true);
    expect(file.bytes()).toBe(1000);
    // Released, as a fetch always is when it ends: its file closed and removed.
    s.release(REF);
  });

  test("its connection closing, or the next start, deletes it", () => {
    const { store: s, folder } = store();
    s.beginFetch(REF)._unsafeUnwrap();
    s.beginFetch({ conn: connId(901), job: 1 })._unsafeUnwrap();
    s.closed(REF.conn);
    expect(s.held).toBe(1);
    expect(s.clearAll().isOk()).toBe(true);
    expect(readdirSync(join(folder, "uploads"))).toEqual([]);
  });
});

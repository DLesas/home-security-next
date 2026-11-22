/**
 * An upload's file calls off the hub's thread (`shell/app/uploads.ts`, design P): what only the
 * hub's driver does, beside the rules the same logic keeps at once (`uploads.test.ts`). A chunk's
 * answer comes once its file call has settled; a chunk sent before the last one's answer is
 * `busy` and never written; an upload voided while a call is in flight (its connection closed, its
 * job ended) has its file closed and removed when the call settles, and its sender answered
 * `unavailable`; a removal, when no call is in flight, is off the loop too.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { connId } from "../../../src/core/model/ids.ts";
import { UploadStore, UPLOADS_FOLDER } from "../../../src/shell/app/uploads.ts";

let data: string;
const A = connId(1);

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "hsn-upload-offloop-"));
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function file(length: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 251);
}

function store(): UploadStore {
  const made = new UploadStore(data, { maxChunkBytes: 10, maxUploadBytes: 40 });
  expect(made.clearAll().isOk()).toBe(true);
  return made;
}

/** The uploads folder's names, once its removals off the loop have settled (within 5 s). */
async function namesWhen(done: (names: readonly string[]) => boolean): Promise<readonly string[]> {
  const end = performance.now() + 5000;
  for (;;) {
    const names = readdirSync(join(data, UPLOADS_FOLDER));
    if (done(names)) return names;
    expect(performance.now()).toBeLessThan(end);
    await Bun.sleep(5);
  }
}

describe("an upload's file calls off the hub's thread", () => {
  test("each chunk answered once its write has settled; the last once the file is closed; the bytes whole", async () => {
    const s = store();
    const bytes = file(25);
    let answered = false;
    const first = s.chunk(A, { job: 1, n: 0, data: b64(bytes.subarray(0, 10)) }).then((o) => {
      answered = true;
      return o;
    });
    // Not answered in the same call: its file's create and write are off the loop.
    expect(answered).toBe(false);
    expect(await first).toEqual({ ok: true, done: false });
    expect(await s.chunk(A, { job: 1, n: 1, data: b64(bytes.subarray(10, 20)) })).toEqual({
      ok: true,
      done: false,
    });
    expect(
      await s.chunk(A, {
        job: 1,
        n: 2,
        data: b64(bytes.subarray(20)),
        end: { chunks: 3, sha256: hex(sha256(bytes)) },
      }),
    ).toEqual({ ok: true, done: true });
    expect(hex(readFileSync(s.finished({ conn: A, job: 1 })?.path ?? ""))).toBe(hex(bytes));
  });

  test("a chunk sent before the last one's answer: busy, never written; the upload goes on", async () => {
    const s = store();
    const bytes = file(20);
    const first = s.chunk(A, { job: 1, n: 0, data: b64(bytes.subarray(0, 10)) });
    // The client did not wait: refused at once, as the protocol answers an upload already being
    // received on this connection.
    expect(await s.chunk(A, { job: 1, n: 1, data: b64(bytes.subarray(10)) })).toEqual({
      ok: false,
      error: { code: "busy", detail: { because: "upload" } },
    });
    expect(await first).toEqual({ ok: true, done: false });
    expect(
      await s.chunk(A, {
        job: 1,
        n: 1,
        data: b64(bytes.subarray(10)),
        end: { chunks: 2, sha256: hex(sha256(bytes)) },
      }),
    ).toEqual({ ok: true, done: true });
    // Only the two chunks the store took are in the file.
    expect(hex(readFileSync(s.finished({ conn: A, job: 1 })?.path ?? ""))).toBe(hex(bytes));
  });

  test("its connection closing while a call is in flight: answered unavailable, the file closed and removed when the call settles", async () => {
    const s = store();
    const pending = s.chunk(A, { job: 1, n: 0, data: b64(file(10)) });
    s.closed(A);
    expect(s.held).toBe(0);
    expect(await pending).toEqual({ ok: false, error: { code: "unavailable", detail: {} } });
    expect(await namesWhen((names) => names.length === 0)).toEqual([]);
  });

  test("its job ending while the last chunk is being closed: the finished file never kept", async () => {
    const s = store();
    const bytes = file(10);
    const last = s.chunk(A, {
      job: 1,
      n: 0,
      data: b64(bytes),
      end: { chunks: 1, sha256: hex(sha256(bytes)) },
    });
    s.release({ conn: A, job: 1 });
    expect(await last).toEqual({ ok: false, error: { code: "unavailable", detail: {} } });
    expect(s.finished({ conn: A, job: 1 })).toBeUndefined();
    expect(await namesWhen((names) => names.length === 0)).toEqual([]);
  });

  test("a finished upload released: its file removed off the loop", async () => {
    const s = store();
    const bytes = file(10);
    await s.chunk(A, {
      job: 1,
      n: 0,
      data: b64(bytes),
      end: { chunks: 1, sha256: hex(sha256(bytes)) },
    });
    const path = s.finished({ conn: A, job: 1 })?.path ?? "";
    expect(existsSync(path)).toBe(true);
    s.release({ conn: A, job: 1 });
    expect(await namesWhen((names) => names.length === 0)).toEqual([]);
  });
});

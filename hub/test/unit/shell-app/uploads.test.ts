/**
 * File chunks (m2-design.md section 6): uploads kept per connection as `UploadRef {conn, job}` in
 * the data folder's `uploads/`, chunks numbered from 0 with no gap, at most 48 KB ‡ each and
 * 256 MB ‡ in all, ending with the SHA-256 of the whole, one upload at a time per connection, a
 * repeated chunk changing nothing; deleted when the job ends, when the connection closes and at
 * every start. Also an upload over a real console session, and the control socket's answer.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { connId } from "../../../src/core/model/ids.ts";
import { ClientKind } from "../../../src/core/model/rows.ts";
import { controlChunkReply, UploadStore, UPLOADS_FOLDER } from "../../../src/shell/app/uploads.ts";
import { expectNoKeyLeaks } from "../setup/support/leak-guard.ts";
import { clientRow, openHub, session, staticKey, stopHubs } from "./support.ts";

let data: string;
const A = connId(1);
const B = connId(2);

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "hsn-a2-up-"));
});

afterEach(() => {
  stopHubs();
  rmSync(data, { recursive: true, force: true });
});

afterAll(() => {
  expectNoKeyLeaks();
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function file(length: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 251);
}

/**
 * A store whose file calls are made at once (`onThread`, the lockstep hub's driver), so the rules
 * are tested a call at a time: the same logic the hub runs off its thread (`uploads.ts`,
 * `#chunkLogic`), whose own behaviour is `upload-offloop.test.ts`'s.
 */
function store(limits = { maxChunkBytes: 10, maxUploadBytes: 40 }, onThread = true): UploadStore {
  const made = new UploadStore(data, limits, { onThread });
  expect(made.clearAll().isOk()).toBe(true);
  return made;
}

function upload(s: UploadStore, conn: typeof A, job: number, bytes: Uint8Array, size = 10) {
  const outcomes = [];
  const chunks = Math.max(1, Math.ceil(bytes.length / size));
  for (let n = 0; n < chunks; n++) {
    const part = bytes.subarray(n * size, (n + 1) * size);
    outcomes.push(
      s.chunkNow(conn, {
        job,
        n,
        data: b64(part),
        ...(n === chunks - 1 ? { end: { chunks, sha256: hex(sha256(bytes)) } } : {}),
      }),
    );
  }
  return outcomes;
}

describe("an upload", () => {
  test("is kept as its bytes, under UploadRef {conn, job}, once the last chunk's hash matches", () => {
    const s = store();
    const bytes = file(35);
    const outcomes = upload(s, A, 7, bytes);
    expect(outcomes.map((o) => o.ok && o.done)).toEqual([false, false, false, true]);
    const done = s.finished({ conn: A, job: 7 });
    expect(done?.bytes).toBe(35);
    expect(hex(readFileSync(done?.path ?? ""))).toBe(hex(bytes));
    expect(s.finished({ conn: B, job: 7 })).toBeUndefined();
  });

  test("a gap is refused; a chunk sent again with the same bytes changes nothing; with others, refused", () => {
    const s = store();
    const bytes = file(30);
    expect(s.chunkNow(A, { job: 1, n: 1, data: b64(bytes.subarray(0, 10)) })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "n", reason: "range" } },
    });
    expect(s.chunkNow(A, { job: 1, n: 0, data: b64(bytes.subarray(0, 10)) }).ok).toBe(true);
    expect(s.chunkNow(A, { job: 1, n: 0, data: b64(bytes.subarray(0, 10)) })).toEqual({
      ok: true,
      done: false,
    });
    expect(s.chunkNow(A, { job: 1, n: 0, data: b64(bytes.subarray(10, 20)) }).ok).toBe(false);
    expect(s.chunkNow(A, { job: 1, n: 2, data: b64(bytes.subarray(20, 30)) }).ok).toBe(false);
    expect(s.chunkNow(A, { job: 1, n: 1, data: b64(bytes.subarray(10, 20)) }).ok).toBe(true);
    expect(
      s.chunkNow(A, {
        job: 1,
        n: 2,
        data: b64(bytes.subarray(20, 30)),
        end: { chunks: 3, sha256: hex(sha256(bytes)) },
      }),
    ).toEqual({ ok: true, done: true });
    expect(hex(readFileSync(s.finished({ conn: A, job: 1 })?.path ?? ""))).toBe(hex(bytes));
  });

  test("a wrong total or a wrong hash voids it", () => {
    const s = store();
    const bytes = file(20);
    s.chunkNow(A, { job: 1, n: 0, data: b64(bytes.subarray(0, 10)) });
    expect(
      s.chunkNow(A, {
        job: 1,
        n: 1,
        data: b64(bytes.subarray(10)),
        end: { chunks: 3, sha256: hex(sha256(bytes)) },
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "end.chunks", reason: "range" } },
    });
    expect(s.held).toBe(0);
    s.chunkNow(A, { job: 2, n: 0, data: b64(bytes.subarray(0, 10)) });
    expect(
      s.chunkNow(A, {
        job: 2,
        n: 1,
        data: b64(bytes.subarray(10)),
        end: { chunks: 2, sha256: hex(sha256(file(20, 9))) },
      }).ok,
    ).toBe(false);
    expect(s.finished({ conn: A, job: 2 })).toBeUndefined();
    expect(readdirSync(join(data, UPLOADS_FOLDER))).toEqual([]);
  });

  test("a chunk over 48 KB ‡ or a whole over 256 MB ‡ is refused, before it is written", () => {
    const s = store();
    expect(s.chunkNow(A, { job: 1, n: 0, data: b64(file(11)) })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "data", reason: "range" } },
    });
    expect(readdirSync(join(data, UPLOADS_FOLDER))).toEqual([]);
    for (let n = 0; n < 4; n++)
      expect(s.chunkNow(A, { job: 2, n, data: b64(file(10)) }).ok).toBe(true);
    expect(s.chunkNow(A, { job: 2, n: 4, data: b64(file(1)) })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "data", reason: "range" } },
    });
    expect(readdirSync(join(data, UPLOADS_FOLDER))).toEqual([]);
  });

  test("data that is not base64url without padding is refused", () => {
    const s = store();
    for (const text of ["AAA=", "A", "AB+/"]) {
      expect(s.chunkNow(A, { job: 1, n: 0, data: text }).ok).toBe(false);
    }
  });

  test("one at a time per connection; other connections are independent", () => {
    const s = store();
    expect(s.chunkNow(A, { job: 1, n: 0, data: b64(file(10)) }).ok).toBe(true);
    expect(s.chunkNow(A, { job: 2, n: 0, data: b64(file(10)) })).toEqual({
      ok: false,
      error: { code: "busy", detail: { because: "upload" } },
    });
    expect(s.chunkNow(B, { job: 2, n: 0, data: b64(file(10)) }).ok).toBe(true);
  });

  test("a finished job's number is not used again on its connection", () => {
    const s = store();
    upload(s, A, 1, file(10));
    expect(s.chunkNow(A, { job: 1, n: 0, data: b64(file(10, 4)) })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "job", reason: "taken" } },
    });
  });

  test("is deleted when its job ends, when its connection closes, and at every start", () => {
    const s = store();
    upload(s, A, 1, file(10));
    const path = s.finished({ conn: A, job: 1 })?.path ?? "";
    s.release({ conn: A, job: 1 });
    expect(existsSync(path)).toBe(false);
    upload(s, B, 1, file(10));
    s.chunkNow(B, { job: 2, n: 0, data: b64(file(10)) });
    s.closed(B);
    expect(readdirSync(join(data, UPLOADS_FOLDER))).toEqual([]);
    writeFileSync(join(data, UPLOADS_FOLDER, "left-from-before"), "x");
    expect(new UploadStore(data).clearAll().isOk()).toBe(true);
    expect(readdirSync(join(data, UPLOADS_FOLDER))).toEqual([]);
  });

  test("the control socket's answer to a chunk", () => {
    expect(controlChunkReply({ ok: true, done: false })).toEqual({
      ok: true,
      result: { kind: "fileChunk" },
    });
    const refused = controlChunkReply({
      ok: false,
      error: { code: "busy", detail: { because: "upload" } },
    });
    expect(refused.ok ? undefined : refused.error.app).toEqual({
      code: "busy",
      detail: { because: "upload" },
    });
  });
});

describe("an upload over a console session", () => {
  test("its chunks are answered by the shell, never reach the core, and go when the session closes", async () => {
    const key = staticKey(30);
    // Off the loop, as the hub's: the session's chunks answered once their file calls settle.
    const uploads = store({ maxChunkBytes: 48_000, maxUploadBytes: 1_000_000 }, false);
    const side = openHub({
      clients: [clientRow(9, key.key.publicKey, ClientKind.Console)],
      uploads,
    });
    const { ws, ik } = await session(side, key.key, "console");
    const bytes = file(70_000);
    const chunks = [bytes.subarray(0, 48_000), bytes.subarray(48_000)];
    // As the app sends them (`app/src/hub/files.ts`, `sendFile`): each after the last's answer.
    ws.send(
      ik.seal({
        t: "req",
        id: 2,
        op: "fileChunk",
        body: { job: 3, n: 0, data: b64(chunks[0] ?? new Uint8Array(0)) },
      }),
    );
    expect(ik.open((await ws.next()) ?? new Uint8Array(0))).toEqual({
      t: "res",
      id: 2,
      ok: true,
      body: {},
    });
    ws.send(
      ik.seal({
        t: "req",
        id: 3,
        op: "fileChunk",
        body: {
          job: 3,
          n: 1,
          data: b64(chunks[1] ?? new Uint8Array(0)),
          end: { chunks: 2, sha256: hex(sha256(bytes)) },
        },
      }),
    );
    expect(ik.open((await ws.next()) ?? new Uint8Array(0))).toEqual({
      t: "res",
      id: 3,
      ok: true,
      body: {},
    });
    const conn = (await side.waitFor("clientConnected")).conn;
    expect(uploads.finished({ conn, job: 3 })?.bytes).toBe(70_000);
    expect(side.of("clientRequest").map((e) => e.request.op.op)).toEqual([]);
    ws.close();
    await side.waitFor("clientClosed");
    expect(uploads.held).toBe(0);
  });
});

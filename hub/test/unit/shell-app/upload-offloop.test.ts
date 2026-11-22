/**
 * An upload's file calls off the hub's thread (`shell/app/uploads.ts`, design P): what only the
 * hub's driver does, beside the rules the same logic keeps at once (`uploads.test.ts`). A chunk's
 * answer comes once its file call has settled; a chunk sent before the last one's answer is
 * `busy` and never written; an upload voided while a call is in flight (its connection closed, its
 * job ended) has its file closed and removed when the call settles, and its sender answered
 * `unavailable`; a removal, when no call is in flight, is off the loop too.
 *
 * With a stand-in for the calls off the loop (the store's `calls`), each call is held or made to
 * fail on purpose: a chunk during the last one's write is `busy`; a void during each of the open,
 * the write and the close makes no call after it and leaves no file; a failed open, write or close
 * voids the upload; a fetch's append while one is in flight is refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { connId } from "../../../src/core/model/ids.ts";
import { err } from "neverthrow";
import {
  type CallResult,
  type FileCall,
  offLoopFileCall,
  UploadStore,
  UPLOADS_FOLDER,
} from "../../../src/shell/app/uploads.ts";

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

type Kind = FileCall["kind"];

const LIMITS = { maxChunkBytes: 10, maxUploadBytes: 40 };
const UNAVAILABLE = { ok: false, error: { code: "unavailable", detail: {} } } as const;

/**
 * A store whose file calls off the loop go through a stand-in: each the real call, recorded; the
 * `hold`'s call (its kind's nth) waits, after it is made, until `release()`; the `fail`'s kind
 * answers an error (an open or a write without being made, a close after it is).
 */
function rigged(
  options: { readonly hold?: { kind: Kind; nth: number }; readonly fail?: Kind } = {},
) {
  const calls: Kind[] = [];
  const seen: Record<Kind, number> = { open: 0, write: 0, close: 0 };
  const reached = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const failure = (): CallResult => err("a stand-in's failure");
  const made = new UploadStore(data, LIMITS, {
    calls: async (call) => {
      calls.push(call.kind);
      seen[call.kind] += 1;
      if (options.fail === call.kind && call.kind !== "close") return failure();
      const done = await offLoopFileCall(call);
      if (options.hold?.kind === call.kind && options.hold.nth === seen[call.kind]) {
        reached.resolve(undefined);
        await released.promise;
      }
      return options.fail === call.kind ? failure() : done;
    },
  });
  expect(made.clearAll().isOk()).toBe(true);
  return {
    store: made,
    calls,
    reached: reached.promise,
    release: () => {
      released.resolve(undefined);
    },
  };
}

/** One chunk of `bytes`, the whole upload, its end mark on it when `last`. */
function only(bytes: Uint8Array, last: boolean) {
  return {
    job: 1,
    n: 0,
    data: b64(bytes),
    ...(last ? { end: { chunks: 1, sha256: hex(sha256(bytes)) } } : {}),
  };
}

describe("each file call held, or failing, through a stand-in for the calls off the loop", () => {
  test("a chunk sent during the last one's write: busy, never written; the upload goes on", async () => {
    const r = rigged({ hold: { kind: "write", nth: 2 } });
    const bytes = file(30);
    expect(await r.store.chunk(A, { job: 1, n: 0, data: b64(bytes.subarray(0, 10)) })).toEqual({
      ok: true,
      done: false,
    });
    const second = r.store.chunk(A, { job: 1, n: 1, data: b64(bytes.subarray(10, 20)) });
    await r.reached;
    // Its write in flight: the same chunk number sent again, with other bytes, before its answer.
    expect(await r.store.chunk(A, { job: 1, n: 1, data: b64(file(10, 9)) })).toEqual({
      ok: false,
      error: { code: "busy", detail: { because: "upload" } },
    });
    expect(r.calls).toEqual(["open", "write", "write"]);
    r.release();
    expect(await second).toEqual({ ok: true, done: false });
    expect(
      await r.store.chunk(A, {
        job: 1,
        n: 2,
        data: b64(bytes.subarray(20)),
        end: { chunks: 3, sha256: hex(sha256(bytes)) },
      }),
    ).toEqual({ ok: true, done: true });
    expect(hex(readFileSync(r.store.finished({ conn: A, job: 1 })?.path ?? ""))).toBe(hex(bytes));
  });

  const ENDS = [
    [
      "its connection closing",
      (s: UploadStore) => {
        s.closed(A);
      },
    ],
    [
      "its job ending",
      (s: UploadStore) => {
        s.release({ conn: A, job: 1 });
      },
    ],
  ] as const;
  // Each call, and the calls made up to it: nothing after it once the upload is voided.
  const HELD = [
    ["open", false, ["open"]],
    ["write", false, ["open", "write"]],
    ["close", true, ["open", "write", "close"]],
  ] as const;
  const VOIDS = HELD.flatMap(([kind, last, calls]) =>
    ENDS.map(([why, end]) => [why, kind, last, calls, end] as const),
  );

  test.each(VOIDS)(
    "%s during its %s: answered unavailable, no file call after it, no file left",
    async (_why, kind, last, calls, end) => {
      const r = rigged({ hold: { kind, nth: 1 } });
      const answer = r.store.chunk(A, only(file(10), last));
      await r.reached;
      end(r.store);
      expect(r.store.held).toBe(0);
      r.release();
      expect(await answer).toEqual(UNAVAILABLE);
      expect(r.calls).toEqual([...calls]);
      expect(r.store.finished({ conn: A, job: 1 })).toBeUndefined();
      expect(await namesWhen((names) => names.length === 0)).toEqual([]);
    },
  );

  test.each([
    ["open", ["open"]],
    ["write", ["open", "write"]],
    ["close", ["open", "write", "close"]],
  ] as const)(
    "a failed %s: the upload voided, answered unavailable, no file left",
    async (kind, calls) => {
      const r = rigged({ fail: kind });
      expect(await r.store.chunk(A, only(file(10), true))).toEqual(UNAVAILABLE);
      expect(r.calls).toEqual([...calls]);
      expect(r.store.held).toBe(0);
      expect(r.store.finished({ conn: A, job: 1 })).toBeUndefined();
      expect(await namesWhen((names) => names.length === 0)).toEqual([]);
    },
  );

  test("a fetch's append while one is in flight: refused, never written", async () => {
    const r = rigged({ hold: { kind: "write", nth: 1 } });
    const fetched = r.store.beginFetch({ conn: A, job: 9 })._unsafeUnwrap();
    const first = file(10, 1);
    const pending = fetched.append(first);
    await r.reached;
    expect((await fetched.append(file(10, 2))).isErr()).toBe(true);
    r.release();
    expect((await pending).isOk()).toBe(true);
    expect(await fetched.finish(10, sha256(first))).toBe(true);
    expect(r.calls).toEqual(["open", "write", "close"]);
    expect(hex(readFileSync(r.store.finished({ conn: A, job: 9 })?.path ?? ""))).toBe(hex(first));
  });
});

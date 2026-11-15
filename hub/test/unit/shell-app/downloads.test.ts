/**
 * Downloads on a session (m2-design.md section 6, the wave 2 ruling): the reply `{job}` first,
 * then the chunks in order, closed by the end mark or `fileFailed {job, reason}`, every one through
 * the session's one send queue; another event between two chunks is told apart by `ev`, `job` and
 * `n`; `fileFailed {stopping}` when the hub stops part way; and a session that closes part way
 * ends the job, so its file is freed.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { clientId, type ConnId } from "../../../src/core/model/ids.ts";
import { expectNoKeyLeaks } from "../setup/support/leak-guard.ts";
import { clientRow, openHub, session, sleep, staticKey, stopHubs } from "./support.ts";

afterEach(() => {
  stopHubs();
});

afterAll(() => {
  expectNoKeyLeaks();
});

const anna = staticKey(60);
const chunk = (job: number, n: number, end = false) => ({
  job,
  n,
  data: "AAEC",
  ...(end ? { end: { chunks: n + 1, sha256: "0".repeat(64) } } : {}),
});

async function exporting(downloadEnded?: (conn: ConnId, job: number) => void) {
  const side = openHub({
    clients: [clientRow(7, anna.key.publicKey)],
    ...(downloadEnded === undefined ? {} : { downloadEnded }),
  });
  const { ws, ik } = await session(side, anna.key);
  const conn = (await side.waitFor("clientConnected", (e) => e.client === clientId(7))).conn;
  return { side, ws, ik, conn };
}

describe("an export's download", () => {
  test("the reply {job}, then the chunks in order, then the end mark, through one queue", async () => {
    const { side, ws, ik, conn } = await exporting();
    side.channel.perform({
      kind: "appSend",
      conn,
      message: { t: "res", id: 5, ok: true, body: { job: 3 } },
    });
    for (let n = 0; n < 50; n++) {
      expect(side.channel.download(conn, { fileChunk: chunk(3, n, n === 49) }).isOk()).toBe(true);
      // Something else of the hub's between two chunks.
      if (n === 10)
        side.channel.perform({
          kind: "appSend",
          conn,
          message: { t: "evt", rev: 42, ev: "ping", body: {} },
        });
    }
    const got: Record<string, unknown>[] = [];
    for (let i = 0; i < 52; i++)
      got.push(ik.open((await ws.next()) ?? new Uint8Array(0)) as Record<string, unknown>);
    expect(got[0]).toEqual({ t: "res", id: 5, ok: true, body: { job: 3 } });
    // The client keeps what is the download's by `ev` and `job`; `n` follows on, with no gap.
    const mine = got
      .filter((m) => m.ev === "fileChunk")
      .map((m) => m.body as { job: number; n: number });
    expect(mine.map((b) => b.job)).toEqual(new Array<number>(50).fill(3));
    expect(mine.map((b) => b.n)).toEqual(Array.from({ length: 50 }, (_, n) => n));
    expect(got.filter((m) => m.ev === "ping")).toHaveLength(1);
    expect((got.at(-1)?.body as { end?: unknown }).end).toBeDefined();
  });

  test("a failed export ends with fileFailed io where its chunks were going", async () => {
    const { side, ws, ik, conn } = await exporting();
    side.channel.perform({
      kind: "appSend",
      conn,
      message: { t: "res", id: 5, ok: true, body: { job: 4 } },
    });
    expect(side.channel.download(conn, { fileChunk: chunk(4, 0) }).isOk()).toBe(true);
    expect(side.channel.download(conn, { fileFailed: { job: 4, reason: "io" } }).isOk()).toBe(true);
    const got = [];
    for (let i = 0; i < 3; i++) got.push(ik.open((await ws.next()) ?? new Uint8Array(0)));
    expect(got.map((m) => (m as { ev?: string; t: string }).ev ?? (m as { t: string }).t)).toEqual([
      "res",
      "fileChunk",
      "fileFailed",
    ]);
    expect(got[2]).toEqual({ t: "evt", rev: 41, ev: "fileFailed", body: { job: 4, reason: "io" } });
  });

  test("the hub stopping part way: fileFailed stopping, then the close, and the job ends", async () => {
    const ended: [ConnId, number][] = [];
    const { side, ws, ik, conn } = await exporting((c, job) => ended.push([c, job]));
    expect(side.channel.download(conn, { fileChunk: chunk(6, 0) }).isOk()).toBe(true);
    side.channel.stop();
    const first = ik.open((await ws.next()) ?? new Uint8Array(0));
    const second = ik.open((await ws.next()) ?? new Uint8Array(0));
    expect(first).toMatchObject({ ev: "fileChunk" });
    expect(second).toEqual({
      t: "evt",
      rev: 41,
      ev: "fileFailed",
      body: { job: 6, reason: "stopping" },
    });
    expect((await ws.waitClosed())?.code).toBe(1001);
    expect(ended).toEqual([[conn, 6]]);
  });

  test("a session that closes part way ends the job, and the next line is refused", async () => {
    const ended: [ConnId, number][] = [];
    const { side, ws, conn } = await exporting((c, job) => ended.push([c, job]));
    expect(side.channel.download(conn, { fileChunk: chunk(8, 0) }).isOk()).toBe(true);
    ws.close();
    await side.waitFor("clientClosed");
    expect(ended).toEqual([[conn, 8]]);
    expect(side.channel.download(conn, { fileChunk: chunk(8, 1) }).isErr()).toBe(true);
  });

  test("a download that ended (end mark or fileFailed) is not ended again at the close", async () => {
    const ended: [ConnId, number][] = [];
    const { side, ws, conn } = await exporting((c, job) => ended.push([c, job]));
    expect(side.channel.download(conn, { fileChunk: chunk(9, 0, true) }).isOk()).toBe(true);
    expect(side.channel.download(conn, { fileChunk: chunk(10, 0) }).isOk()).toBe(true);
    expect(side.channel.download(conn, { fileFailed: { job: 10, reason: "io" } }).isOk()).toBe(
      true,
    );
    await sleep(20);
    ws.close();
    await side.waitFor("clientClosed");
    expect(ended).toEqual([]);
  });
});

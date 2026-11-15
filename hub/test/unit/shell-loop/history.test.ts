/**
 * `history.query`'s page, the shell's half (m2-design.md sections 6 and 7), on the real store: the
 * rows the audit tables hold and the writer's staged ones, newest first by `seq`, filtered by what
 * `app` let the person see, cut at the limit with `next`; a read that fails answers `unavailable`;
 * and a page never commits anything of its own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { err } from "neverthrow";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import type { HistoryFilter } from "../../../src/core/model/effects.ts";
import { deviceId, personId } from "../../../src/core/model/ids.ts";
import { historyReply, type HistorySource } from "../../../src/shell/history-page.ts";
import type { OpenedStore } from "../../../src/shell/storage/store.ts";
import {
  hubEventRecord,
  openTestStore,
  record,
  rxRecord,
  seqOf,
  tempDir,
  TestClock,
  WALL_AT_START_MS,
} from "../storage/fixtures.ts";

let dir: ReturnType<typeof tempDir>;
let store: OpenedStore;

const EVERYTHING: HistoryFilter = { devices: "all", person: null, clients: [], hub: true };
/** A person who may view device 3 only, without manage system. */
const VIEWS_3: HistoryFilter = {
  devices: [deviceId(3)],
  person: personId(2),
  clients: [],
  hub: false,
};

function source(): HistorySource {
  return {
    rows: (page) => store.reader.historyRows(page),
    staged: () => store.writer.stagedRecords(),
  };
}

const at = (n: number) => WALL_AT_START_MS + n * 1000;

beforeEach(() => {
  dir = tempDir("history");
  store = openTestStore(dir.path, new TestClock());
  // Committed: device 3 at 1 and 4, device 4 at 2, a hub event at 3.
  store.writer.stage([
    record("now", rxRecord(seqOf(1, 1), 3, at(1), "event")),
    record("now", rxRecord(seqOf(1, 2), 4, at(2))),
    record("now", hubEventRecord(seqOf(1, 3), at(3), "warning")),
    record("now", rxRecord(seqOf(1, 4), 3, at(4))),
  ]);
  store.writer.flush("now")._unsafeUnwrap();
  // Staged, not committed: device 3 at 5.
  store.writer.stage([record("routine", rxRecord(seqOf(1, 5), 3, at(5)))]);
});
afterEach(() => {
  store.db.close();
  dir.remove();
});

function seqs(message: ReturnType<typeof historyReply>["message"]): readonly number[] {
  if (!("ok" in message) || !message.ok) return [];
  const body = message.body as { rows: { row: { row: { seq: number } } }[] };
  return body.rows.map((r) => r.row.row.seq - seqOf(1, 0));
}

describe("a history page (sections 6 and 7)", () => {
  test("the committed rows and the staged ones, newest first by seq, as hsn log --json writes them", () => {
    const reply = historyReply(source(), { id: 4, query: { limit: 50 }, allowed: EVERYTHING });
    expect(reply.error).toBeUndefined();
    expect(reply.message).toMatchObject({ t: "res", id: 4, ok: true });
    expect(seqs(reply.message)).toEqual([5, 4, 3, 2, 1]);
  });

  test("filtered by what the person may see: their device's rows, and no hub row without manage system", () => {
    const reply = historyReply(source(), { id: 1, query: { limit: 50 }, allowed: VIEWS_3 });
    expect(seqs(reply.message)).toEqual([5, 4, 1]);
    const withHub = historyReply(source(), {
      id: 2,
      query: { limit: 50 },
      allowed: { ...VIEWS_3, hub: true },
    });
    expect(seqs(withHub.message)).toEqual([5, 4, 3, 1]);
  });

  test("the query's own filters: kinds, devices, a time range", () => {
    const kinds = historyReply(source(), {
      id: 1,
      query: { limit: 50, kinds: ["hubEvent"] },
      allowed: EVERYTHING,
    });
    expect(seqs(kinds.message)).toEqual([3]);
    const device = historyReply(source(), {
      id: 2,
      query: { limit: 50, devices: [deviceId(4)] },
      allowed: EVERYTHING,
    });
    expect(seqs(device.message)).toEqual([2]);
    const range = historyReply(source(), {
      id: 3,
      query: { limit: 50, since: at(2), until: at(4) },
      allowed: EVERYTHING,
    });
    expect(seqs(range.message)).toEqual([4, 3, 2]);
  });

  test("cut at the limit, with next; the page after it from before", () => {
    const first = historyReply(source(), { id: 1, query: { limit: 2 }, allowed: EVERYTHING });
    expect(seqs(first.message)).toEqual([5, 4]);
    const next =
      "ok" in first.message && first.message.ok
        ? (first.message.body as { next?: number }).next
        : undefined;
    expect(next).toBe(seqOf(1, 4));
    const second = historyReply(source(), {
      id: 2,
      query: { limit: 2, before: next },
      allowed: EVERYTHING,
    });
    expect(seqs(second.message)).toEqual([3, 2]);
  });

  test("a page commits nothing: the staged record stays staged", () => {
    const commits = store.writer.stats.commits;
    const staged = store.writer.staged;
    historyReply(source(), { id: 1, query: { limit: 50 }, allowed: EVERYTHING });
    expect(store.writer.stats.commits).toBe(commits);
    expect(store.writer.staged).toBe(staged);
  });

  test("a read that fails is answered unavailable, on the request's id", () => {
    const failing: HistorySource = {
      rows: () => err({ kind: "storage", origin: "test", message: "disk I/O error" }),
      staged: (): readonly AuditRecord[] => [],
    };
    const reply = historyReply(failing, { id: 7, query: { limit: 10 }, allowed: EVERYTHING });
    expect(reply.message).toEqual({
      t: "res",
      id: 7,
      ok: false,
      error: { code: "unavailable", detail: {} },
    });
    expect(reply.error?.message).toBe("disk I/O error");
  });
});

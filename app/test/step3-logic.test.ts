/**
 * The rules behind step 3's screens (m2-design.md sections 6, 7 and 9): a schedule entry's body;
 * days in Monday-first order; manage includes view; who a removal takes with it; settings typed
 * as numbers; history rows and notifications in words; files in chunks, refused on a gap or a
 * wrong hash; a download's chunks kept from before its reply.
 */
import { describe, expect, test } from "bun:test";
import "./support/render";
import {
  FILE_CHUNKS,
  type AppEvent,
  type AppOpBody,
  type ClientObject,
  type HistoryRow,
} from "@hsn/protocol/app";
import { HubEnd } from "./support/hub-end";
import { manualTimers, settle } from "./support/timers";
import { createHubClient } from "../src/hub/client";
import { downloadFile, fromBase64url, receiveFile, sendFile, toBase64url } from "../src/hub/files";
import { sha256, toHex } from "../src/hub/digest";
import { memoryRecordStore } from "../src/platform/client-key";

const { NEW_SCHEDULE, daysWords, scheduleFields } = await import("../src/ui/schedules");
const { grant, hasNoAccess } = await import("../src/ui/people");
const { linkedBy, LINKED_WITHIN_MS } = await import("../src/ui/clients");
const { numberOrKeep } = await import("../src/ui/device-detail");
const { rowWords } = await import("../src/ui/history");
const { notificationWords } = await import("../src/ui/notifications");
const { i18n, startI18n } = await import("../src/i18n");
if (!i18n.isInitialized) await startI18n();
const t = i18n.t.bind(i18n);

describe("a schedule entry", () => {
  const base = { ...NEW_SCHEDULE, name: " Night ", target: 3, at: "22:30" };
  test("its body: the name trimmed, a mode for a switch, every day", () => {
    expect(scheduleFields(base)).toEqual({
      ok: true,
      fields: {
        name: "Night",
        action: "switchMode",
        target: { mode: 3 },
        at: "22:30",
        days: "everyDay",
        enabled: true,
      },
    });
  });
  test("a group or a sensor for arm and disarm; weekdays; a date", () => {
    expect(
      scheduleFields({
        ...base,
        action: "arm",
        targetKind: "group",
        daysKind: "weekdays",
        weekdays: ["fri", "mon"],
      }),
    ).toEqual({
      ok: true,
      fields: {
        name: "Night",
        action: "arm",
        target: { group: 3 },
        at: "22:30",
        days: ["fri", "mon"],
        enabled: true,
      },
    });
    const once = scheduleFields({
      ...base,
      action: "disarm",
      targetKind: "sensor",
      daysKind: "date",
      date: "2026-12-24",
    });
    expect(once.ok && once.fields.target).toEqual({ sensor: 3 });
    expect(once.ok && once.fields.days).toEqual({ date: "2026-12-24" });
  });
  test("what is not right yet is named", () => {
    expect(scheduleFields({ ...base, name: "  " })).toEqual({ ok: false, field: "name" });
    expect(scheduleFields({ ...base, target: undefined })).toEqual({ ok: false, field: "target" });
    expect(scheduleFields({ ...base, at: "24:00" })).toEqual({ ok: false, field: "at" });
    expect(scheduleFields({ ...base, daysKind: "weekdays", weekdays: [] })).toEqual({
      ok: false,
      field: "days",
    });
    expect(scheduleFields({ ...base, daysKind: "date", date: "24/12/2026" })).toEqual({
      ok: false,
      field: "days",
    });
  });
  test("days read Monday first, whatever order the hub kept", () => {
    expect(daysWords(t, "en", ["sun", "mon", "wed"])).toBe("on Monday, Wednesday, and Sunday");
    expect(daysWords(t, "en", "everyDay")).toBe("Every day");
    expect(daysWords(t, "en", { date: "2026-12-24" })).toBe("once on December 24, 2026");
  });
});

describe("people and devices", () => {
  const none = { devices: [], manageUsers: false, manageSystem: false };
  test("manage includes view; taking view away takes manage", () => {
    const managed = grant(none, 4, { manage: true });
    expect(managed.devices).toEqual([{ device: 4, manage: true, view: true }]);
    expect(grant(managed, 4, { view: false }).devices).toEqual([
      { device: 4, manage: false, view: false },
    ]);
    expect(grant(managed, 4, { manage: false }).devices).toEqual([
      { device: 4, manage: false, view: true },
    ]);
  });
  test("a person with no permission at all has no access yet", () => {
    const person = { id: 1, name: "Ben", revision: 0, ...none };
    expect(hasNoAccess(person)).toBe(true);
    expect(hasNoAccess({ ...person, devices: [{ device: 4, manage: false, view: true }] })).toBe(
      false,
    );
  });
  test("a removal lists the devices this one linked in the last 30 days only", () => {
    const now = 100 * LINKED_WITHIN_MS;
    const c = (id: number, linkedByClient: number | null, ageMs: number): ClientObject => ({
      id,
      person: 1,
      kind: "web",
      name: `c${String(id)}`,
      createdMs: now - ageMs,
      lastSeenMs: null,
      linkedBy: linkedByClient,
    });
    const all = [c(1, null, 0), c(2, 1, 1000), c(3, 1, LINKED_WITHIN_MS + 1), c(4, 2, 1000)];
    expect(linkedBy(all, 1, now).map((x) => x.id)).toEqual([2]);
  });
  test("settings typed as numbers: empty keeps, learn where allowed, anything else refused", () => {
    expect(numberOrKeep("")).toBeUndefined();
    expect(numberOrKeep(" 12 ")).toBe(12);
    expect(numberOrKeep("-9")).toBe(-9);
    expect(numberOrKeep("learn")).toBeNull();
    expect(numberOrKeep("learn", true)).toBe("learn");
    expect(numberOrKeep("1.5")).toBeNull();
  });
});

describe("in words", () => {
  const devices = { devices: { 4: { id: 4, name: "front-door" } } } as never;
  const stamp = { seq: 1, atMs: 0, clockOk: true };
  test("history rows: a known decision in words, an unknown one by its name, a request, a hub event", () => {
    const decision = (kind: string): HistoryRow => ({
      kind: "decision",
      row: {
        kind: "decision",
        row: { ...stamp, kind, deviceId: 4, causeSeq: null, value: null, detail: null },
      },
    });
    const exists = (key: string) => i18n.exists(key);
    expect(rowWords(t, exists, devices, decision("battery_low"))).toBe("Battery low: front-door");
    expect(rowWords(t, exists, devices, decision("something_new"))).toBe(
      "Decision something_new: front-door",
    );
    expect(
      rowWords(t, exists, devices, {
        kind: "command",
        row: {
          kind: "command",
          row: {
            ...stamp,
            actor: "Anna (client 7)",
            kind: "mode.switch",
            args: "{}",
            outcome: "unauthorized",
            detail: null,
          },
        },
      }),
    ).toBe("Anna (client 7): mode.switch, refused (unauthorized)");
    expect(
      rowWords(t, exists, devices, {
        kind: "hubEvent",
        row: {
          kind: "hubEvent",
          row: {
            ...stamp,
            level: "warning",
            origin: "x",
            code: "y",
            message: "disk slow",
            detail: null,
          },
        },
      }),
    ).toBe("Warning: disk slow");
  });
  test("a notification: its category, its device, late when it was", () => {
    const n = {
      seq: 9,
      atMs: 0,
      clockOk: true,
      kind: "tamper_opened",
      category: "tamper" as const,
      critical: true,
      device: 4,
      cause: null,
      read: false,
      delayed: true,
    };
    expect(notificationWords(t, devices, n)).toBe("Cover opened: front-door (delivered late)");
  });
});

describe("files", () => {
  test("base64url both ways", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1000));
    expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
    expect(toBase64url(new Uint8Array([251, 255]))).toBe("-_8");
  });

  async function linkedClient(hub: HubEnd) {
    const timers = manualTimers();
    const client = createHubClient({
      connect: hub.connect,
      records: memoryRecordStore(),
      timers,
      app: "0.1.0",
    });
    client.start();
    await client.link(
      { kind: "secret", secret: hub.tokenWithSecret("console"), identity: undefined },
      "console",
      { name: "x", kind: "web" },
    );
    await settle();
    return { client, timers };
  }

  test("an upload goes in chunks of at most 48 KB, numbered, the last with the count and the hash; no seq", async () => {
    const hub = new HubEnd();
    const got: AppOpBody<"fileChunk">[] = [];
    hub.handle("fileChunk", (body) => {
      got.push(body);
      return { ok: true, body: {} };
    });
    const { client } = await linkedClient(hub);
    const bytes = crypto.getRandomValues(new Uint8Array(FILE_CHUNKS.maxChunkBytes * 2 + 10));
    const done = await sendFile(client, 5, bytes);
    expect(done.ok).toBe(true);
    expect(got.map((c) => c.n)).toEqual([0, 1, 2]);
    expect(got.map((c) => fromBase64url(c.data)?.length)).toEqual([48_000, 48_000, 10]);
    expect(got[2]?.end).toEqual({ chunks: 3, sha256: toHex(await sha256(bytes)) });
    expect(hub.seen.filter((r) => r.op === "fileChunk").every((r) => r.seq === undefined)).toBe(
      true,
    );
  });

  test("a download: the bytes when the count and hash match; a gap or a wrong hash refused", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(60_000));
    const hash = toHex(await sha256(bytes));
    const chunk = (
      n: number,
      part: Uint8Array,
      end?: { chunks: number; sha256: string },
    ): AppEvent => ({
      t: "evt",
      rev: 1,
      ev: "fileChunk",
      body: { job: 3, n, data: toBase64url(part), ...(end === undefined ? {} : { end }) },
    });
    const run = async (events: readonly AppEvent[]) => {
      let listener: ((e: AppEvent) => void) | undefined;
      const result = receiveFile(
        (l) => {
          listener = l;
          return () => undefined;
        },
        3,
        manualTimers(),
      );
      for (const e of events) listener?.(e);
      return result;
    };
    const a = bytes.subarray(0, 48_000);
    const b = bytes.subarray(48_000);
    expect(await run([chunk(0, a), chunk(1, b, { chunks: 2, sha256: hash })])).toEqual({
      ok: true,
      bytes,
    });
    expect(await run([chunk(1, b, { chunks: 2, sha256: hash })])).toEqual({
      ok: false,
      fault: "gap",
    });
    expect(await run([chunk(0, a), chunk(1, b, { chunks: 2, sha256: "0".repeat(64) })])).toEqual({
      ok: false,
      fault: "hash",
    });
    expect(await run([chunk(0, a), chunk(1, b, { chunks: 3, sha256: hash })])).toEqual({
      ok: false,
      fault: "gap",
    });
  });

  test("an export's chunks that come before its reply are kept", async () => {
    const hub = new HubEnd();
    const bytes = crypto.getRandomValues(new Uint8Array(100));
    const hash = toHex(await sha256(bytes));
    hub.handle("backup.export", () => {
      hub.emit("fileChunk", {
        job: 8,
        n: 0,
        data: toBase64url(bytes),
        end: { chunks: 1, sha256: hash },
      });
      return { ok: true, body: { job: 8 } };
    });
    const { client, timers } = await linkedClient(hub);
    expect(await downloadFile(client, false, timers)).toEqual({ ok: true, bytes });
  });
});

describe("rules the review found untested", () => {
  test("arm anyway confirms exactly what the hub named", async () => {
    const { confirmationFor } = await import("../src/ui/arming");
    expect(confirmationFor({ openDoors: [4], lowBattery: [] })).toEqual({
      openDoors: true,
      lowBattery: false,
    });
    expect(confirmationFor({ openDoors: [], lowBattery: [5] })).toEqual({
      openDoors: false,
      lowBattery: true,
    });
  });

  test("names are sent trimmed and in NFC", async () => {
    const { cleanName } = await import("../src/ui/setup");
    expect(cleanName(" Ze\u0301 ")).toBe("Z\u00e9");
    expect(cleanName("   ")).toBeUndefined();
  });

  test("a download's chunk past 48 KB is refused", async () => {
    let listener: ((e: AppEvent) => void) | undefined;
    const result = receiveFile(
      (l) => {
        listener = l;
        return () => undefined;
      },
      3,
      manualTimers(),
    );
    listener?.({
      t: "evt",
      rev: 1,
      ev: "fileChunk",
      body: { job: 3, n: 0, data: toBase64url(new Uint8Array(FILE_CHUNKS.maxChunkBytes + 1)) },
    });
    expect(await result).toEqual({ ok: false, fault: "badChunk" });
  });

  test("another tab's message: a request only for one of the channel's operations", async () => {
    const { isTabMessage } = await import("../src/hub/tabs");
    expect(isTabMessage({ t: "req", from: "b", rid: 1, op: "mode.switch", body: {} })).toBe(true);
    expect(isTabMessage({ t: "req", from: "b", rid: 1, op: "constructor", body: {} })).toBe(false);
    expect(isTabMessage({ t: "req", from: "b", rid: 1, op: "anything", body: {} })).toBe(false);
  });

  test("a new tab holding the session fails what the old one had not answered", async () => {
    const { Tabs } = await import("../src/hub/tabs");
    const { createLiveStore } = await import("../src/state/live");
    const listeners: ((e: MessageEvent<unknown>) => void)[] = [];
    const posted: unknown[] = [];
    const tabs = new Tabs({
      id: "b",
      locks: { request: () => new Promise(() => undefined) },
      bus: { postMessage: (m) => posted.push(m), addEventListener: (_t, l) => listeners.push(l) },
      store: createLiveStore(),
      makeChannel: () => {
        throw new Error("not the leader");
      },
      listener: () => ({
        status: () => undefined,
        snapshot: () => undefined,
        event: () => undefined,
      }),
      onEvent: () => undefined,
    });
    tabs.start();
    const hear = (data: unknown) => {
      for (const l of listeners) l(new MessageEvent("message", { data }));
    };
    hear({ t: "leader", from: "a" });
    const pending = tabs.request("site.set", { countdown: 30 });
    expect(posted.some((m) => (m as { t?: string }).t === "req")).toBe(true);
    hear({ t: "leader", from: "c" });
    expect(await pending).toEqual({ ok: false, local: "tabClosed" });
  });
});

describe("the wave 2 rulings in the screens", () => {
  test("a group needs every siren or one at least", async () => {
    const { hasSirens } = await import("../src/ui/groups");
    expect(hasSirens("all")).toBe(true);
    expect(hasSirens([9])).toBe(true);
    expect(hasSirens([])).toBe(false);
  });

  test("a history export is told from a backup by its first line; a badFile refusal is named", async () => {
    const { isHistoryExport, restoreRefusal } = await import("../src/ui/backup");
    const enc = new TextEncoder();
    expect(
      isHistoryExport(enc.encode('{"format": "hsn-history/1", "hub": "x"}\n{"kind":"decision"}')),
    ).toBe(true);
    expect(isHistoryExport(enc.encode("HSNB\u0001..."))).toBe(false);
    expect(
      restoreRefusal({
        ok: false,
        error: { code: "invalid", detail: { field: "job", reason: "badFile" } },
      }),
    ).toBe("badFile");
    expect(
      restoreRefusal({
        ok: false,
        error: { code: "invalid", detail: { field: "job", reason: "format" } },
      }),
    ).toBeUndefined();
  });
});

describe("configuration in the snapshot", () => {
  test("the snapshot gives the modes, groups, schedules and this client's categories", async () => {
    const { EMPTY_LIVE, applySnapshot } = await import("../src/state/live");
    const hub = new HubEnd();
    const snapshot = {
      ...hub.snapshot,
      groups: [{ id: 7, name: "Downstairs", sensors: [], sirens: "all" as const, revision: 0 }],
      notificationPrefs: { categories: ["batteryLow" as const], revision: 3 },
    };
    const hello = {
      proto: 1,
      hub: "1",
      boot: 1,
      rev: 1,
      client: { id: 1, person: null, kind: "console" as const },
      features: [],
    };
    const state = applySnapshot(EMPTY_LIVE, snapshot, hello, 0);
    expect(Object.keys(state.modes)).toEqual(["1", "2"]);
    expect(state.groups[7]?.name).toBe("Downstairs");
    expect(state.notificationPrefs).toEqual({ categories: ["batteryLow"], revision: 3 });
  });
});

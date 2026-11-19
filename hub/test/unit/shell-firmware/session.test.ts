/**
 * `firmware.bluetooth`'s reply (`shell/firmware/session.ts`; docs/m3-updates-design.md section 5):
 * the session key against the protocol's vectors; the reply sent where the request came from, the
 * key in it and nowhere else; a device whose key is gone answered `unavailable`. Then through the
 * real loop and a real database: the reply leaves only after the commit that holds the session's
 * nonce (held while a commit fails), and neither the session key nor the device key is found in
 * the database, its log, a record, a report or anything else the hub wrote.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { nodeSha256 } from "@hsn/protocol";
import type { AppReply, BluetoothSessionObject } from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import type { ControlReply } from "../../../src/core/model/control.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { CommitOutcome, Input } from "../../../src/core/model/events.ts";
import {
  connId,
  deviceId,
  linkId,
  type RequestId,
  requestId,
  seq,
} from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import type { Core } from "../../../src/core/step.ts";
import type { HubError } from "../../../src/core/model/errors.ts";
import type { CommitInfo, StagedEffect, StorageError } from "../../../src/ports/writer.ts";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import {
  type BluetoothSessionEffect,
  sendSession,
  sessionBody,
} from "../../../src/shell/firmware/session.ts";
import { HubLoop, type LoopWriter } from "../../../src/shell/loop.ts";
import { MemoryKeyStore } from "../../../src/shell/storage/keys.ts";
import { openStore } from "../../../src/shell/storage/store.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { type TempFolder, tempFolder } from "./support.ts";

interface SessionVector {
  readonly name: string;
  readonly deviceKey: string;
  readonly nonce: string;
  readonly address: number;
  readonly sessionKey: string;
}

const VECTORS = (
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../packages/protocol/vectors/ble-update-session.json"),
      "utf8",
    ),
  ) as { readonly sessionKeys: readonly SessionVector[] }
).sessionKeys;

/** The first session vector; the file has three. */
function firstVector(): SessionVector {
  expect(VECTORS.length).toBeGreaterThan(0);
  return VECTORS[0] ?? VECTORS.at(-1) ?? ({} as SessionVector);
}

const fromHex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "hex"));
const SENSOR = deviceId(5);

function effect(
  vector: SessionVector,
  to: BluetoothSessionEffect["to"] = { kind: "control", request: requestId(1) },
): BluetoothSessionEffect {
  return {
    kind: "bluetoothSession",
    to,
    device: SENSOR,
    address: vector.address,
    nonce: fromHex(vector.nonce),
    reply: {
      device: SENSOR,
      address: vector.address,
      imageId: "5809a93fbda5fee2",
      version: "1.4.0",
      fileBytes: 128 + 4096,
      sha256: "5809a93fbda5fee2a1d80764b42c362e2ebb74b2add07a06ea218d76a79392aa",
      windowS: 120,
      expiresInMs: 900_000,
      needsWake: true,
    },
  };
}

function keysWith(vector: SessionVector): MemoryKeyStore {
  return new MemoryKeyStore(new Map([[SENSOR, fromHex(vector.deviceKey)]]));
}

describe("the session key", () => {
  for (const vector of VECTORS) {
    test(`matches the vectors: ${vector.name}`, () => {
      const body = sessionBody(effect(vector), keysWith(vector))._unsafeUnwrap();
      expect(Buffer.from(body.sessionKey, "base64url").toString("hex")).toBe(vector.sessionKey);
      expect(body.sessionKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      // Everything else is the core's reply, unchanged.
      expect({ ...body, sessionKey: undefined }).toEqual({
        ...effect(vector).reply,
        sessionKey: undefined,
      });
    });
  }

  test("another nonce or address gives another key", () => {
    const vector = firstVector();
    const one = sessionBody(effect(vector), keysWith(vector))._unsafeUnwrap().sessionKey;
    const nonce = { ...effect(vector), nonce: fromHex("5a5b5c5d5e5f6062") };
    const address = { ...effect(vector), address: vector.address + 1 };
    expect(sessionBody(nonce, keysWith(vector))._unsafeUnwrap().sessionKey).not.toBe(one);
    expect(sessionBody(address, keysWith(vector))._unsafeUnwrap().sessionKey).not.toBe(one);
  });
});

describe("the reply", () => {
  const vector = firstVector();

  test("on a session: `{t: res, id, ok, body}` with the key", () => {
    const apps: { conn: number; message: AppReply }[] = [];
    const sent = sendSession(
      effect(vector, { kind: "app", conn: connId(7), id: 42 }),
      keysWith(vector),
      {
        app: (conn, message) => apps.push({ conn, message }),
        control: () => undefined,
      },
    );
    expect(sent.isOk()).toBe(true);
    expect(apps).toHaveLength(1);
    expect(apps[0]?.conn).toBe(connId(7));
    expect(apps[0]?.message).toMatchObject({ t: "res", id: 42, ok: true });
    const body = (apps[0]?.message as { body: BluetoothSessionObject }).body;
    expect(Buffer.from(body.sessionKey, "base64url").toString("hex")).toBe(vector.sessionKey);
  });

  test("on the control socket: the op's result with the key", () => {
    const answers: { request: RequestId; reply: ControlReply }[] = [];
    sendSession(effect(vector, { kind: "control", request: requestId(9) }), keysWith(vector), {
      app: () => undefined,
      control: (request, reply) => answers.push({ request, reply }),
    })._unsafeUnwrap();
    expect(answers).toHaveLength(1);
    expect(answers[0]?.request).toBe(requestId(9));
    expect(answers[0]?.reply).toMatchObject({ ok: true, result: { kind: "op" } });
  });

  test("a device whose key is gone: `unavailable` on either path, and the key is in no message", () => {
    const empty = new MemoryKeyStore();
    const apps: AppReply[] = [];
    const answers: ControlReply[] = [];
    const replies = {
      app: (_conn: unknown, message: AppReply) => apps.push(message),
      control: (_request: unknown, reply: ControlReply) => answers.push(reply),
    };
    const one = sendSession(
      effect(vector, { kind: "app", conn: connId(1), id: 3 }),
      empty,
      replies,
    );
    const two = sendSession(effect(vector), empty, replies);
    expect(one._unsafeUnwrapErr()).toBe("the hub holds no key for device 5");
    expect(two.isErr()).toBe(true);
    expect(apps).toEqual([
      { t: "res", id: 3, ok: false, error: { code: "unavailable", detail: {} } },
    ]);
    expect(answers).toEqual([
      {
        ok: false,
        error: {
          code: "opRefused",
          message: "unavailable",
          app: { code: "unavailable", detail: {} },
        },
      },
    ]);
  });
});

// ----- Through the loop, on a real database -----

const folders: TempFolder[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) folder.remove();
});

class FixedClock {
  now(): Now {
    return { mono: mono(1_000), wall: Date.UTC(2026, 10, 18), wallTrusted: true };
  }
}

/** The core's commit of the session (a record written now), then its effect, as `firmware` does. */
function sessionCore(made: BluetoothSessionEffect): Core {
  const state = { clock: { boot: { id: 1 } } } as unknown as HubState;
  return {
    emptyState: () => state,
    nextDeadline: () => undefined,
    step: (current: HubState, input: Input) => {
      if (input.event.kind !== "tick") return ok({ state: current, effects: [], wake: undefined });
      const record: AuditRecord = {
        kind: "hubEvent",
        row: {
          seq: seq(2 ** 32 + 1),
          atMs: Date.UTC(2026, 10, 18),
          clockOk: true,
          level: "warning",
          origin: "core/firmware",
          code: "test_session_committed",
          message: "the session's nonce, committed now",
          detail: null,
        },
      };
      const effects: Effect[] = [{ kind: "record", durability: "now", record }, made];
      return ok({ state: current, effects, wake: undefined });
    },
  };
}

function loopOf(
  core: Core,
  writer: LoopWriter,
  keys: MemoryKeyStore,
  seen: { answers: ControlReply[]; reports: HubError[]; records: AuditRecord[] },
): HubLoop {
  return new HubLoop(
    core,
    {
      cipher: new VectorCipher([]),
      rules: DEFAULT_RULES,
      calendar: UNBUILT_CALENDAR,
      sha256: nodeSha256,
    },
    {
      clock: new FixedClock(),
      random: { bytes: (n) => ok(new Uint8Array(n)) },
      links: {
        listen: () => undefined,
        send: () => ok(undefined),
        close: () => ok(undefined),
      },
      control: {
        respond: (_request, reply) => seen.answers.push(reply),
        publish: (record) => seen.records.push(record),
      },
      writer,
      advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
      wakeAt: () => undefined,
      soon: () => undefined,
      report: (error) => seen.reports.push(error),
      fatal: (error) => seen.reports.push(error),
      bluetoothSession: (made) => {
        const sent = sendSession(made, keys, {
          app: () => undefined,
          control: (_request, reply) => seen.answers.push(reply),
        });
        if (sent.isErr())
          seen.reports.push({ kind: "internal", origin: "test", message: sent.error });
      },
    },
  );
}

/** Every file under `folder`, its bytes. */
function everyFile(folder: string): Buffer[] {
  const out: Buffer[] = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) out.push(...everyFile(path));
    else out.push(readFileSync(path));
  }
  return out;
}

/** The forms a key could be written in. */
function forms(key: Uint8Array): Buffer[] {
  const raw = Buffer.from(key);
  return [
    raw,
    Buffer.from(raw.toString("hex")),
    Buffer.from(raw.toString("hex").toUpperCase()),
    Buffer.from(raw.toString("base64")),
    Buffer.from(raw.toString("base64url")),
  ];
}

describe("through the loop", () => {
  const vector = firstVector();

  test("the reply leaves after the commit; the keys are nowhere the hub wrote", () => {
    const folder = tempFolder("session");
    folders.push(folder);
    const dataDir = join(folder.path, "data");
    const store = openStore({
      dataDir,
      migrationsFolder: join(import.meta.dir, "..", "..", "..", "drizzle"),
      clock: new FixedClock(),
      rules: DEFAULT_RULES,
      platform: process.platform,
    })._unsafeUnwrap();
    const seen = {
      answers: [] as ControlReply[],
      reports: [] as HubError[],
      records: [] as AuditRecord[],
    };
    const loop = loopOf(sessionCore(effect(vector)), store.writer, keysWith(vector), seen);
    loop.enqueue({ kind: "tick" });
    loop.turn();
    expect(seen.answers).toHaveLength(1);
    const reply = seen.answers[0];
    const body = reply?.ok === true && reply.result.kind === "op" ? reply.result.body : undefined;
    const sessionKey = Buffer.from(
      (body as BluetoothSessionObject | undefined)?.sessionKey ?? "",
      "base64url",
    );
    expect(sessionKey.toString("hex")).toBe(vector.sessionKey);
    expect(store.writer.flush("log").isOk()).toBe(true);
    // The record the core made is committed: it was written now, before the reply.
    expect(seen.records).toHaveLength(1);
    // Search everything the hub wrote, every record and every report, for either key.
    const written = everyFile(dataDir);
    const said = [JSON.stringify(seen.records), JSON.stringify(seen.reports)].map((text) =>
      Buffer.from(text),
    );
    for (const key of [new Uint8Array(sessionKey), fromHex(vector.deviceKey)])
      for (const form of forms(key))
        for (const bytes of [...written, ...said]) expect(bytes.includes(form)).toBe(false);
    store.db.close();
  });

  test("while the commit fails the reply waits; it leaves with the first commit that succeeds", () => {
    let failing = true;
    let outcome: CommitOutcome | undefined;
    const staged: StagedEffect[] = [];
    const writer: LoopWriter = {
      stage: (items) => staged.push(...items),
      setCadence: () => undefined,
      durable: () => undefined,
      due: (now) => (staged.length > 0 ? now : undefined),
      flushIfDue: () => (staged.length > 0 ? writer.flush("now") : ok(undefined)),
      flush: (): Result<CommitInfo & { readonly committed: boolean }, StorageError> => {
        if (failing) {
          outcome = { kind: "failed", message: "disk full" };
          return err({ kind: "storage", origin: "test", message: "disk full" });
        }
        const items = staged.splice(0).length;
        return ok({ items, durationMs: 1, committed: true });
      },
      takeOutcome: () => {
        const taken = outcome;
        outcome = undefined;
        return taken;
      },
      maintain: () => ok(undefined),
    };
    const seen = {
      answers: [] as ControlReply[],
      reports: [] as HubError[],
      records: [] as AuditRecord[],
    };
    const loop = loopOf(sessionCore(effect(vector)), writer, keysWith(vector), seen);
    loop.enqueue({ kind: "tick" });
    loop.turn();
    expect(seen.answers).toHaveLength(0);
    // Another input, and the commit still failing: still held.
    loop.enqueue({ kind: "linkClosed", link: linkId(1), reason: "remote" });
    loop.turn();
    expect(seen.answers).toHaveLength(0);
    failing = false;
    loop.enqueue({ kind: "linkClosed", link: linkId(1), reason: "remote" });
    loop.turn();
    expect(seen.answers).toHaveLength(1);
    expect(seen.answers[0]).toMatchObject({ ok: true, result: { kind: "op" } });
  });

  test("a hub without the loop's session port reports the effect, and sends nothing", () => {
    const seen = {
      answers: [] as ControlReply[],
      reports: [] as HubError[],
      records: [] as AuditRecord[],
    };
    const loop = new HubLoop(
      sessionCore(effect(vector)),
      {
        cipher: new VectorCipher([]),
        rules: DEFAULT_RULES,
        calendar: UNBUILT_CALENDAR,
        sha256: nodeSha256,
      },
      {
        clock: new FixedClock(),
        random: { bytes: (n) => ok(new Uint8Array(n)) },
        links: { listen: () => undefined, send: () => ok(undefined), close: () => ok(undefined) },
        control: { respond: (_r, reply) => seen.answers.push(reply), publish: () => undefined },
        writer: {
          stage: () => undefined,
          setCadence: () => undefined,
          durable: () => undefined,
          due: () => undefined,
          flushIfDue: () => ok({ items: 0, durationMs: 0, committed: true }),
          flush: () => ok({ items: 0, durationMs: 0, committed: true }),
          takeOutcome: () => undefined,
          maintain: () => ok(undefined),
        },
        advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
        wakeAt: () => undefined,
        soon: () => undefined,
        report: (error) => seen.reports.push(error),
        fatal: () => undefined,
      },
    );
    loop.enqueue({ kind: "tick" });
    loop.turn();
    expect(seen.answers).toHaveLength(0);
    expect(seen.reports.map((r) => r.message)).toEqual([
      "the bluetoothSession effect is not built yet (m2-design.md section 11, step 2)",
    ]);
  });
});

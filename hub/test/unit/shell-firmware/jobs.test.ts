/**
 * The firmware store's file jobs as `startJob` starts them (`shell/firmware/jobs.ts`;
 * docs/m3-updates-design.md section 4): staging an upload with the hub's key read from its own
 * database, removing an image's file (image 0 included), and `firmware.download`'s stream, whose
 * last chunk waits for the payload's hash, so a damaged file is never delivered whole.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILE_CHUNK_BYTES } from "@hsn/protocol/app";
import { verifyImageHeader } from "@hsn/protocol/update";
import { err, ok, type Result } from "neverthrow";
import type { FileWork } from "../../../src/core/model/effects.ts";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { connId, imageId, jobId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import type { JobStart } from "../../../src/shell/backup/jobs.ts";
import type { ExportChunk } from "../../../src/shell/backup/write.ts";
import {
  firmwareJob,
  type FirmwareJobDeps,
  isFirmwareWork,
} from "../../../src/shell/firmware/jobs.ts";
import { makeHeader, type HubSigner } from "../../../src/shell/firmware/sign.ts";
import { imageFileName, storeFolder } from "../../../src/shell/firmware/store.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import { openStore, type OpenedStore } from "../../../src/shell/storage/store.ts";
import {
  espImage,
  release,
  sha256,
  type TempFolder,
  tempFolder,
  testHubKeys,
  toEnd,
} from "./support.ts";

const folders: TempFolder[] = [];
let keys: Awaited<ReturnType<typeof testHubKeys>>;

beforeAll(async () => {
  keys = await testHubKeys();
});

afterEach(() => {
  for (const folder of folders.splice(0)) folder.remove();
});

class FixedClock {
  now(): Now {
    return { mono: mono(1), wall: Date.UTC(2026, 10, 18), wallTrusted: true };
  }
}

interface Rig {
  readonly dataDir: string;
  readonly store: OpenedStore;
  readonly chunks: { readonly conn: number; readonly chunk: ExportChunk }[];
  readonly deps: (
    send?: (conn: number, chunk: ExportChunk) => Result<void, string>,
  ) => FirmwareJobDeps;
}

/** A hub's data folder and database, its signing key in `hub_keys` as the hub writes it. */
function rig(withKeys = true): Rig {
  const folder = tempFolder("jobs");
  folders.push(folder);
  const dataDir = join(folder.path, "data");
  const store = openStore({
    dataDir,
    migrationsFolder: join(import.meta.dir, "..", "..", "..", "drizzle"),
    clock: new FixedClock(),
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
  if (withKeys) {
    store.writer.stage([
      {
        kind: "write",
        durability: "now",
        op: {
          table: "hub_keys",
          op: "upsert",
          row: {
            signingPrivate: keys.pkcs8,
            signingPublic: keys.publicKey,
            identity: keys.identity,
            appStaticPrivate: null,
            appStaticPublic: null,
            tlsPrivate: null,
            tlsCertificate: null,
          },
        },
      },
    ]);
    expect(store.writer.flush("now").isOk()).toBe(true);
  }
  const chunks: { conn: number; chunk: ExportChunk }[] = [];
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  writeFileSync(join(dataDir, "uploads", "7"), new Uint8Array(0));
  return {
    dataDir,
    store,
    chunks,
    deps: (send) => ({
      db: store.db,
      dataDir,
      rules: DEFAULT_RULES,
      uploads: { pathOf: (ref) => (ref.job === 7 ? join(dataDir, "uploads", "7") : undefined) },
      exports: {
        send:
          send ??
          ((conn, chunk) => {
            chunks.push({ conn, chunk });
            return ok(undefined);
          }),
      },
      publisherKeys: [TEST_PUBLISHER_KEY],
    }),
  };
}

function run(started: JobStart): FileOutcome {
  if (started.kind === "ready") return started.outcome;
  if (started.kind === "pieces") return toEnd(started.pieces).outcome;
  return { kind: "failed", reason: "io", message: "a switch" };
}

const JOB = jobId(2 ** 31 + 3);

test("the firmware's work is told from the rest", () => {
  const kinds: readonly FileWork[] = [
    { kind: "stageFirmware", upload: { conn: connId(1), job: 1 }, own: null },
    { kind: "removeFirmware", image: imageId(1), file: "x" },
    { kind: "sendFirmware", conn: connId(1), header: new Uint8Array(128), file: "x" },
  ];
  for (const work of kinds) expect(isFirmwareWork(work)).toBe(true);
  expect(isFirmwareWork({ kind: "stageUpdate", upload: { conn: connId(1), job: 1 } })).toBe(false);
  expect(isFirmwareWork({ kind: "switchRestore" })).toBe(false);
});

describe("stageFirmware", () => {
  test("a release staged in pieces, signed with the key in the hub's own database", () => {
    const hub = rig();
    const payload = espImage({ size: 400_000 });
    writeFileSync(join(hub.dataDir, "uploads", "7"), release({ payload }));
    const started = firmwareJob(
      JOB,
      { kind: "stageFirmware", upload: { conn: connId(1), job: 7 }, own: null },
      hub.deps(),
    );
    expect(started.kind).toBe("pieces");
    const outcome = run(started);
    expect(outcome.kind).toBe("firmwareStaged");
    if (outcome.kind !== "firmwareStaged") return;
    expect(verifyImageHeader(outcome.image.header, keys.publicKey)).toBe(true);
    expect(readdirSync(storeFolder(hub.dataDir))).toEqual([outcome.image.file]);
    hub.store.db.close();
  });

  test("an own build with no signing key yet: failed, nothing stored", () => {
    const hub = rig(false);
    writeFileSync(join(hub.dataDir, "uploads", "7"), espImage());
    const outcome = run(
      firmwareJob(
        JOB,
        { kind: "stageFirmware", upload: { conn: connId(1), job: 7 }, own: { version: "1.4.0" } },
        hub.deps(),
      ),
    );
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: "io",
      message: "the hub has no signing key yet",
    });
    expect(existsSync(storeFolder(hub.dataDir))).toBe(false);
    hub.store.db.close();
  });

  test("an upload that is not there: noUpload, at once", () => {
    const hub = rig();
    const started = firmwareJob(
      JOB,
      { kind: "stageFirmware", upload: { conn: connId(1), job: 8 }, own: null },
      hub.deps(),
    );
    expect(started).toEqual({
      kind: "ready",
      outcome: { kind: "failed", reason: "noUpload", message: "no upload 8 on connection 1" },
    });
    hub.store.db.close();
  });
});

describe("removeFirmware", () => {
  test("an image's file, and image 0's (a staged file refused storeFull), each at once", () => {
    const hub = rig();
    const a = imageFileName(sha256(Uint8Array.of(1)));
    const b = imageFileName(sha256(Uint8Array.of(2)));
    mkdirSync(storeFolder(hub.dataDir), { recursive: true });
    writeFileSync(join(storeFolder(hub.dataDir), a), "a");
    writeFileSync(join(storeFolder(hub.dataDir), b), "b");
    expect(
      firmwareJob(JOB, { kind: "removeFirmware", image: imageId(3), file: a }, hub.deps()),
    ).toEqual({ kind: "ready", outcome: { kind: "firmwareRemoved", image: imageId(3) } });
    expect(
      firmwareJob(JOB, { kind: "removeFirmware", image: imageId(0), file: b }, hub.deps()),
    ).toEqual({ kind: "ready", outcome: { kind: "firmwareRemoved", image: imageId(0) } });
    expect(readdirSync(storeFolder(hub.dataDir))).toEqual([]);
    hub.store.db.close();
  });

  test("a name that is not the store's: refused, and nothing outside the store touched", () => {
    const hub = rig();
    const started = firmwareJob(
      JOB,
      { kind: "removeFirmware", image: imageId(3), file: "../hub.db" },
      hub.deps(),
    );
    expect(started).toMatchObject({
      kind: "ready",
      outcome: { kind: "failed", reason: "badFile" },
    });
    expect(existsSync(join(hub.dataDir, "hub.db"))).toBe(true);
    hub.store.db.close();
  });
});

describe("sendFirmware", () => {
  async function stored(
    hub: Rig,
    size: number,
  ): Promise<{ header: Uint8Array; image: Uint8Array; file: string; signer: HubSigner }> {
    const image = espImage({ size, seed: 4 });
    const sha = sha256(image);
    const header = makeHeader(
      {
        ownBuild: true,
        roles: 14,
        version: { major: 1, minor: 4, patch: 0 },
        imageBytes: image.length,
        imageSha256: sha,
      },
      keys.signer,
    )._unsafeUnwrap();
    const file = imageFileName(sha);
    mkdirSync(storeFolder(hub.dataDir), { recursive: true });
    writeFileSync(join(storeFolder(hub.dataDir), file), image);
    return Promise.resolve({ header, image, file, signer: keys.signer });
  }

  test("the header then the payload, in 48 KB chunks, the last with the count and the stream's hash", async () => {
    const hub = rig();
    const { header, image, file } = await stored(hub, 700_000);
    const started = firmwareJob(
      JOB,
      { kind: "sendFirmware", conn: connId(4), header, file },
      hub.deps(),
    );
    expect(started.kind).toBe("pieces");
    const outcome = run(started);
    const whole = Buffer.concat([header, image]);
    expect(outcome).toEqual({ kind: "firmwareSent", bytes: whole.length });
    const parts = hub.chunks.map(({ chunk }) => Buffer.from(chunk.data, "base64url"));
    expect(Buffer.concat(parts)).toEqual(whole);
    expect(hub.chunks.every(({ conn }) => conn === connId(4))).toBe(true);
    expect(hub.chunks.map(({ chunk }) => chunk.n)).toEqual(hub.chunks.map((_, i) => i));
    expect(parts.slice(0, -1).every((p) => p.length === FILE_CHUNK_BYTES)).toBe(true);
    expect(hub.chunks.slice(0, -1).every(({ chunk }) => chunk.end === undefined)).toBe(true);
    expect(hub.chunks.at(-1)?.chunk.end).toEqual({
      chunks: hub.chunks.length,
      sha256: createHash("sha256").update(whole).digest("hex"),
    });
    hub.store.db.close();
  });

  test("a small image: one chunk", async () => {
    const hub = rig();
    const { header, image, file } = await stored(hub, 1000);
    expect(
      run(firmwareJob(JOB, { kind: "sendFirmware", conn: connId(4), header, file }, hub.deps())),
    ).toEqual({
      kind: "firmwareSent",
      bytes: 128 + image.length,
    });
    expect(hub.chunks).toHaveLength(1);
    hub.store.db.close();
  });

  for (const [name, damage, message] of [
    [
      "changed",
      (image: Uint8Array) => {
        const o = image.slice();
        o[650_000] = (o[650_000] ?? 0) ^ 1;
        return o;
      },
      "does not hash to its header's SHA-256",
    ],
    [
      "shorter",
      (image: Uint8Array) => image.subarray(0, image.length - 1),
      "shorter than its header says",
    ],
    ["longer", (image: Uint8Array) => new Uint8Array([...image, 0]), "longer than its header says"],
  ] as const) {
    test(`a stored file ${name}: failed, and no chunk with the end mark`, async () => {
      const hub = rig();
      const { header, image, file } = await stored(hub, 700_000);
      writeFileSync(join(storeFolder(hub.dataDir), file), damage(image));
      const outcome = run(
        firmwareJob(JOB, { kind: "sendFirmware", conn: connId(4), header, file }, hub.deps()),
      );
      expect(outcome.kind).toBe("failed");
      expect(outcome.kind === "failed" ? outcome.message : "").toContain(message);
      expect(hub.chunks.some(({ chunk }) => chunk.end !== undefined)).toBe(false);
      hub.store.db.close();
    });
  }

  test("a file that is not there, or a name not the store's: failed at once", async () => {
    const hub = rig();
    const { header } = await stored(hub, 1000);
    const gone = run(
      firmwareJob(
        JOB,
        { kind: "sendFirmware", conn: connId(4), header, file: imageFileName(new Uint8Array(32)) },
        hub.deps(),
      ),
    );
    expect(gone).toMatchObject({ kind: "failed", reason: "unreachable" });
    const outside = run(
      firmwareJob(
        JOB,
        { kind: "sendFirmware", conn: connId(4), header, file: "../hub.db" },
        hub.deps(),
      ),
    );
    expect(outside).toMatchObject({ kind: "failed" });
    expect(hub.chunks).toHaveLength(0);
    hub.store.db.close();
  });

  test("the session gone part way: failed; a stop: failed, nothing more sent", async () => {
    const hub = rig();
    const { header, file } = await stored(hub, 700_000);
    let sent = 0;
    const closing = run(
      firmwareJob(
        JOB,
        { kind: "sendFirmware", conn: connId(4), header, file },
        hub.deps(() => {
          sent += 1;
          return sent > 3 ? err("the connection is gone") : ok(undefined);
        }),
      ),
    );
    expect(closing).toMatchObject({ kind: "failed" });
    expect(closing.kind === "failed" ? closing.message : "").toContain("the connection is gone");
    const started = firmwareJob(
      JOB,
      { kind: "sendFirmware", conn: connId(4), header, file },
      hub.deps(),
    );
    expect(started.kind).toBe("pieces");
    if (started.kind !== "pieces") return;
    expect(started.pieces.next()).toBeUndefined();
    expect(started.pieces.next()).toBeUndefined();
    const before = hub.chunks.length;
    expect(started.pieces.abort("the hub is stopping")).toMatchObject({ kind: "failed" });
    expect(started.pieces.next()).toMatchObject({ kind: "failed" });
    expect(hub.chunks.length).toBe(before);
    hub.store.db.close();
  });
});

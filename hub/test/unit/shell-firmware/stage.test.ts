/**
 * Staging a firmware file (`shell/firmware/stage.ts`; docs/m3-updates-design.md sections 3 and 4):
 * a publisher's `.hsnf` checked exactly as a hub release is, an owner's own build checked against
 * the ESP layout, the header made and signed, the payload stored, in pieces; every refusal in
 * section 3's order, each leaving the store as it was; a stop, a failure or a power cut at any
 * piece leaving nothing the store's check at start keeps.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeImageHeader, verifyImageHeader } from "@hsn/protocol/update";
import { err, ok, type Result } from "neverthrow";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { ImageKind } from "../../../src/core/model/rows.ts";
import type { HubSigner } from "../../../src/shell/firmware/sign.ts";
import { HEAD_BYTES } from "../../../src/shell/firmware/release.ts";
import { FIRMWARE_PIECE_BYTES, FirmwareStaging } from "../../../src/shell/firmware/stage.ts";
import { checkStore, storeFolder } from "../../../src/shell/firmware/store.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import {
  espImage,
  hex,
  manifestOf,
  release,
  RULES,
  sha256,
  STRANGER_SEED,
  type TempFolder,
  tempFolder,
  testHubKeys,
  toEnd,
} from "./support.ts";

let signer: HubSigner;
let publicKey: Uint8Array;
const folders: TempFolder[] = [];

beforeAll(async () => {
  const keys = await testHubKeys();
  signer = keys.signer;
  publicKey = keys.publicKey;
});

afterEach(() => {
  for (const folder of folders.splice(0)) folder.remove();
});

interface Run {
  readonly outcome: FileOutcome;
  readonly dataDir: string;
  /** The store folder's names after the job. */
  readonly stored: readonly string[];
  readonly staging: FirmwareStaging;
  readonly upload: string;
}

function setup(): { readonly dataDir: string; readonly upload: string } {
  const folder = tempFolder("stage");
  folders.push(folder);
  const dataDir = join(folder.path, "data");
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  return { dataDir, upload: join(dataDir, "uploads", "1") };
}

function staging(
  dataDir: string,
  upload: string,
  own: string | null,
  options: { readonly signer?: () => Result<HubSigner, string> } = {},
): FirmwareStaging {
  return new FirmwareStaging({
    job: 2 ** 31 + 1,
    path: upload,
    own: own === null ? null : { version: own },
    dataDir,
    keys: [TEST_PUBLISHER_KEY],
    rules: RULES,
    signer: options.signer ?? (() => ok(signer)),
  });
}

function stage(
  file: Uint8Array,
  own: string | null = null,
  prepare?: (dataDir: string) => void,
): Run {
  const { dataDir, upload } = setup();
  writeFileSync(upload, file);
  prepare?.(dataDir);
  const job = staging(dataDir, upload, own);
  const { outcome } = toEnd(job);
  const folder = storeFolder(dataDir);
  return {
    outcome,
    dataDir,
    stored: existsSync(folder) ? readdirSync(folder) : [],
    staging: job,
    upload,
  };
}

function refused(run: Run): { reason: string; message: string } {
  expect(run.outcome.kind).toBe("failed");
  return run.outcome.kind === "failed"
    ? { reason: run.outcome.reason, message: run.outcome.message }
    : { reason: "", message: "" };
}

describe("a publisher's release", () => {
  test("is staged: the payload stored under its hash, a signed header, the row's facts", () => {
    const payload = espImage({ size: 600_000, seed: 2 });
    const file = release({ payload, manifest: { roles: [1, 3] } });
    const run = stage(file);
    expect(run.outcome.kind).toBe("firmwareStaged");
    if (run.outcome.kind !== "firmwareStaged") return;
    const image = run.outcome.image;
    const sha = sha256(payload);
    expect(image.sha256).toEqual(sha);
    expect(image.imageId).toEqual(sha.slice(0, 8));
    expect(image.version).toBe(1 * 65_536 + 4 * 256 + 0);
    expect(image.kind).toBe(ImageKind.Official);
    expect(image.roles).toBe(2 | 8);
    expect(image.bytes).toBe(payload.length);
    expect(image.file).toBe(`${hex(sha)}.bin`);
    expect(run.stored).toEqual([image.file]);
    expect(new Uint8Array(readFileSync(join(storeFolder(run.dataDir), image.file)))).toEqual(
      new Uint8Array(payload),
    );
    expect(verifyImageHeader(image.header, publicKey)).toBe(true);
    const header = decodeImageHeader(image.header);
    expect(header).toMatchObject({
      ok: true,
      value: {
        flags: { ownBuild: false },
        roles: 10,
        target: 1,
        version: { major: 1, minor: 4, patch: 0 },
        imageBytes: payload.length,
        hubIdentity: signer.identity,
      },
    });
    // The manifest exactly as signed, and its signature, for the row.
    const kept = JSON.parse(image.manifest ?? "{}") as { manifest: string; signature: string };
    expect(kept.manifest).toBe(JSON.stringify({ ...manifestOf(payload), roles: [1, 3] }));
    expect(kept.signature).toMatch(/^[0-9a-f]{128}$/u);
    // The upload is not changed (the loop frees it when the job ends).
    expect(new Uint8Array(readFileSync(run.upload))).toEqual(new Uint8Array(file));
  });

  test("the same release twice gives the same header and file", () => {
    const payload = espImage({ size: 5000 });
    const a = stage(release({ payload }));
    const b = stage(release({ payload }));
    expect(a.outcome).toEqual(b.outcome);
  });

  test("in pieces, none reading more than a piece's bytes", () => {
    const payload = espImage({ size: 1_200_000, seed: 4 });
    const run = stage(release({ payload }));
    expect(run.outcome.kind).toBe("firmwareStaged");
    expect(run.staging.largestPiece).toBeLessThanOrEqual(
      Math.max(FIRMWARE_PIECE_BYTES, HEAD_BYTES + 512),
    );
    // Both passes over the payload, and the head.
    expect(run.staging.bytesRead).toBeGreaterThanOrEqual(2 * payload.length);
  });

  // Section 3's refusals, in its order: the file (badFile), the signature, the target, the size,
  // the payload's length and hash, the ESP header's magic and version.
  const payload = espImage({ size: 3000, seed: 7 });
  const refusals: readonly (readonly [string, () => Uint8Array, string, RegExp])[] = [
    [
      "a wrong magic",
      () => release({ payload, magic: "HSNR" }),
      "badFile",
      /not a firmware release/u,
    ],
    ["format 2", () => release({ payload, format: 2 }), "badFile", /format 2/u],
    [
      "a reserved byte set",
      () => release({ payload, reserved: [0, 1, 0] }),
      "badFile",
      /reserved/u,
    ],
    [
      "a manifest of length 0",
      () => release({ payload, manifestText: new Uint8Array(0) }),
      "badFile",
      /no manifest/u,
    ],
    [
      "a manifest over 64 KB",
      () => release({ payload, manifestText: new Uint8Array(64 * 1024 + 1).fill(0x20) }),
      "badFile",
      /no manifest/u,
    ],
    [
      "a file cut before its signature",
      () => release({ payload }).slice(0, 12 + 150),
      "badFile",
      /cut/u,
    ],
    ["a file shorter than its fixed bytes", () => new Uint8Array([0x48, 0x53]), "badFile", /cut/u],
    [
      "a manifest that is not JSON",
      () => release({ payload, manifestText: new TextEncoder().encode("{not json") }),
      "badFile",
      /not valid/u,
    ],
    [
      "a manifest that is not UTF-8",
      () => release({ payload, manifestText: Uint8Array.from([0x7b, 0xff, 0x7d]) }),
      "badFile",
      /not UTF-8/u,
    ],
    [
      "a manifest with a field the schema does not name",
      () => release({ payload, manifest: { extra: 1 } }),
      "badFile",
      /not valid/u,
    ],
    [
      "a manifest of kind hub",
      () => release({ payload, manifest: { kind: "hub" } }),
      "badFile",
      /not valid/u,
    ],
    [
      "a signature by a key the hub does not trust",
      () => release({ payload, seed: STRANGER_SEED }),
      "badSignature",
      /no publisher key/u,
    ],
    [
      "a manifest changed after signing",
      () => {
        const file = release({ payload });
        const at = Buffer.from(file).indexOf("1.4.0");
        file[at + 4] = 0x31;
        return file;
      },
      "badSignature",
      /no publisher key/u,
    ],
    [
      "a target other than esp32s3",
      () => release({ payload, manifest: { target: "esp32c3" } }),
      "wrongTarget",
      /esp32c3/u,
    ],
    [
      "a payload whose ESP header names another chip",
      () => release({ payload: espImage({ size: 3000, chip: 5 }) }),
      "wrongTarget",
      /chip 5/u,
    ],
    [
      "a payload over the slot",
      () => release({ payload, manifest: { payloadBytes: RULES.slotBytes + 1 } }),
      "tooLarge",
      /a slot holds/u,
    ],
    [
      "a payload shorter than the manifest says",
      () => release({ payload, manifest: { payloadBytes: payload.length + 4 } }),
      "badFile",
      /the manifest says/u,
    ],
    [
      "a payload longer than the manifest says",
      () => {
        const file = release({ payload });
        const longer = new Uint8Array(file.length + 1);
        longer.set(file, 0);
        return longer;
      },
      "badFile",
      /the manifest says/u,
    ],
    [
      "a payload whose hash is not the manifest's",
      () => {
        const file = release({ payload });
        file[file.length - 100] = (file[file.length - 100] ?? 0) ^ 1;
        return file;
      },
      "badFile",
      /hash is not the manifest's/u,
    ],
    [
      "a payload that is not an ESP application image",
      () => release({ payload: new Uint8Array(3000).fill(0x55) }),
      "badFile",
      /not an ESP application image/u,
    ],
    [
      "a payload whose app description names another version",
      () => release({ payload: espImage({ size: 3000, version: "1.4.1" }) }),
      "badFile",
      /names 1\.4\.1, the manifest 1\.4\.0/u,
    ],
    [
      "a version a header cannot carry",
      () => {
        const big = espImage({ size: 3000, version: "256.0.0" });
        return release({ payload: big, manifest: { version: "256.0.0" } });
      },
      "badFile",
      /does not fit an image header/u,
    ],
  ];
  for (const [name, make, reason, message] of refusals) {
    test(`refused: ${name} (${reason}), leaving nothing`, () => {
      const run = stage(make());
      const why = refused(run);
      expect(why.reason).toBe(reason);
      expect(why.message).toMatch(message);
      expect(run.stored).toEqual([]);
    });
  }

  test("the order: the signature before the target, the target before the size, the size before the length", () => {
    expect(
      refused(stage(release({ payload, seed: STRANGER_SEED, manifest: { target: "x" } }))).reason,
    ).toBe("badSignature");
    expect(
      refused(
        stage(release({ payload, manifest: { target: "x", payloadBytes: RULES.slotBytes + 1 } })),
      ).reason,
    ).toBe("wrongTarget");
    const otherChip = espImage({ size: 3000, chip: 2 });
    expect(
      refused(
        stage(release({ payload: otherChip, manifest: { payloadBytes: RULES.slotBytes + 1 } })),
      ).reason,
    ).toBe("wrongTarget");
    expect(
      refused(stage(release({ payload, manifest: { payloadBytes: RULES.slotBytes + 1 } }))).reason,
    ).toBe("tooLarge");
  });

  test("a payload of exactly the slot's size is taken", () => {
    const whole = espImage({ size: RULES.slotBytes - 64 });
    const padded = whole.length <= RULES.slotBytes;
    expect(padded).toBe(true);
    expect(stage(release({ payload: whole })).outcome.kind).toBe("firmwareStaged");
  });
});

describe("an owner's own build", () => {
  test("is staged as an own build, for every role, signed by the hub", () => {
    const image = espImage({ size: 70_000, version: "2.0.1", seed: 9 });
    const run = stage(image, "2.0.1");
    expect(run.outcome.kind).toBe("firmwareStaged");
    if (run.outcome.kind !== "firmwareStaged") return;
    expect(run.outcome.image.kind).toBe(ImageKind.OwnBuild);
    expect(run.outcome.image.manifest).toBeNull();
    expect(run.outcome.image.roles).toBe(14);
    expect(run.outcome.image.version).toBe(2 * 65_536 + 1);
    expect(run.outcome.image.bytes).toBe(image.length);
    expect(decodeImageHeader(run.outcome.image.header)).toMatchObject({
      ok: true,
      value: { flags: { ownBuild: true } },
    });
    expect(verifyImageHeader(run.outcome.image.header, publicKey)).toBe(true);
    expect(
      new Uint8Array(readFileSync(join(storeFolder(run.dataDir), run.outcome.image.file))),
    ).toEqual(new Uint8Array(image));
  });

  test("of exactly the slot's size, and with several segments", () => {
    expect(stage(espImage({ size: RULES.slotBytes - 64 }), "1.4.0").outcome.kind).toBe(
      "firmwareStaged",
    );
    expect(stage(espImage({ segments: 5 }), "1.4.0").outcome.kind).toBe("firmwareStaged");
  });

  const good = espImage({ size: 9000, version: "1.4.0", seed: 11 });
  const flip = (at: number) => () => {
    const o = good.slice();
    o[at] = (o[at] ?? 0) ^ 1;
    return o;
  };
  const refusals: readonly (readonly [string, () => Uint8Array, string, string, RegExp])[] = [
    ["an empty file", () => new Uint8Array(0), "1.4.0", "badFile", /not an ESP application image/u],
    ["a magic byte other than 0xE9", flip(0), "1.4.0", "badFile", /not an ESP application image/u],
    ["an image for another chip", () => espImage({ chip: 5 }), "1.4.0", "wrongTarget", /chip 5/u],
    [
      "an image over the slot",
      () => espImage({ size: RULES.slotBytes + 64 }),
      "1.4.0",
      "tooLarge",
      /a slot holds/u,
    ],
    [
      "a version other than the app description's",
      () => good,
      "1.4.1",
      "badFile",
      /names 1\.4\.0, not 1\.4\.1/u,
    ],
    [
      "no app description",
      () => espImage({ appDescMagic: 0 }),
      "1.4.0",
      "badFile",
      /names no version/u,
    ],
    [
      "a version a header cannot carry",
      () => espImage({ version: "1.256.0" }),
      "1.256.0",
      "badFile",
      /does not fit/u,
    ],
    ["a wrong checksum", flip(5000), "1.4.0", "badFile", /checksum is wrong/u],
    ["a wrong appended hash", flip(good.length - 1), "1.4.0", "badFile", /appended hash is wrong/u],
    ["a cut image", () => good.slice(0, -10), "1.4.0", "badFile", /cut short/u],
    [
      "bytes after the image",
      () => {
        const o = new Uint8Array(good.length + 16);
        o.set(good, 0);
        return o;
      },
      "1.4.0",
      "badFile",
      /bytes after the image/u,
    ],
    [
      "a segment not whole words",
      () => {
        const o = good.slice();
        const view = new DataView(o.buffer);
        view.setUint32(28, view.getUint32(28, true) - 2, true);
        return o;
      },
      "1.4.0",
      "badFile",
      /not whole words/u,
    ],
  ];
  for (const [name, make, version, reason, message] of refusals) {
    test(`refused: ${name} (${reason}), leaving nothing`, () => {
      const run = stage(make(), version);
      const why = refused(run);
      expect(why.reason).toBe(reason);
      expect(why.message).toMatch(message);
      expect(run.stored).toEqual([]);
    });
  }

  test("the order: the chip before the size, the size before the version", () => {
    expect(refused(stage(espImage({ chip: 3, size: RULES.slotBytes + 64 }), "9.9.9")).reason).toBe(
      "wrongTarget",
    );
    expect(refused(stage(espImage({ size: RULES.slotBytes + 64 }), "9.9.9")).reason).toBe(
      "tooLarge",
    );
  });

  test("a publisher's release given as an own build is not an ESP image", () => {
    expect(refused(stage(release({ payload: good }), "1.4.0")).reason).toBe("badFile");
  });
});

describe("the store's room, and the hub's key", () => {
  function fill(dataDir: string, files: number, bytes: number): void {
    const folder = storeFolder(dataDir);
    mkdirSync(folder, { recursive: true });
    for (let i = 0; i < files; i++)
      writeFileSync(join(folder, `${hex(sha256(Uint8Array.of(i)))}.bin`), new Uint8Array(bytes));
  }

  test("four images already: storeFull, the store as it was", () => {
    const run = stage(espImage(), "1.4.0", (dataDir) => {
      fill(dataDir, 4, 10);
    });
    expect(refused(run).reason).toBe("storeFull");
    expect(run.stored).toHaveLength(4);
  });

  test("three images and too many bytes: storeFull; three small ones: staged", () => {
    const image = espImage({ size: 100_000 });
    const over = RULES.storeMaxBytes - image.length + 1;
    const full = stage(image, "1.4.0", (dataDir) => {
      fill(dataDir, 1, over);
    });
    expect(refused(full).reason).toBe("storeFull");
    const fits = stage(image, "1.4.0", (dataDir) => {
      fill(dataDir, 1, over - 1);
    });
    expect(fits.outcome.kind).toBe("firmwareStaged");
    expect(
      stage(image, "1.4.0", (dataDir) => {
        fill(dataDir, 3, 10);
      }).outcome.kind,
    ).toBe("firmwareStaged");
  });

  test("the same image as one stored, with four stored: replaced, not refused", () => {
    const image = espImage();
    const run = stage(image, "1.4.0", (dataDir) => {
      fill(dataDir, 3, 10);
      writeFileSync(join(storeFolder(dataDir), `${hex(sha256(image))}.bin`), new Uint8Array(1));
    });
    expect(run.outcome.kind).toBe("firmwareStaged");
    expect(run.stored).toHaveLength(4);
  });

  test("a hub without its key: failed, nothing left", () => {
    const { dataDir, upload } = setup();
    writeFileSync(upload, espImage());
    const job = staging(dataDir, upload, "1.4.0", {
      signer: () => err("the hub has no signing key yet"),
    });
    const outcome = toEnd(job).outcome;
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: "io",
      message: "the hub has no signing key yet",
    });
    expect(existsSync(storeFolder(dataDir))).toBe(false);
  });

  test("an upload that is not there: unreachable", () => {
    const { dataDir, upload } = setup();
    expect(toEnd(staging(dataDir, upload, null)).outcome).toMatchObject({
      kind: "failed",
      reason: "unreachable",
    });
  });

  test("an upload changed between the passes: refused, nothing left", () => {
    const { dataDir, upload } = setup();
    const image = espImage({ size: 600_000 });
    writeFileSync(upload, image);
    const job = staging(dataDir, upload, "1.4.0");
    while (job.phase !== "copy") expect(job.next()).toBeUndefined();
    const changed = image.slice();
    changed[500_000] = (changed[500_000] ?? 0) ^ 1;
    writeFileSync(upload, changed);
    const outcome = toEnd(job).outcome;
    expect(outcome).toMatchObject({
      kind: "failed",
      message: "the upload changed while it was staged",
    });
    expect(readdirSync(storeFolder(dataDir))).toEqual([]);
  });
});

describe("a stop, and a power cut, at every piece", () => {
  const image = espImage({ size: 700_000, seed: 21 });
  const file = release({ payload: image });

  test("a stop at any piece removes what it wrote", () => {
    for (let stopAfter = 0; ; stopAfter++) {
      const { dataDir, upload } = setup();
      writeFileSync(upload, file);
      const job = staging(dataDir, upload, null);
      let outcome: FileOutcome | undefined;
      for (let piece = 0; piece < stopAfter && outcome === undefined; piece++) outcome = job.next();
      if (outcome !== undefined) {
        expect(outcome.kind).toBe("firmwareStaged");
        break;
      }
      const placed = job.phase === "syncFolder";
      expect(job.abort("the hub is stopping")).toMatchObject({ kind: "failed" });
      const left = existsSync(storeFolder(dataDir)) ? readdirSync(storeFolder(dataDir)) : [];
      // Before the rename nothing stays; after it, the placed file holds exactly the checked bytes.
      expect(left).toEqual(placed ? [`${hex(sha256(image))}.bin`] : []);
    }
  });

  test("a power cut at any piece: the check at start keeps nothing unindexed, and the file stages after", () => {
    let cuts = 0;
    for (let stopAfter = 1; ; stopAfter++) {
      const { dataDir, upload } = setup();
      writeFileSync(upload, file);
      const job = staging(dataDir, upload, null);
      let outcome: FileOutcome | undefined;
      for (let piece = 0; piece < stopAfter && outcome === undefined; piece++) outcome = job.next();
      if (outcome !== undefined) {
        // Staged, but the core's row never committed (the power went before it): not indexed.
        const check = checkStore(dataDir, [])._unsafeUnwrap();
        expect(check.removed).toEqual([`${hex(sha256(image))}.bin`]);
        expect(readdirSync(storeFolder(dataDir))).toEqual([]);
        break;
      }
      cuts++;
      // The job is simply gone: no abort. The next start's check cleans up.
      const check = checkStore(dataDir, [])._unsafeUnwrap();
      expect(check.damaged).toEqual([]);
      expect(readdirSync(storeFolder(dataDir))).toEqual([]);
      // And the same file stages from the start again.
      const again = toEnd(staging(dataDir, upload, null)).outcome;
      expect(again.kind).toBe("firmwareStaged");
    }
    // The cuts fell before the hash, in both passes, at the sync, the rename and the folder's sync.
    expect(cuts).toBeGreaterThanOrEqual(8);
  });
});

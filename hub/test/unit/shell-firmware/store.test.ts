/**
 * The store's folder (`shell/firmware/store.ts`; docs/m3-updates-design.md section 4): the index
 * read from a real migrated database; the check at start in each way a store can be damaged, one
 * `firmwareStoreDamaged` per damaged image; what no live row names deleted; the file removed when
 * the core says, with a power cut after each step of the removal; never in a backup.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { mono, type Now } from "../../../src/core/model/time.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { imageId } from "../../../src/core/model/ids.ts";
import { ImageKind, type FirmwareImageRow } from "../../../src/core/model/rows.ts";
import type { Clock } from "../../../src/ports/clock.ts";
import { backupDatabase } from "../../../src/shell/backup/contents.ts";
import {
  checkStore,
  imageFileName,
  imagePath,
  indexedImages,
  removalSteps,
  removeImageFile,
  storeFolder,
} from "../../../src/shell/firmware/store.ts";
import { openStore } from "../../../src/shell/storage/store.ts";
import { espImage, sha256, type TempFolder, tempFolder } from "./support.ts";

/** An index naming no file. */
const NOT_INDEXED = () => ok(false);

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "drizzle");
const folders: TempFolder[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) folder.remove();
});

class FixedClock implements Clock {
  now(): Now {
    return { mono: mono(1), wall: Date.UTC(2026, 10, 18), wallTrusted: true };
  }
}

function dataFolder(): string {
  const folder = tempFolder("store");
  folders.push(folder);
  return join(folder.path, "data");
}

/** An image stored as staging leaves it: its file under its hash. */
function stored(
  dataDir: string,
  image: Uint8Array,
): { readonly file: string; readonly sha: Uint8Array } {
  const sha = sha256(image);
  const file = imageFileName(sha);
  mkdirSync(storeFolder(dataDir), { recursive: true });
  writeFileSync(join(storeFolder(dataDir), file), image);
  return { file, sha };
}

function row(
  id: number,
  file: string,
  sha: Uint8Array,
  removedMs: number | null = null,
): FirmwareImageRow {
  return {
    id: imageId(id),
    imageId: sha.slice(0, 8),
    sha256: sha,
    version: 65_536,
    kind: ImageKind.OwnBuild,
    roles: 14,
    bytes: 4096,
    header: new Uint8Array(128),
    manifest: null,
    file,
    addedMs: 1,
    addedBy: "test",
    removedMs,
  };
}

describe("the index", () => {
  test("the images not removed, from `firmware_images`, in their order", () => {
    const dataDir = dataFolder();
    const store = openStore({
      dataDir,
      migrationsFolder: MIGRATIONS,
      clock: new FixedClock(),
      rules: DEFAULT_RULES,
      platform: process.platform,
    })._unsafeUnwrap();
    const a = sha256(Uint8Array.of(1));
    const b = sha256(Uint8Array.of(2));
    const c = sha256(Uint8Array.of(3));
    store.writer.stage(
      [row(2, "b.bin", b), row(1, "a.bin", a), row(3, "c.bin", c, 5)].map((r) => ({
        kind: "write" as const,
        durability: "now" as const,
        op: { table: "firmware_images" as const, op: "upsert" as const, row: r },
      })),
    );
    expect(store.writer.flush("now").isOk()).toBe(true);
    expect(indexedImages(store.db)._unsafeUnwrap()).toEqual([
      { id: imageId(1), file: "a.bin", sha256: a },
      { id: imageId(2), file: "b.bin", sha256: b },
    ]);
    // Never in a backup: the backup's database holds no firmware table and no image bytes.
    const backup = backupDatabase(store.db)._unsafeUnwrap();
    expect(Buffer.from(backup).includes(Buffer.from("firmware_images"))).toBe(false);
    expect(Buffer.from(backup).includes(Buffer.from(a))).toBe(false);
    store.db.close(true);
  });
});

describe("the check at start", () => {
  test("a whole store: nothing damaged, nothing removed", () => {
    const dataDir = dataFolder();
    const one = stored(dataDir, espImage({ seed: 1 }));
    const two = stored(dataDir, espImage({ seed: 2 }));
    const check = checkStore(dataDir, [
      { id: imageId(1), file: one.file, sha256: one.sha },
      { id: imageId(2), file: two.file, sha256: two.sha },
    ])._unsafeUnwrap();
    expect(check).toEqual({ damaged: [], removed: [] });
    expect(readdirSync(storeFolder(dataDir)).toSorted()).toEqual([one.file, two.file].toSorted());
  });

  test("no folder yet: made, the hub account's alone", () => {
    const dataDir = dataFolder();
    expect(checkStore(dataDir, [])._unsafeUnwrap()).toEqual({ damaged: [], removed: [] });
    expect(existsSync(storeFolder(dataDir))).toBe(true);
  });

  // Each way an indexed image's file can be wrong, one damaged image each, the others whole.
  const ways: readonly (readonly [
    string,
    (path: string, image: Uint8Array) => void,
    "missing" | "wrongHash",
  ])[] = [
    [
      "the file deleted",
      (path) => {
        writeFileSync(path, new Uint8Array(0));
        rmSync(path);
      },
      "missing",
    ],
    [
      "one byte changed",
      (path, image) => {
        const changed = image.slice();
        changed[100] = (changed[100] ?? 0) ^ 1;
        writeFileSync(path, changed);
      },
      "wrongHash",
    ],
    [
      "cut short",
      (path, image) => {
        writeFileSync(path, image.subarray(0, image.length - 1));
      },
      "wrongHash",
    ],
    [
      "longer",
      (path, image) => {
        writeFileSync(path, new Uint8Array([...image, 0]));
      },
      "wrongHash",
    ],
    [
      "emptied",
      (path) => {
        writeFileSync(path, new Uint8Array(0));
      },
      "wrongHash",
    ],
    [
      "a folder in its place",
      (path) => {
        rmSync(path);
        mkdirSync(path);
      },
      "missing",
    ],
  ];
  for (const [name, damage, problem] of ways) {
    test(`${name}: ${problem}`, () => {
      const dataDir = dataFolder();
      const whole = stored(dataDir, espImage({ seed: 1 }));
      const image = espImage({ seed: 2 });
      const hurt = stored(dataDir, image);
      damage(join(storeFolder(dataDir), hurt.file), image);
      const check = checkStore(dataDir, [
        { id: imageId(1), file: whole.file, sha256: whole.sha },
        { id: imageId(7), file: hurt.file, sha256: hurt.sha },
      ])._unsafeUnwrap();
      expect(check.damaged).toEqual([{ image: imageId(7), problem }]);
    });
  }

  test("a file the hub cannot read: missing", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const dataDir = dataFolder();
    const hurt = stored(dataDir, espImage());
    chmodSync(join(storeFolder(dataDir), hurt.file), 0o000);
    expect(
      checkStore(dataDir, [{ id: imageId(3), file: hurt.file, sha256: hurt.sha }])._unsafeUnwrap()
        .damaged,
    ).toEqual([{ image: imageId(3), problem: "missing" }]);
    chmodSync(join(storeFolder(dataDir), hurt.file), 0o600);
  });

  test("a row naming a file that is not one of the store's: missing, and nothing outside read", () => {
    const dataDir = dataFolder();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "hub.db"), "not ours");
    const sha = sha256(new TextEncoder().encode("not ours"));
    expect(
      checkStore(dataDir, [{ id: imageId(4), file: "../hub.db", sha256: sha }])._unsafeUnwrap()
        .damaged,
    ).toEqual([{ image: imageId(4), problem: "missing" }]);
    expect(imagePath(dataDir, "../hub.db")).toBeUndefined();
    expect(imagePath(dataDir, `${"a".repeat(64)}.bin`)).toBe(
      join(storeFolder(dataDir), `${"a".repeat(64)}.bin`),
    );
    expect(imagePath(dataDir, `${"A".repeat(64)}.bin`)).toBeUndefined();
  });

  test("every damaged image is told, each once", () => {
    const dataDir = dataFolder();
    const a = stored(dataDir, espImage({ seed: 1 }));
    const b = stored(dataDir, espImage({ seed: 2 }));
    writeFileSync(join(storeFolder(dataDir), a.file), new Uint8Array(3));
    rmSync(join(storeFolder(dataDir), b.file));
    expect(
      checkStore(dataDir, [
        { id: imageId(1), file: a.file, sha256: a.sha },
        { id: imageId(2), file: b.file, sha256: b.sha },
      ])._unsafeUnwrap().damaged,
    ).toEqual([
      { image: imageId(1), problem: "wrongHash" },
      { image: imageId(2), problem: "missing" },
    ]);
  });

  test("temporary files and files no live row names are deleted; anything else is left", () => {
    const dataDir = dataFolder();
    const live = stored(dataDir, espImage({ seed: 1 }));
    const orphan = stored(dataDir, espImage({ seed: 2 }));
    const folder = storeFolder(dataDir);
    writeFileSync(join(folder, ".staging-2147483649"), new Uint8Array(10));
    writeFileSync(join(folder, "README"), "a person's own file");
    const check = checkStore(dataDir, [
      { id: imageId(1), file: live.file, sha256: live.sha },
    ])._unsafeUnwrap();
    expect(check.damaged).toEqual([]);
    expect(check.removed.toSorted()).toEqual([".staging-2147483649", orphan.file].toSorted());
    expect(readdirSync(folder).toSorted()).toEqual([live.file, "README"].toSorted());
  });
});

describe("removal", () => {
  test("the file goes; a file already gone is no error; a name not the store's is refused", () => {
    const dataDir = dataFolder();
    const one = stored(dataDir, espImage());
    expect(removeImageFile(dataDir, one.file, NOT_INDEXED).isOk()).toBe(true);
    expect(readdirSync(storeFolder(dataDir))).toEqual([]);
    expect(removeImageFile(dataDir, one.file, NOT_INDEXED).isOk()).toBe(true);
    writeFileSync(join(dataDir, "hub.db"), "keep me");
    expect(removeImageFile(dataDir, "../hub.db", NOT_INDEXED)._unsafeUnwrapErr().reason).toBe(
      "badFile",
    );
    expect(readFileSync(join(dataDir, "hub.db"), "utf8")).toBe("keep me");
  });

  test("decided when the file is deleted: a file the index names now stays; an index not read keeps it", () => {
    const dataDir = dataFolder();
    const one = stored(dataDir, espImage());
    const asked: string[] = [];
    const steps = removalSteps(dataDir, one.file, (file) => {
      asked.push(file);
      return ok(true);
    })._unsafeUnwrap();
    // Nothing is asked before the step that deletes runs.
    expect(asked).toEqual([]);
    for (const step of steps) expect(step().isOk()).toBe(true);
    expect(asked).toEqual([one.file]);
    expect(readdirSync(storeFolder(dataDir))).toEqual([one.file]);
    const unread = removeImageFile(dataDir, one.file, () => err("the database is locked"));
    expect(unread._unsafeUnwrapErr()).toEqual({ reason: "io", message: "the database is locked" });
    expect(readdirSync(storeFolder(dataDir))).toEqual([one.file]);
  });

  test("a power cut after each step: the next start's check leaves the store without the file", () => {
    const steps = removalSteps("/x", `${"0".repeat(64)}.bin`, NOT_INDEXED)._unsafeUnwrap();
    for (let done = 0; done <= steps.length; done++) {
      const dataDir = dataFolder();
      const keep = stored(dataDir, espImage({ seed: 1 }));
      const gone = stored(dataDir, espImage({ seed: 2 }));
      for (const step of removalSteps(dataDir, gone.file, NOT_INDEXED)
        ._unsafeUnwrap()
        .slice(0, done))
        expect(step().isOk()).toBe(true);
      // The core committed the row's removal before the job: only `keep` is indexed.
      const check = checkStore(dataDir, [
        { id: imageId(1), file: keep.file, sha256: keep.sha },
      ])._unsafeUnwrap();
      expect(check.damaged).toEqual([]);
      expect(readdirSync(storeFolder(dataDir))).toEqual([keep.file]);
    }
  });
});

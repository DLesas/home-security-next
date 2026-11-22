/**
 * An image's file removed off the loop (`shell/firmware/remove-job.ts`, `FileRemoval`): the file
 * unlinked, then the store's folder synced, both settled before the outcome; a failure of either
 * is the outcome; a stop is the stop's failure whatever had come. Its wiring through the app side
 * is `shell-app/worker-jobs.test.ts`'s.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { imageId } from "../../../src/core/model/ids.ts";
import { FileRemoval } from "../../../src/shell/firmware/remove-job.ts";
import { type TempFolder, tempFolder } from "./support.ts";

const folders: TempFolder[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) folder.remove();
});

const STOPPED = { kind: "failed", reason: "io", message: "the hub is stopping" } as const;

/** A store folder with one file in it. */
function store(): { readonly folder: string; readonly file: string } {
  const made = tempFolder("remove-job");
  folders.push(made);
  const folder = join(made.path, "firmware");
  mkdirSync(folder);
  const file = join(folder, "a.bin");
  writeFileSync(file, "an image");
  return { folder, file };
}

/** The removal's outcome, once it has woken the loop (within 5 s). */
async function ended(removal: FileRemoval, woken: Promise<unknown>): Promise<FileOutcome> {
  expect(await Promise.race([woken.then(() => true), Bun.sleep(5000).then(() => false)])).toBe(
    true,
  );
  return removal.next() ?? { kind: "failed", reason: "io", message: "no outcome" };
}

describe("an image's file removed off the loop", () => {
  test("unlinked and the folder synced, then firmwareRemoved", async () => {
    const { folder, file } = store();
    const woken = Promise.withResolvers<undefined>();
    const removal = new FileRemoval(file, folder, imageId(3), () => {
      woken.resolve(undefined);
    });
    expect(await ended(removal, woken.promise)).toEqual({
      kind: "firmwareRemoved",
      image: imageId(3),
    });
    expect(existsSync(file)).toBe(false);
  });

  // Windows has no folder sync (`safe/firmware-io.ts`): there it is nothing to fail.
  test.skipIf(process.platform === "win32")(
    "the folder's sync is part of it: a folder that cannot be synced is the outcome, not firmwareRemoved",
    async () => {
      const { folder, file } = store();
      const woken = Promise.withResolvers<undefined>();
      const removal = new FileRemoval(file, join(folder, "not-there"), imageId(3), () => {
        woken.resolve(undefined);
      });
      const outcome = await ended(removal, woken.promise);
      expect(outcome).toMatchObject({ kind: "failed", reason: "unreachable" });
      expect(outcome.kind === "failed" ? outcome.message : "").toContain("sync");
      expect(existsSync(file)).toBe(false);
    },
  );

  test("a stop after the outcome came, before the loop took it: the stop's failure, not the outcome", async () => {
    const { folder, file } = store();
    const woken = Promise.withResolvers<undefined>();
    const removal = new FileRemoval(file, folder, imageId(3), () => {
      woken.resolve(undefined);
    });
    await woken.promise;
    expect(removal.waiting()).toBe(false);
    expect(removal.abort("the hub is stopping")).toEqual(STOPPED);
    expect(removal.next()).toEqual(STOPPED);
  });

  test("a stop before it settled: the stop's failure, and no wake after it", async () => {
    const { folder, file } = store();
    let wakes = 0;
    const removal = new FileRemoval(file, folder, imageId(3), () => {
      wakes += 1;
    });
    expect(removal.abort("the hub is stopping")).toEqual(STOPPED);
    await Bun.sleep(200);
    expect(wakes).toBe(0);
    expect(removal.next()).toEqual(STOPPED);
  });
});

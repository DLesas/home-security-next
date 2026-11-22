import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import published from "../../../packages/protocol/vectors/relay-push.json";

/** Verify the bytes delivered to the simulator, including the corrupt control. */
test("uniform outer alert, published h and exactly one changed ciphertext byte", async () => {
  const dir = mkdtempSync(join(tmpdir(), "s5-vectors-"));
  const run = Bun.spawnSync(["bun", join(import.meta.dir, "vectors.ts"), dir]);
  expect(run.exitCode).toBe(0);
  const good = await Bun.file(join(dir, "v0.apns")).json();
  const bad = await Bun.file(join(dir, "changed-byte.apns")).json();
  expect(good).toEqual({
    aps: { alert: { "loc-key": "push.placeholder" }, "mutable-content": 1, sound: "default" },
    h: published.seal[0]!.h,
  });
  const [version, id, sealed] = good.h.split(".");
  const bytes = Buffer.from(sealed, "base64url");
  bytes[12] = bytes[12]! ^ 1;
  expect(bad).toEqual({ ...good, h: [version, id, bytes.toString("base64url")].join(".") });
  rmSync(dir, { recursive: true });
});

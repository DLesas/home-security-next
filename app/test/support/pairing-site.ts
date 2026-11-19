/** Test-only site setup for real hub processes that accept Bluetooth pairing. */
import { join } from "node:path";
import type { StoreOp } from "../../../hub/src/core/model/store";
import { DEFAULT_RULES } from "../../../hub/src/core/model/rules";
import { SystemClock } from "../../../hub/src/shell/clock/system-clock";
import { openStore } from "../../../hub/src/shell/storage/store";
import { siteRowAt } from "../../../hub/test/scenarios/sensors/bench";

/** Supplies a surveyed radio channel while leaving the actual pairing to the running hub. */
export function seedPairingSite(dataDir: string, extra: readonly StoreOp[] = []): boolean {
  const store = openStore({
    dataDir,
    migrationsFolder: join(import.meta.dirname, "../../../hub/drizzle"),
    clock: new SystemClock({ wallTrusted: () => true }),
    rules: DEFAULT_RULES,
    platform: process.platform,
  });
  if (store.isErr()) return false;
  const { db, writer } = store.value;
  writer.stage([
    ...extra.map((op) => ({ kind: "write" as const, durability: "now" as const, op })),
    { kind: "write", durability: "now", op: { table: "site", op: "upsert", row: siteRowAt(5) } },
  ]);
  const flushed = writer.flush("now").isOk();
  const stopped = writer.stop().isOk();
  db.close();
  return flushed && stopped;
}

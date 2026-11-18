/**
 * The control protocol's additions of the joint step 0 (docs/m3-m4-plan.md): the lockstep hub's
 * test-only `benchRestore {file, key}` (m3-updates-design section 7), which the core refuses as
 * not built until U10 and K1 build it.
 */
import { describe, expect, test } from "bun:test";
import { controlCommand } from "../../../src/control-protocol/index.ts";
import { Driver, onlyReply, snapshot } from "../setup/support/driver.ts";
import { makeCore, MODULES } from "../../../src/core/step.ts";
import { connId, requestId } from "../../../src/core/model/ids.ts";

const KEY = "A".repeat(42) + "E";

describe("benchRestore", () => {
  test("takes a file and a 32-byte backup key, and nothing else", () => {
    const good = { kind: "benchRestore", file: "/tmp/b.hsnb", key: KEY };
    expect(controlCommand.safeParse(good).success).toBe(true);
    expect(controlCommand.safeParse({ ...good, file: "" }).success).toBe(false);
    expect(controlCommand.safeParse({ ...good, key: KEY.slice(1) }).success).toBe(false);
    expect(controlCommand.safeParse({ ...good, key: `${KEY}A` }).success).toBe(false);
    expect(controlCommand.safeParse({ ...good, key: `${KEY.slice(1)}+` }).success).toBe(false);
    expect(controlCommand.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });

  test("is refused notBuilt by the core until it is built", () => {
    const driver = new Driver(makeCore(MODULES));
    driver.boot(snapshot());
    const reply = onlyReply(
      driver.input({
        kind: "command",
        request: requestId(1),
        conn: connId(1),
        actor: "bench",
        command: { kind: "benchRestore", file: "/tmp/b.hsnb", key: KEY },
      }),
    );
    expect(reply.ok ? "ok" : reply.error.code).toBe("notBuilt");
  });
});

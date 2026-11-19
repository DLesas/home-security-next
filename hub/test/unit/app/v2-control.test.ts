/**
 * `hsn op` for version 2's operations of M2's modules (the coordinator's follow-up 3): routed as a
 * session's are (`control/translate.ts`), with the hub computer's every permission (HD 9). The
 * phone's own operations and `pair.*` are not the hub computer's: the control protocol refuses
 * them before the core (`controlCommand`'s `op`, `CONTROL_OPS_V2`).
 */
import { describe, expect, test } from "bun:test";
import { controlCommand } from "../../../src/control-protocol/index.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import { PhoneHub } from "./support/phone-hub.ts";

function answer(effects: readonly Effect[]) {
  const replies = effects.flatMap((e) => (e.kind === "respond" ? [e.reply] : []));
  expect(replies).toHaveLength(1);
  return replies[0];
}

describe("hsn op, version 2's rows of upkeep", () => {
  test("update.offers is upkeep's answer, not notBuilt", () => {
    const hub = new PhoneHub().boot();
    const reply = answer(hub.command({ kind: "op", operation: { op: "update.offers", body: {} } }));
    expect(reply).toMatchObject({ ok: true, result: { kind: "op", body: { offer: null } } });
  });

  test("update.fetch reaches upkeep: refused for a version not offered, as upkeep refuses it", () => {
    const hub = new PhoneHub().boot();
    const reply = answer(
      hub.command({ kind: "op", operation: { op: "update.fetch", body: { version: "9.9.9" } } }),
    );
    expect(JSON.stringify(reply)).not.toContain("notBuilt");
    expect(reply?.ok).toBe(false);
  });
});

describe("what is not the hub computer's", () => {
  test.each(["pair.prepare", "pair.finish", "presence.set", "backup.keyHeld", "push.register"])(
    "%s is refused by the control protocol",
    (op) => {
      expect(controlCommand.safeParse({ kind: "op", op, body: {} }).success).toBe(false);
    },
  );
});

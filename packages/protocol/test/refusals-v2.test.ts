/**
 * The frozen refusal table of channel version 2 (`src/app/refusals-v2.ts`; docs/m3-m4-plan.md,
 * "Error codes"): every row of every table, written out here by hand rather than read from the
 * table, so a changed code, a changed detail, a row added or a row removed fails. The hub's
 * modules and the app's words both read this table, so a silent change would part them.
 */
import { describe, expect, test } from "bun:test";
import * as refusals from "../src/app/refusals-v2.ts";

describe("version 2's refusal table, row by row", () => {
  test("the file's tables are these six, and no others", () => {
    expect(Object.keys(refusals).toSorted()).toStrictEqual([
      "FIRMWARE_BLUETOOTH_REFUSALS",
      "FIRMWARE_FILE_REFUSALS",
      "NOT_A_PHONE",
      "OFFER_AND_ROLLOUT_REFUSALS",
      "PAIR_PREPARE_REFUSALS",
      "RELAY_SET_REFUSALS",
    ]);
  });

  test("firmware.bluetooth", () => {
    expect(refusals.FIRMWARE_BLUETOOTH_REFUSALS).toStrictEqual({
      armed: { code: "invalid", detail: { field: "device", reason: "armed" } },
      battery: { code: "invalid", detail: { field: "device", reason: "lowBattery" } },
      countdown: { code: "busy", detail: { because: "countdown" } },
      alarm: { code: "busy", detail: { because: "alarm" } },
      siteMove: { code: "busy", detail: { because: "siteMove" } },
      keyChange: { code: "busy", detail: { because: "keyChange" } },
      notPaired: { code: "invalid", detail: { field: "device", reason: "notPaired" } },
      onTrial: { code: "busy", detail: { because: "onTrial" } },
      noImage: { code: "invalid", detail: { field: "device", reason: "noImage" } },
    });
  });

  test("pair.prepare", () => {
    expect(refusals.PAIR_PREPARE_REFUSALS).toStrictEqual({
      pairedElsewhere: {
        code: "invalid",
        detail: { field: "identity", reason: "pairedElsewhere" },
      },
      alreadyOurs: { code: "invalid", detail: { field: "identity", reason: "alreadyOurs" } },
      noWifi: { code: "invalid", detail: { field: "identity", reason: "noWifi" } },
      badIdentity: { code: "invalid", detail: { field: "identity", reason: "badIdentity" } },
      provisioning: { code: "busy", detail: { because: "provisioning" } },
    });
  });

  test("a firmware file refused", () => {
    expect(refusals.FIRMWARE_FILE_REFUSALS).toStrictEqual({
      badFile: { code: "invalid", detail: { field: "job", reason: "badFile" } },
      badSignature: { code: "invalid", detail: { field: "job", reason: "badSignature" } },
      wrongTarget: { code: "invalid", detail: { field: "job", reason: "wrongTarget" } },
      tooLarge: { code: "invalid", detail: { field: "job", reason: "tooLarge" } },
      storeFull: { code: "invalid", detail: { field: "job", reason: "storeFull" } },
      notConfirmed: { code: "invalid", detail: { field: "confirmOwn", reason: "notConfirmed" } },
    });
  });

  test("offers and rollouts", () => {
    expect(refusals.OFFER_AND_ROLLOUT_REFUSALS).toStrictEqual({
      notOffered: { code: "invalid", detail: { field: "version", reason: "unknownReference" } },
      offerTooLarge: { code: "invalid", detail: { field: "version", reason: "tooLarge" } },
      rolloutOpen: { code: "busy", detail: { because: "rollout" } },
    });
  });

  test("relay.set", () => {
    expect(refusals.RELAY_SET_REFUSALS).toStrictEqual({
      format: { code: "invalid", detail: { field: "url", reason: "format" } },
      notLocal: { code: "invalid", detail: { field: "url", reason: "notLocal" } },
    });
  });

  test("a phone-only operation from a client that is not a phone", () => {
    expect(refusals.NOT_A_PHONE).toStrictEqual({ code: "unauthorized", detail: {} });
  });
});

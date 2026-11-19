/**
 * What a person is told holds an update's switch back (m2-design.md section 9, step 3; the firmware
 * module's `devicesInstalling`, m3-updates-design section 4): the shell's check after the commit
 * (`requestSwitch`) names the hold in words, the firmware's among them, and writes no note for the
 * launcher while one holds.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestSwitch, SWITCH_HOLD_WORDS } from "../../../src/shell/update/notes.ts";
import { installPaths } from "../../../launcher/src/layout.ts";

describe("a hold's words", () => {
  test("every hold has its words; a device installing firmware is named as such", () => {
    expect(Object.keys(SWITCH_HOLD_WORDS).toSorted()).toEqual([
      "alarm",
      "countdown",
      "firmwareInstall",
      "provisioning",
      "restore",
      "siteMove",
    ]);
    expect(SWITCH_HOLD_WORDS.firmwareInstall).toBe(
      "a device is installing new firmware or checking it on trial",
    );
  });

  test("requestSwitch held back by firmware: failed, in those words, and no note written", () => {
    const prefix = mkdtempSync(join(tmpdir(), "hsn-holds-"));
    mkdirSync(join(installPaths(prefix).staged, "1.1.0"), { recursive: true });
    mkdirSync(installPaths(prefix).state, { recursive: true });
    const held = requestSwitch(prefix, "1.1.0", "firmwareInstall");
    expect(held.isErr() ? held.error : undefined).toEqual({
      kind: "failed",
      reason: "io",
      message: "held back: a device is installing new firmware or checking it on trial",
    });
    expect(existsSync(installPaths(prefix).switchFile)).toBe(false);
    expect(requestSwitch(prefix, "1.1.0", undefined).isOk()).toBe(true);
    expect(existsSync(installPaths(prefix).switchFile)).toBe(true);
    rmSync(prefix, { recursive: true, force: true });
  });
});

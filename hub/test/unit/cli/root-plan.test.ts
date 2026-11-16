/**
 * No command of `hsn` keeps root (m2-design.md section 9, "The privilege boundary"): every
 * command of section 9's table, the file commands and `hsn open` drop to the hub's account after
 * starting, as the person, the helper they need; the purge is the installers' alone. A command
 * added later goes the same way: nothing in `hsn.ts` decides per command whether to drop.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rootPlan } from "../../../cli/root-plan.ts";
import { TABLE } from "./table.ts";

const words = (line: string): readonly string[] => line.split(" ").filter((w) => w !== "");

describe("hsn as root drops for every command (section 9)", () => {
  test("every command of the table: no helper, and the drop", () => {
    expect(TABLE.length).toBeGreaterThan(20);
    for (const [line] of TABLE) {
      const plan = rootPlan(words(line), 0);
      expect([line, plan.keepsRoot]).toEqual([line, false]);
    }
  });

  test("the commands that name a file: the person's helper, reading or writing", () => {
    expect(rootPlan(["update", "install", "/home/anna/r.hsnr"], 0).helper).toEqual({
      kind: "file",
      mode: "read",
      path: "/home/anna/r.hsnr",
    });
    expect(rootPlan(["restore", "/home/anna/b.hsnb"], 0).helper).toMatchObject({ mode: "read" });
    expect(rootPlan(["backup", "export", "/home/anna/b.hsnb"], 0).helper).toMatchObject({
      mode: "write",
    });
  });

  test("hsn open: the person's page helper, and the drop like every other", () => {
    const plan = rootPlan(["open"], 0);
    expect(plan.helper).toEqual({ kind: "page" });
    expect(plan.keepsRoot).toBe(false);
  });

  test("words hsn does not know still drop (they are refused after it)", () => {
    expect(rootPlan(["no-such-command"], 0).keepsRoot).toBe(false);
    expect(rootPlan(["--help"], 0).keepsRoot).toBe(false);
  });

  test("hsn.ts drops with no per-command condition", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "..", "cli", "hsn.ts"), "utf8");
    expect(source).toContain("dropTo(account.value, platform)");
    expect(source.includes("keepsRoot")).toBe(false);
    expect(source.includes("consoleToken")).toBe(false);
  });
});

/**
 * Which sirens sound for a group (D144; docs/app-design.md, "Which sirens sound"): the sentence on
 * the group's page in each state, the notice when none of its own sirens is left, and the question
 * asked first by each action of the app's that would bring that about, naming each group affected,
 * and not asked when no group is.
 */
import "./support/render";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { DeviceObject, GroupObject } from "@hsn/protocol/app";
import { groupsLeftWithout, groupsOfDetail, sirenInUse, sirensSound } from "../src/ui/siren-choice";
import type { HistoryRow } from "@hsn/protocol/app";
import { renderWith, textOf } from "./support/screens";

const groupsUi = await import("../src/ui/groups");
const detail = await import("../src/ui/device-detail");
const dialog = await import("../src/ui/siren-dialog");
const history = await import("../src/ui/history");
const { i18n, startI18n } = await import("../src/i18n");
if (!i18n.isInitialized) await startI18n();

function siren(id: number, name: string, state: DeviceObject["state"] = "contacted"): DeviceObject {
  return {
    id,
    name,
    role: "siren",
    state,
    firmware: "1.2.0",
    batteryPercent: null,
    signal: null,
    temperatureC: null,
    lastSeenMs: null,
    heardBy: null,
    health: { silent: false, batteryLow: false, tamperOpen: false, poorLink: false },
  };
}

const HALL = siren(3, "hall-siren");
const GARDEN = siren(5, "garden-siren");
const OLD = siren(6, "old-siren", "resetByOwner");
const devices = { 3: HALL, 5: GARDEN, 6: OLD };

function group(id: number, name: string, sirens: GroupObject["sirens"]): GroupObject {
  return { id, name, sensors: [], sirens, revision: 1 };
}

describe("what sounds for a group (siren-choice.ts)", () => {
  test("a siren in use: listed, and neither removed nor reset by its owner", () => {
    expect(sirenInUse(HALL)).toBe(true);
    expect(sirenInUse(OLD)).toBe(false);
    expect(sirenInUse(siren(7, "x", "removed"))).toBe(false);
    expect(sirenInUse(undefined)).toBe(false);
    expect(sirenInUse({ ...HALL, role: "sensor" })).toBe(false);
    expect(sirenInUse(siren(8, "new", "provisioning"))).toBe(true);
  });

  test("every siren by choice; its own in use; every siren when none of its own is left", () => {
    expect(sirensSound("all", devices)).toEqual({ kind: "every" });
    expect(sirensSound([3, 6], devices)).toEqual({ kind: "these", sirens: [3] });
    expect(sirensSound([6], devices)).toEqual({ kind: "noneLeft" });
    // A siren the snapshot no longer lists is gone.
    expect(sirensSound([9], devices)).toEqual({ kind: "noneLeft" });
  });

  test("removing a siren: only the groups it was the last of", () => {
    const groups = [
      group(1, "Downstairs", [3]),
      group(2, "Upstairs", [3, 5]),
      group(3, "Garden", "all"),
      group(4, "Porch", [3, 6]),
      group(5, "Shed", [6]),
    ];
    expect(groupsLeftWithout(groups, devices, 3).map((g) => g.name)).toEqual([
      "Downstairs",
      "Porch",
    ]);
    expect(groupsLeftWithout(groups, devices, 5)).toEqual([]);
    // A siren in no group's list, or a group already left with none: nothing to ask.
    expect(groupsLeftWithout(groups, devices, 6)).toEqual([]);
    expect(groupsLeftWithout([group(3, "Garden", "all")], devices, 3)).toEqual([]);
  });

  test("a record's groups: its detail, u32 little-endian each; anything else, none", () => {
    expect(groupsOfDetail("0100000002000000ffffffff")).toEqual([1, 2, 4294967295]);
    expect(groupsOfDetail("")).toEqual([]);
    expect(groupsOfDetail(null)).toEqual([]);
    expect(groupsOfDetail("010000")).toEqual([]);
    expect(groupsOfDetail("zz000000")).toEqual([]);
  });
});

describe("the group's page says which sirens sound for it", () => {
  const page = (groups: readonly GroupObject[]) =>
    renderWith(createElement(groupsUi.GroupsScreen), {
      devices,
      groups: Object.fromEntries(groups.map((g) => [g.id, g])),
    });

  test("every siren, one siren, several by name", async () => {
    expect(textOf(await page([group(1, "Downstairs", "all")]))).toContain(
      "Downstairs Every siren sounds for this group.",
    );
    expect(textOf(await page([group(1, "Downstairs", [3, 6])]))).toContain(
      "Downstairs hall-siren sounds for this group.",
    );
    const text = textOf(await page([group(1, "Downstairs", [5, 3])]));
    expect(text).toContain("garden-siren and hall-siren sound for this group.");
  });

  test("none of its own left: the ochre notice, with Choose sirens", async () => {
    const html = await page([group(1, "Downstairs", [6])]);
    expect(textOf(html)).toContain(
      "None of this group's sirens is left, so every siren sounds for it. Choose sirens",
    );
    expect(html).toContain('data-testid="group-1-none-left"');
    expect(textOf(html)).not.toContain("sounds for this group.");
  });
});

describe("the question before an action leaves a group none of its own sirens", () => {
  test("one dialog naming each group, saying what will sound, its button saying what happens", async () => {
    const html = await renderWith(
      createElement(dialog.SirenDialog, {
        title: "Remove hall-siren? It must be paired again to come back.",
        groups: [group(1, "Downstairs", [3]), group(4, "Porch", [3, 6])],
        confirm: "Remove the siren",
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
      {},
    );
    expect(html).toMatch(/role="alertdialog"/u);
    const source = readFileSync(new URL("../src/ui/siren-dialog.tsx", import.meta.url), "utf8");
    const button = /<Button\s[^>]*testID="siren-dialog-confirm"[^>]*>/u.exec(source)?.[0];
    expect(button).toContain('kind="danger"');
    const text = textOf(html);
    expect(text).toContain(
      "Downstairs and Porch will then have none of their own sirens left, so every siren will sound for them.",
    );
    expect(text).toContain("Remove the siren");
    expect(text).toContain("Cancel");
    expect(text).not.toContain("OK");
  });

  test("removing a siren: the button opens the question where a group is affected, else the plain one", async () => {
    // Rendered before the button is pressed: the affected case offers the delete that asks.
    const affected = await renderWith(createElement(detail.DeviceDetail, { id: 3 }), {
      devices,
      groups: { 1: group(1, "Downstairs", [3]) },
    });
    expect(affected).toContain('data-testid="device-remove"');
    const none = await renderWith(createElement(detail.DeviceDetail, { id: 3 }), {
      devices,
      groups: { 1: group(1, "Downstairs", "all") },
    });
    expect(none).not.toContain('data-testid="device-remove"');
    expect(textOf(none)).toContain("Delete hall-siren");
  });
});

describe("the hub's history record of it (group_sirens_gone); no notice to anyone", () => {
  const t = i18n.t.bind(i18n);
  const groups = {
    1: group(1, "Downstairs", [6]),
    2: group(2, "Shed", [6]),
    3: group(3, "Hall", "all"),
  };

  test("the history row names the groups the record holds, and says so when it holds none", () => {
    const row = {
      kind: "decision",
      row: {
        kind: "decision",
        row: { kind: "group_sirens_gone", deviceId: 6, value: null, detail: "0100000002000000" },
      },
    } as unknown as HistoryRow;
    expect(history.rowWords(t, () => true, { devices, groups }, row)).toBe(
      "old-siren was removed or reset, so Downstairs and Shed have none of their own sirens left, and every siren will sound for them.",
    );
    const bare = {
      kind: "decision",
      row: {
        kind: "decision",
        row: { kind: "group_sirens_gone", deviceId: 6, value: null, detail: null },
      },
    } as unknown as HistoryRow;
    expect(history.rowWords(t, () => true, { devices, groups }, bare)).toContain(
      "a group was left with none of its own sirens",
    );
  });

  test("no notification of it, to anyone: a hub notice is worded as any other", async () => {
    const { notificationWords } = await import("../src/ui/notifications");
    const words = notificationWords(
      t,
      { devices },
      {
        seq: 1,
        atMs: 1,
        clockOk: true,
        kind: "group_sirens_gone",
        category: "hub",
        critical: false,
        device: 6,
        cause: null,
        read: false,
        delayed: false,
      },
    );
    expect(words).not.toContain("every siren");
  });

  test("the editor says beside a chosen siren that is reset that it is not in use", () => {
    expect(t("groups.notInUse", { name: "old-siren" })).toBe("old-siren (reset, not in use)");
  });
});

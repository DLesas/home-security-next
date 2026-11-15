/**
 * Every text the app can show has English (HB27, D58), including the keys built from a value
 * (`arm.<state>`, an error's reason): the key maps of `state/words.ts`, every value of the
 * protocol's enums the screens turn into keys, and every literal `t("…")` with or without values.
 * Plural keys count when both `_one` and `_other` are there.
 */
import { describe, expect, test } from "bun:test";
import "./support/render";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AppError,
  APP_ERROR_CODES,
  clientKind,
  historyKind,
  NOTIFICATION_CATEGORIES,
  scheduleAction,
  weekday,
  deviceObject,
  doorState,
  INVALID_REASONS,
  roleValue,
  sensorArm,
} from "@hsn/protocol/app";
import { LOCAL_FAULTS } from "../src/hub/faults";
import {
  BUSY_KEYS,
  CONNECTION_FAILURE_KEYS,
  INVALID_KEYS,
  LINK_FAILURE_KEYS,
  LOCAL_FAULT_KEYS,
  NOT_FOUND_KEYS,
  PERMISSION_KEYS,
  appErrorWords,
} from "../src/state/words";

const english = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "locales", "en", "common.json"), "utf8"),
) as unknown;

function text(path: string): string | undefined {
  let at: unknown = english;
  for (const part of path.split(".")) {
    if (typeof at !== "object" || at === null || !(part in at)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return typeof at === "string" && at !== "" ? at : undefined;
}
const has = (key: string) =>
  text(key) !== undefined ||
  (text(`${key}_one`) !== undefined && text(`${key}_other`) !== undefined);

describe("every text has English", () => {
  test("the key maps", () => {
    const keys = [
      ...Object.values(LOCAL_FAULT_KEYS),
      ...Object.values(INVALID_KEYS),
      ...Object.values(BUSY_KEYS),
      ...Object.values(NOT_FOUND_KEYS),
      ...Object.values(PERMISSION_KEYS),
      ...Object.values(CONNECTION_FAILURE_KEYS),
      ...Object.values(LINK_FAILURE_KEYS),
    ];
    expect(keys.filter((k) => !has(k))).toEqual([]);
    expect(Object.keys(LOCAL_FAULT_KEYS).sort()).toEqual([...LOCAL_FAULTS].sort());
    expect(Object.keys(INVALID_KEYS).sort()).toEqual([...INVALID_REASONS].sort());
  });

  test("keys built from the protocol's values", () => {
    const built = [
      ...sensorArm.options.map((v) => `arm.${v}`),
      ...doorState.options.map((v) => `door.${v}`),
      ...roleValue.options.map((v) => `devices.role.${v}`),
      ...roleValue.options.map((v) => `added.${v}`),
      ...deviceObject.unwrap().shape.state.options.map((v) => `devices.state.${v}`),
      ...["silent", "batteryLow", "tamperOpen", "poorLink"].map((v) => `devices.health.${v}`),
      ...["no", "toThisHub", "toAnotherHub"].map((v) => `usb.paired.${v}`),
      ...[0, 1, 2].map((v) => `setup.site.channelValue.${String(v)}`),
      ...NOTIFICATION_CATEGORIES.map((v) => `notifications.category.${v}`),
      ...clientKind.options.map((v) => `people.clientKind.${v}`),
      ...scheduleAction.options.map((v) => `schedules.does.${v}`),
      ...scheduleAction.options.map((v) => `schedules.actions.${v}`),
      ...["mode", "group", "sensor"].flatMap((v) => [
        `schedules.target.${v}`,
        `schedules.noTargets.${v}`,
      ]),
      ...["hubOff", "clockNotSet", "clockStepped"].map((v) => `schedules.missedWhy.${v}`),
      ...weekday.options.map((v) => `days.${v}`),
      ...historyKind.options.map((v) => `history.kinds.${v}`),
      ...["debug", "info", "warning", "critical"].map((v) => `record.level.${v}`),
      ...["gap", "hash", "badChunk", "stalled"].map((v) => `backup.downloadFault.${v}`),
      ...["ok", "failed", "never"].map((v) => `backup.result.${v}`),
      ...["none", "healthy", "rolledBack"].map((v) => `updates.last.${v}`),
      ...["announcing", "switched", "done", "cancelled"].map((v) => `site.stage.${v}`),
      ...["groups", "modes", "schedules"].map((v) => `editing.notToldYet.${v}`),
      ...["io", "stopping"].map((v) => `backup.downloadFault.${v}`),
      ...["wrongKey", "badFile", "expired", "busy"].map(
        (v) => `backup.restoreResult.${v === "badFile" ? "wrongKey" : v}`,
      ),
    ];
    expect(built.filter((k) => !has(k))).toEqual([]);
  });

  test("every refusal the hub can give has its words", async () => {
    const { i18n, startI18n } = await import("../src/i18n");
    if (!i18n.isInitialized) await startI18n();
    const t = i18n.t.bind(i18n);
    const devices = { devices: {} };
    const errors: readonly AppError[] = [
      { code: "unauthorized", detail: {} },
      { code: "unauthorized", detail: { devices: [3] } },
      { code: "unauthorized", detail: { permission: "manageUsers" } },
      { code: "needsConfirmation", detail: { openDoors: [], lowBattery: [] } },
      { code: "conflict", detail: { revision: 1, object: { categories: [], revision: 1 } } },
      { code: "seqTooLow", detail: { last: 1 } },
      ...Object.keys(NOT_FOUND_KEYS).map(
        (what) => ({ code: "notFound", detail: { what, id: 1 } }) as AppError,
      ),
      ...INVALID_REASONS.map(
        (reason) => ({ code: "invalid", detail: { field: "", reason } }) as const,
      ),
      ...Object.keys(BUSY_KEYS).map(
        (because) => ({ code: "busy", detail: { because } }) as AppError,
      ),
      { code: "consoleOnly", detail: {} },
      { code: "unavailable", detail: {} },
      { code: "protoUnsupported", detail: { speaks: [1, 1] } },
      { code: "notBuilt", detail: { op: "x" } },
    ];
    expect(new Set(errors.map((e) => e.code))).toEqual(new Set(APP_ERROR_CODES));
    const said = errors.map((error) => appErrorWords(t, "en", devices, error));
    const looksLikeAKey = /(?:^|\s)[a-z]+(?:\.[a-zA-Z0-9]+)+(?:$|\s)/u;
    expect(said.filter((s) => s === "" || looksLikeAKey.test(s))).toEqual([]);
  });

  test("every decision kind and M2 hub event the hub records has its English (history.decision, history.event)", async () => {
    const { DECISION_KINDS, M2_HUB_EVENTS } = await import("@hsn/protocol/records");
    expect(DECISION_KINDS.filter((k) => !has(`history.decision.${k}`))).toEqual([]);
    expect(Object.keys(M2_HUB_EVENTS).filter((k) => !has(`history.event.${k}`))).toEqual([]);
  });

  test("every hub event has its words", async () => {
    const { HUB_NOTICE_KEYS } = await import("../src/ui/hub-notices");
    const { APP_EVENTS } = await import("@hsn/protocol/app");
    const whats = APP_EVENTS.hub.unwrap().shape.what.options;
    expect([...whats].map(String).sort()).toEqual(Object.keys(HUB_NOTICE_KEYS).sort());
    expect(Object.values(HUB_NOTICE_KEYS).filter((k) => !has(k))).toEqual([]);
  });

  test("every literal key the code names, with or without values", () => {
    const src = join(import.meta.dir, "..", "src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.tsx?$/u.test(f),
    );
    const used = files.flatMap((file) =>
      [
        ...readFileSync(join(src, file), "utf8").matchAll(
          /\bt\(\s*"([^"]+)"|label: t\(\s*"([^"]+)"/gu,
        ),
      ].map((m) => m[1] ?? m[2] ?? ""),
    );
    expect(used.length).toBeGreaterThan(100);
    expect(used.filter((k) => !has(k))).toEqual([]);
  });
});

/**
 * The joint step 0 of M3 and M4 (docs/m3-m4-plan.md): the two new modules sit at the places the
 * plan gives them and are wired into the core's `step`, which hands them every message in that
 * order; every operation of channel version 2 has its owner; the new events reach the core without
 * a fault; the rule values are the designs'; and the model's later additions (the approved changes
 * to step 0's interfaces) hold what they say. What the two modules do is their owners' to test
 * (`hub/test/unit/firmware`, `hub/test/unit/relay-core`), not step 0's.
 */
import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { MessageType, Role, type StartedImage, UpdateReason } from "@hsn/protocol";
import {
  APP_EVENTS_V2,
  APP_OP_NAMES,
  APP_OP_NAMES_V2,
  APP_OPS,
  APP_OPS_V2,
  type AppEventBodyV2,
  appError,
  FIRMWARE_BLUETOOTH_REFUSALS,
  NEW_OPS_V2,
  ROLLOUT_PAUSE_REASONS,
  UPDATE_REASONS,
} from "@hsn/protocol/app";
import { GoneReason } from "@hsn/protocol/update";
import { CONTROL_OPS, CONTROL_OPS_V2, controlReply } from "../../../src/control-protocol/index.ts";
import { handleFirmware } from "../../../src/core/firmware/handle.ts";
import { EMPTY_FIRMWARE_SLICE } from "../../../src/core/firmware/state.ts";
import { firmwareSlice } from "../../../src/core/firmware/view.ts";
import {
  EFFECT_KINDS,
  type Effect,
  type TransferRevokeReason,
} from "../../../src/core/model/effects.ts";
import {
  EMPTY_M3M4_SNAPSHOT,
  type FirmwareStoreProblem,
  type HubEvent,
} from "../../../src/core/model/events.ts";
import {
  deviceId,
  type ImageId,
  imageId,
  JOB_RANGES,
  jobId,
  jobOwner,
  linkId,
  outboxId,
  seq,
} from "../../../src/core/model/ids.ts";
import type {
  DeviceUpdateEventBody,
  Internal,
  OpOutcome,
} from "../../../src/core/model/messages.ts";
import {
  M2_MODULES,
  M3M4_MODULES,
  MODULE_ORDER,
  type ModuleName,
} from "../../../src/core/model/modules.ts";
import { m2OwnerOf, m3m4OwnerOf, OP_OWNERS } from "../../../src/core/model/ops.ts";
import {
  NO_CONTACT_REASON,
  PILOT_FAILED_REASON,
  ROLLED_BACK_REASON,
} from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { replyOf } from "../../../src/core/people/replies.ts";
import { handleRelay } from "../../../src/core/relay/handle.ts";
import { EMPTY_RELAY_SLICE } from "../../../src/core/relay/state.ts";
import { relaySlice } from "../../../src/core/relay/view.ts";
import {
  emptyState,
  makeCore,
  type ModuleDefinition,
  type Modules,
  MODULES,
} from "../../../src/core/step.ts";
import { EMPTY_UPKEEP_SLICE } from "../../../src/core/upkeep/state.ts";
import type { Transfers } from "../../../src/ports/transfers.ts";
import { Driver, snapshot } from "../setup/support/driver.ts";

/** True when each type is assignable to the other: the same values, the type check says. */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

/** Which module took which message, in the order `step` handed them out. */
type Call = readonly [ModuleName, Internal["kind"]];

/** A module's definition whose handler notes each message it is given, then handles it. */
function spied<K extends ModuleName>(
  name: K,
  calls: Call[],
  definition: ModuleDefinition<K>,
): ModuleDefinition<K> {
  return {
    ...definition,
    handle: (slice, message, ctx) => {
      calls.push([name, message.kind]);
      return definition.handle(slice, message, ctx);
    },
  };
}

/** A real module, spied on. */
function spiedReal<K extends ModuleName>(name: K, calls: Call[]): ModuleDefinition<K> {
  return spied(name, calls, MODULES[name]);
}

/** The real twenty-two modules, each spied on; `firmware` replaced when a test gives one. */
function spiedModules(calls: Call[], firmware?: ModuleDefinition<"firmware">): Modules {
  const modules: Record<string, unknown> = {};
  for (const name of MODULE_ORDER) modules[name] = spiedReal(name, calls);
  if (firmware !== undefined) modules.firmware = spied("firmware", calls, firmware);
  return modules as Modules;
}

/** The modules that took messages of `kind`, in order. */
function takers(calls: readonly Call[], kind: Internal["kind"]): readonly ModuleName[] {
  return calls.filter(([, k]) => k === kind).map(([m]) => m);
}

/** One input of each kind the joint step 0 added. */
const NEW_EVENTS: readonly HubEvent[] = [
  { kind: "relayLink", state: "up", url: "wss://relay.test", roles: ["relay"] },
  { kind: "relayLink", state: "down", url: "wss://relay.test", reason: "noPong" },
  { kind: "pushResults", results: [{ id: outboxId(1), outcome: "accepted" }] },
  {
    kind: "releaseOffered",
    releases: [
      {
        kind: "firmware",
        version: "1.3.0",
        target: "esp32s3",
        roles: [1, 2, 3],
        file: "hsn-firmware-1.3.0.hsnf",
        bytes: 1_500_000,
        sha256: "00".repeat(32),
      },
    ],
  },
  { kind: "transferProgress", link: linkId(9), image: new Uint8Array(8), bytes: 65_536 },
  { kind: "firmwareStoreDamaged", image: imageId(1), problem: "missing" },
  { kind: "firmwareStoreDamaged", image: imageId(2), problem: "wrongHash" },
];

describe("the module order (docs/m3-m4-plan.md)", () => {
  test("relay right after people, firmware after alarm and site and before sensors", () => {
    const at = (m: (typeof MODULE_ORDER)[number]) => MODULE_ORDER.indexOf(m);
    expect(at("relay")).toBe(at("people") + 1);
    expect(at("firmware")).toBeGreaterThan(at("alarm"));
    expect(at("firmware")).toBe(at("site") + 1);
    expect(at("firmware")).toBe(at("sensors") - 1);
    expect(MODULE_ORDER).toHaveLength(22);
    expect(M3M4_MODULES).toEqual(["firmware", "relay"]);
    for (const m of M3M4_MODULES) expect(M2_MODULES as readonly string[]).not.toContain(m);
  });

  test("both are definitions of the core, with empty slices and no timers", () => {
    expect(MODULES.relay.handle).toBe(handleRelay);
    expect(MODULES.firmware.handle).toBe(handleFirmware);
    const state = emptyState();
    expect(state.relay).toBe(EMPTY_RELAY_SLICE);
    expect(state.firmware).toBe(EMPTY_FIRMWARE_SLICE);
    expect(relaySlice(state)).toBe(EMPTY_RELAY_SLICE);
    expect(firmwareSlice(state)).toBe(EMPTY_FIRMWARE_SLICE);
    expect(MODULES.relay.deadlines(EMPTY_RELAY_SLICE)).toEqual([]);
    expect(MODULES.firmware.deadlines(EMPTY_FIRMWARE_SLICE)).toEqual([]);
  });
});

describe("both are wired into step, at their places", () => {
  test("step hands the boot to all twenty-two in the order, relay and firmware included", () => {
    const calls: Call[] = [];
    const driver = new Driver(makeCore(spiedModules(calls)));
    driver.boot(snapshot());
    expect(takers(calls, "boot")).toEqual([...MODULE_ORDER]);
  });

  test("every new event reaches both, in the order, without a fault", () => {
    const calls: Call[] = [];
    const driver = new Driver(makeCore(spiedModules(calls)));
    driver.boot(snapshot());
    for (const event of NEW_EVENTS) {
      calls.length = 0;
      driver.input(event);
      expect([event.kind, takers(calls, event.kind)]).toEqual([event.kind, [...MODULE_ORDER]]);
    }
  });

  test("firmware's deviceUpdateEvent reaches app, before it in the order, in the same step", () => {
    const body: DeviceUpdateEventBody = {
      device: 3,
      image: 1,
      state: "fetching",
      held: null,
      method: "ownLink",
      bytes: 65_536,
      of: 1_048_704,
    };
    expect(APP_EVENTS_V2.deviceUpdate.safeParse(body).success).toBe(true);
    const message: Internal = { kind: "deviceUpdateEvent", body };
    const firmware: ModuleDefinition<"firmware"> = {
      ...MODULES.firmware,
      handle: (slice, m) => ok({ slice, out: m.kind === "tick" ? [message] : [] }),
    };
    const calls: Call[] = [];
    const driver = new Driver(makeCore(spiedModules(calls, firmware)));
    driver.boot(snapshot());
    calls.length = 0;
    const steps = driver.steps.length;
    driver.input({ kind: "tick" });
    expect(driver.steps.length).toBe(steps + 1);
    // firmware took the tick and emitted it; then every module took it in the order, app too.
    const emitted = calls.findIndex(([m, k]) => m === "firmware" && k === "tick");
    expect(emitted).toBeGreaterThanOrEqual(0);
    expect(takers(calls.slice(0, emitted), "deviceUpdateEvent")).toEqual([]);
    expect(takers(calls.slice(emitted + 1), "deviceUpdateEvent")).toEqual([...MODULE_ORDER]);
    expect(MODULE_ORDER.indexOf("app")).toBeLessThan(MODULE_ORDER.indexOf("firmware"));
  });
});

describe("version 2's operations and their owners", () => {
  test("every operation of either version has one owner; version 1's keep theirs", () => {
    expect(Object.keys(OP_OWNERS).toSorted()).toEqual([...APP_OP_NAMES_V2].map(String).toSorted());
    for (const name of APP_OP_NAMES) expect(APP_OPS_V2[name]).toBeDefined();
    expect(NEW_OPS_V2).toHaveLength(APP_OP_NAMES_V2.length - APP_OP_NAMES.length);
  });

  test("each design's operations go to the module the designs name", () => {
    const owners = Object.fromEntries(NEW_OPS_V2.map((op) => [op, OP_OWNERS[op]]));
    expect(owners).toEqual({
      "backup.keyHeld": "upkeep",
      "pair.prepare": "setup",
      "pair.finish": "setup",
      "presence.set": "app",
      "push.register": "relay",
      "push.unregister": "relay",
      "push.test": "relay",
      "relay.status": "relay",
      "relay.set": "relay",
      "update.offers": "upkeep",
      "update.fetch": "upkeep",
      "firmware.list": "firmware",
      "firmware.offers": "firmware",
      "firmware.fetch": "firmware",
      "firmware.upload": "firmware",
      "firmware.remove": "firmware",
      "firmware.download": "firmware",
      "firmware.bluetooth": "firmware",
      "rollout.start": "firmware",
      "rollout.pause": "firmware",
      "rollout.resume": "firmware",
      "rollout.cancel": "firmware",
      "rollout.status": "firmware",
    });
    expect(m3m4OwnerOf("relay.set")).toBe("relay");
    expect(m3m4OwnerOf("rollout.start")).toBe("firmware");
    expect(m3m4OwnerOf("backup.keyHeld")).toBeUndefined();
    expect(m2OwnerOf("backup.keyHeld")).toBe("upkeep");
    expect(m2OwnerOf("relay.set")).toBeUndefined();
    expect(m2OwnerOf("pair.prepare")).toBeUndefined();
  });

  test("the hub computer's version 2 operations are new, and none is a phone's own", () => {
    for (const op of CONTROL_OPS_V2) {
      expect(NEW_OPS_V2 as readonly string[]).toContain(op);
      expect(CONTROL_OPS as readonly string[]).not.toContain(op);
      expect(APP_OPS_V2[op].who).not.toContain("the phone itself");
    }
    expect(CONTROL_OPS_V2).toHaveLength(16);
    for (const op of CONTROL_OPS) expect(APP_OPS[op]).toBe(APP_OPS[op]);
  });
});

describe("the model's additions", () => {
  test("seven new effects", () => {
    expect(EFFECT_KINDS.slice(14)).toEqual([
      "relayConnect",
      "relayRoster",
      "pushSend",
      "pushKey",
      "transferGrant",
      "transferRevoke",
      "bluetoothSession",
    ]);
  });

  test("an empty migration 3 snapshot holds nothing", () => {
    expect(EMPTY_M3M4_SNAPSHOT.firmwareImages).toEqual([]);
    expect(EMPTY_M3M4_SNAPSHOT.rollouts).toEqual([]);
    expect(EMPTY_M3M4_SNAPSHOT.deviceUpdates).toEqual([]);
    expect(EMPTY_M3M4_SNAPSHOT.relaySettings).toBeUndefined();
    expect(EMPTY_M3M4_SNAPSHOT.pushTargets).toEqual([]);
    expect(EMPTY_M3M4_SNAPSHOT.pushOutbox).toEqual([]);
    expect(EMPTY_M3M4_SNAPSHOT.rekey).toEqual([]);
    expect(EMPTY_M3M4_SNAPSHOT.rekeyKeys.size).toBe(0);
  });

  test("HubRules.relay is m4-design section 4's", () => {
    expect(DEFAULT_RULES.relay).toEqual({
      unreachableAfterMs: 180 * SECOND,
      linkRecordEveryMs: HOUR,
      retryAfterMs: [MINUTE, 5 * MINUTE, 15 * MINUTE],
      retryEveryMs: 15 * MINUTE,
      outboxMaxAgeMs: 7 * DAY,
      burstOthersPerPhone: 10,
      contentMaxBytes: 1279,
      rosterEveryMs: DAY,
    });
  });

  test("HubRules.firmware is m3-updates-design sections 2, 4 and 5's", () => {
    expect(DEFAULT_RULES.firmware).toEqual({
      maxImages: 4,
      storeMaxBytes: 8 * MB,
      fileMaxBytes: 8 * MB,
      slotBytes: 3_670_016,
      pilotsPerRole: 1,
      soakMs: HOUR,
      sensorsAtOnce: 4,
      fetchesAtOnce: 4,
      sirensAndGatewaysAtOnce: 1,
      heardWithinHeartbeats: 2,
      batteryFloorPercent: 30,
      armedReminderAfterMs: DAY,
      armedReminderEveryMs: DAY,
      trialDeadlineMs: { sensor: 10 * MINUTE, siren: 5 * MINUTE, gateway: 5 * MINUTE },
      noContactGraceMs: 2 * MINUTE,
      brokenTries: 3,
      gatewayBusyRetryMs: HOUR,
      gatewayBusyMaxHolds: 3,
      bluetoothSessionMs: 15 * MINUTE,
      bluetoothWindowTens: 12,
      progressEventEveryMs: 2 * SECOND,
    });
  });

  test("HubRules.keyChange is section 7's", () => {
    expect(DEFAULT_RULES.keyChange).toEqual({ everyMs: 10 * SECOND, resumePoint: 1024 });
  });

  test("the relay's content limit is the padded push less its 0x80 marker", () => {
    expect(DEFAULT_RULES.relay.contentMaxBytes).toBe(1280 - 1);
  });

  // The approved changes to step 0's interfaces, after step 1 began.

  test("JOB_RANGES: one range per module that starts file jobs, apart, covering every job", () => {
    const ranges = Object.values(JOB_RANGES).toSorted((a, b) => a.first - b.first);
    expect(ranges.map((range) => range.owner)).toEqual(["upkeep", "firmware"]);
    expect(Object.entries(JOB_RANGES).map(([module, range]) => [module, range.owner])).toEqual([
      ["upkeep", "upkeep"],
      ["firmware", "firmware"],
    ]);
    // From 1 to the largest job a `{job}` reply carries (2³² − 1), with no gap and no overlap.
    expect(ranges[0]?.first).toBe(1);
    for (const [i, range] of ranges.entries()) {
      expect(range.last).toBeGreaterThanOrEqual(range.first);
      if (i > 0) expect(range.first).toBe((ranges[i - 1]?.last ?? Number.NaN) + 1);
    }
    expect(ranges.at(-1)?.last).toBe(2 ** 32 - 1);
    // What each module counts from is in its own range.
    expect(jobOwner(jobId(EMPTY_UPKEEP_SLICE.nextJob))).toBe("upkeep");
    expect(jobOwner(jobId(EMPTY_FIRMWARE_SLICE.nextJob))).toBe("firmware");
    // At the edges.
    expect(jobOwner(jobId(0))).toBeUndefined();
    expect(jobOwner(jobId(1))).toBe("upkeep");
    expect(jobOwner(jobId(2 ** 31 - 1))).toBe("upkeep");
    expect(jobOwner(jobId(2 ** 31))).toBe("firmware");
    expect(jobOwner(jobId(2 ** 32 - 1))).toBe("firmware");
    expect(jobOwner(jobId(2 ** 32))).toBeUndefined();
    expect(jobOwner(jobId(1.5))).toBeUndefined();
  });

  test("rollouts.paused_reason: a device's 1 to 18, then 19 pilotFailed and 20 rolledBack", () => {
    expect(Math.max(...Object.values(UpdateReason))).toBe(17);
    expect(NO_CONTACT_REASON).toBe(18);
    expect(PILOT_FAILED_REASON).toBe(19);
    expect(ROLLED_BACK_REASON).toBe(20);
    // Each code's name in `rolloutObject.paused.reason`, by its place.
    const names = [...UPDATE_REASONS, ...ROLLOUT_PAUSE_REASONS];
    expect(names).toHaveLength(ROLLED_BACK_REASON);
    expect(names[NO_CONTACT_REASON - 1]).toBe("noContact");
    expect(names[PILOT_FAILED_REASON - 1]).toBe("pilotFailed");
    expect(names[ROLLED_BACK_REASON - 1]).toBe("rolledBack");
  });

  test("transferRevoke's reason is the Gone reason later Gets are answered with", () => {
    // Every reason, and nothing else, is one of the transfer frames' Gone reasons.
    const gone: Readonly<Record<TransferRevokeReason, number>> = {
      paused: GoneReason.Paused,
      notGranted: GoneReason.NotGranted,
    };
    expect(gone).toEqual({ paused: 2, notGranted: 1 });
    type Revoke = Extract<Effect, { readonly kind: "transferRevoke" }>;
    const reason: Equal<Revoke["reason"], TransferRevokeReason | undefined> = true;
    expect(reason).toBe(true);
    // Optional, so a revoke written before it means what it meant: `notGranted`.
    const effects: readonly Revoke[] = [
      { kind: "transferRevoke", link: linkId(5), reason: "paused" },
      { kind: "transferRevoke", link: linkId(6) },
    ];
    const seen: (readonly [number, TransferRevokeReason | undefined])[] = [];
    const transfers: Transfers = {
      grant: () => undefined,
      revoke: (link, why) => {
        seen.push([link, why]);
      },
    };
    for (const effect of effects) transfers.revoke(effect.link, effect.reason);
    expect(seen).toEqual([
      [5, "paused"],
      [6, undefined],
    ]);
  });

  test("an outcome carries a version 2 error as it is; a version 1 reply never holds one", () => {
    const armed = FIRMWARE_BLUETOOTH_REFUSALS.armed;
    const refused: OpOutcome = { ok: false, error: armed };
    expect(appError.safeParse(armed).success).toBe(false);
    expect(replyOf(7, refused)).toEqual({
      t: "res",
      id: 7,
      ok: false,
      error: { code: "protoUnsupported", detail: { speaks: [1, 2] } },
    });
    const busy = { code: "busy", detail: { because: "siteMove" } } as const;
    const reply = replyOf(8, { ok: false, error: busy });
    expect(reply).toEqual({ t: "res", id: 8, ok: false, error: busy });
    expect(!reply.ok && reply.error).toBe(busy);
    // `hsn` takes version 2's errors as they are.
    const error = { code: "opRefused", message: "held: armed", app: armed };
    expect(controlReply.safeParse({ ok: false, error }).success).toBe(true);
    expect(
      controlReply.safeParse({ ok: false, error: { ...error, app: { code: "x" } } }).success,
    ).toBe(false);
  });

  test("accepted carries a Started's M3 fields, optionally, as openPacket gives them", () => {
    type Accepted = Extract<Internal, { readonly kind: "accepted" }>;
    const field: Equal<Accepted["startedImage"], StartedImage | undefined> = true;
    expect(field).toBe(true);
    const without: Accepted = {
      kind: "accepted",
      device: deviceId(4),
      role: Role.Sensor,
      counter: 9,
      message: {
        type: MessageType.Started,
        role: Role.Sensor,
        firmwareVersion: { major: 1, minor: 4, patch: 0 },
        resetCause: 1,
        lastFatalError: 0,
        settingsVersion: 3,
      },
      arrival: { path: "wifi", link: linkId(1) },
      record: seq(1),
      newest: true,
    };
    const startedImage: StartedImage = {
      flags: { onTrial: false, rolledBack: true },
      failedVersion: { major: 1, minor: 5, patch: 0 },
    };
    const withIt: Accepted = { ...without, startedImage };
    expect(Object.hasOwn(without, "startedImage")).toBe(false);
    expect(withIt.startedImage).toBe(startedImage);
  });

  test("firmwareStoreDamaged names the image and what was wrong with its file", () => {
    type Damaged = Extract<HubEvent, { readonly kind: "firmwareStoreDamaged" }>;
    const image: Equal<Damaged["image"], ImageId> = true;
    const problem: Equal<Damaged["problem"], FirmwareStoreProblem> = true;
    const problems: Equal<FirmwareStoreProblem, "missing" | "wrongHash"> = true;
    expect([image, problem, problems]).toEqual([true, true, true]);
  });

  test("deviceUpdateEvent carries the deviceUpdate event's body exactly", () => {
    type Carried = Extract<Internal, { readonly kind: "deviceUpdateEvent" }>["body"];
    const body: Equal<Carried, AppEventBodyV2<"deviceUpdate">> = true;
    const named: Equal<DeviceUpdateEventBody, AppEventBodyV2<"deviceUpdate">> = true;
    expect([body, named]).toEqual([true, true]);
    expect(EFFECT_KINDS as readonly string[]).not.toContain("deviceUpdateEvent");
  });
});

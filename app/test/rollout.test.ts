/** Drives the shared Updates screen with a stand-in version 2 channel, under Bun. */
import { afterEach, expect, test } from "bun:test";
import {
  type AppErrorV2,
  type AppEvent,
  type AppEventBodyV2,
  type AppEventV2,
  type AppOpNameV2,
  type AppOpReplyV2,
  type DeviceObject,
  type RolloutDeviceObject,
  type RolloutObject,
  ROLLOUT_PAUSE_REASONS,
  UPDATE_REASONS,
} from "@hsn/protocol/app";
import { createElement } from "react";
import type { AnyOutcome } from "../src/hub/channel";
import type { HubClient, Version2Channel } from "../src/hub/client";
import { rolloutView } from "../src/state/rollout";
import { clientScreen, screenAct } from "./support/client-screen";
import { screenWorld, textOf } from "./support/screens";
import { snapshotOf } from "./support/snapshots";
import { manualTimers } from "./support/timers";

const { RolloutSection } = await import("../src/ui/rollout");
const { UpdatesScreen } = await import("../src/ui/updates");
const { rowWords } = await import("../src/ui/history");
const { i18n } = await import("../src/i18n");

type Status = AppOpReplyV2<"rollout.status">;
type Images = AppOpReplyV2<"firmware.list">["images"];
type Offers = AppOpReplyV2<"firmware.offers">["offers"];
type Action = "rollout.pause" | "rollout.resume" | "rollout.cancel";
const ID = 17;
const IMAGE = 6;
const FRONT: DeviceObject = {
  id: 4,
  role: "sensor",
  name: "Front door",
  state: "paired",
  firmware: "1.0.0",
  health: { batteryLow: false, silent: false, tamperOpen: false, poorLink: false },
  batteryPercent: 100,
  signal: null,
  temperatureC: null,
  lastSeenMs: null,
  heardBy: null,
};
const DEVICES = {
  4: FRONT,
  5: { ...FRONT, id: 5, name: "Back door" },
  6: { ...FRONT, id: 6, name: "Side door" },
};
const HUB = snapshotOf({ rev: 1, version: "1.0.0", boot: 1, identity: "fake" }).hub;
const SOAK = Date.UTC(2040, 5, 12, 10, 5);
const NO_ROLLOUT = { rollout: null, devices: [] } satisfies Status;
const STAGED: Images[number] = {
  id: IMAGE,
  imageId: "ca".repeat(8),
  version: "2.1.0",
  kind: "ownBuild",
  roles: [1],
  bytes: 1_000_000,
  addedMs: 3,
};
const UNAUTHORIZED: AppErrorV2 = { code: "unauthorized", detail: { permission: "manageSystem" } };

/** Builds a fresh status with one pilot and two other devices. */
function status(
  stage: RolloutObject["stage"],
  fields: Partial<RolloutObject> = {},
  lines = [line("confirmed", 4), line("confirmed", 5), line("planned", 6)],
): Status {
  return {
    rollout: {
      id: ID,
      image: IMAGE,
      version: "2.1.0",
      stage,
      devices: [4, 5, 6],
      pilots: [4],
      approvedBy: "Manager",
      approvedMs: 1,
      soakUntilMs: null,
      paused: null,
      endedMs: null,
      ...fields,
    },
    devices: lines,
  };
}

/** Supplies a device row, with controlled progress and hold fields. */
function line(
  state: RolloutDeviceObject["state"],
  device = 4,
  fields: Partial<RolloutDeviceObject> = {},
): RolloutDeviceObject {
  return {
    device,
    state,
    held: null,
    method: "joinWifi",
    bytes: 0,
    of: 100,
    lastReason: null,
    ...fields,
  };
}

/** An acknowledgement from the named operation, as the transport forwards it. */
function reply(body: unknown): AnyOutcome {
  return { ok: true, body, repeat: false };
}

/** Makes a real audit event body, which rollout decisions use to invalidate the status. */
function record(kind: string, detail: string | null = null): Extract<AppEvent, { ev: "record" }> {
  return {
    t: "evt",
    ev: "record",
    rev: 7,
    body: {
      kind: "decision",
      row: {
        kind: "decision",
        row: {
          kind,
          detail,
          seq: 7,
          atMs: 5,
          clockOk: true,
          deviceId: FRONT.id,
          value: ID,
          causeSeq: null,
        },
      },
    },
  };
}

let screen: ReturnType<typeof clientScreen> | undefined;
afterEach(async () => {
  await screen?.close();
  screen = undefined;
});

/** Mounts Updates with a stand-in hub client and exposes its event feeds. */
async function mount(
  initial: Status | AnyOutcome,
  {
    v2 = true,
    images = [],
    offers = [],
    fullScreen = false,
  }: {
    readonly v2?: boolean;
    readonly images?: Images;
    readonly offers?: Offers;
    readonly fullScreen?: boolean;
  } = {},
) {
  const world = await screenWorld({
    hub: HUB,
    devices: DEVICES,
    session: { boot: 1, client: 1, person: 1, kind: "web", hub: "stand-in" },
  });
  const legacy = new Set<(event: AppEvent) => void>();
  const later = new Set<(event: AppEventV2) => void>();
  const calls: { op: AppOpNameV2; body: unknown }[] = [];
  let current = "ok" in initial ? initial : reply(initial);
  let catalogue = images;
  let action: (() => AnyOutcome | Promise<AnyOutcome>) | undefined;
  world.client.onEvent = (listener) => {
    legacy.add(listener);
    return () => {
      legacy.delete(listener);
    };
  };
  const channel: Version2Channel = {
    forward: async (op, body) => {
      calls.push({ op, body });
      if (op === "rollout.status") return current;
      if (op === "firmware.list") return reply({ images: catalogue, devices: [] });
      if (op === "firmware.offers") return reply({ offers });
      return action?.() ?? reply({ job: 9 });
    },
    onNewEvent: (listener) => {
      later.add(listener);
      return () => {
        later.delete(listener);
      };
    },
  };
  const client: HubClient = { ...world.client, ...(v2 ? { v2: channel } : {}) };
  const shown = clientScreen();
  screen = shown;
  await shown.render(
    world.wrap(createElement(fullScreen ? UpdatesScreen : RolloutSection), client),
  );
  // The unrelated hub-update query notifies through a timer; flush it before removing the DOM.
  if (fullScreen) await screenAct(() => Bun.sleep(10));
  return {
    calls,
    world,
    press: shown.press,
    words: () => textOf(shown.html()),
    html: shown.html,
    status: (next: Status | AnyOutcome) => {
      current = "ok" in next ? next : reply(next);
    },
    images: (next: Images) => {
      catalogue = next;
    },
    action: (outcome: () => AnyOutcome | Promise<AnyOutcome>) => {
      action = outcome;
    },
    event: (event: AppEvent) =>
      screenAct(() => {
        for (const listener of legacy) listener(event);
      }),
    device: (patch: Partial<AppEventBodyV2<"deviceUpdate">> = {}) =>
      screenAct(() => {
        for (const listener of later)
          listener({
            t: "evt",
            ev: "deviceUpdate",
            rev: 8,
            body: {
              device: FRONT.id,
              image: IMAGE,
              state: "fetching",
              held: null,
              method: "joinWifi",
              bytes: 35,
              of: 100,
              ...patch,
            },
          });
      }),
  };
}

const STAGES = [
  ["pilots", "The first devices are updating.", "rollout_started"],
  ["soak", "Checking how the first devices run.", null],
  ["rest", "Updating the remaining devices.", null],
  ["paused", "The rollout is paused.", "rollout_paused"],
  ["done", "The rollout is complete.", "rollout_done"],
  ["cancelled", "The rollout was cancelled.", "rollout_cancelled"],
] as const;

test("a version 2 stand-in web client renders no rollout on the existing Updates screen", async () => {
  const view = await mount(NO_ROLLOUT, { fullScreen: true });
  expect(view.words()).toContain("Device update rollout No device update rollout yet.");
  expect(view.words()).not.toContain("Waiting for approval");
  expect(view.calls[0]).toEqual({ op: "rollout.status", body: {} });
  expect(view.html()).not.toContain('aria-label="Pause the rollout"');
});

test.each(STAGES)(
  "%s renders from status and follows a live change",
  async (stage, words, decision) => {
    const data = status(stage, stage === "soak" ? { soakUntilMs: SOAK } : {});
    const view = await mount(data);
    expect(view.words()).toContain(words);
    if (stage === "soak") expect(view.words()).toContain("Checks end Jun 12, 2040 at 11:05 AM.");
    if (stage === "rest") expect(view.words()).toContain("1 of 2 remaining devices updated.");
    if (stage === "paused") expect(view.words()).toContain("Someone paused the rollout.");
    const pause = await view.press("Pause the rollout");
    expect(pause).toBe(stage === "pilots" || stage === "soak" || stage === "rest");
    expect(view.html().includes('aria-label="Resume the rollout"')).toBe(stage === "paused");
    expect(view.html().includes('aria-label="Cancel the rollout"')).toBe(
      stage !== "done" && stage !== "cancelled",
    );
    view.status(NO_ROLLOUT);
    await view.event(record("rollout_done"));
    expect(view.words()).not.toContain(words);
    view.status(data);
    if (decision === null) await view.device({ state: stage === "soak" ? "confirmed" : "offered" });
    else await view.event(record(decision));
    expect(view.words()).toContain(words);
  },
);

const PAUSE_CASES = [
  ["battery", "Its battery is low. Charge it first."],
  ["armed", "It is armed. Disarm it first."],
  ["noWifi", "It could not join Wi-Fi. Check your home's Wi-Fi details."],
  ["hubNotFound", "The device could not find the hub. Check that the hub is on."],
  [
    "linkLost",
    "The device lost its connection during the download. Check its connection before resuming.",
  ],
  ["badHeader", "The device could not read the update. Check for another update."],
  ["wrongHub", "The update belongs to another hub. Check which update was chosen."],
  ["wrongRole", "The update is for a different kind of device. Check which update was chosen."],
  ["tooLarge", "The update is too large for this device. Check for another update."],
  ["badSignature", "The device could not verify who made the update. Check for another update."],
  ["hashMismatch", "The downloaded update was damaged. Check the update before resuming."],
  ["flash", "The device could not save the update. Try again."],
  ["imageCheck", "The device could not use the new version. Check for another update."],
  ["windowEnded", "The device stopped listening for the update. Start again near it."],
  ["sessionRefused", "The device would not open the update. Start again near it."],
  ["onTrial", "The device is already checking a new version. Wait until it finishes."],
  ["radioBusy", "The device is too busy to update. Try again at a quiet time."],
  [
    "noContact",
    "The hub has not heard from the device since it started installing. Check its connection.",
  ],
  [
    "pilotFailed",
    "One of the first devices stopped working during checks. Check the device before resuming.",
  ],
  ["rolledBack", "The new version failed and the device went back to the old one."],
] as const;

test.each(PAUSE_CASES)(
  "pause reason %s is named in status, live, and history",
  async (reason, words) => {
    const data = status("paused", { paused: { reason, device: FRONT.id } });
    const view = await mount(data);
    expect(view.words()).toContain(`Front door: ${words}`);
    view.status(status("pilots"));
    await view.event(record("rollout_resumed"));
    expect(view.words()).not.toContain(words);
    view.status(data);
    await view.event(record("rollout_paused"));
    expect(view.words()).toContain(`Front door: ${words}`);
    const index = [...UPDATE_REASONS, ...ROLLOUT_PAUSE_REASONS].indexOf(reason);
    const hex = `04000000${(index + 1).toString(16).padStart(2, "0")}`;
    expect(
      rowWords(
        i18n.t,
        i18n.exists,
        { devices: DEVICES },
        record("rollout_paused", hex).body,
        "en",
        true,
      ),
    ).toBe(`Front door: ${words}`);
  },
);

test("the pause table includes every protocol reason exactly once", () => {
  expect(PAUSE_CASES.map(([reason]) => reason)).toEqual([
    ...UPDATE_REASONS,
    ...ROLLOUT_PAUSE_REASONS,
  ]);
});

test("a damaged hub copy is explained without naming a device", async () => {
  const data = status("paused", { paused: { reason: "hashMismatch", device: null } });
  const view = await mount(data);
  const words = "The hub's copy of the firmware is missing or damaged.";
  expect(view.words()).toContain(words);
  expect(view.words()).not.toContain("Front door:");
  const event = record("rollout_paused", "000000000b");
  expect(rowWords(i18n.t, i18n.exists, { devices: DEVICES }, event.body, "en", true)).toContain(
    words,
  );
});

test("a removed device remains listed but does not count towards remaining work", async () => {
  const data = status("rest", {}, [
    line("confirmed", 4),
    line("confirmed", 5),
    line("cancelled", 6),
  ]);
  const view = await mount(data);
  expect(view.words()).toContain("1 of 1 remaining devices updated.");
  expect(view.words()).toContain("Side door The device's update was cancelled.");
});

const DEVICE_CASES = [
  ["none", "No update is planned."],
  ["planned", "Waiting for its turn."],
  ["offered", "The update is ready for this device."],
  ["fetching", "Downloading the update (35%)."],
  ["verified", "Downloaded. It installs at its turn."],
  ["installing", "Restarting. It cannot do its job for a few seconds."],
  ["onTrial", "Checking the new version."],
  ["confirmed", "Up to date with version 2.1.0."],
  ["rolledBack", "The new version failed. The device went back to the old one and works."],
  ["refused", "The device could not update. The device could not save the update. Try again."],
  ["cancelled", "The device's update was cancelled."],
] as const;

test.each(DEVICE_CASES)(
  "%s renders as its own device state and follows deviceUpdate",
  async (state, words) => {
    const current = line(state, FRONT.id, {
      bytes: 35,
      lastReason: state === "refused" ? "flash" : null,
    });
    const view = await mount(status("pilots", {}, [current]));
    expect(view.words()).toContain(`Front door ${words}`);
    view.status(status("pilots", {}, [line("planned")]));
    await view.event(record("rollout_resumed"));
    view.status(status("pilots", {}, [current]));
    await view.device({ state, ...(state === "refused" ? { reason: "flash" } : {}) });
    expect(view.words()).toContain(`Front door ${words}`);
  },
);

const HOLDS = [
  ["armed", "It is armed and still protecting. The update waits until it is disarmed."],
  ["battery", "Its battery is low. Charge it first."],
  ["waitingTurn", "Waiting for its turn."],
  ["needsPhone", "It needs a phone. Open its page in the phone app when you are near it."],
  ["countdownAlarmOrSiteMove", "Wait for the countdown, alarm or radio settings change to finish."],
  [
    "gatewayBusy",
    "This gateway is too busy to update without delaying replies. Update it at a quiet time, or with fewer sensors on it.",
  ],
  ["keyChange", "It has not been heard since the hub was restored. Wait until it is."],
] as const;

test.each(HOLDS)("the %s hold has its own words in status and live", async (held, words) => {
  const data = status("pilots", {}, [line("planned", FRONT.id, { held })]);
  const view = await mount(data);
  expect(view.words()).toContain(`Front door ${words}`);
  view.status(status("pilots", {}, [line("offered")]));
  await view.event(record("rollout_resumed"));
  view.status(data);
  await view.device({ state: "planned", held });
  expect(view.words()).toContain(`Front door ${words}`);
});

test("live bytes repaint just the right row and an armed sensor still downloads", async () => {
  const view = await mount(
    status("pilots", {}, [line("fetching", FRONT.id, { held: "armed", bytes: 35 })]),
  );
  expect(view.words()).toContain("Downloading the update (35%).");
  expect(view.words()).toContain("It is still watching its door.");
  expect(view.words()).toContain("The update waits until it is disarmed.");
  const reads = view.calls.length;
  await view.device({ held: "armed", bytes: 71 });
  expect(view.words()).toContain("Downloading the update (71%).");
  expect(view.calls).toHaveLength(reads);
  await view.device({ image: IMAGE + 1, state: "refused", reason: "flash" });
  await view.device({ device: 99, state: "refused", reason: "flash" });
  expect(view.calls).toHaveLength(reads);
  expect(view.words()).not.toContain("The device could not update.");
  expect(view.words()).not.toContain("Device 99");
});

test("the release is available to download, then approval confirms the named staged image", async () => {
  const view = await mount(NO_ROLLOUT, {
    offers: [{ version: STAGED.version, bytes: 1_000_000, roles: [1] }],
  });
  expect(view.words()).toContain("Waiting for approval Firmware 2.1.0 1 MB to download");
  expect(await view.press("Start the rollout")).toBe(false);
  expect(await view.press("Download firmware")).toBe(true);
  expect(view.calls).toContainEqual({ op: "firmware.fetch", body: { version: STAGED.version } });
  expect(view.words()).toContain("The hub accepted the download.");
  view.images([{ ...STAGED, kind: "official" }]);
  await view.event(record("firmware_added"));
  expect(await view.press("Download firmware")).toBe(false);
  expect(await view.press("Start the rollout")).toBe(true);
  expect(view.words()).toContain("Start the rollout for firmware 2.1.0?");
  expect(view.calls.some((call) => call.op === "rollout.start")).toBe(false);
  expect(await view.press("Not now")).toBe(true);
  expect(view.calls.some((call) => call.op === "rollout.start")).toBe(false);
  view.action(() => {
    const current = status("pilots");
    view.status(current);
    return reply(current.rollout);
  });
  expect(await view.press("Start the rollout")).toBe(true);
  expect(await view.press("Yes, start the rollout")).toBe(true);
  expect(view.calls).toContainEqual({ op: "rollout.start", body: { image: IMAGE } });
  expect(view.words()).toContain("Rollout started.");
  expect(view.words()).toContain("The first devices are updating.");
});

test("own builds are labelled, with any official offer of the same version still available", async () => {
  const view = await mount(NO_ROLLOUT, {
    images: [STAGED],
    offers: [{ version: STAGED.version, bytes: 1_000_000, roles: [1] }],
  });
  expect(view.words()).toContain("Firmware 2.1.0 Own build");
  expect(view.html()).toContain('aria-label="Download firmware"');
});

const COMMANDS = [
  ["rollout.pause", "pilots", "Pause the rollout", "paused", "Rollout paused."],
  ["rollout.resume", "paused", "Resume the rollout", "rest", "Rollout resumed."],
  ["rollout.cancel", "paused", "Cancel the rollout", "cancelled", "Rollout cancelled."],
  ["rollout.cancel", "rest", "Cancel the rollout", "cancelled", "Rollout cancelled."],
] as const;

/** Opens the real confirmation where required, and presses the action. */
async function pressAction(view: Awaited<ReturnType<typeof mount>>, op: Action, label: string) {
  expect(await view.press(label)).toBe(true);
  if (op === "rollout.cancel") {
    expect(view.words()).toContain(
      "Devices already installing or checking the new version will finish.",
    );
    expect(view.calls.some((call) => call.op === op)).toBe(false);
    expect(await view.press("Yes, cancel the rollout")).toBe(true);
  }
  expect(view.calls.filter((call) => call.op === op)).toEqual([{ op, body: { rollout: ID } }]);
}

test.each(COMMANDS)(
  "%s from %s sends the rollout ID and confirms success",
  async (op, stage, label, next, words) => {
    const view = await mount(status(stage));
    view.action(() => {
      const after = status(next);
      view.status(after);
      return reply(after.rollout);
    });
    await pressAction(view, op, label);
    expect(view.words()).toContain(words);
  },
);

const COMMON_REFUSALS: readonly (readonly [string, AnyOutcome, string])[] = [
  [
    "missing rollout",
    { ok: false, error: { code: "notFound", detail: { what: "rollout", id: ID } } },
    "That rollout no longer exists. Check the current rollout.",
  ],
  [
    "ended rollout",
    { ok: false, error: { code: "invalid", detail: { field: "rollout", reason: "range" } } },
    "That rollout has already ended. Check the current rollout.",
  ],
  [
    "permission",
    { ok: false, error: UNAUTHORIZED },
    "This needs the permission to manage the system.",
  ],
  [
    "unavailable",
    { ok: false, error: { code: "unavailable", detail: {} } },
    "The hub cannot save changes at the moment. Its computer says why.",
  ],
  [
    "unreachable",
    { ok: false, local: "offline" },
    "Not connected to the hub, so nothing was sent.",
  ],
];
for (const [op, stage, label, , success] of COMMANDS.slice(0, 3)) {
  const refusals =
    op === "rollout.resume"
      ? ([
          ...COMMON_REFUSALS,
          [
            "missing firmware",
            { ok: false, error: { code: "notFound", detail: { what: "image", id: IMAGE } } },
            "The hub does not have that firmware. Add it again before trying.",
          ],
          [
            "device outside the rollout",
            {
              ok: false,
              error: { code: "invalid", detail: { field: "device", reason: "unknownReference" } },
            },
            "That device is not part of the rollout.",
          ],
          [
            "a forced update on a device other than a gateway",
            { ok: false, error: { code: "invalid", detail: { field: "force", reason: "range" } } },
            "Only a gateway can be updated this way.",
          ],
        ] as const)
      : COMMON_REFUSALS;
  for (const [reason, failure, words] of refusals) {
    test(`${op} reports ${reason}`, async () => {
      const view = await mount(status(stage));
      view.action(() => failure);
      await pressAction(view, op, label);
      expect(view.words()).toContain(words);
      expect(view.words()).not.toContain(success);
    });
  }
}

test("absence of version 2 makes the screen silent and sends no rollout requests", async () => {
  const view = await mount(status("paused"), { v2: false });
  expect(view.words()).not.toContain("Device update rollout");
  expect(view.calls).toEqual([]);
});

test("a person refused manage system sees no rollout or actions and never reads the catalogue", async () => {
  const view = await mount({ ok: false, error: UNAUTHORIZED }, { images: [STAGED] });
  expect(view.words()).not.toContain("Device update rollout");
  expect(view.words()).not.toContain("Start the rollout");
  expect(view.words()).not.toContain("Resume the rollout");
  expect(view.calls).toEqual([{ op: "rollout.status", body: {} }]);
});

test("permissions are checked again live and stale replies cannot restore a hidden rollout", async () => {
  const view = await mount(status("paused"));
  const pending = Promise.withResolvers<AnyOutcome>();
  view.action(() => pending.promise);
  expect(await view.press("Resume the rollout")).toBe(true);
  view.status({ ok: false, error: UNAUTHORIZED });
  await view.event({ t: "evt", ev: "people", rev: 10, body: { userManagement: true } });
  await screenAct(() => {
    pending.resolve(reply(status("pilots").rollout));
  });
  expect(view.words()).not.toContain("Device update rollout");
  expect(view.words()).not.toContain("Rollout resumed.");
  view.status(status("rest"));
  await view.event({ t: "evt", ev: "people", rev: 11, body: { userManagement: false } });
  expect(view.words()).toContain("Updating the remaining devices.");
});

test("the status is read again on reconnection and a different home never inherits its state", async () => {
  const view = await mount(status("paused"));
  await screenAct(() => {
    view.world.client.live.setState({ connection: { kind: "connecting" } });
  });
  view.status(status("done"));
  await screenAct(() => {
    view.world.client.live.setState({ connection: { kind: "open" } });
  });
  expect(view.words()).toContain("The rollout is complete.");
  await screenAct(() => {
    view.world.client.live.setState({ session: null });
  });
  expect(view.words()).not.toContain("Device update rollout");
});

test("the soak deadline triggers a hub read even when held devices send no event", async () => {
  const view = await mount(NO_ROLLOUT, { v2: false });
  const clock = manualTimers(SOAK - 100);
  let data = status("soak", { soakUntilMs: SOAK });
  const model = rolloutView(
    view.world.client,
    {
      forward: (op) =>
        Promise.resolve(
          reply(op === "rollout.status" ? data : { images: [], devices: [], offers: [] }),
        ),
      onNewEvent: () => () => undefined,
    },
    clock,
  );
  const stop = model.watch();
  await screenAct(() => undefined);
  expect(model.store.getState().status?.rollout?.stage).toBe("soak");
  data = status("rest");
  await screenAct(() => {
    clock.advance(99);
  });
  expect(model.store.getState().status?.rollout?.stage).toBe("soak");
  await screenAct(() => {
    clock.advance(1);
  });
  expect(model.store.getState().status?.rollout?.stage).toBe("rest");
  stop();
});

test("a manager learns of a pause during soak even if the pilot's history is hidden", async () => {
  const view = await mount(NO_ROLLOUT, { v2: false });
  view.world.client.live.setState({ devices: {} });
  const clock = manualTimers(SOAK - 3_600_000);
  let data = status("soak", { soakUntilMs: SOAK });
  const model = rolloutView(
    view.world.client,
    {
      forward: (op) =>
        Promise.resolve(
          reply(op === "rollout.status" ? data : { images: [], devices: [], offers: [] }),
        ),
      onNewEvent: () => () => undefined,
    },
    clock,
  );
  const stop = model.watch();
  await screenAct(() => undefined);
  expect(model.store.getState().status?.rollout?.stage).toBe("soak");
  data = status("paused", { paused: { device: FRONT.id, reason: "pilotFailed" } });
  await screenAct(() => {
    clock.advance(60_000);
  });
  expect(model.store.getState().status?.rollout?.paused).toEqual({
    device: FRONT.id,
    reason: "pilotFailed",
  });
  stop();
});

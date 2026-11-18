/**
 * A whole rollout over a site of six sensors, two sirens and two gateways, step by step
 * (docs/m3-updates-design.md section 4, "How a rollout proceeds", D139): approval, the pilots one at
 * a time (sensor, siren, gateway), the soak at its edge, the rest with its limits at their edges
 * (fetches, sensors installing, sirens and gateways one at a time, no gateway while a sensor is on
 * trial), and done; with the rows and decisions each step writes.
 */
import { describe, expect, test } from "bun:test";
import { UpdateAction, UpdateHolding, UpdateStage } from "@hsn/protocol";
import { linkId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  DeviceUpdateState,
  RolloutStage,
  UpdateHeld,
  UpdateMethod,
} from "../../../src/core/model/rows.ts";
import { offerWaiting } from "../../../src/core/firmware/view.ts";
import {
  CONFIRMED_IMAGE,
  decisions,
  effectsOf,
  fileBytes,
  G1,
  G2,
  GATEWAYS,
  HOUR_US,
  linkAll,
  LORA,
  NEW_VERSION,
  ON_TRIAL,
  offers,
  offerTo,
  okBody,
  openRow,
  R1,
  R2,
  rolloutRows,
  rowOf,
  type Runner,
  S1,
  S2,
  SENSORS,
  sensorThrough,
  SIRENS,
  siteRunner,
  updateRows,
  wifi,
} from "./support.ts";

const gwArrival = (i: number) => wifi(700 + i);

function pilotsDone(runner: Runner, image: ReturnType<typeof siteRunner>["image"]): void {
  sensorThrough(runner, S1, image, 501);
  runner.status(R1, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(600));
  runner.started(R1, NEW_VERSION, CONFIRMED_IMAGE, {}, wifi(600));
  runner.status(G1, image.imageId, UpdateStage.Verified, 0, fileBytes(image), gwArrival(0));
  runner.started(G1, NEW_VERSION, CONFIRMED_IMAGE, {}, gwArrival(0));
}

describe("approval", () => {
  test("rollout.start plans every device of the image's roles, chooses one pilot of each, and writes it all now", () => {
    const { runner, image } = siteRunner();
    const ran = runner.op({ op: "rollout.start", body: { image: image.id } });
    const body = okBody(ran.answer) as { stage: string; devices: number[]; pilots: number[] };
    expect(body.stage).toBe("pilots");
    expect(body.devices).toEqual([...SENSORS, ...SIRENS, ...GATEWAYS]);
    expect(body.pilots).toEqual([S1, R1, G1]);
    const rows = updateRows(ran);
    expect(new Set(rows.map((r) => r.row.deviceId))).toEqual(
      new Set([...SENSORS, ...SIRENS, ...GATEWAYS]),
    );
    expect(rows.every((r) => r.durability === "now")).toBe(true);
    expect(rolloutRows(ran)[0]?.stage).toBe(RolloutStage.Pilots);
    expect(decisions(ran).find((d) => d.kind === "rollout_started")?.value).toBe(1);
    // Nothing is offered by approval itself but what the pilots' turn allows: the sensor pilot is
    // reached in a reply (its offer waits), the siren and gateway pilots have no link yet.
    expect(offers(ran)).toEqual([]);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S1)).toBe(true);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S2)).toBe(false);
    expect(rowOf(runner, S2)?.held).toBe(UpdateHeld.WaitingTurn);
  });

  test("devices named: only those, and a pilot of each of their roles", () => {
    const { runner, image } = siteRunner();
    const ran = runner.op({
      op: "rollout.start",
      body: { image: image.id, devices: [S2, R2], pilots: [R2] },
    });
    const body = okBody(ran.answer) as { devices: number[]; pilots: number[] };
    expect(body.devices).toEqual([S2, R2]);
    expect(body.pilots).toEqual([S2, R2]);
    expect(rowOf(runner, S1)).toBeUndefined();
  });

  test("the hub's pilot sensor is a disarmed one with a good battery", () => {
    const { runner, image } = siteRunner();
    runner.arm(S1);
    runner.battery(S2, 3_300);
    runner.battery(SENSORS[2] ?? S2, 4_100);
    const body = okBody(runner.op({ op: "rollout.start", body: { image: image.id } }).answer) as {
      pilots: number[];
    };
    expect(body.pilots[0]).toBe(SENSORS[2]);
  });
});

describe("the pilots, one at a time: sensor, siren, gateway", () => {
  test("the sensor pilot: join Wi-Fi, fetch on the link it comes back on, the go-ahead, its trial, confirmed", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id } });

    const join = runner.query(S1);
    expect(offerTo(join, S1)?.offer.action).toBe(UpdateAction.JoinWifiAndFetch);
    expect(offerTo(join, S1)?.answers?.counter).toBeDefined();
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Offered);
    expect(rowOf(runner, S1)?.method).toBe(UpdateMethod.JoinWifi);
    expect(decisions(join).map((d) => d.kind)).toContain("firmware_device_offered");

    const fetch = runner.query(S1, {}, wifi(501));
    expect(offerTo(fetch, S1)?.offer.action).toBe(UpdateAction.Fetch);
    const grants = effectsOf(fetch, "transferGrant");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.link).toBe(linkId(501));
    expect(grants[0]?.imageId).toEqual(image.imageId);
    expect(grants[0]?.header).toEqual(image.header);
    expect(offerTo(fetch, S1)?.offer.fileBytes).toBe(fileBytes(image));

    // The shell's progress moves it to fetching (now) and its bytes (routine).
    const first = runner.send({
      kind: "transferProgress",
      link: linkId(501),
      image: image.imageId,
      bytes: 65_536,
    });
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Fetching);
    expect(updateRows(first)[0]?.durability).toBe("now");
    const later = runner.send({
      kind: "transferProgress",
      link: linkId(501),
      image: image.imageId,
      bytes: 131_072,
    });
    expect(updateRows(later)[0]?.durability).toBe("routine");
    expect(rowOf(runner, S1)?.bytes).toBe(131_072);

    const verified = runner.status(S1, image.imageId, UpdateStage.Verified);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Installing);
    expect(offerTo(verified, S1)?.offer.action).toBe(UpdateAction.InstallNow);
    expect(decisions(verified).map((d) => d.kind)).toEqual([
      "firmware_verified",
      "firmware_installing",
    ]);
    // The go-ahead is committed before it is sent: a "now" row in the same step.
    expect(
      updateRows(verified).some(
        (r) => r.durability === "now" && r.row.state === DeviceUpdateState.Installing,
      ),
    ).toBe(true);
    expect(effectsOf(verified, "transferRevoke")).toEqual([
      { kind: "transferRevoke", link: linkId(501), reason: "notGranted" },
    ]);

    runner.started(S1, NEW_VERSION, ON_TRIAL);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.OnTrial);
    const done = runner.status(S1, image.imageId, UpdateStage.Confirmed);
    expect(rowOf(runner, S1)?.state).toBe(DeviceUpdateState.Confirmed);
    expect(offerTo(done, S1)?.offer.action).toBe(UpdateAction.Nothing);
    expect(decisions(done).map((d) => d.kind)).toContain("firmware_confirmed");
  });

  test("the siren pilot waits for the sensor pilot, then is offered on its own link at once", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id } });
    const heard = runner.heartbeat(R1, wifi(600));
    expect(offerTo(heard, R1)).toBeUndefined();
    expect(rowOf(runner, R1)?.held).toBe(UpdateHeld.WaitingTurn);

    runner.query(S1);
    runner.query(S1, {}, wifi(501));
    runner.status(S1, image.imageId, UpdateStage.Verified);
    runner.started(S1, NEW_VERSION, ON_TRIAL);
    const confirmed = runner.status(S1, image.imageId, UpdateStage.Confirmed);
    expect(offerTo(confirmed, R1)?.offer.action).toBe(UpdateAction.Fetch);
    expect(offerTo(confirmed, R1)?.answers).toBeUndefined();
    expect(effectsOf(confirmed, "transferGrant").map((g) => g.link)).toEqual([linkId(600)]);
    expect(rowOf(runner, R1)?.method).toBe(UpdateMethod.OwnLink);
    // The gateway pilot is not yet its turn.
    expect(offerTo(confirmed, G1)).toBeUndefined();
  });

  test("pilots in turn, then the soak of an hour at its edge, then the rest", () => {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id } });
    linkAll(runner);
    sensorThrough(runner, S1, image, 501);
    expect(rowOf(runner, R1)?.state).toBe(DeviceUpdateState.Offered);
    runner.status(R1, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(600));
    expect(rowOf(runner, R1)?.state).toBe(DeviceUpdateState.Installing);
    expect(rowOf(runner, G1)?.state).toBe(DeviceUpdateState.Planned);
    const sirenDone = runner.started(R1, NEW_VERSION, CONFIRMED_IMAGE, {}, wifi(600));
    expect(offerTo(sirenDone, G1)?.offer.action).toBe(UpdateAction.Fetch);
    runner.status(G1, image.imageId, UpdateStage.Verified, 0, fileBytes(image), gwArrival(0));
    const last = runner.started(G1, NEW_VERSION, CONFIRMED_IMAGE, {}, gwArrival(0));
    expect(openRow(runner)?.stage).toBe(RolloutStage.Soak);
    expect(openRow(runner)?.soakUntilMs).toBe(runner.now.wall + DEFAULT_RULES.firmware.soakMs);
    expect(rolloutRows(last).at(-1)?.stage).toBe(RolloutStage.Soak);
    // Nothing more is offered during the soak.
    expect(offers(last)).toEqual([]);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S2)).toBe(false);

    runner.run(HOUR_US - 1);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Soak);
    const rest = runner.run(1);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Rest);
    // The rest begins: the other siren and gateway are offered at once on their links.
    expect(offerTo(rest, R2)?.offer.action).toBe(UpdateAction.Fetch);
    expect(offerTo(rest, G2)?.offer.action).toBe(UpdateAction.Fetch);
    // A sensor not heard for two of its intervals is not offered anything until it is heard.
    expect(offerWaiting(runner.view, runner.rules, runner.now, S2)).toBe(false);
    runner.hear(S2);
    expect(offerWaiting(runner.view, runner.rules, runner.now, S2)).toBe(true);
  });
});

describe("the rest, with its limits at their edges", () => {
  function inRest(rules = DEFAULT_RULES) {
    const { runner, image } = siteRunner(rules);
    runner.op({ op: "rollout.start", body: { image: image.id } });
    linkAll(runner);
    pilotsDone(runner, image);
    runner.run(HOUR_US);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Rest);
    return { runner, image };
  }

  test("fetches four at a time: the siren and gateway take two, two sensors the rest, the next waits its turn", () => {
    const { runner } = inRest();
    const [, s2, s3, s4] = SENSORS;
    expect(offerTo(runner.query(s2 ?? S2), s2 ?? S2)?.offer.action).toBe(
      UpdateAction.JoinWifiAndFetch,
    );
    expect(offerTo(runner.query(s3 ?? S2), s3 ?? S2)?.offer.action).toBe(
      UpdateAction.JoinWifiAndFetch,
    );
    const fifth = runner.query(s4 ?? S2);
    expect(offerTo(fifth, s4 ?? S2)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(rowOf(runner, s4 ?? S2)?.held).toBe(UpdateHeld.WaitingTurn);
    expect(rowOf(runner, s4 ?? S2)?.state).toBe(DeviceUpdateState.Planned);
  });

  test("a verified fetch frees its place: the next sensor's offer waits", () => {
    const { runner, image } = inRest();
    const [, s2, s3, s4] = SENSORS.map((s) => s);
    runner.query(s2 ?? S2);
    runner.query(s3 ?? S2);
    runner.query(s4 ?? S2);
    expect(offerWaiting(runner.view, runner.rules, runner.now, s4 ?? S2)).toBe(false);
    runner.status(R2, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(601));
    expect(offerWaiting(runner.view, runner.rules, runner.now, s4 ?? S2)).toBe(true);
    expect(offerTo(runner.query(s4 ?? S2), s4 ?? S2)?.offer.action).toBe(
      UpdateAction.JoinWifiAndFetch,
    );
  });

  test("sensors install four at a time; the fifth waits its turn until one is confirmed", () => {
    const rules = { ...DEFAULT_RULES, firmware: { ...DEFAULT_RULES.firmware, fetchesAtOnce: 10 } };
    const { runner, image } = inRest(rules);
    const rest = SENSORS.slice(1);
    for (const s of rest) runner.query(s);
    for (const s of rest.slice(0, 4)) {
      const ran = runner.status(s, image.imageId, UpdateStage.Verified);
      expect(offerTo(ran, s)?.offer.action).toBe(UpdateAction.InstallNow);
    }
    const last = rest[4] ?? S2;
    const fifth = runner.status(last, image.imageId, UpdateStage.Verified);
    expect(offerTo(fifth, last)?.offer.action).toBe(UpdateAction.KeepAndWait);
    expect(rowOf(runner, last)?.held).toBe(UpdateHeld.WaitingTurn);
    runner.started(rest[0] ?? S2, NEW_VERSION, CONFIRMED_IMAGE);
    expect(offerWaiting(runner.view, runner.rules, runner.now, last)).toBe(true);
    expect(
      offerTo(runner.query(last, { image: image.imageId, held: UpdateHolding.Verified }), last)
        ?.offer.action,
    ).toBe(UpdateAction.InstallNow);
  });

  test("sirens and gateways one at a time between them, and no gateway while a sensor is on trial", () => {
    const { runner, image } = inRest();
    runner.query(S2);
    runner.status(S2, image.imageId, UpdateStage.Verified);
    runner.started(S2, NEW_VERSION, ON_TRIAL);
    expect(rowOf(runner, S2)?.state).toBe(DeviceUpdateState.OnTrial);

    // The gateway is verified while a sensor is on trial: it waits.
    const gateway = runner.status(
      G2,
      image.imageId,
      UpdateStage.Verified,
      0,
      fileBytes(image),
      gwArrival(1),
    );
    expect(offerTo(gateway, G2)).toBeUndefined();
    expect(rowOf(runner, G2)?.held).toBe(UpdateHeld.WaitingTurn);
    // The siren may go: no other siren or gateway is installing.
    const siren = runner.status(
      R2,
      image.imageId,
      UpdateStage.Verified,
      0,
      fileBytes(image),
      wifi(601),
    );
    expect(offerTo(siren, R2)?.offer.action).toBe(UpdateAction.InstallNow);

    // The sensor confirms: the gateway still waits for the siren.
    const sensorDone = runner.status(S2, image.imageId, UpdateStage.Confirmed);
    expect(offerTo(sensorDone, G2)).toBeUndefined();
    // The siren confirms: now the gateway is given the go-ahead.
    const sirenDone = runner.started(R2, NEW_VERSION, CONFIRMED_IMAGE, {}, wifi(601));
    expect(offerTo(sirenDone, G2)?.offer.action).toBe(UpdateAction.InstallNow);
  });

  test("done when every planned device is confirmed", () => {
    const { runner, image } = inRest();
    const order = SENSORS.slice(1);
    for (const [i, s] of order.entries()) sensorDone(runner, s, image, 510 + i);
    runner.status(R2, image.imageId, UpdateStage.Verified, 0, fileBytes(image), wifi(601));
    runner.started(R2, NEW_VERSION, CONFIRMED_IMAGE, {}, wifi(601));
    runner.status(G2, image.imageId, UpdateStage.Verified, 0, fileBytes(image), gwArrival(1));
    const last = runner.started(G2, NEW_VERSION, CONFIRMED_IMAGE, {}, gwArrival(1));
    expect(openRow(runner)).toBeUndefined();
    const ended = rolloutRows(last).at(-1);
    expect(ended?.stage).toBe(RolloutStage.Done);
    expect(ended?.endedMs).toBe(runner.now.wall);
    expect(decisions(last).map((d) => d.kind)).toContain("rollout_done");
    for (const d of [...SENSORS, ...SIRENS, ...GATEWAYS]) {
      expect(rowOf(runner, d)?.state).toBe(DeviceUpdateState.Confirmed);
    }
  });
});

function sensorDone(
  runner: Runner,
  sensor: typeof S1,
  image: ReturnType<typeof siteRunner>["image"],
  link: number,
): void {
  runner.query(sensor);
  runner.query(sensor, {}, wifi(link));
  runner.status(sensor, image.imageId, UpdateStage.Verified);
  runner.started(sensor, NEW_VERSION, CONFIRMED_IMAGE);
  expect(rowOf(runner, sensor)?.state).toBe(DeviceUpdateState.Confirmed);
}

describe("a pilot in its soak", () => {
  function soaking() {
    const { runner, image } = siteRunner();
    runner.op({ op: "rollout.start", body: { image: image.id } });
    linkAll(runner);
    pilotsDone(runner, image);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Soak);
    return { runner, image };
  }

  test("a restart by watchdog pauses the rollout, as pilotFailed", () => {
    const { runner } = soaking();
    const ran = runner.started(S1, NEW_VERSION, CONFIRMED_IMAGE, { resetCause: 6 });
    expect(openRow(runner)?.stage).toBe(RolloutStage.Paused);
    expect(openRow(runner)?.pausedDevice).toBe(S1);
    expect(decisions(ran).find((d) => d.kind === "rollout_paused")?.durability).toBe("now");
    const status = okBody(runner.op({ op: "rollout.status", body: {} }).answer) as {
      rollout: { paused: { reason: string; device: number } };
    };
    expect(status.rollout.paused).toEqual({ reason: "pilotFailed", device: S1 });
  });

  test("a restart with a fatal error pauses it; an ordinary restart does not", () => {
    const { runner } = soaking();
    runner.started(R1, NEW_VERSION, CONFIRMED_IMAGE, { resetCause: 1 }, wifi(600));
    expect(openRow(runner)?.stage).toBe(RolloutStage.Soak);
    runner.started(R1, NEW_VERSION, CONFIRMED_IMAGE, { resetCause: 1, fatal: 0x12 }, wifi(600));
    expect(openRow(runner)?.stage).toBe(RolloutStage.Paused);
  });

  test("a pilot gone silent pauses it; another device's silence does not", () => {
    const { runner } = soaking();
    runner.decision("sensor_silent", S2);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Soak);
    runner.decision("gateway_offline", G1);
    expect(openRow(runner)?.stage).toBe(RolloutStage.Paused);
    expect(openRow(runner)?.pausedDevice).toBe(G1);
  });
});

export { G2, LORA };

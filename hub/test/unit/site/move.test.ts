/**
 * The site move from the hub's side (hub-design.md section 8, "Changing the site's channel or
 * rate"; protocol.md §7; D115), through the real `step` with the stand-ins: the request and its
 * refusals; announcing in one commit before any reply carries it; confirmation from the version
 * history; `move_stalled` after 4 † intervals; no switch while one has not confirmed or while a
 * countdown runs; the switch's commit; follow and done; the reply that still announces on the old
 * settings; cancel and force; pairing during a move; the silence grace; the reply's next-setting
 * fields; a restart in each stage.
 */
import { describe, expect, test } from "bun:test";
import { MessageType, type MessageOf } from "@hsn/protocol";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";
import { bootId, deviceId, HUB_DEVICE } from "../../../src/core/model/ids.ts";
import {
  DeviceState,
  MoveStage,
  NEXT_SETTING_STAYS,
  type SensorConfigRow,
  type SiteRow,
} from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import { encodeHistory } from "../../../src/core/sensors/settings.ts";
import { nextSettingFields, sirenSiteChannelField } from "../../../src/core/site/view.ts";
import {
  Bench,
  benchSensors,
  flags,
  heartbeat,
  SECOND,
  sensorRow,
  sensorSnapshot,
  siteRowAt,
} from "../../scenarios/sensors/bench.ts";
import { standIns } from "../../scenarios/sensors/stand-ins.ts";

type Reply = MessageOf<typeof MessageType.Reply>;
const MIN = 60 * SECOND;

/** Two sensors on a DR5 site, `front` version 7 and `back` version 11, as section 7's table. */
function twoSensors(
  options: {
    readonly snapshot?: (s: DurableSnapshot) => DurableSnapshot;
    readonly downtimeMs?: number;
  } = {},
) {
  const sensors = benchSensors(2);
  const [front, back] = sensors;
  const b = new Bench(sensors, { stand: standIns({}, () => undefined, options.downtimeMs) });
  const configs = [
    sensorRow(front?.device ?? deviceId(0), 5, { version: 7 }),
    sensorRow(back?.device ?? deviceId(0), 5, { version: 11 }),
  ];
  const snapshot = sensorSnapshot(sensors, 5, { configs });
  b.boot(options.snapshot === undefined ? snapshot : options.snapshot(snapshot));
  return { b, front: front?.device ?? deviceId(0), back: back?.device ?? deviceId(0) };
}

function config(b: Bench, device: number): SensorConfigRow | undefined {
  return b.world.state.sensors.sensors.get(deviceId(device))?.config;
}

function lastReply(b: Bench, index: number, answered: number): Reply | undefined {
  const out = b.stand.radioOuts.at(-1);
  const opened = out === undefined ? undefined : b.openReply(index, out.packet, answered);
  return opened?.type === MessageType.Reply ? opened : undefined;
}

const asking = (version: number) =>
  heartbeat({ settingsVersion: version, flags: flags({ replyWanted: true }) });

describe("the request", () => {
  test("starts announcing: every sensor's version carries the next settings, all in one commit with the move", () => {
    const { b, front, back } = twoSensors();
    const commits = b.world.writer.commits.length;
    b.command({ kind: "siteChange", rate: 2 });
    expect(b.world.replies.at(-1)?.reply).toEqual({
      ok: true,
      result: { kind: "siteChange", channel: 1, rate: 2, sensors: 2 },
    });
    expect(config(b, front)).toMatchObject({
      version: 8,
      nextChannel: NEXT_SETTING_STAYS,
      nextRate: 2,
    });
    expect(config(b, back)).toMatchObject({ version: 12, nextRate: 2 });
    const commit = b.world.writer.commits.slice(commits);
    expect(commit).toHaveLength(1);
    const tables = commit[0]?.items.flatMap((i) => (i.kind === "write" ? [i.op.table] : [])) ?? [];
    expect(tables.filter((t) => t === "sensor_config")).toHaveLength(2);
    expect(tables).toContain("site");
    expect(b.world.state.site.row).toMatchObject({
      moveId: 1,
      moveStage: MoveStage.Announcing,
      moveRate: 2,
      moveChannel: NEXT_SETTING_STAYS,
      moveActor: "test",
    });
    // The move's number, and its target as a reply's next settings: channel (0xFF stays), rate.
    expect(b.decisions("move_requested").map((d) => [d.value, [...(d.detail ?? [])]])).toEqual([
      [1, [0xff, 2]],
    ]);
  });

  test("is refused while a move is in progress, and when nothing would change", () => {
    const { b } = twoSensors();
    b.command({ kind: "siteChange", rate: 5, channel: 1 });
    expect(b.world.replies.at(-1)?.reply).toMatchObject({
      ok: false,
      error: { code: "nothingToChange" },
    });
    b.command({ kind: "siteChange", rate: 2 });
    b.command({ kind: "siteChange", channel: 2 });
    expect(b.world.replies.at(-1)?.reply).toMatchObject({
      ok: false,
      error: { code: "moveInProgress" },
    });
  });
});

describe("announce, confirm, switch, follow (section 7's table)", () => {
  test("replies announce; a packet naming an announcing version confirms; the last confirmation switches", () => {
    const { b, front, back } = twoSensors();
    b.command({ kind: "siteChange", rate: 2 });
    // 40 s: back's heartbeat holds 11: the reply carries 12 with next 0xFF, DR2, at DR5.
    b.hear(b.seal(1, heartbeat({ settingsVersion: 11 }), 100), mono(40 * SECOND), 5);
    expect(lastReply(b, 1, 100)).toMatchObject({
      settingsVersion: 12,
      sendDataRate: 5,
      replyDataRate: 5,
      nextSiteChannel: 0xff,
      nextSendDataRate: 2,
    });
    b.hear(b.seal(0, heartbeat({ settingsVersion: 7 }), 100), mono(100 * SECOND), 5);
    expect(lastReply(b, 0, 100)).toMatchObject({ settingsVersion: 8, nextSendDataRate: 2 });
    // 220 s: back names 12 and asks: confirmed, written now.
    const before = b.world.effects.length;
    b.hear(b.seal(1, asking(12), 101), mono(220 * SECOND), 5);
    expect(config(b, back)?.moveConfirmed).toBe(1);
    expect(
      b.world.effects
        .slice(before)
        .some(
          (e) => e.kind === "write" && e.durability === "now" && e.op.table === "sensor_config",
        ),
    ).toBe(true);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Announcing);
    // 280 s: front names 8: 2 of 2, the switch.
    b.hear(b.seal(0, asking(8), 101), mono(280 * SECOND), 5);
    expect(b.world.state.site.row).toMatchObject({
      moveStage: MoveStage.Switched,
      rateMask: 1 << 2,
      moveSwitchedMono: mono(280 * SECOND + 30_000),
    });
    // The reply to front's heartbeat still announces: it answers a packet sent on the old settings.
    expect(lastReply(b, 0, 101)).toMatchObject({
      settingsVersion: 8,
      nextSendDataRate: 2,
      sendDataRate: 5,
    });
    // Each sensor's next version: send DR2, reply chosen again (fewer than 10 samples: kept DR5, bounded), nothing announced.
    expect(config(b, front)).toMatchObject({
      version: 9,
      sendRate: 2,
      replyRate: 5,
      nextRate: NEXT_SETTING_STAYS,
    });
    expect(config(b, back)).toMatchObject({ version: 13, sendRate: 2 });
    expect(b.decisions("move_switched").map((d) => d.value)).toEqual([0]);
    expect(b.messages("siteMove").map((m) => m.stage)).toEqual(["announcing", "switched"]);
  });

  test("a packet on the new rate follows: answered at the arrival rate, naming the new version, announcing nothing; all followed: done", () => {
    const { b, front, back } = twoSensors();
    b.command({ kind: "siteChange", rate: 2 });
    b.hear(b.seal(1, asking(12), 100), mono(220 * SECOND), 5);
    b.hear(b.seal(0, asking(8), 100), mono(280 * SECOND), 5);
    // back's door retry on DR2 with bit 7.
    const door = {
      type: MessageType.DoorChanged,
      settingsVersion: 12,
      flags: flags({ doorOpen: true, replyWanted: true, listeningAtSendRate: true }),
      batteryCode: 1,
      temperatureCelsius: 1,
      doorChangeCount: 1,
      eventAgeSeconds: 2,
    } as const;
    b.hear(b.seal(1, door, 101), mono(283.6 * SECOND), 2);
    expect(b.stand.radioOuts.at(-1)?.dataRate).toBe(2);
    expect(lastReply(b, 1, 101)).toMatchObject({
      settingsVersion: 13,
      sendDataRate: 2,
      replyDataRate: 5,
      nextSiteChannel: 0xff,
      nextSendDataRate: 0xff,
    });
    expect(config(b, back)?.moveFollowed).toBe(1);
    expect(b.decisions("device_followed").map((d) => d.deviceId)).toEqual([back]);
    // A follow's bit 7 says the old settings went unanswered, not a faster reply lost: the rate stays.
    expect(config(b, back)?.replyRate).toBe(5);
    // A packet still on the old settings, from a gateway not yet switched, is answered still announcing.
    b.hear(b.seal(0, asking(8), 101), mono(460 * SECOND), 5);
    expect(lastReply(b, 0, 101)).toMatchObject({ settingsVersion: 8, nextSendDataRate: 2 });
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Switched);
    b.hear(
      b.seal(
        0,
        heartbeat({
          settingsVersion: 8,
          flags: flags({ replyWanted: true, listeningAtSendRate: true }),
        }),
        102,
      ),
      mono(640 * SECOND),
      2,
    );
    expect(lastReply(b, 0, 102)).toMatchObject({
      settingsVersion: 9,
      sendDataRate: 2,
      nextSendDataRate: 0xff,
    });
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Done);
    expect(b.decisions("move_done").map((d) => d.value)).toEqual([0]);
    expect(config(b, front)?.moveFollowed).toBe(1);
  });

  test("the hub never switches while one sensor has not confirmed; after 4 † of its intervals, one move_stalled names it", () => {
    const { b, back } = twoSensors();
    b.command({ kind: "siteChange", rate: 2 });
    b.hear(b.seal(0, asking(8), 100), mono(60 * SECOND), 5);
    expect(b.world.advanceTo(mono(4 * 3 * MIN - SECOND)).isOk()).toBe(true);
    expect(b.decisions("move_stalled")).toEqual([]);
    expect(b.world.advanceTo(mono(4 * 3 * MIN + SECOND)).isOk()).toBe(true);
    expect(b.decisions("move_stalled").map((d) => d.deviceId)).toEqual([back]);
    expect(b.world.advanceTo(mono(60 * MIN)).isOk()).toBe(true);
    expect(b.decisions("move_stalled")).toHaveLength(1);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Announcing);
  });

  test("the switch waits for a running countdown, and goes when it ends", () => {
    const { b, front } = twoSensors();
    b.stand.armed.add(front);
    b.command({ kind: "siteChange", rate: 2 });
    b.hear(b.seal(1, asking(12), 100), mono(10 * SECOND), 5);
    const door = {
      type: MessageType.DoorChanged,
      settingsVersion: 8,
      flags: flags({ doorOpen: true, replyWanted: true }),
      batteryCode: 1,
      temperatureCelsius: 1,
      doorChangeCount: 1,
      eventAgeSeconds: 0,
    } as const;
    b.hear(b.seal(0, door, 100), mono(20 * SECOND), 5);
    expect(config(b, front)?.moveConfirmed).toBe(1);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Announcing);
    expect(b.world.advanceTo(mono(51 * SECOND)).isOk()).toBe(true);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Switched);
  });
});

describe("cancel and force", () => {
  test("cancel, only while announcing: every sensor gets a version announcing nothing", () => {
    const { b, front } = twoSensors();
    b.command({ kind: "siteChange", rate: 2 });
    b.command({ kind: "siteChangeCancel" });
    expect(b.world.replies.at(-1)?.reply).toEqual({
      ok: true,
      result: { kind: "siteChangeCancel", sensors: 2 },
    });
    expect(config(b, front)).toMatchObject({
      version: 9,
      nextChannel: NEXT_SETTING_STAYS,
      nextRate: NEXT_SETTING_STAYS,
    });
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Cancelled);
    b.hear(b.seal(0, asking(8), 100), mono(10 * SECOND), 5);
    expect(lastReply(b, 0, 100)).toMatchObject({
      settingsVersion: 9,
      nextSiteChannel: 0xff,
      nextSendDataRate: 0xff,
    });
    b.command({ kind: "siteChangeCancel" });
    expect(b.world.replies.at(-1)?.reply).toMatchObject({
      ok: false,
      error: { code: "notAnnouncing" },
    });
  });

  test("force without --yes names who would be left behind and changes nothing; with it, switches and leaves them behind", () => {
    const { b, front, back } = twoSensors();
    b.command({ kind: "siteChange", rate: 2 });
    b.hear(b.seal(0, asking(8), 100), mono(10 * SECOND), 5);
    b.command({ kind: "siteChangeForce", yes: false });
    expect(b.world.replies.at(-1)?.reply).toEqual({
      ok: true,
      result: { kind: "siteChangeForce", switched: false, leftBehind: ["sensor-2"] },
    });
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Announcing);
    b.command({ kind: "siteChangeForce", yes: true });
    expect(b.world.replies.at(-1)?.reply).toEqual({
      ok: true,
      result: { kind: "siteChangeForce", switched: true, leftBehind: ["sensor-2"] },
    });
    expect(b.world.state.site.row).toMatchObject({
      moveStage: MoveStage.Switched,
      moveForced: true,
    });
    expect(b.decisions("move_forced").map((d) => d.deviceId)).toEqual([back]);
    expect(b.decisions("move_switched").map((d) => d.value)).toEqual([1]);
    // The left-behind sensor keeps its settings and raises no silence alert.
    expect(config(b, back)?.sendRate).toBe(5);
    expect(config(b, front)?.sendRate).toBe(2);
    expect(
      b.world.state.sensors.timers.some((t) => t.key.kind === "silence" && t.key.sensor === back),
    ).toBe(false);
    b.command({ kind: "siteChangeForce", yes: true });
    expect(b.world.replies.at(-1)?.reply).toMatchObject({
      ok: false,
      error: { code: "notAnnouncing" },
    });
  });
});

describe("pairing during a move, and the silence grace", () => {
  test("a sensor paired while announcing gets a version announcing the move and is waited for", () => {
    const { b } = twoSensors();
    b.command({ kind: "siteChange", rate: 2 });
    b.stand.toAdd.set("new", { device: deviceId(20), address: 0x6f000001, role: 1 });
    b.command({ kind: "usbAdd", port: "/dev/x", name: "new" });
    expect(config(b, 20)).toMatchObject({ version: 1, nextRate: 2, sendRate: 5 });
    expect(b.world.state.site.sensors.get(deviceId(20))?.confirmed).toBe(0);
    b.command({ kind: "siteChangeStatus" });
    expect(b.world.replies.at(-1)?.reply).toMatchObject({
      ok: true,
      result: { move: { stage: "announcing", total: 3, confirmed: 0 } },
    });
  });

  test("a sensor paired after the switch gets the new settings and has nothing to follow", () => {
    const { b } = twoSensors();
    b.command({ kind: "siteChange", rate: 2 });
    b.hear(b.seal(0, asking(8), 100), mono(10 * SECOND), 5);
    b.command({ kind: "siteChangeForce", yes: true });
    b.stand.toAdd.set("late", { device: deviceId(21), address: 0x6f000002, role: 1 });
    b.command({ kind: "usbAdd", port: "/dev/x", name: "late" });
    expect(config(b, 21)).toMatchObject({
      version: 1,
      sendRate: 2,
      replyRate: 2,
      nextRate: NEXT_SETTING_STAYS,
      moveFollowed: 1,
    });
  });

  test("a sensor not heard on the new settings has its silence held back 4 † intervals after the switch", () => {
    const { b, front, back } = twoSensors();
    b.command({ kind: "siteChange", rate: 2 });
    b.hear(b.seal(0, asking(8), 100), mono(10 * SECOND), 5);
    b.hear(b.seal(1, asking(12), 100), mono(14 * MIN), 5);
    // Switched at 14 min: front's ordinary threshold, 10 s + 5 × 3 min + 30 s, falls inside the
    // grace, which ends 4 × 3 minutes after the switch; back, heard at the switch, is past it.
    const switchedAt = 14 * MIN + 30_000;
    const silence = (device: number) =>
      b.world.state.sensors.timers.find((t) => t.key.kind === "silence" && t.key.sensor === device)
        ?.at;
    expect(silence(front)).toBe(mono(switchedAt + 12 * MIN));
    expect(silence(back)).toBe(mono(switchedAt + 15 * MIN + 30 * SECOND));
    expect(b.world.state.site.timers.map((t) => [t.key.kind, t.at])).toEqual([
      ["followGraceEnd", mono(switchedAt + 12 * MIN)],
    ]);
    expect(b.world.advanceTo(mono(switchedAt + 12 * MIN - 1)).isOk()).toBe(true);
    expect(b.decisions("sensor_silent")).toEqual([]);
    expect(b.world.advanceTo(mono(switchedAt + 12 * MIN)).isOk()).toBe(true);
    expect(b.decisions("move_done").map((d) => d.value)).toEqual([2]);
    expect(b.decisions("sensor_silent").map((d) => d.deviceId)).toEqual([front]);
  });
});

describe("the next-setting fields (§6, Reply; D115)", () => {
  test("a field that stays is 0xFF; both 0xFF announce no move; the siren's channel is its site channel", () => {
    expect(nextSettingFields({ nextChannel: undefined, nextRate: 2 })).toEqual({
      nextSiteChannel: 0xff,
      nextSendDataRate: 2,
    });
    expect(nextSettingFields({ nextChannel: 2, nextRate: undefined })).toEqual({
      nextSiteChannel: 2,
      nextSendDataRate: 0xff,
    });
    expect(nextSettingFields({ nextChannel: undefined, nextRate: undefined })).toEqual({
      nextSiteChannel: 0xff,
      nextSendDataRate: 0xff,
    });
    expect(sirenSiteChannelField(2)).toEqual({ siteChannel: 2 });
  });
});

describe("a restart in each stage (section 8)", () => {
  const moving =
    (stage: number, over: Partial<SiteRow> = {}) =>
    (s: DurableSnapshot): DurableSnapshot => {
      const site = siteRowAt(stage === MoveStage.Switched ? 2 : 5, {
        moveId: 1,
        moveStage: stage as SiteRow["moveStage"],
        moveRate: 2,
        moveChannel: NEXT_SETTING_STAYS,
        ...over,
      });
      const configs = s.sensorConfig.map((c, i) =>
        stage === MoveStage.Announcing
          ? {
              ...c,
              version: c.version + 1,
              nextRate: 2,
              moveConfirmed: i === 0 ? 1 : 0,
              versionHistory: encodeHistory([
                { version: c.version + 1, replyRate: 5, move: 1 },
                { version: c.version, replyRate: 5, move: 0 },
              ]),
            }
          : {
              ...c,
              version: c.version + 2,
              sendRate: 2,
              moveConfirmed: 1,
              moveFollowed: i === 0 ? 1 : 0,
              versionHistory: encodeHistory([
                { version: c.version + 2, replyRate: 5, move: 0 },
                { version: c.version + 1, replyRate: 5, move: 1 },
              ]),
            },
      );
      return { ...s, site, sensorConfig: configs };
    };

  test("announcing: versions, next settings and confirmations are restored; the hub carries on waiting", () => {
    const { b, front, back } = twoSensors({ snapshot: moving(MoveStage.Announcing) });
    expect(b.world.state.site.sensors.get(front)?.confirmed).toBe(1);
    expect(b.world.state.site.sensors.get(back)?.confirmed).toBe(0);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Announcing);
    b.hear(b.seal(1, asking(12), 100), mono(10 * SECOND), 5);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Switched);
  });

  test("switched: the new settings stay; with the downtime unknown the grace counts from the start; one following completes it", () => {
    const { b, back } = twoSensors({
      snapshot: moving(MoveStage.Switched, {
        moveSwitchedBoot: bootId(1),
        moveSwitchedMono: mono(5 * SECOND),
      }),
    });
    expect(b.world.state.site.switchedAt).toBe(mono(0));
    expect(b.world.state.site.timers.map((t) => t.key.kind)).toEqual(["followGraceEnd"]);
    b.hear(
      b.seal(
        1,
        heartbeat({
          settingsVersion: 13,
          flags: flags({ replyWanted: true, listeningAtSendRate: true }),
        }),
        100,
      ),
      mono(10 * SECOND),
      2,
    );
    expect(b.decisions("device_followed").map((d) => d.deviceId)).toEqual([back]);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Done);
  });

  test("switched, with the downtime then known: the switch time is re-expressed like a countdown", () => {
    const { b } = twoSensors({
      downtimeMs: 30_000,
      snapshot: (s) => {
        const moved = moving(MoveStage.Switched, {
          moveSwitchedBoot: bootId(1),
          moveSwitchedMono: mono(100 * SECOND),
        })(s);
        const mark = {
          deviceId: HUB_DEVICE,
          boot: bootId(1),
          lastSeenMono: mono(160 * SECOND),
          lastSeenMs: 0,
          clockOk: true,
          window: null,
          reading: null,
          rssi: null,
          snrQ: null,
          bestGatewayId: null,
          uptimeS: null,
          estimates: null,
        };
        return { ...moved, deviceState: [mark] };
      },
    });
    expect(b.world.state.site.switchedBeforeStopMs).toBe(60_000);
    expect(b.world.input({ kind: "tick" }).isOk()).toBe(true);
    // 60 s from the switch to the last commit, 30 s down: switched 90 s before this start.
    expect(b.world.state.site.switchedAt).toBe(mono(-90 * SECOND));
    expect(b.world.state.site.timers.map((t) => t.at)).toEqual([mono(-90 * SECOND + 12 * MIN)]);
  });

  /** Switched 60 s before the last commit, then down for `downtimeMs`, known at the first tick. */
  function switchedThenDown(downtimeMs: number) {
    return twoSensors({
      downtimeMs,
      snapshot: (s) => ({
        ...moving(MoveStage.Switched, {
          moveSwitchedBoot: bootId(1),
          moveSwitchedMono: mono(100 * SECOND),
        })(s),
        deviceState: [
          {
            deviceId: HUB_DEVICE,
            boot: bootId(1),
            lastSeenMono: mono(160 * SECOND),
            lastSeenMs: 0,
            clockOk: true,
            window: null,
            reading: null,
            rssi: null,
            snrQ: null,
            bestGatewayId: null,
            uptimeS: null,
            estimates: null,
          },
        ],
      }),
    });
  }

  /** No site timer at or before the World's time: none left behind (hub-design.md section 2). */
  function noneLeft(b: Bench): void {
    const now = b.world.now.mono;
    expect(b.world.state.site.timers.filter((t) => t.at <= now)).toEqual([]);
    expect(b.world.faults.map((f) => f.message)).toEqual([]);
  }

  test("a downtime longer than the grace, known after the start: the move done in that step, naming who did not follow", () => {
    // Switched 60 s before the stop and down 20 minutes: the 12-minute grace ended 9 minutes ago.
    const { b, back } = switchedThenDown(20 * 60_000);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Switched);
    expect(b.world.input({ kind: "tick" }).isOk()).toBe(true);
    const done = b.decisions("move_done");
    expect(done.map((d) => d.value)).toEqual([1]);
    expect([...(done[0]?.detail ?? [])]).toEqual([back, 0, 0, 0]);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Done);
    noneLeft(b);
    // Done once: the time going on gives no second.
    expect(b.world.advanceByMs(30 * 60_000).isOk()).toBe(true);
    expect(b.decisions("move_done")).toHaveLength(1);
  });

  test("a downtime that ends the grace exactly now: done in that step; a millisecond less: done a millisecond later", () => {
    // Switched 60 s + 11 min before this start: the grace of 12 minutes ends at this start.
    const exact = switchedThenDown(11 * 60_000);
    expect(exact.b.world.input({ kind: "tick" }).isOk()).toBe(true);
    expect(exact.b.decisions("move_done").map((d) => d.value)).toEqual([1]);
    noneLeft(exact.b);

    const just = switchedThenDown(11 * 60_000 - 1);
    expect(just.b.world.input({ kind: "tick" }).isOk()).toBe(true);
    expect(just.b.decisions("move_done")).toEqual([]);
    expect(just.b.world.state.site.timers.map((t) => t.at)).toEqual([mono(1000)]);
    noneLeft(just.b);
    expect(just.b.world.advanceTo(mono(999)).isOk()).toBe(true);
    expect(just.b.decisions("move_done")).toEqual([]);
    expect(just.b.world.advanceTo(mono(1000)).isOk()).toBe(true);
    expect(just.b.decisions("move_done").map((d) => d.value)).toEqual([1]);
    noneLeft(just.b);
  });

  test("switched with no sensor: no grace to wait for, so the start ends the move, once", () => {
    const b = new Bench([], { stand: standIns({}, () => undefined) });
    b.boot({
      ...sensorSnapshot([], 2),
      site: siteRowAt(2, {
        moveId: 1,
        moveStage: MoveStage.Switched,
        moveRate: 2,
        moveChannel: NEXT_SETTING_STAYS,
        moveSwitchedBoot: bootId(1),
        moveSwitchedMono: mono(5 * SECOND),
      }),
    });
    expect(b.decisions("move_done").map((d) => d.value)).toEqual([0]);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Done);
    noneLeft(b);
    expect(b.world.advanceByMs(60_000).isOk()).toBe(true);
    expect(b.decisions("move_done")).toHaveLength(1);
  });

  test("a move with no sensor but a siren switches at once and is done in that step, naming the siren", () => {
    const siren = deviceId(30);
    const b = new Bench([], { stand: standIns({}, () => undefined) });
    const empty = sensorSnapshot([], 5);
    b.boot({
      ...empty,
      devices: [
        {
          id: siren,
          address: 0x6e000001,
          role: 2,
          name: "hall",
          chipId: new Uint8Array(6),
          firmware: 0x010000,
          development: true,
          state: DeviceState.Contacted,
          addedMs: 0,
          removedMs: null,
        },
      ],
    });
    b.command({ kind: "siteChange", rate: 2 });
    expect(b.decisions("move_switched")).toHaveLength(1);
    const done = b.decisions("move_done");
    expect(done.map((d) => d.value)).toEqual([1]);
    expect([...(done[0]?.detail ?? [])]).toEqual([siren, 0, 0, 0]);
    expect(b.world.state.site.row.moveStage).toBe(MoveStage.Done);
    noneLeft(b);
  });

  test("done or cancelled: nothing more", () => {
    for (const stage of [MoveStage.Done, MoveStage.Cancelled]) {
      const { b } = twoSensors({
        snapshot: (s) => ({
          ...s,
          site: siteRowAt(5, { moveId: 1, moveStage: stage as SiteRow["moveStage"] }),
        }),
      });
      expect(b.world.state.site.timers).toEqual([]);
      b.command({ kind: "siteChange", rate: 2 });
      expect(b.world.state.site.row.moveId).toBe(2);
    }
  });
});

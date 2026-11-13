/**
 * The sirens module's command rules at their boundaries (hub-design.md section 8, "What the siren
 * should do, and commands", "Which gateway a packet goes through", "Silence"; §7 "Siren command"
 * and "Hub restart"; D52, D73, D80, D95, D111, D115, SR4, SR5).
 */
import { describe, expect, test } from "bun:test";
import { MessageType, SirenAction, SirenState } from "@hsn/protocol";
import { deviceId, linkId, requestId, sendRef, seq } from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { mono } from "../../../src/core/model/time.ts";
import {
  decisionsIn,
  Direct,
  GATEWAY,
  loraArrival,
  radiosIn,
  report,
  SECOND,
  SIREN,
  sendsIn,
  sirenSnapshot,
  WIFI,
} from "./direct.ts";

function hub(counter = 1024): Direct {
  const d = new Direct();
  d.boot(sirenSnapshot({}, counter));
  d.forgoReportNow();
  d.send({ kind: "gatewayUp", gateway: GATEWAY, link: linkId(94) });
  d.send(report({ version: 3 }));
  return d;
}

const sound = (until: number): Internal => ({
  kind: "sirenIntent",
  siren: SIREN,
  should: { kind: "sound", until: mono(until) },
  cause: seq(1),
});
const off: Internal = { kind: "sirenIntent", siren: SIREN, should: { kind: "off" }, cause: seq(2) };

function counterOf(out: readonly unknown[]): number | undefined {
  return sendsIn(out as never)[0]?.counters[0]?.counter;
}

describe("commands (§7 steps 1 to 5)", () => {
  test("SR5: the seconds are what is left, capped by the siren's longest sound", () => {
    const d = hub();
    const out = d.send(sound(1_000 * SECOND));
    expect(decisionsIn(out, "siren_command").map((r) => r.value)).toEqual([
      SirenAction.SoundAlarm * 65_536 + 900,
    ]);
  });

  test("§4: a counter that is a multiple of 1,024 has the next resume point written now, before the send", () => {
    const d = hub(1024);
    const out = d.send(sound(300 * SECOND));
    const write = out.findIndex((o) => o.kind === "write" && o.op.table === "send_counters");
    const send = out.findIndex((o) => o.kind === "send");
    expect(write).toBeGreaterThanOrEqual(0);
    expect(write).toBeLessThan(send);
    expect(out[write]).toMatchObject({ durability: "now", op: { row: { resumePoint: 2048 } } });
  });

  test("SR4: repeats every 2 s on Wi-Fi and 5 s on LoRa for a minute, then siren_unreachable", () => {
    const d = hub(1100);
    d.send(sound(300 * SECOND));
    let wifi = 1;
    let lora = 1;
    for (let t = 1; t <= 60; t++) {
      const out = d.advanceTo(t * SECOND);
      wifi += sendsIn(out).length;
      lora += radiosIn(out).length;
      if (t < 60) expect(decisionsIn(out, "siren_unreachable")).toEqual([]);
      else expect(decisionsIn(out, "siren_unreachable")).toHaveLength(1);
    }
    expect([wifi, lora]).toEqual([30, 12]);
    expect(d.state.sirens.sirens.get(SIREN)?.inFlight).toBeUndefined();
  });

  test("a report naming the counter's low 16 bits confirms it; one bit off does not", () => {
    const d = hub(70_000);
    const out = d.send(sound(300 * SECOND));
    const counter = counterOf(out) ?? 0;
    d.send(report({ last: (counter + 1) & 0xffff, state: 0 }, undefined, 5001));
    expect(d.state.sirens.sirens.get(SIREN)?.inFlight).toBeDefined();
    const confirmed = d.send(
      report({ last: counter & 0xffff, state: 1, secondsLeft: 300 }, undefined, 5002),
    );
    expect(decisionsIn(confirmed, "siren_confirmed").map((r) => r.value)).toEqual([1]);
    expect(d.state.sirens.sirens.get(SIREN)?.commanded).toEqual({
      kind: "sound",
      until: mono(300 * SECOND),
    });
    // No alarm says it should sound, so the confirming report is corrected at once with Off.
    expect(d.state.sirens.sirens.get(SIREN)?.inFlight?.action).toBe(SirenAction.Off);
  });

  test("an older copy that confirms still confirms; only the newest sets what was reported", () => {
    const d = hub(1100);
    const counter = counterOf(d.send(sound(300 * SECOND))) ?? 0;
    d.send(report({ state: 1, last: counter, secondsLeft: 299 }, loraArrival(d.at), 4000, false));
    const entry = d.state.sirens.sirens.get(SIREN);
    expect(entry?.inFlight).toBeUndefined();
    expect(entry?.reported?.state).toBe(SirenState.Off);
  });

  test("§7 step 5: a newer command replaces the one in flight and its repeats", () => {
    const d = hub(1100);
    const first = counterOf(d.send(sound(300 * SECOND)));
    const second = counterOf(d.send(off));
    expect(second).toBe((first ?? 0) + 1);
    const repeats = d.advanceTo(2 * SECOND);
    expect(sendsIn(repeats).map((s) => s.counters[0]?.counter)).toEqual([second]);
  });

  test("§7 step 5: settings wait while a command is in flight, and go once it is confirmed", () => {
    const d = hub(1100);
    const counter = counterOf(d.send(sound(300 * SECOND))) ?? 0;
    const asked = d.send({
      kind: "sirenSettingsRequest",
      siren: SIREN,
      maxSoundS: 120,
      request: requestId(1),
      actor: "anna",
      record: seq(1),
    });
    expect(sendsIn(asked)).toEqual([]);
    expect(asked.some((o) => o.kind === "write" && o.op.table === "siren_config")).toBe(true);
    const after = d.send(report({ state: 0, last: counter, version: 3 }, undefined, 5003));
    expect(decisionsIn(after, "siren_settings").map((r) => r.value)).toEqual([4]);
  });

  test("a command with no socket and no gateway records no_path, a warning written now", () => {
    const d = new Direct();
    d.boot(sirenSnapshot());
    d.forgoReportNow();
    const out = d.send(sound(300 * SECOND));
    expect(decisionsIn(out, "no_path")).toHaveLength(1);
  });
});

describe("paths (section 8, 'Which gateway a packet goes through')", () => {
  test("Wi-Fi: every open socket with an accepted packet in the last 60 s ‡, none older", () => {
    const d = hub();
    d.at = mono(10 * SECOND);
    d.send(report({ version: 3 }, { path: "wifi", link: linkId(8) }, 5100));
    d.at = mono(60.001 * SECOND);
    const out = d.send(sound(300 * SECOND));
    expect(sendsIn(out).map((s) => s.link)).toEqual([linkId(8)]);
    d.at = mono(71 * SECOND);
    d.send(off);
    expect(sendsIn(d.out.slice(-10)).filter((s) => s.link === WIFI)).toEqual([]);
  });

  test("a socket that closed is used no more", () => {
    const d = hub();
    d.send({ kind: "linkClosed", link: WIFI, reason: "remote" });
    expect(sendsIn(d.send(sound(300 * SECOND)))).toEqual([]);
  });

  test("LoRa: the best SNR in 15 minutes ‡ among open sessions, the newest on a tie", () => {
    const d = hub();
    const near = deviceId(40);
    const far = deviceId(41);
    d.send({ kind: "gatewayUp", gateway: near, link: linkId(40) });
    d.send({ kind: "gatewayUp", gateway: far, link: linkId(41) });
    d.send(report({}, loraArrival(d.at, 30, near), 5200, false));
    d.send(report({}, loraArrival(d.at, 10, far), 5201, false));
    expect(radiosIn(d.send(sound(300 * SECOND)))[0]?.gateway).toBe(near);
    d.send({ kind: "gatewayDown", gateway: near });
    expect(radiosIn(d.send(off))[0]?.gateway).toBe(far);
    d.send({ kind: "gatewayUp", gateway: near, link: linkId(40) });
    d.send(report({}, loraArrival(d.at, 10, near), 5202, false));
    // Equal SNR now; `far`'s copy... and `near`'s newer copy wins.
    d.send(report({}, loraArrival(d.at, 30, far), 5203, false));
    d.send(report({}, loraArrival(d.at, 30, near), 5204, false));
    expect(radiosIn(d.send(sound(300 * SECOND)))[0]?.gateway).toBe(near);
    d.at = mono(16 * 60 * SECOND);
    // Heard by none in 15 minutes: any connected gateway, the lowest id.
    expect(radiosIn(d.send(off))[0]?.gateway).toBe(GATEWAY);
  });
});

describe("correcting a siren (section 8)", () => {
  function alarmed(until: number): Direct {
    const d = hub(1100);
    d.state = {
      ...d.state,
      alarm: {
        ...d.state.alarm,
        alarm: {
          startedAt: mono(0),
          cause: seq(1),
          triggers: new Map(),
          sirens: new Map([
            [SIREN, { until: mono(until), commanded: true, restore: "fresh" as const }],
          ]),
          quietEnd: mono(until),
        },
      },
    };
    return d;
  }

  test("should sound with at least 10 s ‡ left and reports off: sounded for what is left", () => {
    const d = alarmed(100 * SECOND);
    d.at = mono(90 * SECOND);
    const out = d.send(report({ state: SirenState.Off }, undefined, 6000));
    expect(decisionsIn(out, "siren_command").map((r) => r.value)).toEqual([
      SirenAction.SoundAlarm * 65_536 + 10,
    ]);
  });

  test("with less than 10 s left it is left off", () => {
    const d = alarmed(100 * SECOND);
    d.at = mono(90.5 * SECOND);
    expect(
      decisionsIn(d.send(report({ state: SirenState.Off }, undefined, 6000)), "siren_command"),
    ).toEqual([]);
  });

  test("should be off and reports sounding for an alarm: commanded off; a test is left to end", () => {
    const d = hub(1100);
    const testing = d.send(report({ state: SirenState.Testing, secondsLeft: 4 }, undefined, 6001));
    expect(decisionsIn(testing, "siren_command")).toEqual([]);
    const sounding = d.send(
      report({ state: SirenState.SoundingAlarm, secondsLeft: 100 }, undefined, 6002),
    );
    expect(decisionsIn(sounding, "siren_command").map((r) => r.value)).toEqual([0]);
  });

  test("a report that is not the newest corrects nothing (section 5: replays)", () => {
    const d = hub(1100);
    const out = d.send(
      report({ state: SirenState.SoundingAlarm, secondsLeft: 100 }, undefined, 10, false),
    );
    expect(decisionsIn(out, "siren_command")).toEqual([]);
  });

  test("a late copy after a command gave up corrects nothing: only the newest report is answered", () => {
    const d = alarmed(200 * SECOND);
    d.send(sound(200 * SECOND));
    d.send(report({ state: SirenState.Off }, undefined, 6100));
    d.advanceTo(60 * SECOND);
    expect(d.state.sirens.sirens.get(SIREN)?.inFlight).toBeUndefined();
    const late = d.send(report({ state: SirenState.Off }, loraArrival(d.at), 6050, false));
    expect(decisionsIn(late, "siren_command")).toEqual([]);
  });

  test("nothing is corrected while a command is in flight", () => {
    const d = hub(1100);
    d.send(off);
    const out = d.send(
      report({ state: SirenState.SoundingAlarm, secondsLeft: 100 }, undefined, 6003),
    );
    expect(decisionsIn(out, "siren_command")).toEqual([]);
  });
});

describe("settings and versions (§6, D115)", () => {
  test("a report holding another version, nothing in flight: the settings, repeated like a command", () => {
    const d = hub(1100);
    const out = d.send(report({ version: 2 }, undefined, 7000));
    expect(decisionsIn(out, "siren_settings").map((r) => r.value)).toEqual([3]);
    expect(sendsIn(d.advanceTo(2 * SECOND))).toHaveLength(1);
  });

  test("D115: a move's settings keep going every 60 s ‡ after the first minute, until confirmed", () => {
    const d = hub(1100);
    d.send({ kind: "siteMove", move: 1, stage: "switched", channel: 2, rate: 2, forced: false });
    d.advanceTo(60 * SECOND);
    expect(decisionsIn(d.out, "siren_unreachable")).toHaveLength(1);
    expect(radiosIn(d.advanceTo(119 * SECOND))).toEqual([]);
    expect(radiosIn(d.advanceTo(120 * SECOND))).toHaveLength(1);
    expect(radiosIn(d.advanceTo(180 * SECOND))).toHaveLength(1);
    const counter = d.state.sirens.sirens.get(SIREN)?.inFlight?.counter ?? 0;
    d.send(report({ version: 4, last: counter }, undefined, 7001));
    expect(d.state.sirens.sirens.get(SIREN)?.inFlight).toBeUndefined();
  });

  test("the command rate is that of the version last reported (section 8)", () => {
    const d = hub(1100);
    d.send({ kind: "siteMove", move: 1, stage: "switched", channel: 1, rate: 0, forced: false });
    // The siren still holds version 3, whose command rate is DR5.
    expect(radiosIn(d.out).at(-1)?.dataRate).toBe(5);
    const counter = d.state.sirens.sirens.get(SIREN)?.inFlight?.counter ?? 0;
    d.send(report({ version: 4, last: counter }, undefined, 7002));
    expect(radiosIn(d.send(sound(300 * SECOND)))[0]?.dataRate).toBe(3);
  });
});

describe("report now after a start (§7 'Hub restart', D80)", () => {
  test("goes when a gateway comes up within 120 s ‡, as an ordinary command; not after", () => {
    const d = new Direct();
    d.boot(sirenSnapshot());
    d.at = mono(119 * SECOND);
    const out = d.send({ kind: "gatewayUp", gateway: GATEWAY, link: linkId(94) });
    expect(decisionsIn(out, "siren_command").map((r) => r.value)).toEqual([
      SirenAction.ReportNow * 65_536,
    ]);
    const late = new Direct();
    late.boot(sirenSnapshot());
    late.advanceTo(120 * SECOND);
    expect(
      decisionsIn(
        late.send({ kind: "gatewayUp", gateway: GATEWAY, link: linkId(94) }),
        "siren_command",
      ),
    ).toEqual([]);
  });

  test("is owed no more once the siren has reported", () => {
    const d = new Direct();
    d.boot(sirenSnapshot());
    d.send(report({ version: 3 }));
    expect(
      decisionsIn(
        d.send({ kind: "gatewayUp", gateway: GATEWAY, link: linkId(94) }),
        "siren_command",
      ),
    ).toEqual([]);
  });
});

describe("silence (section 8; D52, D73)", () => {
  test("D73: Wi-Fi lost at 70 s ‡ without a packet, not before; a packet clears it", () => {
    const d = hub();
    expect(decisionsIn(d.advanceTo(69.9 * SECOND), "siren_wifi_lost")).toEqual([]);
    expect(decisionsIn(d.advanceTo(70 * SECOND), "siren_wifi_lost")).toHaveLength(1);
    d.send(report({ version: 3 }, undefined, 8000));
    expect(d.state.sirens.sirens.get(SIREN)?.paths.wifiLost).toBe(false);
  });

  test("D73: a LoRa report with reason 3 loses Wi-Fi at once", () => {
    const d = hub();
    const out = d.send(report({ version: 3, reason: 3 }, loraArrival(d.at), 8001));
    expect(decisionsIn(out, "siren_wifi_lost")).toHaveLength(1);
  });

  test("D73: LoRa lost after 630 s ‡ with nothing on it while Wi-Fi works", () => {
    const d = hub();
    for (let t = 30; t <= 630; t += 30) {
      d.at = mono(t * SECOND - 1);
      d.send(report({ version: 3 }, undefined, 8100 + t));
      const out = d.advanceTo(t * SECOND - 1);
      if (t < 630) expect(decisionsIn(out, "siren_lora_lost")).toEqual([]);
    }
    expect(decisionsIn(d.advanceTo(630 * SECOND), "siren_lora_lost")).toHaveLength(1);
  });

  for (const [rate, silentAfterS] of [
    [5, 70],
    [2, 174.8],
    [0, 691.7],
  ] as const) {
    test(`D52: on LoRa alone at DR${rate}, silent after ${silentAfterS} s`, () => {
      const d = new Direct();
      d.boot(sirenSnapshot({ sendRate: rate }));
      d.forgoReportNow();
      d.send(report({ version: 3, reason: 3 }, loraArrival(d.at), 9000));
      const before = d.advanceTo((silentAfterS - 0.2) * SECOND);
      expect(decisionsIn(before, "siren_silent")).toEqual([]);
      expect(decisionsIn(d.advanceTo((silentAfterS + 0.2) * SECOND), "siren_silent")).toHaveLength(
        1,
      );
      // With Wi-Fi lost, LoRa's own loss is not judged: silence is (D73).
      expect(decisionsIn(d.out, "siren_lora_lost")).toEqual([]);
    });
  }
});

describe("outcomes and records (section 6, D110)", () => {
  test("a LoRa packet's tx row is written when its transmit result comes, with the outcome", () => {
    const d = hub(1100);
    const radio = radiosIn(d.send(sound(300 * SECOND)))[0];
    const out = d.send({
      kind: "radioResult",
      ref: radio?.ref ?? sendRef(0),
      device: SIREN,
      gateway: GATEWAY,
      requestCounter: 61_440,
      outcome: 3,
      sentGatewayMicros: undefined,
    });
    const tx = out.flatMap((o) =>
      o.kind === "auditRecord" && o.record.kind === "tx" ? [o.record.row] : [],
    );
    expect(tx.map((r) => [r.outcome, r.path, r.type, r.requestCounter])).toEqual([
      [3, 0, MessageType.SirenCommand, 61_440],
    ]);
  });
});

describe("devices added (section 9, D40)", () => {
  test("D40: a new siren gets version 1 on the site's channel and rate, capped at 300 s, written now", () => {
    const d = new Direct();
    d.boot(sirenSnapshot());
    const out = d.send({
      kind: "deviceAdded",
      device: deviceId(60),
      role: 2,
      address: 0x70000001,
      name: "attic",
    });
    const rows = out.flatMap((o) =>
      o.kind === "write" && o.op.op === "upsert" && o.op.table === "siren_config"
        ? [[o.durability, o.op.row]]
        : [],
    );
    expect(rows).toMatchObject([
      ["now", { deviceId: 60, version: 1, maxSoundS: 300, wifiIntervalS: 30, loraCheckUnits: 20 }],
    ]);
  });

  test("D40 D86: a new sensor is disarmed with the site's default countdown of 30 s", () => {
    const d = new Direct();
    d.boot(sirenSnapshot());
    d.send({
      kind: "deviceAdded",
      device: deviceId(61),
      role: 1,
      address: 0x70000002,
      name: "garage",
    });
    expect(d.state.alarm.sensors.get(deviceId(61))).toMatchObject({ arm: 0, countdownS: 30 });
  });
});

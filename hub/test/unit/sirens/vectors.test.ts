/**
 * The protocol's siren vectors (hub-design.md section 11, "Unit tests of the core, against the
 * protocol's vectors"): every `siren-command` and `siren-settings` case produced byte for byte by
 * the sirens module in the state that makes it send that case's message with that counter, the
 * new site channel of D115 included; every `siren-report` case opened and taken in.
 */
import { describe, expect, test } from "bun:test";
import { MessageType, NO_BINDING, SirenState } from "@hsn/protocol";
import { linkId, seq } from "../../../src/core/model/ids.ts";
import { mono } from "../../../src/core/model/time.ts";
import { vectorsOf } from "../../world/vectors.ts";
import {
  cipher,
  Direct,
  GATEWAY,
  loraArrival,
  radiosIn,
  report,
  SECOND,
  SIREN,
  sendsIn,
  sirenSnapshot,
  wifiArrival,
} from "./direct.ts";

function vector(file: string, name: string) {
  const found = vectorsOf(file).find((v) => v.name === name);
  expect(found).toBeDefined();
  return found;
}

/** A hub that knows the siren, a gateway up, and no "report now" owed (section 7). */
function hub(counter: number, settings: Parameters<typeof sirenSnapshot>[0] = {}): Direct {
  const d = new Direct();
  d.boot(sirenSnapshot(settings, counter));
  d.forgoReportNow();
  d.send({ kind: "gatewayUp", gateway: GATEWAY, link: linkId(94) });
  return d;
}

describe("siren-command.json, every case byte for byte (§6, §7)", () => {
  test("action 1: SoundAlarm 180 s, from what the siren should do", () => {
    const v = vector("siren-command.json", "siren command, action 1");
    const d = hub(7000);
    d.send(report({ version: 3 }));
    const out = d.send({
      kind: "sirenIntent",
      siren: SIREN,
      should: { kind: "sound", until: mono(180 * SECOND) },
      cause: seq(1),
    });
    const sent = sendsIn(out);
    expect(sent[0]?.bytes).toEqual(v?.packet);
    // The same bytes on LoRa, at siren priority (D73, D111).
    expect(radiosIn(out)[0]?.packet).toEqual(v?.packet);
    expect(radiosIn(out)[0]?.priority).toBe(1);
  });

  test("action 2: Test 5 s; action 0: Off; action 3: report now", () => {
    const test2 = vector("siren-command.json", "siren command, action 2");
    const off = vector("siren-command.json", "siren command, action 0");
    const now3 = vector("siren-command.json", "siren command, action 3");
    const d = hub(7001);
    d.send(report({ version: 3 }));
    const t = d.send({
      kind: "sirenIntent",
      siren: SIREN,
      should: { kind: "test", until: mono(5 * SECOND) },
      cause: seq(1),
    });
    expect(sendsIn(t)[0]?.bytes).toEqual(test2?.packet);
    const o = d.send({ kind: "sirenIntent", siren: SIREN, should: { kind: "off" }, cause: seq(2) });
    expect(sendsIn(o)[0]?.bytes).toEqual(off?.packet);
    // "Report now" after a start, as the siren's path appears (section 7).
    const fresh = new Direct();
    fresh.boot(sirenSnapshot({}, 7003));
    fresh.send({
      kind: "accepted",
      device: SIREN,
      role: 2,
      counter: 9,
      message: {
        type: MessageType.Started,
        role: 2,
        firmwareVersion: { major: 1, minor: 0, patch: 0 },
        resetCause: 3,
        lastFatalError: 0,
        settingsVersion: 3,
      },
      arrival: wifiArrival,
      record: seq(5),
      newest: true,
    });
    const r = fresh.out;
    expect(sendsIn(r)[0]?.bytes).toEqual(now3?.packet);
  });

  test("an unlisted action 7 with 65,535 s passes through the packet builder unchanged (§3)", async () => {
    const v = vector(
      "siren-command.json",
      "siren command with unlisted action 7, which passes through",
    );
    const d = hub(7004, { maxSoundS: 65535 });
    d.send(report({ version: 3 }));
    const { issue } = await import("../../../src/core/sirens/send.ts");
    const result = issue(
      d.state.sirens,
      d.context(),
      SIREN,
      { purpose: "sirenCommand", action: 7, seconds: 65535 },
      undefined,
    );
    expect(result.isOk() && sendsIn(result.value.out)[0]?.bytes).toEqual(v?.packet);
  });
});

describe("siren-settings.json, every case byte for byte (§6, D115)", () => {
  /** Settings go when a report shows another version and nothing is in flight. */
  function settingsFrom(
    counter: number,
    settings: Parameters<typeof sirenSnapshot>[0],
  ): Uint8Array | undefined {
    const d = hub(counter, settings);
    return sendsIn(d.send(report({ version: 1 })))[0]?.bytes;
  }

  test("siren settings, and at every limit with unlisted rates 6 and 7", () => {
    expect(
      settingsFrom(7100, {
        version: 2,
        wifiIntervalS: 30,
        loraCheckUnits: 20,
        maxSoundS: 900,
        sendRate: 2,
        commandRate: 5,
        siteChannel: 0,
      }),
    ).toEqual(vector("siren-settings.json", "siren settings")?.packet);
    expect(
      settingsFrom(7102, {
        version: 255,
        wifiIntervalS: 255,
        loraCheckUnits: 255,
        maxSoundS: 65535,
        sendRate: 6,
        commandRate: 7,
        siteChannel: 2,
      }),
    ).toEqual(
      vector(
        "siren-settings.json",
        "siren settings at every limit, with unlisted data rates 6 and 7",
      )?.packet,
    );
    expect(
      settingsFrom(7103, {
        version: 4,
        wifiIntervalS: 30,
        loraCheckUnits: 20,
        maxSoundS: 900,
        sendRate: 2,
        commandRate: 5,
        siteChannel: 3,
      }),
    ).toEqual(
      vector(
        "siren-settings.json",
        "siren settings with unlisted site channel 3, which passes through",
      )?.packet,
    );
  });

  test("D115: a site switch to channel 868.3 and DR0 gives the slow site's settings, version 3", () => {
    const d = hub(7101, {
      version: 2,
      wifiIntervalS: 60,
      loraCheckUnits: 40,
      maxSoundS: 180,
      sendRate: 5,
      commandRate: 5,
      siteChannel: 0,
    });
    d.send(report({ version: 2 }));
    const out = d.send({
      kind: "siteMove",
      move: 1,
      stage: "switched",
      channel: 1,
      rate: 0,
      forced: false,
    });
    // Written now with the switch, before it is sent (section 5).
    const write = out.findIndex((o) => o.kind === "write" && o.op.table === "siren_config");
    const send = out.findIndex((o) => o.kind === "send");
    expect(write).toBeGreaterThanOrEqual(0);
    expect(write).toBeLessThan(send);
    expect(sendsIn(out)[0]?.bytes).toEqual(
      vector("siren-settings.json", "siren settings for a slow site")?.packet,
    );
    // Announced again after a restart, the switch bumps nothing twice.
    const again = d.send({
      kind: "siteMove",
      move: 1,
      stage: "switched",
      channel: 1,
      rate: 0,
      forced: false,
    });
    expect(again.filter((o) => o.kind === "write")).toEqual([]);
  });
});

describe("siren-report.json, every case opened and taken in (§6)", () => {
  for (const v of vectorsOf("siren-report.json")) {
    test(v.name, () => {
      const opened = cipher.open(SIREN, v.packet, { binding: NO_BINDING, maxLength: v.maxLength });
      expect(opened.isOk()).toBe(true);
      if (opened.isErr()) return;
      const { message } = opened.value;
      expect(message.type).toBe(MessageType.SirenReport);
      if (message.type !== MessageType.SirenReport) return;
      const d = hub(1024);
      const arrival = v.maxLength === 1024 ? wifiArrival : loraArrival(d.at);
      const out = d.send({
        kind: "accepted",
        device: SIREN,
        role: 2,
        counter: v.counter,
        message,
        arrival,
        record: seq(3),
        newest: true,
      });
      const entry = d.state.sirens.sirens.get(SIREN);
      expect(entry?.reported).toEqual({
        state: message.state,
        secondsLeft: message.soundingSecondsLeft,
        version: message.settingsVersion,
        at: d.at,
      });
      const commands = sendsIn(out).length + radiosIn(out).length;
      // Should be off: only a report of sounding for an alarm is corrected, with Off; an unlisted
      // state 9 is acted on by nobody. Version 2 is not the hub's 3, so settings follow otherwise.
      if (message.state === SirenState.SoundingAlarm) {
        expect(
          out.some(
            (o) =>
              o.kind === "auditRecord" && o.record.kind === "decision" && o.record.row.value === 0,
          ),
        ).toBe(true);
      }
      expect(commands).toBeGreaterThan(0);
    });
  }
});

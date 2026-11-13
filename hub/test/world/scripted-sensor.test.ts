/**
 * The scripted sensor against the firmware's sensor role (firmware/roles/sensor/: heartbeat.cpp,
 * replies.cpp, reports.cpp, data_rates.cpp; protocol.md §6, §7), with a hand-made hub on
 * `@hsn/protocol`: Started first; heartbeats at the interval ±10% until a slot, on a clock that
 * drifts; a link check every 5th, every one after a miss, and bit 7 and no slot after two; door
 * reports with their age, retried about 2, 5 and 10 s after the change then every 60 s with a
 * random extra wait, never past 10 minutes; replies taken only in the window, at the listen rate,
 * bound to its counters; and a site move followed.
 */
import { describe, expect, test } from "bun:test";
import {
  counterBinding,
  Direction,
  MaxPacketLength,
  type Message,
  MessageType,
  type MessageOf,
  NEXT_SETTING_UNCHANGED,
  openPacket,
  sealPacket,
} from "@hsn/protocol";
import { type Mono, mono } from "../../src/core/model/time.ts";
import { SeededBytes } from "./entropy.ts";
import { ScriptedSensor, type Transmission } from "./scripted-sensor.ts";

const S = 1_000_000;
const KEY = new Uint8Array(16).map((_, i) => i + 1);
const ADDRESS = 0x5e000001;

function sensor(
  over: Partial<ConstructorParameters<typeof ScriptedSensor>[0]> = {},
): ScriptedSensor {
  const random = new SeededBytes(3);
  return new ScriptedSensor({
    key: KEY,
    address: ADDRESS,
    channel: 1,
    rate: 5,
    random: () => random.next() / 2 ** 32,
    startAt: mono(S),
    ...over,
  });
}

/** Runs the sensor alone until `until`, collecting what it sends; `answer` may reply to each packet. */
function run(
  s: ScriptedSensor,
  until: number,
  answer?: (t: Transmission, message: Message, counter: number) => void,
): { t: Transmission; message: Message; counter: number }[] {
  const out: { t: Transmission; message: Message; counter: number }[] = [];
  for (let wake = s.nextWake(); wake !== undefined && wake <= until; wake = s.nextWake()) {
    for (const t of s.wake(wake)) {
      const opened = openPacket(t.packet, {
        key: KEY,
        expectedDirection: Direction.ToHub,
        binding: new Uint8Array(),
        maxLength: MaxPacketLength.Radio,
      });
      if (!opened.ok) continue;
      out.push({ t, message: opened.value.message, counter: opened.value.header.counter });
      answer?.(t, opened.value.message, opened.value.header.counter);
    }
  }
  return out;
}

let hubCounter = 1;
/** A reply from the hub, bound to `answered`. */
function reply(
  answered: number,
  over: Partial<MessageOf<typeof MessageType.Reply>> = {},
): Uint8Array {
  return sealPacket(
    {
      type: MessageType.Reply,
      settingsVersion: 2,
      flags: { armed: false, countdownStarted: false, updateAvailable: false },
      countdownSeconds: 30,
      countdownRemainingSeconds: 0,
      heartbeatIntervalUnits: 12,
      linkCheckEvery: 5,
      sendDataRate: 5,
      replyDataRate: 5,
      nextHeartbeatTenths: 0,
      clockCorrectionTenPpm: 0,
      nextSiteChannel: NEXT_SETTING_UNCHANGED,
      nextSendDataRate: NEXT_SETTING_UNCHANGED,
      ...over,
    },
    {
      key: KEY,
      direction: Direction.FromHub,
      address: ADDRESS,
      counter: hubCounter++,
      binding: counterBinding(answered),
      maxLength: MaxPacketLength.Radio,
    },
  );
}

const kinds = (sent: readonly { message: Message }[]) => sent.map((x) => x.message.type);

describe("start and heartbeats", () => {
  test("Started first, retried unanswered, then heartbeats at 3 minutes ±10% on its own clock", () => {
    const s = sensor({ drift: 0.03 });
    const sent = run(s, 20 * 60 * S);
    expect(sent[0]?.message.type).toBe(MessageType.Started);
    const beats = sent.filter((x) => x.message.type === MessageType.Heartbeat);
    for (const [a, b] of beats.slice(1).map((x, i) => [beats[i], x] as const)) {
      const gap = (b.t.start - (a?.t.start ?? 0)) / S;
      // 180 s on a clock 3 % fast is 174.8 s; ±10%.
      expect(gap).toBeGreaterThan((180 / 1.03) * 0.9 - 1);
      expect(gap).toBeLessThan((180 / 1.03) * 1.1 + 1);
    }
  });

  test("a link check every 5th; after a miss every heartbeat asks; after two, bit 7 and no slot", () => {
    const s = sensor();
    let answeredStarted = false;
    const sent = run(s, 40 * 60 * S, (t, m, counter) => {
      if (m.type === MessageType.Started && !answeredStarted) {
        answeredStarted = true;
        s.hear(reply(counter), 5, mono(t.end + 100_000));
      }
    });
    const beats = sent.filter(
      (x): x is typeof x & { message: Extract<Message, { type: 1 }> } =>
        x.message.type === MessageType.Heartbeat,
    );
    const asks = beats.map((b) => b.message.flags.replyWanted);
    expect(asks.slice(0, 5)).toEqual([false, false, false, false, true]);
    // Unanswered from the 5th on: every one asks, and from the 7th on, bit 7.
    expect(asks.slice(5, 8)).toEqual([true, true, true]);
    expect(beats.slice(4, 8).map((b) => b.message.flags.listeningAtSendRate)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(s.slotted).toBe(false);
  });

  test("a reply's next heartbeat puts it in the slot, counted from the answered end on its corrected clock", () => {
    const s = sensor({ drift: 0.01 });
    let target: Mono | undefined;
    const sent = run(s, 10 * 60 * S, (t, m, counter) => {
      if (m.type !== MessageType.Started) return;
      // Corrected exactly: 1 % fast held as 1,000 units of 10 ppm.
      s.hear(
        reply(counter, { nextHeartbeatTenths: 450, clockCorrectionTenPpm: 1000 }),
        5,
        mono(t.end + 50_000),
      );
      target = mono(t.end + 45 * S);
    });
    expect(s.slotted).toBe(true);
    const beats = sent.filter((x) => x.message.type === MessageType.Heartbeat);
    expect(Math.abs((beats[0]?.t.start ?? 0) - (target ?? 0))).toBeLessThan(1000);
    // Then every interval on the corrected clock: 180 s exactly.
    expect(Math.abs((beats[1]?.t.start ?? 0) - (beats[0]?.t.start ?? 0) - 180 * S)).toBeLessThan(
      1000,
    );
  });

  test("a reply outside the window, at another rate, or bound to another counter is not taken", () => {
    const s = sensor();
    run(s, 2 * S, (t, m, counter) => {
      if (m.type !== MessageType.Started) return;
      s.hear(reply(counter), 5, mono(t.end + 1600 * 1000));
      s.hear(reply(counter), 3, mono(t.end + 100_000));
      s.hear(reply(counter + 1), 5, mono(t.end + 100_000));
    });
    expect(s.replies).toEqual([]);
  });
});

describe("door reports (§7, No reply from the hub)", () => {
  test("go at once with their age, retried about 2, 5, 10 s then every 60 s with an extra wait, for 10 minutes", () => {
    const s = sensor();
    s.door(mono(100 * S), true);
    const sent = run(s, 30 * 60 * S, (t, m, counter) => {
      if (m.type === MessageType.Started) s.hear(reply(counter), 5, mono(t.end + 100_000));
    });
    const doors = sent.filter(
      (x): x is typeof x & { message: Extract<Message, { type: 2 }> } =>
        x.message.type === MessageType.DoorChanged,
    );
    const offsets = doors.map((d) => (d.t.start - 100 * S) / S);
    expect(offsets[0]).toBe(0);
    expect(doors.map((d) => d.message.eventAgeSeconds)).toEqual(offsets.map((o) => Math.floor(o)));
    const nominal = [0, 2, 5, 10, 70, 130, 190, 250, 310, 370, 430, 490, 550];
    expect(doors).toHaveLength(nominal.length);
    nominal.forEach((at, i) => {
      const gap = i === 0 ? 0 : at - (nominal[i - 1] ?? 0);
      expect(offsets[i]).toBeGreaterThanOrEqual(at);
      expect(offsets[i]).toBeLessThanOrEqual(at + gap / 2 + 1.6);
    });
    expect(doors.every((d) => d.message.flags.replyWanted && d.message.flags.doorOpen)).toBe(true);
  });

  test("an armed opening whose first try goes unanswered sets bit 5 until a reply", () => {
    const s = sensor({ armed: true, version: 2 });
    s.door(mono(100 * S), true);
    let tries = 0;
    const sent = run(s, 120 * S, (t, m, counter) => {
      if (m.type === MessageType.DoorChanged && ++tries === 2)
        s.hear(
          reply(counter, {
            flags: { armed: true, countdownStarted: true, updateAvailable: false },
            countdownRemainingSeconds: 28,
          }),
          5,
          mono(t.end + 100_000),
        );
      if (m.type === MessageType.Started)
        s.hear(
          reply(counter, {
            flags: { armed: true, countdownStarted: false, updateAvailable: false },
          }),
          5,
          mono(t.end + 100_000),
        );
    });
    const doors = sent.filter(
      (x): x is typeof x & { message: Extract<Message, { type: 2 }> } =>
        x.message.type === MessageType.DoorChanged,
    );
    expect(doors.map((d) => d.message.flags.localAlarmSounded)).toEqual([false, true]);
    expect(s.localAlarmSounded).toBe(false);
    expect(s.buzzing).toBe(true);
  });
});

describe("a site move (§7, Changing the site's channel or rate)", () => {
  test("holding next settings it asks every heartbeat; after a miss the next packet goes on them with bit 7; a reply to it makes them current", () => {
    const s = sensor();
    let phase: "announce" | "silent" | "follow" = "announce";
    const sent = run(s, 40 * 60 * S, (t, m, counter) => {
      if (phase === "announce" && m.type === MessageType.Started) {
        s.hear(reply(counter, { nextSendDataRate: 2 }), 5, mono(t.end + 100_000));
        phase = "silent";
      } else if (phase === "silent" && t.dataRate === 2) {
        s.hear(
          reply(counter, { sendDataRate: 2, replyDataRate: 4, settingsVersion: 3 }),
          2,
          mono(t.end + S),
        );
        phase = "follow";
      }
    });
    const beats = sent.filter(
      (x): x is typeof x & { message: Extract<Message, { type: 1 }> } =>
        x.message.type === MessageType.Heartbeat,
    );
    expect(beats[0]?.message.flags.replyWanted).toBe(true);
    const moved = beats.findIndex((b) => b.t.dataRate === 2);
    expect(moved).toBe(1);
    expect(beats[moved]?.message.flags.listeningAtSendRate).toBe(true);
    expect(s.next).toBeUndefined();
    expect(s.held.sendRate).toBe(2);
    expect(beats.slice(moved + 1).every((b) => b.t.dataRate === 2)).toBe(true);
    expect(kinds(sent)[0]).toBe(MessageType.Started);
  });

  test("a reply announcing nothing clears next settings", () => {
    const s = sensor();
    let n = 0;
    run(s, 10 * 60 * S, (t, _message, counter) => {
      n += 1;
      if (n === 1) s.hear(reply(counter, { nextSendDataRate: 2 }), 5, mono(t.end + 100_000));
      if (n === 2) s.hear(reply(counter), 5, mono(t.end + 1_000_000));
    });
    expect(s.next).toBeUndefined();
    expect(s.held.sendRate).toBe(5);
  });
});

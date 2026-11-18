import { describe, expect, test } from "bun:test";
import {
  concatBytes,
  decodeMessage,
  encodeMessage,
  fromHex,
  type Message,
  MessageType,
  SENSOR_STATUS_FLAGS,
} from "../src/index.ts";
import { packetCases } from "../scripts/vectors/packetCases.ts";

const samples: readonly Message[] = packetCases.map((c) => c.message);
const knownTypes = new Set<number>(Object.values(MessageType));
/** Types whose last field runs to the end of the body. */
const openEnded = new Set<number>([
  MessageType.ForwardedPacket,
  MessageType.TransmitRequest,
  MessageType.LogEntries,
]);

/** Body length of each fixed-size type, from section 6. */
const fixedBodyLength: Readonly<Record<number, number>> = {
  [MessageType.Heartbeat]: 7,
  [MessageType.DoorChanged]: 7,
  [MessageType.CoverChanged]: 7,
  [MessageType.Button]: 8,
  [MessageType.Started]: 8,
  [MessageType.UpdateQuery]: 15,
  [MessageType.UpdateStatus]: 14,
  [MessageType.SirenReport]: 10,
  [MessageType.Hello]: 12,
  [MessageType.GatewayStatus]: 16,
  [MessageType.TransmitResult]: 9,
  [MessageType.Interference]: 4,
  [MessageType.Reply]: 14,
  [MessageType.DisarmedNotice]: 0,
  [MessageType.UpdateOffer]: 25,
  [MessageType.KeyChange]: 16,
  [MessageType.SirenCommand]: 3,
  [MessageType.SirenSettings]: 8,
  [MessageType.Welcome]: 8,
  [MessageType.GatewaySettings]: 8,
};

describe("every message type", () => {
  test("has samples", () => {
    expect(new Set<number>(samples.map((m) => m.type))).toEqual(knownTypes);
  });

  test.each(samples.map((m) => [m.type, m] as const))(
    "type 0x%x sample round-trips",
    (_, message) => {
      expect(decodeMessage(encodeMessage(message))).toEqual({ ok: true, value: message });
    },
  );

  test("fixed bodies have the sizes section 6 lists", () => {
    for (const message of samples) {
      const expected = fixedBodyLength[message.type];
      if (expected !== undefined) expect(encodeMessage(message).length).toBe(1 + expected);
      else expect(openEnded.has(message.type)).toBe(true);
    }
  });

  test("a fixed body cut short at any length is truncated", () => {
    for (const message of samples.filter((m) => !openEnded.has(m.type))) {
      const plaintext = encodeMessage(message);
      for (let length = 0; length < plaintext.length; length++) {
        expect(decodeMessage(plaintext.subarray(0, length))).toEqual({
          ok: false,
          error: { code: "truncated" },
        });
      }
    }
  });

  test("bytes after the known fields are ignored", () => {
    for (const message of samples.filter((m) => !openEnded.has(m.type))) {
      for (const extra of [fromHex("00"), fromHex("ffffffff"), new Uint8Array(200).fill(0xaa)]) {
        expect(decodeMessage(concatBytes(encodeMessage(message), extra))).toEqual({
          ok: true,
          value: message,
        });
      }
    }
  });

  test("every type byte either decodes or is reported", () => {
    for (let type = 0; type < 256; type++) {
      const result = decodeMessage(Uint8Array.of(type));
      if (!knownTypes.has(type)) {
        expect(result).toEqual({ ok: false, error: { code: "unknownType", messageType: type } });
      } else if (type === MessageType.DisarmedNotice) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toEqual({ ok: false, error: { code: "truncated" } });
      }
    }
  });

  test("empty input is truncated", () => {
    expect(decodeMessage(new Uint8Array(0))).toEqual({ ok: false, error: { code: "truncated" } });
  });
});

describe("flags", () => {
  test("each sensor status bit maps to its name, all eight in use", () => {
    for (let byte = 0; byte < 256; byte++) {
      const result = decodeMessage(
        fromHex("0100" + byte.toString(16).padStart(2, "0") + "0000000000"),
      );
      if (!result.ok) throw new Error("did not decode");
      const heartbeat = result.value;
      if (heartbeat.type !== MessageType.Heartbeat) throw new Error("not a heartbeat");
      SENSOR_STATUS_FLAGS.forEach((name, bit) => {
        expect(heartbeat.flags[name]).toBe((byte & (1 << bit)) !== 0);
      });
      expect(encodeMessage(heartbeat)[2]).toBe(byte);
    }
  });

  test("each flag set alone sets exactly its bit", () => {
    const base = samples.find((m) => m.type === MessageType.Heartbeat);
    if (base?.type !== MessageType.Heartbeat) throw new Error("no heartbeat sample");
    const none = Object.fromEntries(SENSOR_STATUS_FLAGS.map((name) => [name, false]));
    SENSOR_STATUS_FLAGS.forEach((name, bit) => {
      const flags = { ...base.flags, ...none, [name]: true };
      expect(encodeMessage({ ...base, flags })[2]).toBe(1 << bit);
    });
  });
});

describe("open-ended bodies", () => {
  test("a carried radio packet must be 18 to 255 bytes", () => {
    const heads = ["21" + "00000000" + "0000" + "00" + "00" + "00", "a1" + "00000000000000" + "00"];
    for (const head of heads) {
      for (let length = 0; length <= 300; length++) {
        const result = decodeMessage(fromHex(head + "10".repeat(length)));
        const expected = length < 18 ? "truncated" : length > 255 ? "tooLong" : undefined;
        expect(result.ok ? undefined : result.error.code).toBe(expected);
        if (result.ok && "packet" in result.value) expect(result.value.packet.length).toBe(length);
      }
    }
  });

  test("encoding a carried packet outside 18 to 255 bytes throws", () => {
    const forwarded = samples.find((m) => m.type === MessageType.ForwardedPacket);
    if (forwarded?.type !== MessageType.ForwardedPacket) throw new Error("no sample");
    for (const length of [0, 17, 256]) {
      expect(() => encodeMessage({ ...forwarded, packet: new Uint8Array(length) })).toThrow(
        RangeError,
      );
    }
    expect(encodeMessage({ ...forwarded, packet: new Uint8Array(18) }).length).toBe(1 + 9 + 18);
  });

  test("log entries: one or more whole entries", () => {
    const entry = "e8030000" + "01" + "0200" + "03" + "616263";
    expect(decodeMessage(fromHex("30"))).toEqual({ ok: false, error: { code: "truncated" } });
    const one = decodeMessage(fromHex("30" + entry));
    expect(one).toEqual({
      ok: true,
      value: {
        type: MessageType.LogEntries,
        entries: [{ ageTenths: 1000, level: 1, code: 2, text: "abc" }],
      },
    });
    const two = fromHex("30" + entry + entry);
    for (let length = 2; length < two.length; length++) {
      const result = decodeMessage(two.subarray(0, length));
      expect(result.ok).toBe(length === 1 + entry.length / 2);
    }
    expect(
      decodeMessage(fromHex("30" + "00000000" + "00" + "0000" + "40" + "61".repeat(64))).ok,
    ).toBe(true);
    expect(
      decodeMessage(fromHex("30" + "00000000" + "00" + "0000" + "41" + "61".repeat(65))),
    ).toEqual({
      ok: false,
      error: { code: "badLength" },
    });
    // Invalid UTF-8 shows as replacement characters and leaves the message valid.
    expect(decodeMessage(fromHex("30" + "00000000" + "00" + "0000" + "03" + "80c328"))).toEqual({
      ok: true,
      value: {
        type: MessageType.LogEntries,
        entries: [{ ageTenths: 0, level: 0, code: 0, text: "\uFFFD\uFFFD(" }],
      },
    });
  });
});

describe("encoding refuses values that do not fit", () => {
  const heartbeat = samples.find((m) => m.type === MessageType.Heartbeat);
  if (heartbeat?.type !== MessageType.Heartbeat) throw new Error("no heartbeat sample");

  test.each([
    ["battery byte 256", { ...heartbeat, batteryCode: 256 }],
    ["temperature 128", { ...heartbeat, temperatureCelsius: 128 }],
    ["event age 65536", { ...heartbeat, eventAgeSeconds: 65536 }],
    ["fractional settings version", { ...heartbeat, settingsVersion: 1.5 }],
    [
      "hello random of 7 bytes",
      {
        type: MessageType.Hello,
        gatewayRandom: new Uint8Array(7),
        firmwareVersion: { major: 0, minor: 0, patch: 0 },
        settingsVersion: 0,
      },
    ],
    [
      "log text of 65 bytes",
      {
        type: MessageType.LogEntries,
        entries: [{ ageTenths: 0, level: 0, code: 0, text: "é".repeat(33) }],
      },
    ],
    ["no log entries", { type: MessageType.LogEntries, entries: [] }],
  ] satisfies [string, Message][])("%s", (_, message) => {
    expect(() => encodeMessage(message)).toThrow(RangeError);
  });
});

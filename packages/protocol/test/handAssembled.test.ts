/**
 * Packets assembled by hand from the tables in docs/protocol.md sections 3, 4 and 6. Every
 * expected byte is written out here, not produced by the encoder under test; only the AES-CCM
 * step (checked separately against RFC 3610) is computed.
 */
import { describe, expect, test } from "bun:test";
import {
  counterBinding,
  createAesCcm,
  decodeMessage,
  Direction,
  encodeMessage,
  fromHex,
  MaxPacketLength,
  type Message,
  MessageType,
  NO_BINDING,
  openPacket,
  sealPacket,
  sessionBinding,
  toHex,
} from "../src/index.ts";

const sensorKey = fromHex("000102030405060708090a0b0c0d0e0f");
const sirenKey = fromHex("101112131415161718191a1b1c1d1e1f");
const gatewayKey = fromHex("202122232425262728292a2b2c2d2e2f");
const SENSOR = 0x1a2b3c4d; // 4d3c2b1a on the wire
const SIREN = 0x5e6f7081; // 81706f5e
const GATEWAY = 0x92a3b4c5; // c5b4a392
const gatewayRandom = fromHex("a0a1a2a3a4a5a6a7");
const hubRandom = fromHex("b0b1b2b3b4b5b6b7");
/** 18 bytes, the smallest radio packet; the carrying layer does not look inside it. */
const innerPacket = "18" + "4d3c2b1a" + "01000000" + "82" + "0011223344556677";

interface Expected {
  /** Header byte, address and counter, as section 3 lays them out. */
  readonly clear: string;
  /** Address · direction byte · counter · four zero bytes. */
  readonly nonce: string;
  /** The clear bytes, then the binding. */
  readonly aad: string;
  /** Type byte and body, from section 6. */
  readonly plaintext: string;
}

interface Case {
  readonly name: string;
  readonly message: Message;
  readonly key: Uint8Array;
  readonly direction: Direction;
  readonly address: number;
  readonly counter: number;
  readonly binding: Uint8Array;
  readonly expected: Expected;
}

const noSensorFlags = {
  doorOpen: false,
  coverOpen: false,
  usbPower: false,
  charging: false,
  replyWanted: false,
  localAlarmSounded: false,
  buzzing: false,
};

const cases: readonly Case[] = [
  {
    name: "sensor status: heartbeat",
    message: {
      type: MessageType.Heartbeat,
      settingsVersion: 7,
      flags: { ...noSensorFlags, doorOpen: true, usbPower: true },
      batteryCode: 120,
      temperatureCelsius: -5,
      doorChangeCount: 3,
      eventAgeSeconds: 0,
    },
    key: sensorKey,
    direction: Direction.ToHub,
    address: SENSOR,
    counter: 0x102,
    binding: NO_BINDING,
    expected: {
      clear: "10" + "4d3c2b1a" + "02010000",
      nonce: "4d3c2b1a" + "00" + "02010000" + "00000000",
      aad: "10" + "4d3c2b1a" + "02010000",
      // type, settings 7, flags bits 0 and 2, battery 120 (3.70 V), −5 °C, 3 changes, age 0
      plaintext: "01" + "07" + "05" + "78" + "fb" + "03" + "0000",
    },
  },
  {
    name: "sensor status: door changed",
    message: {
      type: MessageType.DoorChanged,
      settingsVersion: 3,
      flags: { ...noSensorFlags, doorOpen: true, replyWanted: true, localAlarmSounded: true },
      batteryCode: 255,
      temperatureCelsius: 127,
      doorChangeCount: 0,
      eventAgeSeconds: 0x1234,
    },
    key: sensorKey,
    direction: Direction.ToHub,
    address: SENSOR,
    counter: 0xffffffff,
    binding: NO_BINDING,
    expected: {
      clear: "10" + "4d3c2b1a" + "ffffffff",
      nonce: "4d3c2b1a" + "00" + "ffffffff" + "00000000",
      aad: "10" + "4d3c2b1a" + "ffffffff",
      plaintext: "02" + "03" + "31" + "ff" + "7f" + "00" + "3412",
    },
  },
  {
    name: "sensor status: cover changed",
    message: {
      type: MessageType.CoverChanged,
      settingsVersion: 9,
      flags: { ...noSensorFlags, coverOpen: true, buzzing: true },
      batteryCode: 100,
      temperatureCelsius: -128,
      doorChangeCount: 1,
      eventAgeSeconds: 0,
    },
    key: sensorKey,
    direction: Direction.ToHub,
    address: SENSOR,
    counter: 2,
    binding: NO_BINDING,
    expected: {
      clear: "10" + "4d3c2b1a" + "02000000",
      nonce: "4d3c2b1a" + "00" + "02000000" + "00000000",
      aad: "10" + "4d3c2b1a" + "02000000",
      plaintext: "03" + "09" + "42" + "64" + "80" + "01" + "0000",
    },
  },
  {
    name: "sensor status: button",
    message: {
      type: MessageType.Button,
      settingsVersion: 1,
      flags: { ...noSensorFlags, replyWanted: true },
      batteryCode: 0,
      temperatureCelsius: 0,
      doorChangeCount: 255,
      eventAgeSeconds: 0x0102,
      buttonAction: 3,
    },
    key: sensorKey,
    direction: Direction.ToHub,
    address: SENSOR,
    counter: 1,
    binding: NO_BINDING,
    expected: {
      clear: "10" + "4d3c2b1a" + "01000000",
      nonce: "4d3c2b1a" + "00" + "01000000" + "00000000",
      aad: "10" + "4d3c2b1a" + "01000000",
      plaintext: "04" + "01" + "10" + "00" + "00" + "ff" + "0201" + "03",
    },
  },
  {
    name: "started",
    message: {
      type: MessageType.Started,
      role: 2,
      firmwareVersion: { major: 1, minor: 2, patch: 3 },
      resetCause: 9,
      lastFatalError: 0x1234,
      settingsVersion: 5,
    },
    key: sirenKey,
    direction: Direction.ToHub,
    address: SIREN,
    counter: 1024,
    binding: NO_BINDING,
    expected: {
      clear: "10" + "81706f5e" + "00040000",
      nonce: "81706f5e" + "00" + "00040000" + "00000000",
      aad: "10" + "81706f5e" + "00040000",
      plaintext: "05" + "02" + "010203" + "09" + "3412" + "05",
    },
  },
  {
    name: "reply, bound to the counter of the sensor packet it answers",
    message: {
      type: MessageType.Reply,
      settingsVersion: 4,
      flags: { armed: true, countdownStarted: true, updateAvailable: false },
      countdownSeconds: 30,
      countdownRemainingSeconds: 25,
      heartbeatIntervalUnits: 12,
      linkCheckEvery: 5,
      sendDataRate: 2,
      replyDataRate: 5,
      nextHeartbeatTenths: 1800,
      clockCorrectionPpm: -100,
    },
    key: sensorKey,
    direction: Direction.FromHub,
    address: SENSOR,
    counter: 0xabcd,
    binding: counterBinding(0x102),
    expected: {
      clear: "18" + "4d3c2b1a" + "cdab0000",
      nonce: "4d3c2b1a" + "01" + "cdab0000" + "00000000",
      aad: "18" + "4d3c2b1a" + "cdab0000" + "02010000",
      plaintext: "81" + "04" + "03" + "1e" + "19" + "0c" + "05" + "02" + "05" + "0807" + "9cff",
    },
  },
  {
    name: "disarmed notice, no body",
    message: { type: MessageType.DisarmedNotice },
    key: sensorKey,
    direction: Direction.FromHub,
    address: SENSOR,
    counter: 0xabce,
    binding: counterBinding(0x102),
    expected: {
      clear: "18" + "4d3c2b1a" + "ceab0000",
      nonce: "4d3c2b1a" + "01" + "ceab0000" + "00000000",
      aad: "18" + "4d3c2b1a" + "ceab0000" + "02010000",
      plaintext: "82",
    },
  },
  {
    name: "siren command, no binding",
    message: { type: MessageType.SirenCommand, action: 1, soundSeconds: 180 },
    key: sirenKey,
    direction: Direction.FromHub,
    address: SIREN,
    counter: 7000,
    binding: NO_BINDING,
    expected: {
      clear: "18" + "81706f5e" + "581b0000",
      nonce: "81706f5e" + "01" + "581b0000" + "00000000",
      aad: "18" + "81706f5e" + "581b0000",
      plaintext: "90" + "01" + "b400",
    },
  },
  {
    name: "siren report",
    message: {
      type: MessageType.SirenReport,
      settingsVersion: 2,
      state: 1,
      soundingSecondsLeft: 179,
      lastCommandCounterLow: 7000,
      flags: {
        onMains: true,
        cellFitted: true,
        charging: false,
        coverOpen: false,
        wifiConnected: true,
      },
      cellBatteryCode: 160,
      temperatureCelsius: -20,
      reason: 1,
    },
    key: sirenKey,
    direction: Direction.ToHub,
    address: SIREN,
    counter: 5001,
    binding: NO_BINDING,
    expected: {
      clear: "10" + "81706f5e" + "89130000",
      nonce: "81706f5e" + "00" + "89130000" + "00000000",
      aad: "10" + "81706f5e" + "89130000",
      plaintext: "10" + "02" + "01" + "b300" + "581b" + "13" + "a0" + "ec" + "01",
    },
  },
  {
    name: "siren settings",
    message: {
      type: MessageType.SirenSettings,
      settingsVersion: 2,
      wifiReportIntervalSeconds: 30,
      loraCheckIntervalUnits: 20,
      maxSoundSeconds: 900,
      sendDataRate: 2,
      commandDataRate: 5,
    },
    key: sirenKey,
    direction: Direction.FromHub,
    address: SIREN,
    counter: 7100,
    binding: NO_BINDING,
    expected: {
      clear: "18" + "81706f5e" + "bc1b0000",
      nonce: "81706f5e" + "01" + "bc1b0000" + "00000000",
      aad: "18" + "81706f5e" + "bc1b0000",
      plaintext: "91" + "02" + "1e" + "14" + "8403" + "02" + "05",
    },
  },
  {
    name: "hello, no binding",
    message: {
      type: MessageType.Hello,
      gatewayRandom,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      settingsVersion: 1,
    },
    key: gatewayKey,
    direction: Direction.ToHub,
    address: GATEWAY,
    counter: 1,
    binding: NO_BINDING,
    expected: {
      clear: "10" + "c5b4a392" + "01000000",
      nonce: "c5b4a392" + "00" + "01000000" + "00000000",
      aad: "10" + "c5b4a392" + "01000000",
      plaintext: "20" + "a0a1a2a3a4a5a6a7" + "010000" + "01",
    },
  },
  {
    name: "welcome, bound to the gateway random",
    message: { type: MessageType.Welcome, hubRandom },
    key: gatewayKey,
    direction: Direction.FromHub,
    address: GATEWAY,
    counter: 1,
    binding: gatewayRandom,
    expected: {
      clear: "18" + "c5b4a392" + "01000000",
      nonce: "c5b4a392" + "01" + "01000000" + "00000000",
      aad: "18" + "c5b4a392" + "01000000" + "a0a1a2a3a4a5a6a7",
      plaintext: "a0" + "b0b1b2b3b4b5b6b7",
    },
  },
  {
    name: "gateway settings, bound to the session",
    message: {
      type: MessageType.GatewaySettings,
      settingsVersion: 1,
      siteChannel: 0,
      listenDataRateMask: 0x24,
      statusIntervalSeconds: 30,
      interferenceThresholdDb: 10,
      interferenceSeconds: 30,
      defaultTxPowerDbm: 14,
      sirenTxPowerDbm: 22,
    },
    key: gatewayKey,
    direction: Direction.FromHub,
    address: GATEWAY,
    counter: 2,
    binding: sessionBinding(gatewayRandom, hubRandom),
    expected: {
      clear: "18" + "c5b4a392" + "02000000",
      nonce: "c5b4a392" + "01" + "02000000" + "00000000",
      aad: "18" + "c5b4a392" + "02000000" + "a0a1a2a3a4a5a6a7" + "b0b1b2b3b4b5b6b7",
      plaintext: "a2" + "01" + "00" + "24" + "1e" + "0a" + "1e" + "0e" + "16",
    },
  },
  {
    name: "forwarded packet",
    message: {
      type: MessageType.ForwardedPacket,
      receivedAtMicros: 0x01020304,
      rssiDbm: -120,
      snrQuarterDb: -30,
      dataRate: 2,
      siteChannel: 1,
      packet: fromHex(innerPacket),
    },
    key: gatewayKey,
    direction: Direction.ToHub,
    address: GATEWAY,
    counter: 3,
    binding: sessionBinding(gatewayRandom, hubRandom),
    expected: {
      clear: "10" + "c5b4a392" + "03000000",
      nonce: "c5b4a392" + "00" + "03000000" + "00000000",
      aad: "10" + "c5b4a392" + "03000000" + "a0a1a2a3a4a5a6a7" + "b0b1b2b3b4b5b6b7",
      plaintext: "21" + "04030201" + "88ff" + "e2" + "02" + "01" + innerPacket,
    },
  },
  {
    name: "transmit request",
    message: {
      type: MessageType.TransmitRequest,
      when: 1,
      gatewayTimeMicros: 0,
      dataRate: 5,
      powerDbm: 22,
      priority: 1,
      packet: fromHex(innerPacket),
    },
    key: gatewayKey,
    direction: Direction.FromHub,
    address: GATEWAY,
    counter: 3,
    binding: sessionBinding(gatewayRandom, hubRandom),
    expected: {
      clear: "18" + "c5b4a392" + "03000000",
      nonce: "c5b4a392" + "01" + "03000000" + "00000000",
      aad: "18" + "c5b4a392" + "03000000" + "a0a1a2a3a4a5a6a7" + "b0b1b2b3b4b5b6b7",
      plaintext: "a1" + "01" + "00000000" + "05" + "16" + "01" + innerPacket,
    },
  },
  {
    name: "transmit result",
    message: {
      type: MessageType.TransmitResult,
      requestCounter: 20,
      result: 1,
      sentAtMicros: 0x0a0b0c0d,
    },
    key: gatewayKey,
    direction: Direction.ToHub,
    address: GATEWAY,
    counter: 4,
    binding: sessionBinding(gatewayRandom, hubRandom),
    expected: {
      clear: "10" + "c5b4a392" + "04000000",
      nonce: "c5b4a392" + "00" + "04000000" + "00000000",
      aad: "10" + "c5b4a392" + "04000000" + "a0a1a2a3a4a5a6a7" + "b0b1b2b3b4b5b6b7",
      plaintext: "23" + "14000000" + "01" + "0d0c0b0a",
    },
  },
  {
    name: "gateway status",
    message: {
      type: MessageType.GatewayStatus,
      settingsVersion: 1,
      uptimeSeconds: 86400,
      airtimeHundredthsPercent: 125,
      noiseMedianDbm: -118,
      noiseHighestDbm: -95,
      normalNoiseDbm: -117,
      packetsReceived: 42,
      packetsCrcFailed: 3,
      wifiRssiDbm: -61,
      flags: { usbConnected: true, cellFitted: false, onMains: true },
    },
    key: gatewayKey,
    direction: Direction.ToHub,
    address: GATEWAY,
    counter: 5,
    binding: sessionBinding(gatewayRandom, hubRandom),
    expected: {
      clear: "10" + "c5b4a392" + "05000000",
      nonce: "c5b4a392" + "00" + "05000000" + "00000000",
      aad: "10" + "c5b4a392" + "05000000" + "a0a1a2a3a4a5a6a7" + "b0b1b2b3b4b5b6b7",
      plaintext:
        "22" + "01" + "80510100" + "7d00" + "8a" + "a1" + "8b" + "2a00" + "0300" + "c3" + "05",
    },
  },
  {
    name: "interference",
    message: { type: MessageType.Interference, event: 1, noiseDbm: -80, durationSeconds: 30 },
    key: gatewayKey,
    direction: Direction.ToHub,
    address: GATEWAY,
    counter: 6,
    binding: sessionBinding(gatewayRandom, hubRandom),
    expected: {
      clear: "10" + "c5b4a392" + "06000000",
      nonce: "c5b4a392" + "00" + "06000000" + "00000000",
      aad: "10" + "c5b4a392" + "06000000" + "a0a1a2a3a4a5a6a7" + "b0b1b2b3b4b5b6b7",
      plaintext: "24" + "01" + "b0" + "1e00",
    },
  },
  {
    name: "log entries",
    message: {
      type: MessageType.LogEntries,
      entries: [
        { millisecondsSinceStart: 1500, level: 2, code: 0x0101, text: "ok" },
        { millisecondsSinceStart: 0, level: 0, code: 0xbeef, text: "" },
      ],
    },
    key: sirenKey,
    direction: Direction.ToHub,
    address: SIREN,
    counter: 5002,
    binding: NO_BINDING,
    expected: {
      clear: "10" + "81706f5e" + "8a130000",
      nonce: "81706f5e" + "00" + "8a130000" + "00000000",
      aad: "10" + "81706f5e" + "8a130000",
      plaintext:
        "30" + "dc050000" + "02" + "0101" + "02" + "6f6b" + "00000000" + "00" + "efbe" + "00",
    },
  },
];

describe("hand-assembled packets", () => {
  test.each(cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const { expected } = c;
    expect(toHex(encodeMessage(c.message))).toBe(expected.plaintext);
    expect(decodeMessage(fromHex(expected.plaintext))).toEqual({ ok: true, value: c.message });

    const options = {
      key: c.key,
      address: c.address,
      counter: c.counter,
      binding: c.binding,
      maxLength: MaxPacketLength.Link,
    } as const;
    const packet = sealPacket(c.message, { ...options, direction: c.direction });
    const sealed = createAesCcm(c.key, 8).seal(
      fromHex(expected.nonce),
      fromHex(expected.aad),
      fromHex(expected.plaintext),
    );
    expect(toHex(packet)).toBe(expected.clear + toHex(sealed));

    const opened = openPacket(packet, { ...options, expectedDirection: c.direction });
    expect(opened).toEqual({
      ok: true,
      value: {
        header: { direction: c.direction, address: c.address, counter: c.counter },
        message: c.message,
      },
    });
  });

  test("covers every message type", () => {
    const covered = new Set(cases.map((c) => c.message.type));
    expect([...covered].sort()).toEqual(Object.values(MessageType).sort());
  });
});

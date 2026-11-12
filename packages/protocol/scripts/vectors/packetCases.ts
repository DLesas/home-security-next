/** The valid packet cases, one or more per message type. Field values follow section 6. */
import {
  batteryCode,
  ButtonAction,
  counterBinding,
  fromHex,
  InterferenceEvent,
  isEnumValue,
  MaxPacketLength,
  encodeMessage,
  type Message,
  messageDirection,
  type MessageOf,
  MessageType,
  NO_BINDING,
  Role,
  sealPacket,
  sessionBinding,
  SiteChannel,
  SirenAction,
  SirenReportReason,
  SirenState,
  TransmitPriority,
  TransmitResultCode,
  TransmitWhen,
  welcomeBinding,
} from "../../src/index.ts";
import {
  type Device,
  gateway,
  gatewayRandom,
  hubRandom,
  laterGatewayRandoms,
  laterHubRandoms,
  sensor,
  sensor2,
  siren,
} from "./devices.ts";

export interface PacketCase {
  readonly name: string;
  readonly device: Device;
  readonly counter: number;
  readonly binding: Uint8Array;
  readonly maxLength: MaxPacketLength;
  readonly message: Message;
  /** Decode-only variations a receiver must still accept. */
  readonly variation?: {
    readonly headerLowBits?: number;
    readonly extraBodyBytes?: Uint8Array;
    /** Plaintext sent in place of the encoded message, which it must still decode to. */
    readonly plaintext?: Uint8Array;
  };
}

const session = sessionBinding(gatewayRandom, hubRandom);
const radio = MaxPacketLength.Radio;
const link = MaxPacketLength.Link;

const noSensorFlags = {
  doorOpen: false,
  coverOpen: false,
  usbPower: false,
  charging: false,
  replyWanted: false,
  localAlarmSounded: false,
  buzzing: false,
  listeningAtSendRate: false,
};
const allSensorFlags = {
  doorOpen: true,
  coverOpen: true,
  usbPower: true,
  charging: true,
  replyWanted: true,
  localAlarmSounded: true,
  buzzing: true,
  listeningAtSendRate: true,
};

const heartbeat: Message = {
  type: MessageType.Heartbeat,
  settingsVersion: 3,
  flags: noSensorFlags,
  batteryCode: batteryCode(3700),
  temperatureCelsius: 21,
  doorChangeCount: 0,
  eventAgeSeconds: 0,
};

const doorOpened: MessageOf<typeof MessageType.DoorChanged> = {
  type: MessageType.DoorChanged,
  settingsVersion: 3,
  flags: { ...noSensorFlags, doorOpen: true, replyWanted: true },
  batteryCode: batteryCode(3650),
  temperatureCelsius: 19,
  doorChangeCount: 17,
  eventAgeSeconds: 2,
};

/** Seals a case with the library's encoder, for cases whose packet travels inside another. */
function sealCase(c: PacketCase): Uint8Array {
  return sealPacket(c.message, {
    key: c.device.key,
    direction: messageDirection(c.message.type),
    address: c.device.address,
    counter: c.counter,
    binding: c.binding,
    maxLength: c.maxLength,
  });
}

/** Sets bits an encoder always writes as zero, at `offset` in the plaintext (type byte is 0). */
function withBitsSet(message: Message, offset: number, mask: number): Uint8Array {
  const plaintext = encodeMessage(message);
  plaintext[offset] = (plaintext[offset] ?? 0) | mask;
  return plaintext;
}

const heartbeatCase: PacketCase = {
  name: "heartbeat, door closed, 3.70 V, 21 °C",
  device: sensor,
  counter: 1,
  binding: NO_BINDING,
  maxLength: radio,
  message: heartbeat,
};
/** Carried inside forwarded packets below, and altered in the rejected-packet cases. */
export const heartbeatPacket = sealCase(heartbeatCase);

const replyToDoor: Message = {
  type: MessageType.Reply,
  settingsVersion: 3,
  flags: { armed: true, countdownStarted: true, updateAvailable: false },
  countdownSeconds: 30,
  countdownRemainingSeconds: 28,
  heartbeatIntervalUnits: 12,
  linkCheckEvery: 5,
  sendDataRate: 2,
  replyDataRate: 5,
  nextHeartbeatTenths: 0,
  clockCorrectionTenPpm: 0,
};

const replyCase: PacketCase = {
  name: "reply to a door report: armed, countdown started",
  device: sensor,
  counter: 9,
  binding: counterBinding(41),
  maxLength: radio,
  message: replyToDoor,
};
/** The reply answering the door report at counter 41, carried in transmit requests. */
const replyPacket = sealCase(replyCase);

const sirenReportWifi: MessageOf<typeof MessageType.SirenReport> = {
  type: MessageType.SirenReport,
  settingsVersion: 2,
  state: SirenState.Off,
  soundingSecondsLeft: 0,
  lastCommandCounterLow: 0x1234,
  flags: {
    onMains: true,
    cellFitted: true,
    charging: false,
    coverOpen: false,
    wifiConnected: true,
  },
  cellBatteryCode: batteryCode(4100),
  temperatureCelsius: 24,
  reason: SirenReportReason.Regular,
};

const sirenReportLoraCase: PacketCase = {
  name: "siren answering a command over LoRa, sounding, cold",
  device: siren,
  counter: 5001,
  binding: NO_BINDING,
  maxLength: radio,
  message: {
    type: MessageType.SirenReport,
    settingsVersion: 2,
    state: SirenState.SoundingAlarm,
    soundingSecondsLeft: 179,
    lastCommandCounterLow: 0xffff,
    flags: {
      onMains: false,
      cellFitted: true,
      charging: false,
      coverOpen: true,
      wifiConnected: false,
    },
    cellBatteryCode: batteryCode(3300),
    temperatureCelsius: -20,
    reason: SirenReportReason.CommandAnswer,
  },
};
/** Carried inside a forwarded packet. */
const sirenReportPacket = sealCase(sirenReportLoraCase);

const sirenCommandCase: PacketCase = {
  name: "siren command, action 1",
  device: siren,
  counter: 7000,
  binding: NO_BINDING,
  maxLength: radio,
  message: { type: MessageType.SirenCommand, action: SirenAction.SoundAlarm, soundSeconds: 180 },
};
/** Carried inside transmit requests. */
const sirenCommandPacket = sealCase(sirenCommandCase);

/** A 255-byte radio packet with a valid clear header: log entries sealed by the sensor. */
const largestRadioPacket = sealCase({
  name: "largest radio packet",
  device: sensor,
  counter: 300,
  binding: NO_BINDING,
  maxLength: radio,
  message: {
    type: MessageType.LogEntries,
    entries: ["l".repeat(64), "l".repeat(64), "l".repeat(64), "m".repeat(13)].map((text) => ({
      ageTenths: 0,
      level: 0,
      code: 0,
      text,
    })),
  },
});
if (largestRadioPacket.length !== MaxPacketLength.Radio) throw new Error("expected 255 bytes");

const gatewayStatusQuiet: Message = {
  type: MessageType.GatewayStatus,
  settingsVersion: 1,
  uptimeSeconds: 30,
  airtimeHundredthsPercent: 0,
  noiseMedianDbm: -120,
  noiseHighestDbm: -119,
  normalNoiseDbm: -120,
  packetsReceived: 0,
  packetsCrcFailed: 0,
  wifiRssiDbm: -50,
  flags: { usbConnected: false, cellFitted: false, onMains: false },
};

const replyToLinkCheck: Message = {
  type: MessageType.Reply,
  settingsVersion: 4,
  flags: { armed: false, countdownStarted: false, updateAvailable: false },
  countdownSeconds: 30,
  countdownRemainingSeconds: 0,
  heartbeatIntervalUnits: 12,
  linkCheckEvery: 5,
  sendDataRate: 2,
  replyDataRate: 5,
  nextHeartbeatTenths: 1800,
  clockCorrectionTenPpm: 12,
};

export const packetCases: readonly PacketCase[] = [
  // Heartbeat (0x01)
  heartbeatCase,
  {
    name: "heartbeat, every flag set and every field at its limit",
    device: sensor,
    counter: 0xffffffff,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      type: MessageType.Heartbeat,
      settingsVersion: 255,
      flags: allSensorFlags,
      batteryCode: 255,
      temperatureCelsius: -128,
      doorChangeCount: 255,
      eventAgeSeconds: 65535,
    },
  },
  {
    name: "heartbeat asking for a link check, on USB power and charging",
    device: sensor,
    counter: 0x01000000,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      ...heartbeat,
      flags: { ...noSensorFlags, usbPower: true, charging: true, replyWanted: true },
      batteryCode: batteryCode(4200),
      temperatureCelsius: 127,
      doorChangeCount: 200,
    },
  },
  {
    name: "heartbeat with the header's low three bits set, which receivers ignore",
    device: sensor,
    counter: 2,
    binding: NO_BINDING,
    maxLength: radio,
    message: heartbeat,
    variation: { headerLowBits: 0x07 },
  },
  {
    name: "heartbeat asking for a link check, listening at the sending rate",
    device: sensor,
    counter: 4,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      ...heartbeat,
      flags: { ...noSensorFlags, replyWanted: true, listeningAtSendRate: true },
    },
  },
  {
    name: "heartbeat with two bytes after the known fields, which receivers ignore",
    device: sensor,
    counter: 3,
    binding: NO_BINDING,
    maxLength: radio,
    message: heartbeat,
    variation: { extraBodyBytes: Uint8Array.of(0xee, 0xff) },
  },

  // Door changed (0x02)
  {
    name: "door opened, reply wanted",
    device: sensor,
    counter: 41,
    binding: NO_BINDING,
    maxLength: radio,
    message: doorOpened,
  },
  {
    name: "door closed after a local alarm, sent late",
    device: sensor,
    counter: 42,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      ...doorOpened,
      flags: { ...noSensorFlags, replyWanted: true, localAlarmSounded: true },
      doorChangeCount: 18,
      eventAgeSeconds: 600,
    },
  },

  {
    name: "door opened, listening for the reply at the sending rate",
    device: sensor,
    counter: 43,
    binding: NO_BINDING,
    maxLength: radio,
    message: { ...doorOpened, flags: { ...doorOpened.flags, listeningAtSendRate: true } },
  },

  // Cover changed (0x03)
  {
    name: "cover opened while buzzing",
    device: sensor,
    counter: 100,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      ...doorOpened,
      type: MessageType.CoverChanged,
      flags: { ...noSensorFlags, coverOpen: true, replyWanted: true, buzzing: true },
      eventAgeSeconds: 0,
    },
  },
  {
    name: "cover closed, on USB power and charging, cold and old",
    device: sensor,
    counter: 101,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      type: MessageType.CoverChanged,
      settingsVersion: 0,
      flags: { ...noSensorFlags, doorOpen: true, usbPower: true, charging: true },
      batteryCode: 0,
      temperatureCelsius: -40,
      doorChangeCount: 255,
      eventAgeSeconds: 65535,
    },
  },
  {
    name: "cover opened after a local alarm, hot, full battery",
    device: sensor2,
    counter: 2,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      type: MessageType.CoverChanged,
      settingsVersion: 200,
      flags: { ...noSensorFlags, coverOpen: true, localAlarmSounded: true },
      batteryCode: 255,
      temperatureCelsius: 85,
      doorChangeCount: 1,
      eventAgeSeconds: 30,
    },
  },

  // Button (0x04)
  ...[
    ButtonAction.ShortPress,
    ButtonAction.PairingHoldIgnoredWhileArmed,
    ButtonAction.FactoryResetHoldWhileArmed,
    ButtonAction.FactoryResetGoingAhead,
  ].map((buttonAction, i): PacketCase => ({
    name: `button, action ${buttonAction}`,
    device: sensor,
    counter: 200 + i,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      ...heartbeat,
      type: MessageType.Button,
      flags: { ...noSensorFlags, replyWanted: true },
      eventAgeSeconds: 1,
      buttonAction,
    },
  })),
  {
    name: "button with unlisted action 9, which passes through",
    device: sensor,
    counter: 204,
    binding: NO_BINDING,
    maxLength: radio,
    message: { ...heartbeat, type: MessageType.Button, eventAgeSeconds: 0, buttonAction: 9 },
  },

  // Started (0x05)
  {
    name: "sensor started",
    device: sensor,
    counter: 64,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      type: MessageType.Started,
      role: Role.Sensor,
      firmwareVersion: { major: 1, minor: 2, patch: 3 },
      resetCause: 1,
      lastFatalError: 0,
      settingsVersion: 3,
    },
  },
  {
    name: "started with unlisted role 9, which passes through",
    device: sensor2,
    counter: 1,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      type: MessageType.Started,
      role: 9,
      firmwareVersion: { major: 3, minor: 0, patch: 1 },
      resetCause: 0,
      lastFatalError: 1,
      settingsVersion: 7,
    },
  },
  {
    name: "siren started after a fatal error",
    device: siren,
    counter: 1024,
    binding: NO_BINDING,
    maxLength: link,
    message: {
      type: MessageType.Started,
      role: Role.Siren,
      firmwareVersion: { major: 0, minor: 9, patch: 255 },
      resetCause: 4,
      lastFatalError: 0xbeef,
      settingsVersion: 0,
    },
  },
  {
    name: "gateway started, on its connection",
    device: gateway,
    counter: 2,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.Started,
      role: Role.Gateway,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      resetCause: 3,
      lastFatalError: 0,
      settingsVersion: 1,
    },
  },

  // Siren report (0x10)
  {
    name: "siren regular report over Wi-Fi",
    device: siren,
    counter: 5000,
    binding: NO_BINDING,
    maxLength: link,
    message: sirenReportWifi,
  },
  sirenReportLoraCase,
  {
    name: "siren report with unlisted state 9 and reason 9, which pass through",
    device: siren,
    counter: 5003,
    binding: NO_BINDING,
    maxLength: radio,
    message: { ...sirenReportWifi, state: 9, reason: 9 },
  },
  {
    name: "siren report with the unused flag bits 5 to 7 set, which receivers ignore",
    device: siren,
    counter: 5004,
    binding: NO_BINDING,
    maxLength: radio,
    message: sirenReportWifi,
    variation: { plaintext: withBitsSet(sirenReportWifi, 7, 0xe0) },
  },

  // Hello (0x20)
  {
    name: "gateway hello",
    device: gateway,
    counter: 1,
    binding: NO_BINDING,
    maxLength: link,
    message: {
      type: MessageType.Hello,
      gatewayRandom,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      settingsVersion: 1,
    },
  },
  {
    name: "gateway hello on a later connection",
    device: gateway,
    counter: 30,
    binding: NO_BINDING,
    maxLength: link,
    message: {
      type: MessageType.Hello,
      gatewayRandom: laterGatewayRandoms[0],
      firmwareVersion: { major: 2, minor: 5, patch: 13 },
      settingsVersion: 0,
    },
  },
  {
    name: "gateway hello with every version at its limit",
    device: gateway,
    counter: 0xfffffffe,
    binding: NO_BINDING,
    maxLength: link,
    message: {
      type: MessageType.Hello,
      gatewayRandom: laterGatewayRandoms[1],
      firmwareVersion: { major: 255, minor: 255, patch: 255 },
      settingsVersion: 255,
    },
  },

  // Forwarded packet (0x21)
  {
    name: "forwarded heartbeat (the first heartbeat case's packet), weak signal",
    device: gateway,
    counter: 3,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.ForwardedPacket,
      receivedAtMicros: 0xdeadbeef,
      rssiDbm: -120,
      snrQuarterDb: -30,
      dataRate: 2,
      siteChannel: SiteChannel.Mhz868_3,
      packet: heartbeatPacket,
    },
  },
  {
    name: "forwarded 255-byte radio packet, which needs the larger link limit",
    device: gateway,
    counter: 4,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.ForwardedPacket,
      receivedAtMicros: 0,
      rssiDbm: 32767,
      snrQuarterDb: 127,
      dataRate: 5,
      siteChannel: SiteChannel.Mhz868_5,
      packet: largestRadioPacket,
    },
  },
  {
    name: "forwarded siren report (the LoRa siren report case's packet), strong signal",
    device: gateway,
    counter: 14,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.ForwardedPacket,
      receivedAtMicros: 1,
      rssiDbm: -32768,
      snrQuarterDb: -128,
      dataRate: 0,
      siteChannel: SiteChannel.Mhz868_1,
      packet: sirenReportPacket,
    },
  },
  {
    name: "forwarded heartbeat with unlisted data rate 6 and site channel 3, which pass through",
    device: gateway,
    counter: 15,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.ForwardedPacket,
      receivedAtMicros: 77,
      rssiDbm: -90,
      snrQuarterDb: 10,
      dataRate: 6,
      siteChannel: 3,
      packet: heartbeatPacket,
    },
  },

  // Gateway status (0x22)
  {
    name: "gateway status on Wi-Fi",
    device: gateway,
    counter: 5,
    binding: session,
    maxLength: link,
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
      flags: { usbConnected: false, cellFitted: false, onMains: true },
    },
  },
  {
    name: "gateway status on USB",
    device: gateway,
    counter: 6,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.GatewayStatus,
      settingsVersion: 255,
      uptimeSeconds: 0xffffffff,
      airtimeHundredthsPercent: 10000,
      noiseMedianDbm: -128,
      noiseHighestDbm: 127,
      normalNoiseDbm: 0,
      packetsReceived: 65535,
      packetsCrcFailed: 65535,
      wifiRssiDbm: 0,
      flags: { usbConnected: true, cellFitted: true, onMains: true },
    },
  },
  {
    name: "gateway status with the unused flag bits 3 to 7 set, which receivers ignore",
    device: gateway,
    counter: 18,
    binding: session,
    maxLength: link,
    message: gatewayStatusQuiet,
    variation: { plaintext: withBitsSet(gatewayStatusQuiet, 16, 0xf8) },
  },

  // Transmit result (0x23)
  {
    name: "transmit result, sent",
    device: gateway,
    counter: 7,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.TransmitResult,
      requestCounter: 20,
      result: TransmitResultCode.Sent,
      sentAtMicros: 123456789,
    },
  },
  {
    name: "transmit result, too late",
    device: gateway,
    counter: 8,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.TransmitResult,
      requestCounter: 0xfffffffe,
      result: TransmitResultCode.TooLate,
      sentAtMicros: 0,
    },
  },
  {
    name: "transmit result with unlisted result 5, which passes through",
    device: gateway,
    counter: 16,
    binding: session,
    maxLength: link,
    message: { type: MessageType.TransmitResult, requestCounter: 23, result: 5, sentAtMicros: 9 },
  },

  // Interference (0x24)
  {
    name: "interference started",
    device: gateway,
    counter: 9,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.Interference,
      event: InterferenceEvent.Started,
      noiseDbm: -80,
      durationSeconds: 30,
    },
  },
  {
    name: "interference ended",
    device: gateway,
    counter: 10,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.Interference,
      event: InterferenceEvent.Ended,
      noiseDbm: -79,
      durationSeconds: 65535,
    },
  },
  {
    name: "interference with unlisted event 2, which passes through",
    device: gateway,
    counter: 17,
    binding: session,
    maxLength: link,
    message: { type: MessageType.Interference, event: 2, noiseDbm: 0, durationSeconds: 0 },
  },

  // Log entries (0x30)
  {
    name: "one log entry from a siren",
    device: siren,
    counter: 5002,
    binding: NO_BINDING,
    maxLength: link,
    message: {
      type: MessageType.LogEntries,
      entries: [{ ageTenths: 1500, level: 2, code: 0x0101, text: "wifi connected" }],
    },
  },
  {
    name: "log entries with empty, multi-byte and 64-byte texts",
    device: gateway,
    counter: 11,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.LogEntries,
      entries: [
        { ageTenths: 0, level: 0, code: 0, text: "" },
        { ageTenths: 0xffffffff, level: 255, code: 65535, text: "Tür offen – 5 °C" },
        { ageTenths: 60000, level: 3, code: 7, text: "x".repeat(64) },
      ],
    },
  },
  {
    name: "thirteen log entries, the most whole 64-byte entries one link packet holds",
    device: gateway,
    counter: 12,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.LogEntries,
      entries: Array.from({ length: 13 }, (_, i) => ({
        ageTenths: 1000 * i,
        level: i % 4,
        code: i,
        text: String.fromCharCode(0x61 + i).repeat(64),
      })),
    },
  },

  {
    name: "log entry text that is not UTF-8, shown with replacement characters",
    device: gateway,
    counter: 13,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.LogEntries,
      entries: [{ ageTenths: 1, level: 1, code: 1, text: "\uFFFD\uFFFD(A" }],
    },
    // One entry whose text bytes are ff c3 28 41: a stray byte, a cut-off sequence, "(A".
    variation: { plaintext: fromHex("30" + "01000000" + "01" + "0100" + "04" + "ffc32841") },
  },

  // Reply (0x81)
  replyCase,
  {
    name: "reply to a link check, with the next heartbeat moment and a clock correction",
    device: sensor,
    counter: 10,
    binding: counterBinding(0x01000000),
    maxLength: radio,
    message: {
      type: MessageType.Reply,
      settingsVersion: 4,
      flags: { armed: false, countdownStarted: false, updateAvailable: true },
      countdownSeconds: 45,
      countdownRemainingSeconds: 0,
      heartbeatIntervalUnits: 20,
      linkCheckEvery: 5,
      sendDataRate: 0,
      replyDataRate: 3,
      nextHeartbeatTenths: 1795,
      clockCorrectionTenPpm: -32768,
    },
  },
  {
    name: "reply with unlisted data rates 6 and 7, which pass through",
    device: sensor,
    counter: 12,
    binding: counterBinding(0x01000001),
    maxLength: radio,
    message: { ...replyToLinkCheck, sendDataRate: 6, replyDataRate: 7 },
  },
  {
    name: "reply with the unused flag bits 3 to 7 set, which receivers ignore",
    device: sensor,
    counter: 13,
    binding: counterBinding(0x01000002),
    maxLength: radio,
    message: replyToLinkCheck,
    variation: { plaintext: withBitsSet(replyToLinkCheck, 2, 0xf8) },
  },

  // Disarmed notice (0x82)
  {
    name: "disarmed notice, bound to the door report that started the countdown",
    device: sensor,
    counter: 11,
    binding: counterBinding(41),
    maxLength: radio,
    message: { type: MessageType.DisarmedNotice },
  },
  {
    name: "disarmed notice from another sensor's pairing, bound to its door report",
    device: sensor2,
    counter: 1,
    binding: counterBinding(7),
    maxLength: radio,
    message: { type: MessageType.DisarmedNotice },
  },
  {
    name: "disarmed notice near the top of the counter range",
    device: sensor,
    counter: 0xfffffff0,
    binding: counterBinding(0xfffffffe),
    maxLength: radio,
    message: { type: MessageType.DisarmedNotice },
  },

  // Siren command (0x90)
  sirenCommandCase,
  ...[
    { action: SirenAction.Test, soundSeconds: 5 },
    { action: SirenAction.Off, soundSeconds: 0 },
    { action: SirenAction.ReportNow, soundSeconds: 0 },
    { action: 7, soundSeconds: 65535 },
  ].map(({ action, soundSeconds }, i): PacketCase => ({
    name: isEnumValue(SirenAction, action)
      ? `siren command, action ${action}`
      : `siren command with unlisted action ${action}, which passes through`,
    device: siren,
    counter: 7001 + i,
    binding: NO_BINDING,
    maxLength: radio,
    message: { type: MessageType.SirenCommand, action, soundSeconds },
  })),

  // Siren settings (0x91)
  {
    name: "siren settings",
    device: siren,
    counter: 7100,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      type: MessageType.SirenSettings,
      settingsVersion: 2,
      wifiReportIntervalSeconds: 30,
      loraCheckIntervalUnits: 20,
      maxSoundSeconds: 900,
      sendDataRate: 2,
      commandDataRate: 5,
    },
  },
  {
    name: "siren settings for a slow site",
    device: siren,
    counter: 7101,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      type: MessageType.SirenSettings,
      settingsVersion: 3,
      wifiReportIntervalSeconds: 60,
      loraCheckIntervalUnits: 40,
      maxSoundSeconds: 180,
      sendDataRate: 0,
      commandDataRate: 3,
    },
  },
  {
    name: "siren settings at every limit, with unlisted data rates 6 and 7",
    device: siren,
    counter: 7102,
    binding: NO_BINDING,
    maxLength: radio,
    message: {
      type: MessageType.SirenSettings,
      settingsVersion: 255,
      wifiReportIntervalSeconds: 255,
      loraCheckIntervalUnits: 255,
      maxSoundSeconds: 65535,
      sendDataRate: 6,
      commandDataRate: 7,
    },
  },

  // Welcome (0xA0)
  {
    name: "welcome, bound to the gateway's random value",
    device: gateway,
    counter: 1,
    binding: welcomeBinding(gatewayRandom),
    maxLength: link,
    message: { type: MessageType.Welcome, hubRandom },
  },
  ...laterGatewayRandoms.map((random, i): PacketCase => ({
    name: `welcome answering the hello on later connection ${i + 1}`,
    device: gateway,
    counter: 30 + i,
    binding: welcomeBinding(random),
    maxLength: link,
    message: { type: MessageType.Welcome, hubRandom: laterHubRandoms[i] ?? hubRandom },
  })),

  // Transmit request (0xA1)
  {
    name: "transmit request: a reply as soon as possible",
    device: gateway,
    counter: 20,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.TransmitRequest,
      when: TransmitWhen.AsSoonAsPossible,
      gatewayTimeMicros: 0,
      dataRate: 5,
      powerDbm: 22,
      priority: TransmitPriority.Normal,
      packet: replyPacket,
    },
  },
  {
    name: "transmit request: a siren command (the first siren command case's packet) at a given time",
    device: gateway,
    counter: 21,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.TransmitRequest,
      when: TransmitWhen.AtTime,
      gatewayTimeMicros: 0xffffffff,
      dataRate: 0,
      powerDbm: 14,
      priority: TransmitPriority.SirenCommand,
      packet: sirenCommandPacket,
    },
  },

  {
    name: "transmit request at the radio's lowest power, -9 dBm",
    device: gateway,
    counter: 22,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.TransmitRequest,
      when: TransmitWhen.AsSoonAsPossible,
      gatewayTimeMicros: 1000,
      dataRate: 5,
      powerDbm: -9,
      priority: TransmitPriority.Normal,
      packet: replyPacket,
    },
  },
  {
    name: "transmit request with unlisted when 2, data rate 6 and priority 2, which pass through",
    device: gateway,
    counter: 23,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.TransmitRequest,
      when: 2,
      gatewayTimeMicros: 5,
      dataRate: 6,
      powerDbm: 0,
      priority: 2,
      packet: sirenCommandPacket,
    },
  },

  // Gateway settings (0xA2)
  {
    name: "gateway settings",
    device: gateway,
    counter: 2,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.GatewaySettings,
      settingsVersion: 1,
      siteChannel: SiteChannel.Mhz868_1,
      listenDataRateMask: 0b100100,
      statusIntervalSeconds: 30,
      interferenceThresholdDb: 10,
      interferenceSeconds: 30,
      defaultTxPowerDbm: 14,
      sirenTxPowerDbm: 22,
    },
  },
  {
    name: "gateway settings with negative and extreme transmit powers",
    device: gateway,
    counter: 3,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.GatewaySettings,
      settingsVersion: 2,
      siteChannel: SiteChannel.Mhz868_5,
      listenDataRateMask: 0b000001,
      statusIntervalSeconds: 255,
      interferenceThresholdDb: 0,
      interferenceSeconds: 255,
      defaultTxPowerDbm: -9,
      sirenTxPowerDbm: -128,
    },
  },
  {
    name: "gateway settings with unlisted site channel 3 and data rate bits 6 and 7, which pass through",
    device: gateway,
    counter: 4,
    binding: session,
    maxLength: link,
    message: {
      type: MessageType.GatewaySettings,
      settingsVersion: 3,
      siteChannel: 3,
      listenDataRateMask: 0xc0,
      statusIntervalSeconds: 30,
      interferenceThresholdDb: 10,
      interferenceSeconds: 30,
      defaultTxPowerDbm: 14,
      sirenTxPowerDbm: 22,
    },
  },
];

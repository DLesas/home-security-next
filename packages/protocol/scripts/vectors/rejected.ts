/**
 * Packets a receiver must reject. Every expected error is checked against the library while
 * the file is generated, so a case cannot drift from the code.
 */
import {
  checkReplayWindow,
  checkStrictlyHigher,
  concatBytes,
  counterBinding,
  type CounterCheck,
  Direction,
  EMPTY_REPLAY_WINDOW,
  encodeMessage,
  encodeReplayWindow,
  fromHex,
  MaxPacketLength,
  type Message,
  MessageType,
  NO_BINDING,
  openPacket,
  type ReplayWindow,
  sessionBinding,
  SirenAction,
  toHex,
} from "../../src/index.ts";
import { gateway, gatewayRandom, hubRandom, sensor, siren, type Device } from "./devices.ts";
import { errorJson, type Json, type JsonObject } from "./json.ts";
import { heartbeatPacket } from "./packetCases.ts";
import { sealRaw } from "./packets.ts";

interface Rejected {
  readonly name: string;
  readonly device: Device;
  readonly expectedDirection: Direction;
  readonly binding: Uint8Array;
  readonly maxLength: MaxPacketLength;
  readonly packet: Uint8Array;
}

function withByte(packet: Uint8Array, index: number, value: (old: number) => number): Uint8Array {
  const copy = packet.slice();
  copy[index] = value(copy[index] ?? 0);
  return copy;
}

const session = sessionBinding(gatewayRandom, hubRandom);
const toHub = { expectedDirection: Direction.ToHub, binding: NO_BINDING } as const;
const radio = MaxPacketLength.Radio;
const link = MaxPacketLength.Link;

const reply = sealRaw({
  device: sensor,
  direction: Direction.FromHub,
  counter: 9,
  binding: counterBinding(41),
  plaintext: fromHex("8103031e1c0c05020500000000"),
}).packet;

/** Authenticated packets from the sensor whose plaintext is not a valid message. */
function sensorPacket(plaintext: Uint8Array, counter = 77): Uint8Array {
  return sealRaw({
    device: sensor,
    direction: Direction.ToHub,
    counter,
    binding: NO_BINDING,
    plaintext,
  }).packet;
}

/** Header fields replaced, then sealed properly, so only the header check can reject them. */
function sensorPacketWithHeader(header: number, address = sensor.address, counter = 1): Uint8Array {
  return sealRaw({
    device: sensor,
    direction: Direction.ToHub,
    counter,
    binding: NO_BINDING,
    plaintext: fromHex("010300780f000000"),
    header,
    address,
  }).packet;
}

/** Log entries filling exactly 256 bytes: three 64-byte texts and one of 14 bytes. */
const overRadioLimit = sensorPacket(
  encodeMessage({
    type: MessageType.LogEntries,
    entries: ["y".repeat(64), "y".repeat(64), "y".repeat(64), "z".repeat(14)].map((text) => ({
      ageTenths: 0,
      level: 0,
      code: 0,
      text,
    })),
  }),
);
if (overRadioLimit.length !== MaxPacketLength.Radio + 1) throw new Error("expected 256 bytes");

/** Authenticated gateway-connection packets, for bodies the encoder refuses to make. */
function gatewayPacket(direction: Direction, plaintext: Uint8Array, counter: number): Uint8Array {
  return sealRaw({ device: gateway, direction, counter, binding: session, plaintext }).packet;
}
const forwardedHead = fromHex("21" + "000000000000000000");
const transmitHead = fromHex("a1" + "0000000000000000");
const seventeenBytes = heartbeatPacket.subarray(0, 17);
const twoHundredFiftySixBytes = concatBytes(
  heartbeatPacket,
  new Uint8Array(MaxPacketLength.Radio + 1 - heartbeatPacket.length),
);

const logEntryHead = "30" + "00000000" + "01" + "0000";

const rejectedPackets: readonly Rejected[] = [
  {
    name: "tag altered",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: withByte(heartbeatPacket, heartbeatPacket.length - 1, (b) => b ^ 0x01),
  },
  {
    name: "encrypted type byte altered",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: withByte(heartbeatPacket, 9, (b) => b ^ 0x80),
  },
  {
    name: "encrypted body byte altered",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: withByte(heartbeatPacket, 12, (b) => b ^ 0x10),
  },
  {
    name: "address altered",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: withByte(heartbeatPacket, 1, (b) => b ^ 0x01),
  },
  {
    name: "counter altered",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: withByte(heartbeatPacket, 5, (b) => b ^ 0x02),
  },
  {
    name: "header's low bits altered after sealing",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: withByte(heartbeatPacket, 0, (b) => b | 0x01),
  },
  {
    name: "opened with another device's key",
    device: siren,
    ...toHub,
    maxLength: radio,
    packet: heartbeatPacket,
  },
  {
    name: "reply opened with the binding of a different sensor packet",
    device: sensor,
    expectedDirection: Direction.FromHub,
    binding: counterBinding(42),
    maxLength: radio,
    packet: reply,
  },
  {
    name: "reply opened without its binding",
    device: sensor,
    expectedDirection: Direction.FromHub,
    binding: NO_BINDING,
    maxLength: radio,
    packet: reply,
  },
  {
    name: "gateway packet from an earlier connection",
    device: gateway,
    expectedDirection: Direction.ToHub,
    binding: session,
    maxLength: link,
    packet: sealRaw({
      device: gateway,
      direction: Direction.ToHub,
      counter: 5,
      binding: sessionBinding(gatewayRandom, fromHex("c0c1c2c3c4c5c6c7")),
      plaintext: fromHex("2400b01e00"),
    }).packet,
  },
  {
    name: "hub receives a packet from the hub",
    device: sensor,
    expectedDirection: Direction.ToHub,
    binding: counterBinding(41),
    maxLength: radio,
    packet: reply,
  },
  {
    name: "device receives a packet to the hub",
    device: sensor,
    expectedDirection: Direction.FromHub,
    binding: NO_BINDING,
    maxLength: radio,
    packet: heartbeatPacket,
  },
  { name: "empty", device: sensor, ...toHub, maxLength: radio, packet: new Uint8Array(0) },
  {
    name: "17 bytes, one short of the smallest packet",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: heartbeatPacket.subarray(0, 17),
  },
  {
    name: "tag cut short",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: heartbeatPacket.subarray(0, heartbeatPacket.length - 1),
  },
  {
    name: "256 bytes, one over the radio limit",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: overRadioLimit,
  },
  {
    name: "protocol version 2",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: sensorPacketWithHeader(0x20),
  },
  {
    name: "setup marker where a header belongs",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: sensorPacketWithHeader(0xf1),
  },
  {
    name: "address 0",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: sensorPacketWithHeader(0x10, 0),
  },
  {
    name: "address 0xFFFFFFFF",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: sensorPacketWithHeader(0x10, 0xffffffff),
  },
  {
    name: "counter 0",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: sensorPacketWithHeader(0x10, sensor.address, 0),
  },
  {
    name: "authenticated, unknown message type 0x7F",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: sensorPacket(fromHex("7f")),
  },
  {
    name: "authenticated heartbeat, body one byte short",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: sensorPacket(fromHex("010300780f0000")),
  },
  {
    name: "authenticated button, action byte missing",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: sensorPacket(fromHex("040310780f000100")),
  },
  {
    name: "authenticated log entries, empty body",
    device: sensor,
    ...toHub,
    maxLength: link,
    packet: sensorPacket(fromHex("30")),
  },
  {
    name: "authenticated log entry text longer than 64 bytes",
    device: sensor,
    ...toHub,
    maxLength: link,
    packet: sensorPacket(fromHex(logEntryHead + "41" + "61".repeat(65))),
  },
  {
    name: "authenticated forwarded packet carrying 17 bytes",
    device: gateway,
    expectedDirection: Direction.ToHub,
    binding: session,
    maxLength: link,
    packet: gatewayPacket(Direction.ToHub, concatBytes(forwardedHead, seventeenBytes), 40),
  },
  {
    name: "authenticated forwarded packet carrying 256 bytes",
    device: gateway,
    expectedDirection: Direction.ToHub,
    binding: session,
    maxLength: link,
    packet: gatewayPacket(Direction.ToHub, concatBytes(forwardedHead, twoHundredFiftySixBytes), 41),
  },
  {
    name: "authenticated transmit request carrying 17 bytes",
    device: gateway,
    expectedDirection: Direction.FromHub,
    binding: session,
    maxLength: link,
    packet: gatewayPacket(Direction.FromHub, concatBytes(transmitHead, seventeenBytes), 40),
  },
  {
    name: "authenticated transmit request carrying 256 bytes",
    device: gateway,
    expectedDirection: Direction.FromHub,
    binding: session,
    maxLength: link,
    packet: gatewayPacket(
      Direction.FromHub,
      concatBytes(transmitHead, twoHundredFiftySixBytes),
      41,
    ),
  },
  {
    name: "authenticated reply sealed in the to-hub direction",
    device: sensor,
    ...toHub,
    maxLength: radio,
    packet: sensorPacket(fromHex("8103031e1c0c05020500000000")),
  },
  {
    name: "authenticated heartbeat sealed in the from-hub direction",
    device: sensor,
    expectedDirection: Direction.FromHub,
    binding: NO_BINDING,
    maxLength: radio,
    packet: sealRaw({
      device: sensor,
      direction: Direction.FromHub,
      counter: 78,
      binding: NO_BINDING,
      plaintext: fromHex("010300780f000000"),
    }).packet,
  },
  {
    name: "authenticated log entries ending in a partial entry",
    device: sensor,
    ...toHub,
    maxLength: link,
    packet: sensorPacket(fromHex(logEntryHead + "00" + "0000")),
  },
];

function rejectedJson(r: Rejected): Json {
  const result = openPacket(r.packet, {
    key: r.device.key,
    expectedDirection: r.expectedDirection,
    binding: r.binding,
    maxLength: r.maxLength,
  });
  if (result.ok) throw new Error(`"${r.name}" was accepted`);
  return {
    name: r.name,
    key: toHex(r.device.key),
    expectedDirection: r.expectedDirection,
    binding: toHex(r.binding),
    maxLength: r.maxLength,
    packet: toHex(r.packet),
    ...errorJson(result.error),
  };
}

/** Packets that open, then fail the receiver's counter rule. */
interface Replayed {
  readonly name: string;
  readonly device: Device;
  readonly expectedDirection: Direction;
  readonly packet: Uint8Array;
  readonly rule: "replayWindow" | "strictlyHigher";
  /** Window state, or the last accepted counter for the strict rule. */
  readonly stateBefore: ReplayWindow | number;
}

function windowAfter(counters: readonly number[]): ReplayWindow {
  return counters.reduce((window, counter) => {
    const check = checkReplayWindow(window, counter);
    if (!check.accepted) throw new Error(`setup counter ${counter} rejected`);
    return check.state;
  }, EMPTY_REPLAY_WINDOW);
}

const everyCounterTo100 = windowAfter(Array.from({ length: 100 }, (_, i) => i + 1));
const sirenCommand = (counter: number): Uint8Array =>
  sealRaw({
    device: siren,
    direction: Direction.FromHub,
    counter,
    binding: NO_BINDING,
    plaintext: encodeMessage({
      type: MessageType.SirenCommand,
      action: SirenAction.SoundAlarm,
      soundSeconds: 180,
    } satisfies Message),
  }).packet;

const replayed: readonly Replayed[] = [
  {
    name: "hub: counter already accepted, 64 below the highest",
    device: sensor,
    expectedDirection: Direction.ToHub,
    packet: sensorPacket(fromHex("010300780f000000"), 36),
    rule: "replayWindow",
    stateBefore: everyCounterTo100,
  },
  {
    name: "hub: counter 65 below the highest",
    device: sensor,
    expectedDirection: Direction.ToHub,
    packet: sensorPacket(fromHex("010300780f000000"), 35),
    rule: "replayWindow",
    stateBefore: everyCounterTo100,
  },
  {
    name: "hub: repeat of the highest counter",
    device: sensor,
    expectedDirection: Direction.ToHub,
    packet: sensorPacket(fromHex("010300780f000000"), 100),
    rule: "replayWindow",
    stateBefore: everyCounterTo100,
  },
  {
    name: "siren: exact repeat of the last command",
    device: siren,
    expectedDirection: Direction.FromHub,
    packet: sirenCommand(7000),
    rule: "strictlyHigher",
    stateBefore: 7000,
  },
  {
    name: "siren: older command arriving late",
    device: siren,
    expectedDirection: Direction.FromHub,
    packet: sirenCommand(7000),
    rule: "strictlyHigher",
    stateBefore: 7001,
  },
];

function replayedJson(r: Replayed): Json {
  const opened = openPacket(r.packet, {
    key: r.device.key,
    expectedDirection: r.expectedDirection,
    binding: NO_BINDING,
    maxLength: radio,
  });
  if (!opened.ok) throw new Error(`"${r.name}" did not open`);
  const counter = opened.value.header.counter;
  const check: CounterCheck<unknown> =
    typeof r.stateBefore === "number"
      ? checkStrictlyHigher(r.stateBefore, counter)
      : checkReplayWindow(r.stateBefore, counter);
  if (check.accepted) throw new Error(`"${r.name}" was accepted`);
  return {
    name: r.name,
    key: toHex(r.device.key),
    expectedDirection: r.expectedDirection,
    binding: "",
    maxLength: radio,
    packet: toHex(r.packet),
    rule: r.rule,
    stateBefore:
      typeof r.stateBefore === "number" ? r.stateBefore : toHex(encodeReplayWindow(r.stateBefore)),
    rejection: check.reason,
  };
}

export function rejectedVectorFile(): JsonObject {
  return {
    packets: rejectedPackets.map(rejectedJson),
    replayed: replayed.map(replayedJson),
  };
}

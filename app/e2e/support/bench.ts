#!/usr/bin/env bun
/**
 * The boards of the browser tests (m2-design.md section 10, "The app": "scripted boards on
 * pseudo-terminals"), in real time, run by Bun as a child of the Playwright test:
 *
 * - **Three USB boards**, each on a pseudo-terminal or the Windows test entry's loopback
 *   stream: a gateway (a release build, so the hub
 *   adds it on its own, D100), a sensor and a siren (development builds, added over USB from the
 *   app, PR5). The hub is given a path for each with `--serial`, in the ports folder
 *   (`HSN_E2E_USB_DIR`); a board is **plugged in** when the bench makes that path a link to its
 *   terminal or a marker for the stream. The hub watches the folder of each path and opens it as it
 *   opens a USB port that appears. The sensor and the siren are plugged in at the start, the
 *   gateway when the test says (`plug`), so the app sees it added. Each answers setup messages as
 *   `ScriptedBoard` does (protocol.md §10). A board that accepts a pairing restarts as its role:
 *   `ScriptedGateway` on the same USB link (a hello every 2 s until it is welcomed, then its
 *   status every second, `STATUS_EVERY_US`), `ScriptedSensor` on the radio, `ScriptedSiren` on the
 *   radio and on its own `/device` WebSocket (its Wi-Fi).
 * - **The air**, the real-time form of `hub/test/world/home.ts`'s: a sensor's or siren's packet
 *   reaches the gateway 30 ms after its end, if the gateway listens on its channel at its rate,
 *   and is forwarded; a transmission the gateway makes reaches the device it is addressed to at
 *   its start. The gateway's transmit results go to the hub when due (`wake`, every few ms), as
 *   `hub/test/budget/loop-limit.test.ts` does. One clock, in microseconds since the bench started,
 *   is every device's and the gateway's.
 *
 * Standard output carries one JSON line per event (`BenchLine`); standard input one command per
 * line (`BenchCommand`). Nothing secret is written: no key, no pairing, only roles and counts.
 *
 * `HSN_E2E_BREAK` (names joined by commas) breaks things at run time, so a test can be shown to
 * fail without editing the app or the hub: `siren-deaf` (the siren hears nothing from the hub,
 * so it never sounds), `gateway-no-forward` (the gateway forwards no radio packet, so no door
 * report reaches the hub), `noise-flat` (every channel sounds the same, so the survey falls back
 * to its tie-breaker). `breaks.ts` has the browser's.
 */
import { join } from "node:path";
import {
  dataRatesInMask,
  encodeUsbFrame,
  MaxPacketLength,
  MessageType,
  type PairingData,
  readPacketHeader,
  ResumeStep,
  Role,
  SirenAction,
  SirenState,
  spreadingFactor,
  timeOnAirMs,
  UsbFrameDecoder,
} from "@hsn/protocol";
import { mono, type Mono } from "../../../hub/src/core/model/time.ts";
import { DEVICE_PATH } from "../../../hub/src/shell/links/websocket.ts";
import { benchPort, type BenchPort } from "./bench-port.ts";
import { ScriptedBoard } from "../../../hub/test/unit/setup/support/board.ts";
import { ScriptedGateway } from "../../../hub/test/world/scripted-gateway.ts";
import { ScriptedSensor, type Transmission } from "../../../hub/test/world/scripted-sensor.ts";
import { ScriptedSiren } from "../../../hub/test/world/scripted-siren.ts";

/** What the bench says, one JSON line each. */
export type BenchLine =
  | {
      readonly kind: "ports";
      readonly gateway: string;
      readonly sensor: string;
      readonly siren: string;
    }
  | { readonly kind: "provisioned"; readonly role: BoardRole }
  | { readonly kind: "welcomed" }
  | { readonly kind: "sirenActed"; readonly path: "wifi" | "lora"; readonly action: number }
  | { readonly kind: "state"; readonly id: number; readonly state: BenchState }
  | { readonly kind: "problem"; readonly message: string };

/** What the test can ask, one JSON line each. */
export type BenchCommand =
  | { readonly cmd: "plug"; readonly board: BoardRole }
  | { readonly cmd: "door"; readonly open: boolean }
  | { readonly cmd: "state"; readonly id: number }
  | { readonly cmd: "quit" };

export type BoardRole = "gateway" | "sensor" | "siren";

/** What the boards have done, for the test's checks (counts and states, nothing secret). */
export interface BenchState {
  readonly gatewayWelcomed: boolean;
  /** Radio packets the gateway forwarded to the hub. */
  readonly forwarded: number;
  readonly sensor: {
    readonly started: boolean;
    readonly doorOpen: boolean;
    readonly armed: boolean;
    readonly buzzing: boolean;
    readonly replies: number;
  };
  readonly siren: {
    readonly started: boolean;
    readonly wifiConnected: boolean;
    /** The siren's output: `SirenState`. */
    readonly output: number;
    /** Sound commands it acted on (SoundAlarm), on either path. */
    readonly soundCommands: number;
    /** Off commands it acted on. */
    readonly offCommands: number;
  };
}

const BREAKS = (process.env.HSN_E2E_BREAK ?? "").split(",");
const HUB_DEVICE_PORT = process.env.HSN_E2E_DEVICE_PORT ?? "";
const USB_DIR = process.env.HSN_E2E_USB_DIR ?? "";
/** How often the bench runs what is due ‡: often enough for the 20 ms rule of a transmit request. */
const PUMP_MS = 4;
/** From a packet's end to the gateway's forwarded copy (home.ts's figure). */
const FORWARD_DELAY_US = 30_000;
/** A gateway on USB sends a hello every 2 s until welcomed (protocol.md §10, D81). */
const HELLO_EVERY_US = 2_000_000;
/**
 * The gateway's status, every second rather than at the interval the hub sets (30 s): the hub's
 * channel survey takes five statuses on each channel, so the survey a person starts in setup
 * takes seconds here, not six minutes. The hub takes a status whenever it comes.
 */
const STATUS_EVERY_US = 1_000_000;
/**
 * The noise the gateway hears on each site channel: 868.5 MHz is the quietest, so the survey has
 * a clear answer that is not its tie-breaker (868.3 MHz).
 */
const NOISE_DBM: readonly number[] = BREAKS.includes("noise-flat")
  ? [-116, -116, -116]
  : [-112, -116, -121];
/** A board restarts after accepting a pairing; its role starts this long after (‡). */
const RESTART_US = 300_000;
const SECOND_US = 1_000_000;
/** Every setup message starts with this byte, which no encrypted packet starts with (§10). */
const SETUP_FIRST_BYTE = 0xf1;

const started = performance.now();
function now(): Mono {
  return mono(Math.round((performance.now() - started) * 1000));
}

function say(line: BenchLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// ----- The boards -----

interface Board {
  readonly role: BoardRole;
  readonly cable: BenchPort;
  /** The path the hub is given, published when the board is plugged in. */
  readonly port: string;
  readonly board: ScriptedBoard;
  readonly decoder: UsbFrameDecoder;
  /** The pairing it accepted, once it has, and when its role starts. */
  pairing: PairingData | undefined;
  startsAt: number | undefined;
}

function chip(role: number): Uint8Array {
  return new Uint8Array([0x3c, 0x84, 0x27, 0xe2, 0x10, role]);
}

/** Makes a scripted board and its byte stream, ready to be plugged in later. */
async function makeBoard(
  role: BoardRole,
  roleNumber: number,
  development: boolean,
): Promise<Board | undefined> {
  const port = join(USB_DIR, role);
  const cable = await benchPort(port);
  if (cable === undefined) return undefined;
  return {
    role,
    cable,
    port,
    board: new ScriptedBoard({ role: roleNumber, chipId: chip(roleNumber), development }),
    decoder: new UsbFrameDecoder(),
    pairing: undefined,
    startsAt: undefined,
  };
}

function allMade(made: readonly (Board | undefined)[]): made is readonly [Board, Board, Board] {
  return made.length === 3 && made.every((board) => board !== undefined);
}

const made = await Promise.all([
  makeBoard("gateway", Role.Gateway, false),
  makeBoard("sensor", Role.Sensor, true),
  makeBoard("siren", Role.Siren, true),
]);
if (!allMade(made)) {
  say({ kind: "problem", message: "no bench port" });
  process.exit(1);
}
const [gatewayBoard, sensorBoard, sirenBoard] = made;
const boards: readonly Board[] = made;

/** Plugs a board in so its port's path appears. */
function plug(board: Board): void {
  board.cable.plug();
}

// ----- The roles, once paired -----

let gateway: ScriptedGateway | undefined;
let gatewayHelloAt: number | undefined;
let gatewayStatusAt: number | undefined;
let gatewayWelcomed = false;
let forwarded = 0;
let sensor: ScriptedSensor | undefined;
let sensorAddress: number | undefined;
let siren: ScriptedSiren | undefined;
let sirenAddress: number | undefined;
let sirenSocket: WebSocket | undefined;
let sirenWifiConnected = false;
let soundCommands = 0;
let offCommands = 0;
let actedSeen = 0;

interface OnAir {
  readonly packet: Uint8Array;
  readonly channel: number;
  readonly dataRate: number;
  readonly start: number;
  readonly end: number;
}
/** Device packets on their way to the gateway, by when they are forwarded. */
let forwards: { at: number; t: OnAir }[] = [];
/** The gateway's transmissions on their way to a device, by their start. */
let deliveries: { at: number; packet: Uint8Array; rate: number }[] = [];
let taken = 0;

function airtimeUs(dataRate: number, length: number): number {
  return Math.ceil(timeOnAirMs(spreadingFactor(dataRate) ?? 7, length) * 1000);
}

function writeFrame(board: Board, bytes: Uint8Array): void {
  board.cable.send(encodeUsbFrame(bytes));
}

function onAir(t: OnAir): void {
  forwards.push({ at: t.end + FORWARD_DELAY_US, t });
  forwards.sort((a, b) => a.at - b.at);
}

function sensorOnAir(t: Transmission): void {
  onAir({ packet: t.packet, channel: t.channel, dataRate: t.dataRate, start: t.start, end: t.end });
}

function sirenOnAir(packet: Uint8Array): void {
  if (siren === undefined) return;
  const start = now();
  onAir({
    packet,
    channel: siren.held.siteChannel,
    dataRate: siren.held.sendRate,
    start,
    end: start + airtimeUs(siren.held.sendRate, packet.length),
  });
}

function addressOf(packet: Uint8Array): number | undefined {
  const header = readPacketHeader(packet, MaxPacketLength.Radio);
  return header.ok ? header.value.address : undefined;
}

/** The gateway's new transmissions: on the air from their start. */
function takeTransmissions(): void {
  if (gateway === undefined) return;
  for (const t of gateway.transmissions.slice(taken)) {
    deliveries.push({ at: gateway.hubTimeAt(t.startMicros), packet: t.packet, rate: t.dataRate });
  }
  taken = gateway.transmissions.length;
  deliveries.sort((a, b) => a.at - b.at);
}

function rateOf(pairing: PairingData): number {
  return dataRatesInMask(pairing.allowedDataRateMask)[0] ?? 5;
}

function startRole(board: Board, pairing: PairingData, at: Mono): void {
  if (board.role === "gateway") {
    gateway = new ScriptedGateway({
      key: pairing.key,
      address: pairing.address,
      nextRandom: () => crypto.getRandomValues(new Uint8Array(8)),
    });
    taken = 0;
    gatewayWelcomed = false;
    gatewayHelloAt = at;
    gatewayStatusAt = undefined;
    return;
  }
  if (board.role === "sensor") {
    sensorAddress = pairing.address;
    sensor = new ScriptedSensor({
      key: pairing.key,
      address: pairing.address,
      channel: pairing.siteChannel,
      rate: rateOf(pairing),
      random: () => Math.random(),
      startAt: at,
    });
    return;
  }
  sirenAddress = pairing.address;
  const rate = rateOf(pairing);
  siren = new ScriptedSiren({
    key: pairing.key,
    address: pairing.address,
    resumePoint: ResumeStep.SirenOrGateway,
    settings: { siteChannel: pairing.siteChannel, sendRate: rate, commandRate: rate },
    wifiUp: false,
  });
  siren.deaf = BREAKS.includes("siren-deaf");
  siren.clockOffset = 0;
  connectSiren();
}

/** The siren's Wi-Fi: its own `/device` WebSocket, as the bench's bridge gives the firmware's. */
function connectSiren(): void {
  if (HUB_DEVICE_PORT === "" || siren === undefined) return;
  const socket = new WebSocket(`ws://127.0.0.1:${HUB_DEVICE_PORT}${DEVICE_PATH}`);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => {
    sirenWifiConnected = true;
    siren?.setWifi(true, now());
  };
  socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (siren === undefined) return;
    for (const answer of siren.wifi.receive(new Uint8Array(event.data), now()))
      socket.send(new Uint8Array(answer));
  };
  socket.onclose = () => {
    sirenWifiConnected = false;
    siren?.setWifi(false, now());
    sirenSocket = undefined;
  };
  sirenSocket = socket;
}

function fromHub(board: Board, bytes: Uint8Array): void {
  if (bytes[0] === SETUP_FIRST_BYTE) {
    const before = board.board.accepted.length;
    for (const answer of board.board.receive(bytes)) writeFrame(board, answer);
    const pairing = board.board.accepted.at(-1);
    if (board.board.accepted.length > before && pairing !== undefined) {
      board.pairing = pairing;
      board.startsAt = now() + RESTART_US;
      if (board.role === "gateway") gateway = undefined;
      say({ kind: "provisioned", role: board.role });
    }
    return;
  }
  // A link message: only the gateway speaks on its USB link once paired.
  if (board.role !== "gateway" || gateway === undefined) return;
  for (const answer of gateway.receive(bytes, now())) writeFrame(board, answer);
  takeTransmissions();
  if (!gatewayWelcomed && gateway.session !== undefined) {
    gatewayWelcomed = true;
    gatewayStatusAt = now() + SECOND_US;
    say({ kind: "welcomed" });
  }
}

for (const board of boards) {
  board.cable.receive((chunk) => {
    for (const frame of board.decoder.push(new Uint8Array(chunk))) {
      if (frame.ok) fromHub(board, frame.value);
    }
  });
}

function gatewayStatus(at: number): Uint8Array | undefined {
  if (gateway === undefined) return undefined;
  const noise = NOISE_DBM[gateway.settings?.siteChannel ?? 1] ?? -110;
  return gateway.status({
    settingsVersion: gateway.settings?.settingsVersion ?? 0,
    uptimeSeconds: Math.floor(at / SECOND_US),
    airtimeHundredthsPercent: 12,
    noiseMedianDbm: noise,
    noiseHighestDbm: noise + 8,
    normalNoiseDbm: noise,
    packetsReceived: forwarded,
    packetsCrcFailed: 0,
    wifiRssiDbm: -60,
    flags: { usbConnected: true, cellFitted: false, onMains: true },
  });
}

function pump(): void {
  const at = now();
  for (const board of boards) {
    if (board.startsAt !== undefined && board.startsAt <= at && board.pairing !== undefined) {
      board.startsAt = undefined;
      startRole(board, board.pairing, at);
    }
  }
  if (gateway !== undefined) {
    if (!gatewayWelcomed && gatewayHelloAt !== undefined && gatewayHelloAt <= at) {
      gatewayHelloAt = at + HELLO_EVERY_US;
      const hello = gateway.hello();
      if (hello !== undefined) writeFrame(gatewayBoard, hello);
    }
    const due = gateway.nextWake();
    if (due !== undefined && due <= at) {
      for (const frame of gateway.wake(at)) writeFrame(gatewayBoard, frame);
    }
    if (gatewayStatusAt !== undefined && gatewayStatusAt <= at) {
      gatewayStatusAt = at + STATUS_EVERY_US;
      const status = gatewayStatus(at);
      if (status !== undefined) writeFrame(gatewayBoard, status);
    }
  }
  // The gateway's packets reach the devices at their start.
  while (deliveries[0] !== undefined && deliveries[0].at <= at) {
    const delivery = deliveries.shift();
    if (delivery === undefined) break;
    const address = addressOf(delivery.packet);
    if (sensor !== undefined && address === sensorAddress)
      sensor.hear(delivery.packet, delivery.rate, mono(delivery.at));
    if (siren !== undefined && address === sirenAddress)
      for (const answer of siren.lora.receive(delivery.packet, at)) sirenOnAir(answer);
  }
  if (sensor !== undefined) {
    const due = sensor.nextWake();
    if (due !== undefined && due <= at) for (const t of sensor.wake(at)) sensorOnAir(t);
  }
  if (siren !== undefined) {
    const loraDue = siren.lora.nextWake();
    if (loraDue !== undefined && loraDue <= at)
      for (const packet of siren.lora.wake(at)) sirenOnAir(packet);
    const wifiDue = siren.wifi.nextWake();
    if (sirenSocket !== undefined && sirenWifiConnected && wifiDue !== undefined && wifiDue <= at)
      for (const bytes of siren.wifi.wake(at)) sirenSocket.send(new Uint8Array(bytes));
    for (const acted of siren.acted.slice(actedSeen)) {
      if (acted.message.type !== MessageType.SirenCommand) continue;
      if (acted.message.action === SirenAction.SoundAlarm) soundCommands += 1;
      if (acted.message.action === SirenAction.Off) offCommands += 1;
      say({ kind: "sirenActed", path: acted.path, action: acted.message.action });
    }
    actedSeen = siren.acted.length;
  }
  // Device packets reach the gateway, if it listens on their channel at their rate.
  while (forwards[0] !== undefined && forwards[0].at <= at) {
    const forward = forwards.shift();
    if (forward === undefined) break;
    const settings = gateway?.settings;
    const t = forward.t;
    const listening =
      settings?.siteChannel === t.channel &&
      ((settings.listenDataRateMask >> t.dataRate) & 1) === 1;
    if (gateway === undefined || !gatewayWelcomed || !listening) continue;
    if (BREAKS.includes("gateway-no-forward")) continue;
    const frame = gateway.forward(t.packet, {
      endedAt: mono(t.end),
      rssiDbm: -72,
      snrQuarterDb: 32,
      dataRate: t.dataRate,
      siteChannel: t.channel,
    });
    if (frame === undefined) continue;
    forwarded += 1;
    writeFrame(gatewayBoard, frame);
  }
  forwards = forwards.filter((f) => f.at > at - 10 * SECOND_US);
  deliveries = deliveries.filter((d) => d.at > at - 10 * SECOND_US);
}

const timer = setInterval(pump, PUMP_MS);

function state(): BenchState {
  return {
    gatewayWelcomed,
    forwarded,
    sensor: {
      started: sensor !== undefined,
      doorOpen: sensor?.doorOpen ?? false,
      armed: sensor?.armed ?? false,
      buzzing: sensor?.buzzing ?? false,
      replies: sensor?.replies.length ?? 0,
    },
    siren: {
      started: siren !== undefined,
      wifiConnected: sirenWifiConnected,
      output: siren?.output ?? SirenState.Off,
      soundCommands,
      offCommands,
    },
  };
}

function quit(): void {
  clearInterval(timer);
  sirenSocket?.close();
  for (const board of boards) board.cable.close();
  setTimeout(() => process.exit(0), 50);
}

let pending = "";
process.stdin.on("data", (chunk: Buffer) => {
  pending += chunk.toString();
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    const command = JSON.parse(line) as BenchCommand;
    if (command.cmd === "door") sensor?.door(now(), command.open);
    else if (command.cmd === "plug")
      plug(
        command.board === "gateway"
          ? gatewayBoard
          : command.board === "sensor"
            ? sensorBoard
            : sirenBoard,
      );
    else if (command.cmd === "state") say({ kind: "state", id: command.id, state: state() });
    else quit();
  }
});
process.stdin.on("end", quit);

plug(sensorBoard);
plug(sirenBoard);
say({
  kind: "ports",
  gateway: gatewayBoard.port,
  sensor: sensorBoard.port,
  siren: sirenBoard.port,
});

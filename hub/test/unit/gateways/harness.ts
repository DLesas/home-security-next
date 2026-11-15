/**
 * A harness for the links and gateways handlers (hub-design.md section 11, unit tests): the
 * dispatcher's rules (each message to links, then gateways, in order; due timers first, to
 * their owner only; what a handler emits joins the back of the queue) over just these two
 * modules, with every message and effect kept, so a test sees what the other modules would get.
 * Other modules' messages (`accepted`, `rejected`, `radioOut`, `siteMove`) are put in by hand.
 */
import { nodeSha256 } from "@hsn/protocol";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { EMPTY_M2_SNAPSHOT } from "../../../src/core/model/events.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";
import {
  Direction,
  fromHex,
  MaxPacketLength,
  type Message,
  type MessageOf,
  MessageType,
  sealPacket,
} from "@hsn/protocol";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { CoreFault } from "../../../src/core/model/errors.ts";
import type { DurableSnapshot, HubEvent } from "../../../src/core/model/events.ts";
import type { DeviceCipher } from "../../../src/core/model/cipher.ts";
import type { Context, CoreDeps, RecordCursor } from "../../../src/core/model/handler.ts";
import {
  bootId,
  type DeviceId,
  deviceId,
  type LinkId,
  linkId,
  seq,
} from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { DEFAULT_RULES, type HubRules } from "../../../src/core/model/rules.ts";
import {
  DeviceState,
  type DeviceRow,
  type GatewayConfigRow,
  type SiteRow,
} from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { type Mono, mono, monoAfterMs } from "../../../src/core/model/time.ts";
import { EFFECT_KINDS } from "../../../src/core/model/effects.ts";
import { handleGateways } from "../../../src/core/gateways/handle.ts";
import { gatewaysDeadlines } from "../../../src/core/gateways/deadlines.ts";
import { handleLinks } from "../../../src/core/links/handle.ts";
import { EMPTY_GATEWAYS_SLICE } from "../../../src/core/gateways/state.ts";
import { EMPTY_LINKS_SLICE } from "../../../src/core/links/state.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { VECTOR_DIRECTORY } from "../../world/vectors.ts";

/** The vectors' gateway (packages/protocol/vectors): address, key and its session's randoms. */
export const GATEWAY_ADDRESS = 0x92a3b4c5;
export const GATEWAY_KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x20 + i);
export const GATEWAY_RANDOM = Uint8Array.from({ length: 8 }, (_, i) => 0xa0 + i);
export const HUB_RANDOM = Uint8Array.from({ length: 8 }, (_, i) => 0xb0 + i);
/** The vectors' sensor and siren. */
export const SENSOR_ADDRESS = 0x1a2b3c4d;
export const SIREN_ADDRESS = 0x5e6f7081;
/** A fourth vector device, used where a test needs a second gateway. */
export const SECOND_GATEWAY_ADDRESS = 0x0badf00d;

export const SECOND = 1_000_000;

const effectKinds: ReadonlySet<string> = new Set(EFFECT_KINDS);
function isEffect(item: Internal | Effect): item is Effect {
  return effectKinds.has(item.kind);
}

export const cipher = VectorCipher.fromVectors();

/** The vector device with this address. */
export function deviceOf(address: number): DeviceId {
  return cipher.deviceFor(address)?.device ?? deviceId(-1);
}

export function keyOf(address: number): Uint8Array {
  return cipher.deviceFor(address)?.key ?? new Uint8Array(16);
}

export function deviceRow(
  address: number,
  role: number,
  state: number = DeviceState.Paired,
): DeviceRow {
  return {
    id: deviceOf(address),
    address,
    role,
    name: `device-${address.toString(16)}`,
    chipId: new Uint8Array(6),
    firmware: 0x010000,
    development: false,
    state: state as DeviceRow["state"],
    addedMs: 0,
    removedMs: null,
  };
}

export function configRow(
  address: number,
  version = 1,
  overrides: Partial<GatewayConfigRow> = {},
): GatewayConfigRow {
  return {
    deviceId: deviceOf(address),
    version,
    statusIntervalS: 30,
    interferenceDb: 10,
    interferenceS: 30,
    defaultPowerDbm: 22,
    sirenPowerDbm: 22,
    ...overrides,
  };
}

/**
 * An empty database's snapshot. `world.ts` has the same, but importing it loads every module
 * through `step.ts`, which these tests stay clear of (see `ownState`).
 */
export function emptySnapshot(): DurableSnapshot {
  return {
    devices: [],
    sendCounters: [],
    hubKeys: undefined,
    site: undefined,
    sensorConfig: [],
    sirenConfig: [],
    gatewayConfig: [],
    countdowns: [],
    alarm: undefined,
    alarmTriggers: [],
    alarmSirens: [],
    previousBoot: undefined,
    deviceState: [],
    lossDaily: [],
    provisioningKeys: new Map(),
    m2: EMPTY_M2_SNAPSHOT,
  };
}

/** A snapshot with the vectors' gateway, sensor and siren paired. */
export function snapshotWith(overrides: Partial<DurableSnapshot> = {}): DurableSnapshot {
  return {
    ...emptySnapshot(),
    devices: [
      deviceRow(GATEWAY_ADDRESS, 3),
      deviceRow(SENSOR_ADDRESS, 1),
      deviceRow(SIREN_ADDRESS, 2),
    ],
    gatewayConfig: [configRow(GATEWAY_ADDRESS)],
    sendCounters: [{ deviceId: deviceOf(GATEWAY_ADDRESS), resumePoint: 1024 }],
    ...overrides,
  };
}

/** Seals a packet from a vector device to the hub. */
export function toHub(
  address: number,
  message: Message,
  counter: number,
  binding: Uint8Array,
): Uint8Array {
  return sealPacket(message, {
    key: keyOf(address),
    direction: Direction.ToHub,
    address,
    counter,
    binding,
    maxLength: MaxPacketLength.Link,
  });
}

/**
 * The state these two modules read: their own slices. The rest of `HubState` is left out on
 * purpose, so these tests do not load the other modules (their owners are mid-edit); neither
 * module reads another's slice.
 */
function ownState(): HubState {
  const own: Pick<HubState, "links" | "gateways"> = {
    links: EMPTY_LINKS_SLICE,
    gateways: EMPTY_GATEWAYS_SLICE,
  };
  return own as HubState;
}

export class Harness {
  state: HubState = ownState();
  now: Mono = mono(0);
  wall = 1_800_000_000_000;
  wallTrusted = true;
  rules: HubRules;
  /** The bytes the next input's entropy starts with; the rest are zero. */
  entropy: Uint8Array = new Uint8Array(32);
  readonly messages: Internal[] = [];
  readonly effects: Effect[] = [];
  #seq = 0;

  constructor(rules: HubRules = DEFAULT_RULES) {
    this.rules = rules;
  }

  /** The cipher the handlers open and seal through; a test may wrap it to count calls. */
  cipher: DeviceCipher = cipher;

  get deps(): CoreDeps {
    return {
      cipher: this.cipher,
      rules: this.rules,
      calendar: UNBUILT_CALENDAR,
      sha256: nodeSha256,
    };
  }

  /** Runs one input event and everything it causes; returns what this one input emitted. */
  input(event: Internal): {
    readonly messages: readonly Internal[];
    readonly effects: readonly Effect[];
    readonly fault: CoreFault | undefined;
  } {
    const entropy = new Uint8Array(32);
    entropy.set(this.entropy.slice(0, 32));
    const eventKind = inputKind(event);
    const cursor = entropyCursor(entropy, eventKind);
    const records: RecordCursor = { take: () => ok(seq(this.#seq++)) };
    const due = gatewaysDeadlines(this.state.gateways)
      .filter((t) => t.at <= this.now)
      .toSorted((a, b) => a.at - b.at);
    const queue: { readonly message: Internal; readonly onlyGateways: boolean }[] = [
      ...due.map((t) => {
        const message: Internal = { kind: "timer", key: t.key, at: t.at };
        return { message, onlyGateways: true };
      }),
      { message: event, onlyGateways: false },
    ];
    const messages: Internal[] = [];
    const effects: Effect[] = [];
    // The queue grows as handlers emit; `for … of` reaches what is pushed meanwhile.
    for (const item of queue) {
      const ctxFor = (): Context => ({
        now: { mono: this.now, wall: this.wall, wallTrusted: this.wallTrusted },
        view: this.state,
        deps: this.deps,
        entropy: cursor,
        records,
        event: eventKind,
      });
      const outs: (Internal | Effect)[] = [];
      if (!item.onlyGateways) {
        const links = handleLinks(this.state.links, item.message, ctxFor());
        if (links.isErr()) return { messages, effects, fault: links.error };
        this.state = { ...this.state, links: links.value.slice };
        outs.push(...links.value.out);
      }
      const gateways = handleGateways(this.state.gateways, item.message, ctxFor());
      if (gateways.isErr()) return { messages, effects, fault: gateways.error };
      this.state = { ...this.state, gateways: gateways.value.slice };
      outs.push(...gateways.value.out);
      for (const out of outs) {
        if (isEffect(out)) effects.push(out);
        else {
          messages.push(out);
          queue.push({ message: out, onlyGateways: false });
        }
      }
    }
    this.messages.push(...messages);
    this.effects.push(...effects);
    return { messages, effects, fault: undefined };
  }

  boot(snapshot: DurableSnapshot = snapshotWith()): ReturnType<Harness["input"]> {
    return this.input({
      kind: "boot",
      snapshot,
      boot: { id: bootId(1), previousExit: "clean", cause: undefined },
    });
  }

  open(link: number, kind: "usb" | "network" = "network", label = `link-${link}`): LinkId {
    const id = linkId(link);
    this.input({ kind: "linkOpened", link: id, linkKind: kind, label });
    return id;
  }

  frame(link: LinkId, bytes: Uint8Array): ReturnType<Harness["input"]> {
    return this.input({ kind: "frame", link, bytes });
  }

  /** Moves the clock on and runs a tick (due timers). */
  advance(ms: number): ReturnType<Harness["input"]> {
    this.now = monoAfterMs(this.now, ms);
    this.wall += ms;
    return this.input({ kind: "tick" });
  }
}

const INPUT_KINDS: ReadonlySet<string> = new Set([
  "boot",
  "linkOpened",
  "linkClosed",
  "frame",
  "sendFailed",
  "commit",
  "command",
  "tick",
]);

/** A message put in by hand stands for one made in a step whose input was a tick. */
function inputKind(message: Internal): HubEvent["kind"] {
  return INPUT_KINDS.has(message.kind) ? (message.kind as HubEvent["kind"]) : "tick";
}

/** The messages of one kind. */
export function ofKind<K extends Internal["kind"]>(
  items: readonly (Internal | Effect)[],
  kind: K,
): Extract<Internal, { readonly kind: K }>[] {
  return items.filter((m): m is Extract<Internal, { readonly kind: K }> => m.kind === kind);
}

/** The effects of one kind. */
export function effectsOf<K extends Effect["kind"]>(
  items: readonly Effect[],
  kind: K,
): Extract<Effect, { readonly kind: K }>[] {
  return items.filter((m): m is Extract<Effect, { readonly kind: K }> => m.kind === kind);
}

/** The decision kinds among the audit records emitted. */
export function decisionsIn(messages: readonly Internal[]): readonly string[] {
  return ofKind(messages, "auditRecord").flatMap((m) =>
    m.record.kind === "decision" ? [m.record.row.kind] : [],
  );
}

export { deviceId, linkId, mono };

/** One case of a vector file with its fields, for the tests that compare decoded fields. */
export interface FieldCase {
  readonly name: string;
  readonly counter: number;
  readonly address: number;
  readonly binding: string;
  readonly fields: Record<string, unknown>;
  readonly packet: Uint8Array;
}

/** Every case of one message vector file, fields included. */
export function fieldCases(file: string): readonly FieldCase[] {
  const parsed = z
    .object({
      cases: z.array(
        z.object({
          name: z.string(),
          counter: z.number(),
          address: z.number(),
          binding: z.string(),
          fields: z.record(z.string(), z.unknown()),
          packet: z.string(),
        }),
      ),
    })
    .parse(JSON.parse(readFileSync(join(VECTOR_DIRECTORY, file), "utf8")));
  return parsed.cases.map((c) => ({ ...c, packet: fromHex(c.packet) }));
}

/** The case of `file` whose name starts with `prefix`; fails the test when there is none. */
export function fieldCase(file: string, prefix: string): FieldCase {
  const found = fieldCases(file).find((c) => c.name.startsWith(prefix));
  expect(found, `a case "${prefix}" in ${file}`).toBeDefined();
  return (
    found ?? { name: "", counter: 0, address: 0, binding: "", fields: {}, packet: new Uint8Array() }
  );
}

/** A rejected-packets case. */
export interface RejectedCase {
  readonly name: string;
  readonly error: string;
  readonly expectedDirection: number;
  readonly binding: string;
  readonly packet: Uint8Array;
}

export function rejectedCases(): readonly RejectedCase[] {
  const parsed = z
    .object({
      packets: z.array(
        z.object({
          name: z.string(),
          error: z.string(),
          expectedDirection: z.number(),
          binding: z.string(),
          packet: z.string(),
        }),
      ),
    })
    .parse(JSON.parse(readFileSync(join(VECTOR_DIRECTORY, "rejected-packets.json"), "utf8")));
  return parsed.packets.map((c) => ({ ...c, packet: fromHex(c.packet) }));
}

/** The site row of the vectors' gateway settings: 868.1 MHz, listening at DR2 and DR5. */
export function vectorSite(overrides: Partial<SiteRow> = {}): SiteRow {
  return {
    channel: 0,
    rateMask: 36,
    moveId: 0,
    moveStage: 0,
    moveChannel: null,
    moveRate: null,
    moveActor: null,
    moveRequestedMs: null,
    moveForced: false,
    moveSwitchedBoot: null,
    moveSwitchedMono: null,
    wifiName: new Uint8Array(),
    wifiPassword: new Uint8Array(),
    countdownDefaultS: 30,
    autoStopS: 300,
    replyPowerDbm: 14,
    sirenPowerDbm: 22,
    retentionRoutineDays: 30,
    retentionEventDays: 365,
    ...overrides,
  };
}

/**
 * The vectors' first connection: a snapshot whose gateway has no counter yet (so the hub's first
 * is 1), settings version 1 at 14 and 22 dBm, the vectors' site; then the hello vector on
 * `link`, answered with entropy starting with the vectors' hub random, and the gateway's Started
 * vector, which proves the session. The hub's next counter to the gateway is then 3, and the
 * session's last received counter 2.
 */
export function connectVectors(
  h: Harness,
  link: LinkId,
  kind: "usb" | "network" = "network",
): void {
  h.boot(
    snapshotWith({
      sendCounters: [],
      site: vectorSite(),
      gatewayConfig: [configRow(GATEWAY_ADDRESS, 1, { defaultPowerDbm: 14, sirenPowerDbm: 22 })],
    }),
  );
  h.open(link, kind);
  h.entropy = HUB_RANDOM;
  h.frame(link, fieldCase("hello.json", "gateway hello").packet);
  h.frame(link, fieldCase("started.json", "gateway started").packet);
}

type StatusFields = Omit<MessageOf<typeof MessageType.GatewayStatus>, "type">;

/** A gateway status with quiet, ordinary figures, changed by `overrides`. */
export function statusMessage(overrides: Partial<StatusFields> = {}): Message {
  return { type: MessageType.GatewayStatus, ...statusFields(overrides) };
}

/** A status's fields, as `ScriptedGateway.status` takes them. */
export function statusFields(overrides: Partial<StatusFields> = {}): StatusFields {
  return {
    settingsVersion: 1,
    uptimeSeconds: 100,
    airtimeHundredthsPercent: 0,
    noiseMedianDbm: -120,
    noiseHighestDbm: -110,
    normalNoiseDbm: -120,
    packetsReceived: 0,
    packetsCrcFailed: 0,
    wifiRssiDbm: -60,
    flags: { usbConnected: false, cellFitted: false, onMains: true },
    ...overrides,
  };
}

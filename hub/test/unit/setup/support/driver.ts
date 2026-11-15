/**
 * A driver for E5's modules in the real dispatcher (`setupCore`): every input with a chosen time
 * and chosen entropy, so address draws and keys are exactly what a test asks for; the effects of
 * each step kept, and noted for the key-leak guard. Also fixtures (the hub's signing key and
 * identity from `pairing-data.json`, site rows) and the committed rows a restart reads back.
 */
import { nodeSha256 } from "@hsn/protocol";
import { UNBUILT_CALENDAR } from "../../../../src/shell/calendar/unbuilt.ts";
import { expect } from "bun:test";
import { fromHex, Role, SetupType, encodeSetupMessage, HUB_IDENTITY_LENGTH } from "@hsn/protocol";
import type { Result } from "neverthrow";
import type { ControlCommand, ControlReply } from "../../../../src/core/model/control.ts";
import type { Effect } from "../../../../src/core/model/effects.ts";
import type { CoreFault } from "../../../../src/core/model/errors.ts";
import type { DurableSnapshot, HubEvent } from "../../../../src/core/model/events.ts";
import type { CoreDeps, Stepped } from "../../../../src/core/model/handler.ts";
import {
  bootId,
  type DeviceId,
  type LinkId,
  linkId,
  requestId,
  type RequestId,
  deviceId,
  connId,
} from "../../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../../src/core/model/rules.ts";
import {
  type DeviceRow,
  DeviceState,
  MoveStage,
  type SiteRow,
} from "../../../../src/core/model/rows.ts";
import type { HubState } from "../../../../src/core/model/state.ts";
import type { StoreOp } from "../../../../src/core/model/store.ts";
import { type Mono, mono } from "../../../../src/core/model/time.ts";
import type { Core } from "../../../../src/core/step.ts";
import { VectorCipher } from "../../../world/vector-cipher.ts";
import { emptySnapshot } from "../../../world/world.ts";
import { setupCore } from "./core.ts";
import { noteEffects } from "./leak-guard.ts";

/** The signing key and identity of every `pairing-data.json` case (§9). */
export const HUB_SIGNING_PUBLIC = fromHex(
  "60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299",
);
export const HUB_IDENTITY = fromHex("d6c23e2744a840cb");
export const OTHER_HUB_IDENTITY = fromHex("0102030405060708");

export const SECOND = 1_000_000;
export const WALL_AT_START = Date.UTC(2026, 10, 13);

/** A site row: channel 868.3, DR5 only, Wi-Fi "home", unless given. */
export function siteRow(overrides: Partial<SiteRow> = {}): SiteRow {
  return {
    channel: 1,
    rateMask: 1 << 5,
    moveId: 0,
    moveStage: MoveStage.None,
    moveChannel: null,
    moveRate: null,
    moveActor: null,
    moveRequestedMs: null,
    moveForced: false,
    moveSwitchedBoot: null,
    moveSwitchedMono: null,
    wifiName: new TextEncoder().encode("home"),
    wifiPassword: new TextEncoder().encode("correct horse battery"),
    countdownDefaultS: 30,
    autoStopS: 300,
    replyPowerDbm: 22,
    sirenPowerDbm: 22,
    retentionRoutineDays: 30,
    retentionEventDays: 365,
    ...overrides,
  };
}

/** A snapshot with the hub's keys and a site, plus whatever is given. */
/**
 * A paired sensor that has not confirmed a site move: with one, an announced move waits, as it
 * does on a site with sensors (section 8, "Switch"); with none it would switch at once.
 */
export function unconfirmedSensor(): DeviceRow {
  return {
    id: deviceId(90),
    address: 0x0f0f0f0f,
    role: Role.Sensor,
    name: "porch",
    chipId: new Uint8Array(6).fill(0x90),
    firmware: 0,
    development: true,
    state: DeviceState.Contacted,
    addedMs: 0,
    removedMs: null,
  };
}

export function snapshot(overrides: Partial<DurableSnapshot> = {}): DurableSnapshot {
  return {
    ...emptySnapshot(),
    hubKeys: { signingPublic: HUB_SIGNING_PUBLIC, identity: HUB_IDENTITY },
    site: siteRow(),
    ...overrides,
  };
}

/** An Identity setup message (§10). */
export function identityFrame(options: {
  readonly role: number;
  readonly chipId: Uint8Array;
  readonly development: boolean;
  readonly hubIdentity?: Uint8Array;
  readonly firmware?: { readonly major: number; readonly minor: number; readonly patch: number };
}): Uint8Array {
  return encodeSetupMessage({
    type: SetupType.Identity,
    role: options.role,
    chipId: options.chipId,
    firmwareVersion: options.firmware ?? { major: 1, minor: 2, patch: 3 },
    paired: options.hubIdentity !== undefined,
    hubIdentity: options.hubIdentity ?? new Uint8Array(HUB_IDENTITY_LENGTH),
    developmentBuild: options.development,
  });
}

export function resultFrame(result: number): Uint8Array {
  return encodeSetupMessage({ type: SetupType.ProvisionResult, result });
}

export const CHIP_A = fromHex("a1b2c3d4e5f6");
export const CHIP_B = fromHex("010203040506");
export { Role };

/** Entropy that starts with these bytes, zero after: an address draw and a key, in that order. */
export function entropy(...parts: readonly (Uint8Array | readonly number[])[]): Uint8Array {
  const bytes = new Uint8Array(32);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** A 32-bit address as its 4 little-endian bytes. */
export function le32(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

/** The key the default entropy gives: 0x10 to 0x1f. */
export const KEY_ONE = new Uint8Array(16).map((_, i) => 0x10 + i);

export class Driver {
  readonly core: Core;
  readonly deps: CoreDeps;
  state: HubState;
  at: Mono = mono(SECOND);
  /** Every step's effects, in order. */
  readonly steps: (readonly Effect[])[] = [];
  #nextLink = 1;
  #nextRequest = 1;

  constructor(core: Core = setupCore()) {
    this.core = core;
    this.deps = {
      cipher: VectorCipher.fromVectors(),
      rules: DEFAULT_RULES,
      calendar: UNBUILT_CALENDAR,
      sha256: nodeSha256,
      deepFreeze: true,
    };
    this.state = core.emptyState();
  }

  /** One input; a fault leaves the state as it was. */
  try(
    event: HubEvent,
    bytes: Uint8Array = entropy(le32(0x11223344), KEY_ONE),
  ): Result<Stepped, CoreFault> {
    const result = this.core.step(
      this.state,
      {
        now: { mono: this.at, wall: WALL_AT_START + Math.floor(this.at / 1000), wallTrusted: true },
        entropy: bytes,
        event,
      },
      this.deps,
    );
    if (result.isOk()) {
      this.state = result.value.state;
      this.steps.push(result.value.effects);
      noteEffects(result.value.effects);
    }
    return result;
  }

  /** One input that must not fault; its effects. */
  input(event: HubEvent, bytes?: Uint8Array): readonly Effect[] {
    const result = this.try(event, bytes);
    expect(result.isOk() ? "ok" : result.error.message).toBe("ok");
    return result.isOk() ? result.value.effects : [];
  }

  boot(from: DurableSnapshot = snapshot(), id = 1): readonly Effect[] {
    return this.input({
      kind: "boot",
      snapshot: from,
      boot: { id: bootId(id), previousExit: "clean", cause: undefined },
    });
  }

  openUsb(label: string): { readonly link: LinkId; readonly effects: readonly Effect[] } {
    const link = linkId(this.#nextLink++);
    return { link, effects: this.input({ kind: "linkOpened", link, linkKind: "usb", label }) };
  }

  frame(link: LinkId, bytes: Uint8Array, entropyBytes?: Uint8Array): readonly Effect[] {
    return this.input({ kind: "frame", link, bytes }, entropyBytes);
  }

  command(
    command: ControlCommand,
    entropyBytes?: Uint8Array,
    actor = "tester",
  ): { readonly request: RequestId; readonly effects: readonly Effect[] } {
    const request = requestId(this.#nextRequest++);
    return {
      request,
      effects: this.input(
        { kind: "command", conn: connId(0), request, actor, command },
        entropyBytes,
      ),
    };
  }

  /** Time passes; due timers run. */
  advance(ms: number): readonly Effect[] {
    this.at = mono(this.at + ms * 1000);
    return this.input({ kind: "tick" });
  }

  /** Every effect of every step. */
  get all(): readonly Effect[] {
    return this.steps.flat();
  }
}

// Picking effects apart.

export function replies(effects: readonly Effect[]): readonly ControlReply[] {
  return effects.flatMap((e) => (e.kind === "respond" ? [e.reply] : []));
}

export function onlyReply(effects: readonly Effect[]): ControlReply {
  const all = replies(effects);
  expect(all.length).toBe(1);
  return all[0] ?? { ok: false, error: { code: "failed", message: "no reply at all" } };
}

export function errorCode(reply: ControlReply): string {
  return reply.ok ? "ok" : reply.error.code;
}

export function sends(
  effects: readonly Effect[],
): readonly Extract<Effect, { readonly kind: "send" }>[] {
  return effects.flatMap((e) => (e.kind === "send" ? [e] : []));
}

export function writes(effects: readonly Effect[]): readonly StoreOp[] {
  return effects.flatMap((e) => (e.kind === "write" ? [e.op] : []));
}

export function nowWrites(effects: readonly Effect[]): readonly StoreOp[] {
  return effects.flatMap((e) => (e.kind === "write" && e.durability === "now" ? [e.op] : []));
}

export function hubEvents(effects: readonly Effect[]) {
  return effects.flatMap((e) =>
    e.kind === "record" && e.record.kind === "hubEvent"
      ? [{ durability: e.durability, row: e.record.row }]
      : [],
  );
}

export function commandRows(effects: readonly Effect[]) {
  return effects.flatMap((e) =>
    e.kind === "record" && e.record.kind === "command" ? [e.record.row] : [],
  );
}

export function devicesOf(state: HubState): readonly DeviceRow[] {
  return [...state.registry.devices.values()];
}

export function deviceNamed(state: HubState, name: string): DeviceRow | undefined {
  return devicesOf(state).find((row) => row.name === name);
}

/**
 * The rows that are committed, as a restart reads them back: devices, keys, resume points, hub
 * keys and site. Applies `write` ops in order, as the writer does.
 */
export class CommittedRows {
  readonly devices = new Map<DeviceId, DeviceRow>();
  readonly keys = new Map<DeviceId, Uint8Array>();
  readonly resumePoints = new Map<DeviceId, number>();
  site: SiteRow | undefined = siteRow();

  apply(ops: readonly StoreOp[]): void {
    for (const op of ops) {
      if (op.table === "devices") {
        if (op.op === "upsert") this.devices.set(op.row.id, op.row);
        else this.devices.delete(op.key.id);
      } else if (op.table === "device_keys") {
        if (op.op === "upsert") this.keys.set(op.row.deviceId, op.row.key);
        else this.keys.delete(op.key.deviceId);
      } else if (op.table === "send_counters") {
        if (op.op === "upsert") this.resumePoints.set(op.row.deviceId, op.row.resumePoint);
        else this.resumePoints.delete(op.key.deviceId);
      }
    }
  }

  snapshot(): DurableSnapshot {
    return snapshot({
      devices: [...this.devices.values()],
      sendCounters: [...this.resumePoints].map(([deviceId, resumePoint]) => ({
        deviceId,
        resumePoint,
      })),
      site: this.site,
      provisioningKeys: new Map(
        [...this.keys].filter(
          ([device]) => this.devices.get(device)?.state === DeviceState.Provisioning,
        ),
      ),
    });
  }
}

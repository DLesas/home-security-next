/**
 * The scenario harness (hub-design.md section 11, "Scenario tests"): the real `step`, a virtual
 * `Now` (mono, wall and trust), seeded entropy, fake links, the vector cipher and a recording
 * writer, with scripted devices on the far ends of links. Each input is one turn of the loop of
 * section 4: step; stage the writes and records; commit if any is "now"; then the sends, each
 * through the send gate, the closes and the answers. The world jumps from deadline to deadline
 * (the core's wake, the writer's, each device's); nothing sleeps.
 */
import { UNBUILT_CALENDAR } from "../../src/shell/calendar/unbuilt.ts";
import { EMPTY_M2_SNAPSHOT } from "../../src/core/model/events.ts";
import { err, ok, type Result } from "neverthrow";
import type { DeviceCipher } from "../../src/core/model/cipher.ts";
import type { CoreDeps } from "../../src/core/model/handler.ts";
import type { Effect } from "../../src/core/model/effects.ts";
import type { CoreFault } from "../../src/core/model/errors.ts";
import {
  type DurableSnapshot,
  type HubEvent,
  INPUT_ENTROPY_BYTES,
  type LinkCloseReason,
  type LinkKind,
} from "../../src/core/model/events.ts";
import { bootId, type LinkId, linkId, type RequestId } from "../../src/core/model/ids.ts";
import type { ControlReply } from "../../src/core/model/control.ts";
import { DEFAULT_RULES, type HubRules } from "../../src/core/model/rules.ts";
import type { HubState } from "../../src/core/model/state.ts";
import type { Stepped } from "../../src/core/model/handler.ts";
import { type Mono, mono, monoAfterMs, msBetween, type Now } from "../../src/core/model/time.ts";
import { type Core, makeCore, MODULES } from "../../src/core/step.ts";
import type { StagedEffect } from "../../src/ports/writer.ts";
import { SeededBytes } from "./entropy.ts";
import { RecordingWriter } from "./recording-writer.ts";
import { VectorCipher } from "./vector-cipher.ts";

/** A device on the far end of a link, written in TypeScript on `@hsn/protocol`. */
export interface ScriptedDevice {
  /** When it next has something to do on its own, or undefined. */
  nextWake(): Mono | undefined;
  /** Runs what is due at `now`; returns the frames it sends to the hub. */
  wake(now: Mono): readonly Uint8Array[];
  /** A frame from the hub arrived at `now`; returns the frames it sends back at once. */
  receive(bytes: Uint8Array, now: Mono): readonly Uint8Array[];
}

/** One link as the world keeps it. */
export interface FakeLink {
  readonly id: LinkId;
  readonly kind: LinkKind;
  readonly label: string;
  open: boolean;
  /** Every frame the hub sent on it, with when. */
  readonly sent: { readonly at: Mono; readonly bytes: Uint8Array }[];
  device: ScriptedDevice | undefined;
}

export interface WorldOptions {
  readonly seed?: number;
  readonly rules?: HubRules;
  /** The wall clock at mono 0, in milliseconds since 1970. */
  readonly wallAtStartMs?: number;
  readonly wallTrusted?: boolean;
  /** The core to drive; the real one by default. */
  readonly core?: Core;
  /** The cipher to key devices with; the vector files' devices by default. */
  readonly cipher?: DeviceCipher;
}

/** A snapshot of an empty database: what the first start of a new hub reads. */
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

/** Why a run of the world stopped without finishing: it would otherwise spin for ever. */
export interface WorldStalled {
  readonly kind: "stalled";
  readonly message: string;
}

/**
 * Turns at one instant with no new state, effect or commit before the world gives up: a wake
 * that is never handled (a timer the dispatcher never finds due) would otherwise spin for ever.
 */
export const MAX_TURNS_WITHOUT_PROGRESS = 100;
/** Inputs the shell may make in answer to one input before the world gives up (a ping-pong). */
export const MAX_FOLLOW_UPS = 10_000;

/** A wall clock this world starts at by default: 2026-11-13 00:00 UTC. */
const DEFAULT_WALL_AT_START_MS = Date.UTC(2026, 10, 13);
const DEFAULT_SEED = 1;

export class World {
  readonly core: Core;
  /** The vector cipher, or the one the options gave (a test with more devices than the vectors'). */
  readonly cipher: DeviceCipher;
  readonly writer: RecordingWriter;
  readonly deps: CoreDeps;
  readonly links = new Map<LinkId, FakeLink>();
  /** Every effect the core made, in order. */
  readonly effects: Effect[] = [];
  /** Every fault, with the event that caused it; the state stayed as it was. */
  readonly faults: CoreFault[] = [];
  /** Answers to control requests, in order. */
  readonly replies: { readonly request: RequestId; readonly reply: ControlReply }[] = [];
  state: HubState;
  #mono: Mono = mono(0);
  #wallAtStartMs: number;
  #wallTrusted: boolean;
  readonly #entropy: SeededBytes;
  #nextLink = 1;
  /** Inputs the shell makes itself, handled after the current turn: sendFailed, linkClosed. */
  readonly #pending: HubEvent[] = [];
  /** Set when a run stopped without finishing; every later `advanceTo` reports it. */
  #stalled: WorldStalled | undefined;

  constructor(options: WorldOptions = {}) {
    this.core = options.core ?? makeCore(MODULES);
    const rules = options.rules ?? DEFAULT_RULES;
    this.cipher = options.cipher ?? VectorCipher.fromVectors();
    this.deps = { cipher: this.cipher, rules, calendar: UNBUILT_CALENDAR, deepFreeze: true };
    this.writer = new RecordingWriter(rules.persistence.routineBatchMs);
    this.state = this.core.emptyState();
    this.#entropy = new SeededBytes(options.seed ?? DEFAULT_SEED);
    this.#wallAtStartMs = options.wallAtStartMs ?? DEFAULT_WALL_AT_START_MS;
    this.#wallTrusted = options.wallTrusted ?? true;
  }

  /** The time the next input is stamped with. */
  get now(): Now {
    return {
      mono: this.#mono,
      wall: this.#wallAtStartMs + Math.floor(msBetween(mono(0), this.#mono)),
      wallTrusted: this.#wallTrusted,
    };
  }

  /** Sets the wall clock to read `wallMs` now, as a Pi does when the network sets it (section 5). */
  setWall(wallMs: number, trusted: boolean): void {
    this.#wallAtStartMs = wallMs - Math.floor(msBetween(mono(0), this.#mono));
    this.#wallTrusted = trusted;
  }

  /** The first input of a run. */
  boot(snapshot: DurableSnapshot = emptySnapshot(), id = 1): Result<Stepped, CoreFault> {
    return this.input({
      kind: "boot",
      snapshot,
      boot: { id: bootId(id), previousExit: "unknown", cause: undefined },
    });
  }

  /** One input, then every input the shell makes in answer to its effects; a fault is also kept in `faults`. */
  input(event: HubEvent): Result<Stepped, CoreFault> {
    const result = this.#turn(event);
    let followUps = 0;
    for (let next = this.#pending.shift(); next !== undefined; next = this.#pending.shift()) {
      if (++followUps > MAX_FOLLOW_UPS) {
        this.#pending.length = 0;
        this.#stalled = {
          kind: "stalled",
          message: `more than ${MAX_FOLLOW_UPS} inputs made in answer to one ${event.kind} at mono ${this.#mono}`,
        };
        break;
      }
      const followUp = this.#turn(next);
      if (followUp.isErr()) break;
    }
    return result;
  }

  /** Opens a link, with a device on its far end if given. */
  openLink(kind: LinkKind, label: string, device?: ScriptedDevice): LinkId {
    const id = linkId(this.#nextLink++);
    this.links.set(id, { id, kind, label, open: true, sent: [], device });
    this.#inputKeepingFaults({ kind: "linkOpened", link: id, linkKind: kind, label });
    return id;
  }

  closeLink(link: LinkId, reason: LinkCloseReason = "remote"): void {
    const fake = this.links.get(link);
    if (fake?.open !== true) return;
    fake.open = false;
    this.#inputKeepingFaults({ kind: "linkClosed", link, reason });
  }

  /** A frame from the far end of a link. */
  deliver(link: LinkId, bytes: Uint8Array): Result<Stepped, CoreFault> {
    return this.input({ kind: "frame", link, bytes });
  }

  /** The earliest of the core's wake, the writer's and every device's. */
  nextWake(): Mono | undefined {
    const wakes = [
      this.core.nextDeadline(this.state),
      this.writer.due(),
      ...[...this.links.values()].map((l) => (l.open ? l.device?.nextWake() : undefined)),
    ].filter((wake) => wake !== undefined);
    return wakes.length === 0 ? undefined : mono(Math.min(...wakes));
  }

  /**
   * Runs every wake up to and including `to`, then leaves the clock at `to`. Fails, and stops,
   * when a wake makes no progress: `MAX_TURNS_WITHOUT_PROGRESS` turns at one instant with no new
   * state, effect or commit.
   */
  advanceTo(to: Mono): Result<void, WorldStalled> {
    let stuck = 0;
    for (let wake = this.nextWake(); wake !== undefined && wake <= to; wake = this.nextWake()) {
      if (this.#stalled !== undefined) return err(this.#stalled);
      const before = this.#progressMark();
      this.#mono = mono(Math.max(this.#mono, wake));
      this.#runDue();
      const after = this.#progressMark();
      stuck = before.every((value, i) => value === after[i]) ? stuck + 1 : 0;
      if (stuck >= MAX_TURNS_WITHOUT_PROGRESS) {
        this.#stalled = {
          kind: "stalled",
          message:
            `no progress at mono ${this.#mono} after ${stuck} turns: the wake at ${wake} ` +
            "is never handled, so nothing changes and it stays due",
        };
        return err(this.#stalled);
      }
    }
    if (this.#stalled !== undefined) return err(this.#stalled);
    this.#mono = mono(Math.max(this.#mono, to));
    return ok(undefined);
  }

  advanceByMs(ms: number): Result<void, WorldStalled> {
    return this.advanceTo(monoAfterMs(this.#mono, ms));
  }

  /** What changes when the world makes progress: time, state, effects, commits, frames sent. */
  #progressMark(): readonly unknown[] {
    const sent = [...this.links.values()].reduce((n, link) => n + link.sent.length, 0);
    return [this.#mono, this.state, this.effects.length, this.writer.commits.length, sent];
  }

  /** Everything due now: the writer's flush, the core's timers, each device's own sends. */
  #runDue(): void {
    const writerDue = this.writer.due();
    if (writerDue !== undefined && writerDue <= this.#mono) this.writer.flush(this.#mono);
    const coreDue = this.core.nextDeadline(this.state);
    if (coreDue !== undefined && coreDue <= this.#mono) this.#inputKeepingFaults({ kind: "tick" });
    for (const link of this.links.values()) {
      const deviceDue = link.device?.nextWake();
      if (!link.open || link.device === undefined || deviceDue === undefined) continue;
      if (deviceDue > this.#mono) continue;
      for (const bytes of link.device.wake(this.#mono)) {
        this.#inputKeepingFaults({ kind: "frame", link: link.id, bytes });
      }
    }
  }

  /** An input the world makes itself; a fault goes to `faults` only. */
  #inputKeepingFaults(event: HubEvent): void {
    this.input(event).match(
      () => undefined,
      () => undefined,
    );
  }

  #turn(event: HubEvent): Result<Stepped, CoreFault> {
    const input = { now: this.now, entropy: this.#entropy.bytes(INPUT_ENTROPY_BYTES), event };
    const result = this.core.step(this.state, input, this.deps);
    if (result.isErr()) {
      this.faults.push(result.error);
      return result;
    }
    const { state, effects } = result.value;
    this.state = state;
    this.effects.push(...effects);
    const staged = effects.filter(
      (effect): effect is StagedEffect => effect.kind === "write" || effect.kind === "record",
    );
    if (this.writer.stage(staged, this.#mono)) this.writer.flush(this.#mono);
    for (const effect of effects) this.#perform(effect);
    return result;
  }

  #perform(effect: Effect): void {
    switch (effect.kind) {
      case "write":
      case "record":
      case "advertise":
        return;
      case "cadence":
        this.writer.setCadence(effect.everyMs);
        return;
      case "respond":
        this.replies.push({ request: effect.request, reply: effect.reply });
        return;
      case "close": {
        const link = this.links.get(effect.link);
        if (link?.open !== true) return;
        link.open = false;
        this.#pending.push({ kind: "linkClosed", link: effect.link, reason: "closedByHub" });
        return;
      }
      case "send": {
        const link = this.links.get(effect.link);
        const durable = effect.counters.every(
          (use) => use.counter < (this.writer.durable(use.device) ?? 0),
        );
        if (link?.open !== true || !durable) {
          const error = link?.open === true ? "notDurable" : "closed";
          this.#pending.push({ kind: "sendFailed", link: effect.link, ref: effect.ref, error });
          return;
        }
        link.sent.push({ at: this.#mono, bytes: effect.bytes });
        for (const answer of link.device?.receive(effect.bytes, this.#mono) ?? []) {
          this.#pending.push({ kind: "frame", link: link.id, bytes: answer });
        }
        return;
      }
    }
  }
}

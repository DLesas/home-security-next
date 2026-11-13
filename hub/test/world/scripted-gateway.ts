/**
 * A scripted gateway on `@hsn/protocol` (hub-design.md section 11): it speaks the gateway's side
 * of protocol.md §6 and §7 to the hub. It sends a hello with a fresh random, takes the welcome
 * and its settings, answers the settings with Started (firmware-design.md section 7), forwards
 * device packets stamped with its own microsecond clock (which may drift), and answers transmit
 * requests through a modelled radio: one transmission at a time, a few places for waiting
 * requests, and the 20 ms rule for requests at a given time (a moment already past included).
 */
import { Result } from "neverthrow";
import {
  checkStrictlyHigher,
  Direction,
  isEnumValue,
  MaxPacketLength,
  type Message,
  MessageType,
  type MessageOf,
  NO_BINDING,
  openPacket,
  sealPacket,
  sessionBinding,
  spreadingFactor,
  timeOnAirMs,
  TransmitResultCode,
  TransmitWhen,
  welcomeBinding,
} from "@hsn/protocol";
import { type Mono, mono, MICROS_PER_MILLISECOND } from "../../src/core/model/time.ts";
import type { ScriptedDevice } from "./world.ts";

/** A transmit request for a given time may start at most this late (§6, 20 ms †). */
export const TOO_LATE_MS = 20;
/** How many requests the radio holds while they wait (§6: "only a few") ‡, for the model. */
export const DEFAULT_RADIO_PLACES = 4;
/** The gateway's microsecond clock is 32 bits on the wire (§6). */
const GATEWAY_CLOCK_WRAP = 2 ** 32;
const RESET_CAUSE_POWER_ON = 1;

type Fields<T extends MessageType> = Omit<MessageOf<T>, "type">;

export interface ScriptedGatewayOptions {
  readonly key: Uint8Array;
  readonly address: number;
  /** A new 8-byte random for each hello. */
  readonly nextRandom: () => Uint8Array;
  readonly firmware?: { readonly major: number; readonly minor: number; readonly patch: number };
  readonly settingsVersion?: number;
  /** The reset cause its Started reports. */
  readonly resetCause?: number;
  /** Its clock's reading at hub mono 0, in microseconds. */
  readonly clockOffsetMicros?: number;
  /** How fast its clock runs against the hub's: 0.0001 is 100 ppm fast. */
  readonly drift?: number;
  readonly radioPlaces?: number;
}

/** A packet the radio sent, on the gateway's clock. */
export interface Transmission {
  readonly startMicros: number;
  readonly packet: Uint8Array;
  readonly dataRate: number;
  readonly powerDbm: number;
}

interface PendingResult {
  /** When the result is due, on the gateway's unwrapped clock. */
  readonly atMicros: number;
  readonly requestCounter: number;
  readonly result: number;
  readonly sentAtMicros: number;
}

const seal = Result.fromThrowable(sealPacket, (error) =>
  error instanceof Error ? error.message : "seal failed",
);

export class ScriptedGateway implements ScriptedDevice {
  readonly transmissions: Transmission[] = [];
  /** The settings the hub last sent. */
  settings: Fields<typeof MessageType.GatewaySettings> | undefined;
  readonly #options: ScriptedGatewayOptions;
  #counter = 1;
  #gatewayRandom: Uint8Array | undefined;
  #session: Uint8Array | undefined;
  #lastHubCounter = 0;
  #busyUntilMicros = 0;
  #results: PendingResult[] = [];

  constructor(options: ScriptedGatewayOptions) {
    this.#options = options;
  }

  /** Its clock at hub time `at`, unwrapped. */
  clockMicros(at: Mono): number {
    const { clockOffsetMicros = 0, drift = 0 } = this.#options;
    return Math.floor(clockOffsetMicros + at * (1 + drift));
  }

  /** The hub time its clock reads `micros` (unwrapped). */
  hubTimeAt(micros: number): Mono {
    const { clockOffsetMicros = 0, drift = 0 } = this.#options;
    return mono(Math.ceil((micros - clockOffsetMicros) / (1 + drift)));
  }

  get session(): Uint8Array | undefined {
    return this.#session;
  }

  /** A hello on a new connection, with a fresh random (§7, "Gateway connection"). */
  hello(): Uint8Array | undefined {
    this.#gatewayRandom = this.#options.nextRandom();
    this.#session = undefined;
    this.#lastHubCounter = 0;
    return this.#seal(
      {
        type: MessageType.Hello,
        gatewayRandom: this.#gatewayRandom,
        firmwareVersion: this.#options.firmware ?? { major: 1, minor: 0, patch: 0 },
        settingsVersion: this.#options.settingsVersion ?? 0,
      },
      NO_BINDING,
    );
  }

  /** A device packet heard on the radio, ending at hub time `endedAt`. */
  forward(
    packet: Uint8Array,
    radio: {
      readonly endedAt: Mono;
      readonly rssiDbm: number;
      readonly snrQuarterDb: number;
      readonly dataRate: number;
      readonly siteChannel: number;
    },
  ): Uint8Array | undefined {
    return this.#sealOnSession({
      type: MessageType.ForwardedPacket,
      receivedAtMicros: this.clockMicros(radio.endedAt) % GATEWAY_CLOCK_WRAP,
      rssiDbm: radio.rssiDbm,
      snrQuarterDb: radio.snrQuarterDb,
      dataRate: radio.dataRate,
      siteChannel: radio.siteChannel,
      packet,
    });
  }

  /** A status (§6), on the session. */
  status(fields: Fields<typeof MessageType.GatewayStatus>): Uint8Array | undefined {
    return this.#sealOnSession({ type: MessageType.GatewayStatus, ...fields });
  }

  nextWake(): Mono | undefined {
    const first = this.#results[0];
    return first === undefined ? undefined : this.hubTimeAt(first.atMicros);
  }

  /** The transmit results due by `now`. */
  wake(now: Mono): readonly Uint8Array[] {
    const nowMicros = this.clockMicros(now);
    const due = this.#results.filter((r) => r.atMicros <= nowMicros);
    this.#results = this.#results.filter((r) => r.atMicros > nowMicros);
    return due.flatMap((r) => this.#resultPacket(r) ?? []);
  }

  receive(bytes: Uint8Array, now: Mono): readonly Uint8Array[] {
    const message = this.#open(bytes);
    if (message === undefined) return [];
    switch (message.type) {
      case MessageType.Welcome:
        if (this.#gatewayRandom === undefined || this.#session !== undefined) return [];
        this.#session = sessionBinding(this.#gatewayRandom, message.hubRandom);
        return [];
      case MessageType.GatewaySettings: {
        const settings: Fields<typeof MessageType.GatewaySettings> = message;
        this.settings = settings;
        const started = this.#sealOnSession({
          type: MessageType.Started,
          role: 3,
          firmwareVersion: this.#options.firmware ?? { major: 1, minor: 0, patch: 0 },
          resetCause: this.#options.resetCause ?? RESET_CAUSE_POWER_ON,
          lastFatalError: 0,
          settingsVersion: settings.settingsVersion,
        });
        return started === undefined ? [] : [started];
      }
      case MessageType.TransmitRequest:
        return this.#transmit(message, this.#lastHubCounter, now);
      default:
        return [];
    }
  }

  /** Opens a packet from the hub: the welcome by its hello's random, the rest by the session. */
  #open(bytes: Uint8Array): Message | undefined {
    const binding =
      this.#session ??
      (this.#gatewayRandom === undefined ? undefined : welcomeBinding(this.#gatewayRandom));
    if (binding === undefined) return undefined;
    const opened = openPacket(bytes, {
      key: this.#options.key,
      expectedDirection: Direction.FromHub,
      binding,
      maxLength: MaxPacketLength.Link,
    });
    if (!opened.ok || opened.value.header.address !== this.#options.address) return undefined;
    const check = checkStrictlyHigher(this.#lastHubCounter, opened.value.header.counter);
    if (!check.accepted) return undefined;
    this.#lastHubCounter = check.state;
    return opened.value.message;
  }

  /** The radio model: one transmission at a time, a few waiting places, the 20 ms rule. */
  #transmit(
    request: MessageOf<typeof MessageType.TransmitRequest>,
    requestCounter: number,
    now: Mono,
  ): readonly Uint8Array[] {
    const nowMicros = this.clockMicros(now);
    const answer = (result: number, atMicros: number, sentAtMicros = 0): readonly Uint8Array[] => {
      this.#results.push({ atMicros, requestCounter, result, sentAtMicros });
      this.#results.sort((a, b) => a.atMicros - b.atMicros);
      return atMicros <= nowMicros ? this.wake(now) : [];
    };
    const sf = spreadingFactor(request.dataRate);
    if (sf === undefined || !isEnumValue(TransmitWhen, request.when)) {
      return answer(TransmitResultCode.NotValid, nowMicros);
    }
    const waiting = this.#results.filter((r) => r.atMicros > nowMicros).length;
    if (waiting >= (this.#options.radioPlaces ?? DEFAULT_RADIO_PLACES)) {
      return answer(TransmitResultCode.RadioBusy, nowMicros);
    }
    const tooLateMicros = TOO_LATE_MS * MICROS_PER_MILLISECOND;
    const airtimeMicros = Math.ceil(
      timeOnAirMs(sf, request.packet.length) * MICROS_PER_MILLISECOND,
    );
    if (request.when === TransmitWhen.AtTime) {
      const wanted = unwrapNear(request.gatewayTimeMicros, nowMicros);
      // A moment already past starts now, if that is within the 20 ms; the radio cannot go back.
      const start = Math.max(wanted, this.#busyUntilMicros, nowMicros);
      if (start - wanted > tooLateMicros) return answer(TransmitResultCode.TooLate, start);
      return this.#send(request, start, airtimeMicros, answer);
    }
    const start = Math.max(nowMicros, this.#busyUntilMicros);
    const latest =
      request.gatewayTimeMicros === 0
        ? undefined
        : unwrapNear(request.gatewayTimeMicros, nowMicros);
    if (latest !== undefined && start > latest) return answer(TransmitResultCode.TooLate, start);
    return this.#send(request, start, airtimeMicros, answer);
  }

  #send(
    request: MessageOf<typeof MessageType.TransmitRequest>,
    start: number,
    airtimeMicros: number,
    answer: (result: number, atMicros: number, sentAtMicros: number) => readonly Uint8Array[],
  ): readonly Uint8Array[] {
    this.#busyUntilMicros = start + airtimeMicros;
    this.transmissions.push({
      startMicros: start,
      packet: request.packet,
      dataRate: request.dataRate,
      powerDbm: request.powerDbm,
    });
    return answer(TransmitResultCode.Sent, start, start % GATEWAY_CLOCK_WRAP);
  }

  #resultPacket(result: PendingResult): Uint8Array | undefined {
    return this.#sealOnSession({
      type: MessageType.TransmitResult,
      requestCounter: result.requestCounter,
      result: result.result,
      sentAtMicros: result.sentAtMicros,
    });
  }

  #sealOnSession(message: Message): Uint8Array | undefined {
    return this.#session === undefined ? undefined : this.#seal(message, this.#session);
  }

  #seal(message: Message, binding: Uint8Array): Uint8Array | undefined {
    const counter = this.#counter++;
    return seal(message, {
      key: this.#options.key,
      direction: Direction.ToHub,
      address: this.#options.address,
      counter,
      binding,
      maxLength: MaxPacketLength.Link,
    }).unwrapOr(undefined);
  }
}

/** The unwrapped time nearest `reference` whose low 32 bits are `wrapped`. */
function unwrapNear(wrapped: number, reference: number): number {
  const half = GATEWAY_CLOCK_WRAP / 2;
  const difference =
    ((((wrapped - (reference % GATEWAY_CLOCK_WRAP)) % GATEWAY_CLOCK_WRAP) +
      GATEWAY_CLOCK_WRAP +
      half) %
      GATEWAY_CLOCK_WRAP) -
    half;
  return reference + difference;
}

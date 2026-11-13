/**
 * A scripted door sensor on `@hsn/protocol` (hub-design.md section 11), behaving as the
 * firmware's sensor role does (`firmware/roles/sensor/`: replies.cpp, heartbeat.cpp,
 * data_rates.cpp, reports.cpp): it sends Started when it starts, heartbeats in the hub's slot or
 * at its interval ±10% on a sleep clock that runs fast or slow, a link check every Nth and on every
 * heartbeat while a reply was missed or next settings are held, door reports at once with their
 * age and retries about 2, 5 and 10 s after the change then every 60 s for 10 minutes, each with
 * a random extra wait; flag bit 5 after its local alarm and bit 7 after two missed replies; and it
 * follows a site move: when a reply-wanted packet goes unanswered while next settings are held,
 * its following packet goes on the other settings, and a reply to one sent on the next settings
 * makes them current. A packet from the hub is taken only while it listens, at the rate it
 * listens at, bound to one of its 16 latest counters (§4).
 *
 * It is a radio device, not a link: a `RadioSite` in a scenario carries its packets to and from a
 * gateway. Times are the World's (`Mono`, true time); the sensor's own clock runs `1 + drift`
 * times as fast, so a sleep of D on it lasts D ÷ (1 + drift).
 */
import {
  counterBinding,
  Direction,
  MaxPacketLength,
  type Message,
  MessageType,
  NEXT_SETTING_UNCHANGED,
  NO_BINDING,
  openPacket,
  sealPacket,
  spreadingFactor,
  timeOnAirMs,
} from "@hsn/protocol";
import { type Mono, mono } from "../../src/core/model/time.ts";

/** A true time, rounded to the microsecond. */
function instant(micros: number): Mono {
  return mono(Math.round(micros));
}

/** Microseconds in a second and a millisecond. */
const S = 1_000_000;
const MS = 1000;
/** The heartbeat reply moment, 1 s † (§8); the listening margin, 20 ms early, 50 ms + 8 symbols late † (§8). */
const REPLY_MOMENT_US = S;
const EARLY_US = 20 * MS;
const LATE_US = 50 * MS;
const LATE_SYMBOLS = 8;
/** Event listen time by rate, DR0 to DR5 (§8 †, `kEventListenMs`). */
const EVENT_LISTEN_MS = [3000, 2600, 2200, 1900, 1700, 1500] as const;
/** The retry table of §7: about 2, 5, 10 s after the change, then every 60 s, for 10 minutes. */
const FIRST_RETRIES_S = [2, 5, 10] as const;
const LAST_FIRST_RETRY_S = 10;
const RETRY_EVERY_S = 60;
const RETRY_FOR_S = 600;
/** Two unanswered reply-wanted packets in a row: listen at the sending rate, lose the slot (§7). */
const MISSES_BEFORE_OWN_RATE = 2;
/** The defaults before the hub gives settings (firmware `sensor_constants.hpp`). */
const DEFAULT_UNITS = 12;
const DEFAULT_LINK_CHECK = 5;
const DEFAULT_COUNTDOWN_S = 30;
/** Unslotted heartbeats move by up to 10% either way (§7). */
const JITTER = 0.1;
/** The sensor keeps its 16 latest counters for bindings (§4). */
const KEPT_COUNTERS = 16;
/** 10 ppm per unit of the reply's correction (§6). */
const PPM_PER_UNIT = 10;
/** Sensors save a resume point every 64 packets (§4); after pairing they start from one step. */
const SENSOR_STEP = 64;

/** One packet on the air. */
export interface Transmission {
  readonly packet: Uint8Array;
  readonly dataRate: number;
  readonly channel: number;
  readonly start: Mono;
  readonly end: Mono;
}

export interface ScriptedSensorOptions {
  readonly key: Uint8Array;
  readonly address: number;
  /** The pairing's site channel and its one allowed rate (§9). */
  readonly channel: number;
  readonly rate: number;
  /** Its sleep clock runs this much fast: 0.03 is 3% fast, −0.03 3% slow. */
  readonly drift?: number;
  /** Random numbers from 0 to 1, seeded by the scenario. */
  readonly random: () => number;
  /** When it starts and sends Started. */
  readonly startAt: Mono;
  /** The settings version it holds at start: 0, none (§6). */
  readonly version?: number;
  readonly armed?: boolean;
}

type Kind = "heartbeat" | "door" | "started";

/** Settings as the latest reply gave them (§6). */
interface Held {
  readonly version: number;
  readonly countdownS: number;
  readonly units: number;
  readonly linkCheckEvery: number;
  readonly sendRate: number;
  readonly replyRate: number;
  readonly correctionUnits: number;
}

/** A report waiting for its reply: Started or the door, with its run of tries (§7). */
interface Exchange {
  readonly kind: "door" | "started";
  /** When the change happened, for the age and the retry table. */
  readonly origin: Mono;
  attempt: number;
  next: Mono | undefined;
}

export class ScriptedSensor {
  readonly options: ScriptedSensorOptions;
  /** What it sent, in order. */
  readonly sent: (Transmission & {
    readonly kind: Kind;
    readonly counter: number;
    readonly onNext: boolean;
  })[] = [];
  /** Replies it took, with when. */
  readonly replies: {
    readonly at: Mono;
    readonly answered: number;
    readonly reply: Extract<Message, { type: typeof MessageType.Reply }>;
  }[] = [];
  /** Disarmed notices it took. */
  readonly notices: Mono[] = [];
  held: Held;
  armed: boolean;
  buzzing = false;
  channel: number;
  /** The site move's next settings it holds, if any (§7, "Changing the site's channel or rate"). */
  next: { readonly channel: number | undefined; readonly rate: number | undefined } | undefined;
  doorOpen = false;
  changeCount = 0;
  misses = 0;
  listenAtSendRate = false;
  slotted = false;
  localAlarmSounded = false;
  #counter = SENSOR_STEP;
  #started = false;
  #planned: Mono;
  #heartbeatsSinceCheck = 0;
  /** The packet whose reply is being listened for, and the window. */
  #listening:
    | {
        readonly counter: number;
        readonly kind: Kind;
        readonly from: Mono;
        readonly until: Mono;
        readonly wanted: boolean;
        readonly end: Mono;
        readonly onNext: boolean;
      }
    | undefined;
  #exchange: Exchange | undefined;
  #kept: {
    readonly counter: number;
    readonly kind: Kind;
    readonly end: Mono;
    readonly onNext: boolean;
  }[] = [];
  /** After a miss with next settings held, the following packet goes on the other settings. */
  #useNext = false;
  readonly #doorScript: { at: Mono; open: boolean }[] = [];
  #countdownUntil: Mono | undefined;

  constructor(options: ScriptedSensorOptions) {
    this.options = options;
    this.held = {
      version: options.version ?? 0,
      countdownS: DEFAULT_COUNTDOWN_S,
      units: DEFAULT_UNITS,
      linkCheckEvery: DEFAULT_LINK_CHECK,
      sendRate: options.rate,
      replyRate: options.rate,
      correctionUnits: 0,
    };
    this.armed = options.armed ?? false;
    this.channel = options.channel;
    this.next = undefined;
    this.#planned = options.startAt;
  }

  /** The door opens or closes at `at` (in true time). */
  door(at: Mono, open: boolean): void {
    this.#doorScript.push({ at, open });
    this.#doorScript.sort((a, b) => a.at - b.at);
  }

  /** The heartbeat interval at its rate (§7: at least 3 minutes at SF11, 5 at SF12), in true µs. */
  intervalUs(): number {
    return this.#trueUs(this.#nominalIntervalUs());
  }

  #nominalIntervalUs(): number {
    const units = this.held.units === 0 ? DEFAULT_UNITS : this.held.units;
    const floor = this.held.sendRate === 0 ? 300 * S : this.held.sendRate === 1 ? 180 * S : 0;
    return Math.max(units * 15 * S, floor);
  }

  /** A nominal duration as the sensor sleeps it: scaled by its correction on its own clock, in true µs. */
  #trueUs(nominalUs: number): number {
    const corrected = nominalUs * (1 + (this.held.correctionUnits * PPM_PER_UNIT) / 1e6);
    return corrected / (1 + (this.options.drift ?? 0));
  }

  nextWake(): Mono | undefined {
    // A report waits while a reply window is open: it goes when the window closes, not before.
    const report = this.#exchange?.next;
    const listening = this.#listening?.until;
    const times = [
      this.#started ? this.#planned : this.options.startAt,
      listening,
      report === undefined || listening === undefined ? report : Math.max(report, listening),
      this.#doorScript[0]?.at,
    ].filter((t): t is Mono => t !== undefined);
    return times.length === 0 ? undefined : instant(Math.min(...times));
  }

  /** Runs what is due at `now`; returns the packets it starts sending now. */
  wake(now: Mono): readonly Transmission[] {
    const out: Transmission[] = [];
    if (!this.#started && now >= this.options.startAt) {
      this.#started = true;
      this.#planned = instant(now + this.#jittered());
      this.#exchange = { kind: "started", origin: now, attempt: 0, next: now };
    }
    while (this.#doorScript[0] !== undefined && this.#doorScript[0].at <= now) {
      const change = this.#doorScript.shift();
      if (change === undefined || change.open === this.doorOpen) continue;
      this.doorOpen = change.open;
      this.changeCount = (this.changeCount + 1) % 256;
      // A new change: the run counts again from it, the newest state goes (§7, DS3).
      this.#exchange = { kind: "door", origin: change.at, attempt: 0, next: now };
    }
    if (this.#listening !== undefined && now >= this.#listening.until) this.#windowClosed();
    if (
      this.#listening === undefined &&
      this.#exchange?.next !== undefined &&
      now >= this.#exchange.next
    ) {
      out.push(this.#sendReport(now, this.#exchange));
    } else if (this.#started && now >= this.#planned) {
      const due = this.#planned;
      this.#planned = instant(
        this.slotted ? Math.max(due + this.intervalUs(), now + 1) : now + this.#jittered(),
      );
      // A report in flight already tells the hub everything a heartbeat would.
      if (this.#listening === undefined && this.#exchange === undefined)
        out.push(this.#sendHeartbeat(now));
    }
    return out;
  }

  #jittered(): number {
    return this.intervalUs() * (1 + JITTER * (2 * this.options.random() - 1));
  }

  /** Flag bit 7: it listens at its sending rate, with no settings yet or after two misses (§6). */
  #atSendRate(): boolean {
    return this.held.version === 0 || this.listenAtSendRate;
  }

  #listenRate(onNext: boolean): number {
    const sendRate = onNext ? (this.next?.rate ?? this.held.sendRate) : this.held.sendRate;
    return this.#atSendRate() || onNext ? sendRate : this.held.replyRate;
  }

  #status(type: 1 | 2, replyWanted: boolean, age: number): Message {
    return {
      type,
      settingsVersion: this.held.version,
      flags: {
        doorOpen: this.doorOpen,
        coverOpen: false,
        usbPower: false,
        charging: false,
        replyWanted,
        localAlarmSounded: this.localAlarmSounded,
        buzzing: this.buzzing,
        listeningAtSendRate: this.#atSendRate() || this.#useNext,
      },
      batteryCode: 120,
      temperatureCelsius: 20,
      doorChangeCount: this.changeCount,
      eventAgeSeconds: age,
    };
  }

  #send(now: Mono, kind: Kind, message: Message, wanted: boolean): Transmission {
    const onNext = this.#useNext && this.next !== undefined;
    const counter = this.#counter++;
    const packet = sealPacket(message, {
      key: this.options.key,
      direction: Direction.ToHub,
      address: this.options.address,
      counter,
      binding: NO_BINDING,
      maxLength: MaxPacketLength.Radio,
    });
    const rate = onNext ? (this.next?.rate ?? this.held.sendRate) : this.held.sendRate;
    const channel = onNext ? (this.next?.channel ?? this.channel) : this.channel;
    const end = instant(
      now + Math.ceil(timeOnAirMs(spreadingFactor(rate) ?? 7, packet.length) * MS),
    );
    const sent = { packet, dataRate: rate, channel, start: now, end };
    this.sent.push({ ...sent, kind, counter, onNext });
    this.#kept = [
      ...this.#kept.filter((k) => !(kind === "heartbeat" && k.kind === "heartbeat")),
      { counter, kind, end, onNext },
    ].slice(-KEPT_COUNTERS);
    const listenRate = this.#listenRate(onNext);
    if (kind === "heartbeat") {
      const moment = end + this.#trueUs(REPLY_MOMENT_US);
      const late = LATE_US + LATE_SYMBOLS * symbolUs(listenRate);
      this.#listening = {
        counter,
        kind,
        from: instant(moment - EARLY_US),
        until: instant(moment + late),
        wanted,
        end,
        onNext,
      };
    } else {
      const listen = (EVENT_LISTEN_MS[rate] ?? 1500) * MS;
      this.#listening = {
        counter,
        kind,
        from: end,
        until: instant(end + listen),
        wanted,
        end,
        onNext,
      };
    }
    return sent;
  }

  #sendHeartbeat(now: Mono): Transmission {
    this.#heartbeatsSinceCheck += 1;
    const every = this.held.linkCheckEvery === 0 ? DEFAULT_LINK_CHECK : this.held.linkCheckEvery;
    // Every Nth asks; every one does after a miss or while next settings are held (§7).
    const wanted =
      this.#heartbeatsSinceCheck >= every || this.misses > 0 || this.next !== undefined;
    if (wanted) this.#heartbeatsSinceCheck = 0;
    return this.#send(now, "heartbeat", this.#status(MessageType.Heartbeat, wanted, 0), wanted);
  }

  #sendReport(now: Mono, exchange: Exchange): Transmission {
    exchange.next = undefined;
    if (exchange.kind === "started") {
      return this.#send(
        now,
        "started",
        {
          type: MessageType.Started,
          role: 1,
          firmwareVersion: { major: 1, minor: 0, patch: 0 },
          resetCause: 1,
          lastFatalError: 0,
          settingsVersion: this.held.version,
        },
        true,
      );
    }
    const age = Math.floor((now - exchange.origin) / S);
    return this.#send(now, "door", this.#status(MessageType.DoorChanged, true, age), true);
  }

  /** The window ended with no reply: a miss, and for a report its next try (§7). */
  #windowClosed(): void {
    const listening = this.#listening;
    this.#listening = undefined;
    if (listening?.wanted !== true) return;
    this.misses += 1;
    if (this.misses >= MISSES_BEFORE_OWN_RATE) {
      this.listenAtSendRate = true;
      this.slotted = false;
    }
    // Holding next settings: the following packet goes on the other settings (§7).
    if (this.next !== undefined) this.#useNext = !listening.onNext;
    if (
      listening.kind === "door" &&
      this.#exchange?.kind === "door" &&
      this.#exchange.attempt === 0 &&
      this.armed
    ) {
      // The first unanswered try of an armed opening: the local alarm (DS6); bit 5 tells the hub.
      this.localAlarmSounded = true;
    }
    const exchange = this.#exchange;
    if (exchange === undefined || listening.kind === "heartbeat") return;
    exchange.attempt += 1;
    exchange.next = this.#retryAt(exchange, listening.until);
    if (exchange.next === undefined) this.#exchange = undefined;
  }

  /**
   * The try after `attempt` unanswered ones (§7): 2, 5, 10 s after the change, then every 60 s, each
   * plus a random extra wait of up to half the gap before it, never before the last listening
   * ended; none past 10 minutes.
   */
  #retryAt(exchange: Exchange, notBefore: Mono): Mono | undefined {
    const offsetS = (attempt: number): number =>
      attempt <= 0
        ? 0
        : (FIRST_RETRIES_S[attempt - 1] ??
          LAST_FIRST_RETRY_S + RETRY_EVERY_S * (attempt - FIRST_RETRIES_S.length));
    const offset = offsetS(exchange.attempt);
    if (offset > RETRY_FOR_S) return undefined;
    const gap = offset - offsetS(exchange.attempt - 1);
    const at = exchange.origin + (offset + (gap / 2) * this.options.random()) * S;
    return instant(Math.max(at, notBefore));
  }

  /** A packet from the hub on 869.525 MHz, starting at `start`, at `rate`. */
  hear(packet: Uint8Array, rate: number, start: Mono): void {
    const listening = this.#listening;
    const window = listening !== undefined && start >= listening.from && start <= listening.until;
    const buzzingNow = this.#countdownUntil !== undefined && start <= this.#countdownUntil;
    if (!window && !buzzingNow) return;
    if (listening !== undefined && window && rate !== this.#listenRate(listening.onNext)) return;
    for (const kept of this.#kept.toSorted((a, b) => b.counter - a.counter)) {
      const opened = openPacket(packet, {
        key: this.options.key,
        expectedDirection: Direction.FromHub,
        binding: counterBinding(kept.counter),
        maxLength: MaxPacketLength.Radio,
      });
      if (!opened.ok) continue;
      const message = opened.value.message;
      if (message.type === MessageType.DisarmedNotice) {
        this.notices.push(start);
        this.buzzing = false;
        this.#countdownUntil = undefined;
        this.armed = false;
        return;
      }
      if (message.type !== MessageType.Reply) return;
      this.#onReply(message, kept, start);
      return;
    }
  }

  #onReply(
    reply: Extract<Message, { type: typeof MessageType.Reply }>,
    answered: {
      readonly counter: number;
      readonly kind: Kind;
      readonly end: Mono;
      readonly onNext: boolean;
    },
    at: Mono,
  ): void {
    this.replies.push({ at, answered: answered.counter, reply });
    if (this.#listening?.counter === answered.counter) this.#listening = undefined;
    // A reply to a packet sent on the next settings makes them current, for good (§7).
    if (answered.onNext && this.next !== undefined) {
      this.channel = this.next.channel ?? this.channel;
      this.next = undefined;
    }
    const announced =
      reply.nextSiteChannel === NEXT_SETTING_UNCHANGED &&
      reply.nextSendDataRate === NEXT_SETTING_UNCHANGED
        ? undefined
        : {
            channel:
              reply.nextSiteChannel === NEXT_SETTING_UNCHANGED ? undefined : reply.nextSiteChannel,
            rate:
              reply.nextSendDataRate === NEXT_SETTING_UNCHANGED
                ? undefined
                : reply.nextSendDataRate,
          };
    // A reply announcing nothing clears next settings; one announcing them keeps them (§7).
    this.next = announced;
    this.#useNext = false;
    this.held = {
      version: reply.settingsVersion,
      countdownS: reply.countdownSeconds,
      units: reply.heartbeatIntervalUnits,
      linkCheckEvery: reply.linkCheckEvery,
      sendRate: reply.sendDataRate,
      replyRate: reply.replyDataRate,
      correctionUnits: reply.clockCorrectionTenPpm,
    };
    this.armed = reply.flags.armed;
    this.misses = 0;
    this.listenAtSendRate = false;
    // Bit 5 is cleared by a reply to a packet that carried it, or a later one (§6).
    this.localAlarmSounded = false;
    if (reply.nextHeartbeatTenths !== 0) {
      // Counted from the end of the packet it answers (§6), on the sensor's corrected clock.
      this.#planned = instant(answered.end + this.#trueUs(reply.nextHeartbeatTenths * 100 * MS));
      this.slotted = true;
    }
    if (answered.kind !== "heartbeat" && this.#exchange?.kind === answered.kind)
      this.#exchange = undefined;
    if (reply.flags.armed && reply.flags.countdownStarted) {
      this.buzzing = true;
      this.#countdownUntil = instant(at + reply.countdownRemainingSeconds * S);
    } else if (!reply.flags.armed) {
      this.buzzing = false;
      this.#countdownUntil = undefined;
    }
  }

  /** The heartbeat it plans next, in true time. */
  get planned(): Mono {
    return this.#planned;
  }
}

/** One LoRa symbol at a rate: 2^SF ÷ 125 kHz (§2), in µs. */
function symbolUs(rate: number): number {
  return (2 ** (spreadingFactor(rate) ?? 7) * S) / 125_000;
}

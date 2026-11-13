/**
 * A scripted siren on `@hsn/protocol` (hub-design.md section 11), behaving as the firmware's siren
 * role does (firmware/roles/siren/): it takes commands and settings on either path under the
 * strictly-higher counter rule, answers each new one and an exact repeat of the latest on the path
 * it came by, and an older counter not at all (§4, §7 "Siren command"); it sounds for the
 * command's seconds capped by its longest sound and stops by itself (SR5); it reports every Wi-Fi
 * interval on Wi-Fi, on LoRa at once when Wi-Fi is down (reason 3) and every LoRa check interval
 * (reason 2), pacing those two to 200 × a report's airtime at its sending rate (§7 "Siren
 * reports"); a report of a change (sounder stopped, Wi-Fi gone) is never paced; it restarts after a
 * power-on silent, after a reset still sounding (D80), and sends Started on Wi-Fi, or on LoRa after
 * 30 s without it.
 *
 * It has two faces, one per path: `wifi` sits on the far end of its WebSocket link, `lora` on the
 * far end of a link that stands for the radio. Times are the World's `Mono` plus `clockOffset`, so
 * a siren can carry on across a hub restart, which starts a new World at mono 0.
 *
 * One difference from today's firmware: the firmware's `apply_settings` does not take the site
 * channel of D115 yet; this siren does, as protocol.md §6 says ("from its next transmission on").
 */
import {
  checkStrictlyHigher,
  DataRate,
  Direction,
  isEnumValue,
  MaxPacketLength,
  type Message,
  MessageType,
  type MessageOf,
  NO_BINDING,
  openPacket,
  ResumeStep,
  resumeSendCounter,
  sealPacket,
  type SendCounter,
  SirenAction,
  SirenReportReason,
  SirenState,
  spreadingFactor,
  takeSendCounter,
  timeOnAirMs,
} from "@hsn/protocol";
import { type Mono, mono } from "../../src/core/model/time.ts";
import type { ScriptedDevice } from "./world.ts";

const SECOND = 1_000_000;
/** Settings until the hub sends some (firmware siren_constants.hpp; §6, D40). */
const DEFAULT_WIFI_REPORT_S = 30;
const DEFAULT_LORA_CHECK_UNITS = 20;
const DEFAULT_MAX_SOUND_S = 300;
const FIFTEEN_SECONDS = 15;
/** Started goes on LoRa when Wi-Fi is not up this long after a start (kStartedLoraAfter). */
const STARTED_LORA_AFTER = 30 * SECOND;
/** Routine LoRa reports are paced to half the site channel's hourly 1 %: 200 × airtime (§2, §7). */
const PACE_AIRTIMES = 200;
/** A report packet: 9 clear bytes, type, a 10-byte body, the 8-byte tag (§3, §6). */
const REPORT_PACKET_BYTES = 28;
const RESET_CAUSE = { powerOn: 1, softwareReset: 3 } as const;
const COUNTER_LOW = 0xffff;

export interface SirenHeld {
  readonly version: number;
  readonly wifiIntervalS: number;
  readonly loraCheckUnits: number;
  readonly maxSoundS: number;
  readonly sendRate: number;
  readonly commandRate: number;
  readonly siteChannel: number;
}

export interface ScriptedSirenOptions {
  readonly key: Uint8Array;
  readonly address: number;
  /** The saved resume point it starts from; a just-paired siren's is 1,024 (§4). */
  readonly resumePoint?: number;
  readonly settings?: Partial<SirenHeld>;
  /** Whether its WebSocket is up at the start. */
  readonly wifiUp?: boolean;
  /** Where in each interval its timers first fire, 0 to 1 (§7: "a random point"). */
  readonly phase?: number;
}

/** A report it sent, for the tests. */
export interface SentReport {
  readonly at: Mono;
  readonly path: "wifi" | "lora";
  readonly fields: MessageOf<typeof MessageType.SirenReport>;
}

/** A hub packet it acted on. */
export interface Acted {
  readonly at: Mono;
  readonly path: "wifi" | "lora";
  readonly counter: number;
  readonly message: Message;
}

type LoraItem = "answer" | "started" | "change" | "check" | "wifiFailed";
/** Most urgent first; the last two are paced (firmware kLoraOrder). */
const LORA_ORDER: readonly LoraItem[] = ["answer", "started", "change", "check", "wifiFailed"];

export class ScriptedSiren {
  readonly reports: SentReport[] = [];
  readonly acted: Acted[] = [];
  /** Every hub packet it heard, by path, before any check. */
  readonly heard: { readonly at: Mono; readonly path: "wifi" | "lora" }[] = [];
  /** A deaf siren hears no hub packet, as with a broken receiver; it still reports. */
  deaf = false;
  /** Microseconds of its own clock at World mono 0. */
  clockOffset = 0;
  readonly #options: ScriptedSirenOptions;
  held: SirenHeld;
  #counter: SendCounter;
  #savedResume: number;
  #lastCommand = 0;
  output: number = SirenState.Off;
  #stopAt: number | undefined;
  wifiUp: boolean;
  #startedPending = true;
  #startedLoraAt: number | undefined;
  #reportAt: number;
  #checkAt: number;
  #lastRoutine = Number.NEGATIVE_INFINITY;
  #lora = new Set<LoraItem>();
  #wifiOut: Uint8Array[] = [];
  #loraOut: Uint8Array[] = [];
  #resetCause: number = RESET_CAUSE.powerOn;
  /** Its clock at the latest event. */
  #lastLocal = 0;

  readonly wifi: ScriptedDevice = {
    nextWake: () => this.#nextWake(this.#wifiOut),
    wake: (now) => this.#wake(now, "wifi"),
    receive: (bytes, now) => this.#receive(bytes, now, "wifi"),
  };

  readonly lora: ScriptedDevice = {
    nextWake: () => this.#nextWake(this.#loraOut),
    wake: (now) => this.#wake(now, "lora"),
    receive: (bytes, now) => this.#receive(bytes, now, "lora"),
  };

  constructor(options: ScriptedSirenOptions) {
    this.#options = options;
    this.held = {
      version: 0,
      wifiIntervalS: DEFAULT_WIFI_REPORT_S,
      loraCheckUnits: DEFAULT_LORA_CHECK_UNITS,
      maxSoundS: DEFAULT_MAX_SOUND_S,
      sendRate: DataRate.DR5,
      commandRate: DataRate.DR5,
      siteChannel: 1,
      ...options.settings,
    };
    this.#savedResume = options.resumePoint ?? ResumeStep.SirenOrGateway;
    // Pairing restarts it, so its first packet carries the saved resume point (§4).
    this.#counter = resumeSendCounter(ResumeStep.SirenOrGateway, this.#savedResume);
    this.wifiUp = options.wifiUp ?? true;
    this.#reportAt = this.#phased(this.#wifiInterval(), 0);
    this.#checkAt = this.#phased(this.#checkInterval(), 0);
    this.#startedLoraAt = STARTED_LORA_AFTER;
    if (this.wifiUp) this.#onWifiUp(0);
  }

  /** A log entry, sent on Wi-Fi at its next wake (§6: log entries go on Wi-Fi and USB only). */
  log(level: number, code: number, text: string): void {
    if (!this.wifiUp) return;
    this.#wifiOut.push(
      this.#seal(
        { type: MessageType.LogEntries, entries: [{ ageTenths: 0, level, code, text }] },
        MaxPacketLength.Link,
      ),
    );
  }

  /** Seconds of sounding left, rounded up (§6). */
  secondsLeft(now: Mono): number {
    const local = this.#local(now);
    if (this.output === SirenState.Off || this.#stopAt === undefined || this.#stopAt <= local) {
      return 0;
    }
    return Math.ceil((this.#stopAt - local) / SECOND);
  }

  /** The low 16 bits of the last command or settings counter acted on. */
  get lastCommand(): number {
    return this.#lastCommand;
  }

  /** The next counter it will send with. */
  get nextCounter(): number {
    return this.#counter.next;
  }

  /** Its WebSocket goes down or comes back (§7: the hub's link closing is the test's to do). */
  setWifi(up: boolean, now: Mono): void {
    const local = this.#local(now);
    this.#runTimers(local);
    if (up === this.wifiUp) return;
    if (up) {
      this.#onWifiUp(local);
    } else {
      this.wifiUp = false;
      // The reports since the hub last answered a ping went nowhere: say so on LoRa at once.
      this.#lora.add("change");
    }
    this.#pump(local);
  }

  /** A restart (§6 Started, D80): after a power-on it is silent; after a reset it sounds on. */
  restart(kind: "powerOn" | "reset", now: Mono): void {
    const local = this.#local(now);
    this.#lastLocal = Math.max(this.#lastLocal, local);
    this.#counter = resumeSendCounter(ResumeStep.SirenOrGateway, this.#savedResume);
    if (kind === "powerOn") {
      this.output = SirenState.Off;
      this.#stopAt = undefined;
    }
    this.#resetCause = kind === "powerOn" ? RESET_CAUSE.powerOn : RESET_CAUSE.softwareReset;
    this.#lora.clear();
    this.#wifiOut = [];
    this.#loraOut = [];
    this.#startedPending = true;
    this.#startedLoraAt = local + STARTED_LORA_AFTER;
    this.#reportAt = this.#phased(this.#wifiInterval(), local);
    this.#checkAt = this.#phased(this.#checkInterval(), local);
    if (this.wifiUp) this.#onWifiUp(local);
  }

  /** Carries the siren's own clock over to a World that starts at mono 0 after `elapsed` µs. */
  carryOver(now: Mono, elapsed: number): void {
    this.clockOffset = this.#local(now) + elapsed;
    // What it did while the hub was away went nowhere.
    this.#runTimers(this.#local(mono(0)));
    this.#lora.clear();
    this.#wifiOut = [];
    this.#loraOut = [];
  }

  #local(now: Mono): number {
    return now + this.clockOffset;
  }

  #mono(local: number): Mono {
    return mono(local - this.clockOffset);
  }

  #phased(interval: number, from: number): number {
    return from + Math.max(1, Math.round((this.#options.phase ?? 1) * interval));
  }

  #wifiInterval(): number {
    // At least a second, so the catch-up loops of `#runTimers` always end.
    return Math.max(1, this.held.wifiIntervalS) * SECOND;
  }

  #checkInterval(): number {
    return Math.max(1, this.held.loraCheckUnits) * FIFTEEN_SECONDS * SECOND;
  }

  #pace(): number {
    const sf = spreadingFactor(this.held.sendRate) ?? spreadingFactor(DataRate.DR0) ?? 12;
    return Math.round(timeOnAirMs(sf, REPORT_PACKET_BYTES) * 1000 * PACE_AIRTIMES);
  }

  /** Its own next event: a timer, or what waits to go, at once or at the LoRa pace. */
  #nextWake(outbox: readonly Uint8Array[]): Mono {
    if (outbox.length > 0) return this.#mono(this.#lastLocal);
    const pace = this.#lastRoutine + this.#pace();
    const pending = [...this.#lora].map((item) =>
      item === "check" || item === "wifiFailed" ? Math.max(pace, this.#lastLocal) : this.#lastLocal,
    );
    const times = [
      this.#reportAt,
      this.#checkAt,
      ...(this.#stopAt === undefined ? [] : [this.#stopAt]),
      ...(this.#startedPending && this.#startedLoraAt !== undefined ? [this.#startedLoraAt] : []),
      ...pending,
    ];
    return this.#mono(Math.min(...times));
  }

  #wake(now: Mono, path: "wifi" | "lora"): readonly Uint8Array[] {
    const local = this.#local(now);
    this.#runTimers(local);
    this.#pump(local);
    return this.#drain(path);
  }

  #drain(path: "wifi" | "lora"): readonly Uint8Array[] {
    if (path === "wifi") {
      const out = this.#wifiOut;
      this.#wifiOut = [];
      return out;
    }
    const out = this.#loraOut;
    this.#loraOut = [];
    return out;
  }

  #runTimers(local: number): void {
    this.#lastLocal = Math.max(this.#lastLocal, local);
    if (this.#stopAt !== undefined && this.#stopAt <= local) {
      // SR5: it stops by itself, and says so at once.
      this.output = SirenState.Off;
      this.#stopAt = undefined;
      this.#report(local, true);
    }
    while (this.#reportAt <= local) {
      this.#reportAt += this.#wifiInterval();
      this.#report(local, false);
    }
    while (this.#checkAt <= local) {
      this.#checkAt += this.#checkInterval();
      this.#lora.add("check");
    }
    if (this.#startedPending && this.#startedLoraAt !== undefined && this.#startedLoraAt <= local) {
      this.#startedLoraAt = undefined;
      this.#lora.add("started");
    }
  }

  #onWifiUp(local: number): void {
    this.wifiUp = true;
    if (this.#startedPending) {
      this.#wifiOut.push(this.#seal(this.#started(), MaxPacketLength.Link));
      this.#startedPending = false;
      this.#startedLoraAt = undefined;
      this.#lora.delete("started");
    }
    this.#report(local, true);
  }

  /** A regular report on Wi-Fi, or on LoRa when Wi-Fi is down: a change at once, else paced. */
  #report(local: number, change: boolean): void {
    if (this.wifiUp) {
      this.#wifiOut.push(this.#reportPacket(local, SirenReportReason.Regular, "wifi"));
      return;
    }
    this.#lora.add(change ? "change" : "wifiFailed");
  }

  /** Sends what waits on LoRa, most urgent first; checks and failed reports keep the pace. */
  #pump(local: number): void {
    for (const item of LORA_ORDER) {
      if (!this.#lora.has(item)) continue;
      const paced = item === "check" || item === "wifiFailed";
      if (paced && local < this.#lastRoutine + this.#pace()) continue;
      this.#lora.delete(item);
      // A check carries the same state as a waiting failed report, and proves the path too.
      if (item === "check") this.#lora.delete("wifiFailed");
      if (paced) this.#lastRoutine = local;
      if (item === "started") {
        this.#startedPending = false;
        this.#loraOut.push(this.#seal(this.#started(), MaxPacketLength.Radio));
        continue;
      }
      const reason =
        item === "answer"
          ? SirenReportReason.CommandAnswer
          : item === "check"
            ? SirenReportReason.LoraCheck
            : SirenReportReason.WifiReportFailed;
      this.#loraOut.push(this.#reportPacket(local, reason, "lora"));
    }
  }

  #receive(bytes: Uint8Array, now: Mono, path: "wifi" | "lora"): readonly Uint8Array[] {
    const local = this.#local(now);
    this.#runTimers(local);
    if (this.deaf) return this.#drain(path);
    this.heard.push({ at: now, path });
    const opened = openPacket(bytes, {
      key: this.#options.key,
      expectedDirection: Direction.FromHub,
      binding: NO_BINDING,
      maxLength: path === "wifi" ? MaxPacketLength.Link : MaxPacketLength.Radio,
    });
    if (opened.ok && opened.value.header.address === this.#options.address) {
      this.#onHubPacket(opened.value.header.counter, opened.value.message, local, path);
    }
    this.#pump(local);
    return this.#drain(path);
  }

  #onHubPacket(counter: number, message: Message, local: number, path: "wifi" | "lora"): void {
    if (message.type !== MessageType.SirenCommand && message.type !== MessageType.SirenSettings) {
      return;
    }
    const check = checkStrictlyHigher(this.#lastCommand, counter);
    if (!check.accepted && check.reason === "tooOld") return; // §7: no answer at all
    if (check.accepted) {
      this.#lastCommand = check.state;
      this.acted.push({ at: this.#mono(local), path, counter, message });
      if (message.type === MessageType.SirenCommand) this.#act(message, local);
      else this.#apply(message, local);
    }
    // A new counter, or an exact repeat of the latest: answered on the path it came by.
    if (path === "wifi" && this.wifiUp) {
      this.#wifiOut.push(this.#reportPacket(local, SirenReportReason.CommandAnswer, "wifi"));
    } else {
      this.#lora.add("answer");
    }
  }

  #act(command: MessageOf<typeof MessageType.SirenCommand>, local: number): void {
    switch (command.action) {
      case SirenAction.Off:
        this.output = SirenState.Off;
        this.#stopAt = undefined;
        return;
      case SirenAction.SoundAlarm:
      case SirenAction.Test: {
        const seconds = Math.min(command.soundSeconds, this.held.maxSoundS);
        if (seconds === 0) {
          this.output = SirenState.Off;
          this.#stopAt = undefined;
          return;
        }
        this.output =
          command.action === SirenAction.SoundAlarm ? SirenState.SoundingAlarm : SirenState.Testing;
        this.#stopAt = local + seconds * SECOND;
        return;
      }
      default:
        return; // report now, or an action it does not know: the answer is the report
    }
  }

  #apply(settings: MessageOf<typeof MessageType.SirenSettings>, local: number): void {
    const before = this.held;
    const rate = (value: number, held: number) => (isEnumValue(DataRate, value) ? value : held);
    this.held = {
      version: settings.settingsVersion,
      wifiIntervalS: settings.wifiReportIntervalSeconds || before.wifiIntervalS,
      loraCheckUnits: settings.loraCheckIntervalUnits || before.loraCheckUnits,
      // §6: a longest time of 0 is not valid and never silences it.
      maxSoundS: settings.maxSoundSeconds || before.maxSoundS,
      sendRate: rate(settings.sendDataRate, before.sendRate),
      commandRate: rate(settings.commandDataRate, before.commandRate),
      siteChannel: settings.siteChannel,
    };
    if (this.held.wifiIntervalS !== before.wifiIntervalS) {
      this.#reportAt = this.#phased(this.#wifiInterval(), local);
    }
    if (this.held.loraCheckUnits !== before.loraCheckUnits) {
      this.#checkAt = this.#phased(this.#checkInterval(), local);
    }
  }

  #started(): Message {
    return {
      type: MessageType.Started,
      role: 2,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      resetCause: this.#resetCause,
      lastFatalError: 0,
      settingsVersion: this.held.version,
    };
  }

  #reportPacket(local: number, reason: number, path: "wifi" | "lora"): Uint8Array {
    const fields: MessageOf<typeof MessageType.SirenReport> = {
      type: MessageType.SirenReport,
      settingsVersion: this.held.version,
      state: this.output,
      soundingSecondsLeft: this.secondsLeft(this.#mono(local)),
      lastCommandCounterLow: this.#lastCommand & COUNTER_LOW,
      flags: {
        onMains: true,
        cellFitted: false,
        charging: false,
        coverOpen: false,
        wifiConnected: this.wifiUp,
      },
      cellBatteryCode: 0,
      temperatureCelsius: 21,
      reason,
    };
    this.reports.push({ at: this.#mono(local), path, fields });
    return this.#seal(fields, path === "wifi" ? MaxPacketLength.Link : MaxPacketLength.Radio);
  }

  #seal(message: Message, maxLength: MaxPacketLength): Uint8Array {
    const taken = takeSendCounter(this.#counter);
    if (!taken.ok) return new Uint8Array();
    this.#counter = taken.value.state;
    // The resume point is saved to flash before the counter that asked for it is used (§4).
    if (taken.value.saveResumePoint !== undefined) this.#savedResume = taken.value.saveResumePoint;
    return sealPacket(message, {
      key: this.#options.key,
      direction: Direction.ToHub,
      address: this.#options.address,
      counter: taken.value.counter,
      binding: NO_BINDING,
      maxLength,
    });
  }
}

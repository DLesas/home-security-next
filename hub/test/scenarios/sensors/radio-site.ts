/**
 * The air between scripted sensors and one gateway, as the far end of the stand-in gateway's link
 * (hub-design.md section 11): the gateway listens on one channel at one rate (§2), hears a packet
 * only when nothing else overlapped it on that channel and it was not sending itself, forwards it
 * after a network delay, and sends the hub's transmit requests on 869.525 MHz with one radio: at a
 * given time, "too late" when it gets to it more than 20 ms † after; as soon as possible within
 * the latest moment (§6). A packet it sends reaches the sensor it is addressed to.
 */
import {
  MessageType,
  spreadingFactor,
  timeOnAirMs,
  TransmitResultCode,
  TransmitWhen,
} from "@hsn/protocol";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import type { ScriptedSensor, Transmission } from "../../world/scripted-sensor.ts";
import type { ScriptedDevice } from "../../world/world.ts";
import { forwardedFrame, readRequest, resultFrame, unwrapNear } from "./stand-ins.ts";

const MS = 1000;
/** A request for a given time may start at most 20 ms † late (§6). */
const TOO_LATE_US = 20 * MS;
/** Transmissions older than this cannot overlap anything new. */
const KEEP_US = 10_000_000;

/** A sensor packet as the gateway did or did not hear it. */
export interface Heard {
  readonly sensor: number;
  readonly transmission: Transmission;
  readonly heard: boolean;
}

export class RadioSite implements ScriptedDevice {
  readonly sensors: readonly ScriptedSensor[];
  readonly heard: Heard[] = [];
  /** Packets the gateway sent, with their start. */
  readonly sent: { readonly start: Mono; readonly rate: number; readonly address: number }[] = [];
  channel: number;
  rate: number;
  #delayUs: number;
  /** Sensors whose packets the gateway never hears: out of range (by index). */
  readonly unheard = new Set<number>();
  #air: { readonly sensor: number; readonly t: Transmission }[] = [];
  #forwards: { readonly at: Mono; readonly sensor: number; readonly t: Transmission }[] = [];
  #deliveries: { readonly at: Mono; readonly packet: Uint8Array; readonly rate: number }[] = [];
  #results: { readonly at: Mono; readonly frame: Uint8Array }[] = [];
  #busy: { readonly from: Mono; readonly until: Mono }[] = [];

  constructor(
    sensors: readonly ScriptedSensor[],
    options: { readonly channel: number; readonly rate: number; readonly delayMs?: number },
  ) {
    this.sensors = sensors;
    this.channel = options.channel;
    this.rate = options.rate;
    this.#delayUs = (options.delayMs ?? 30) * MS;
  }

  /** The network delay from a packet's end to its forwarded copy reaching the hub. */
  setDelayMs(ms: number): void {
    this.#delayUs = ms * MS;
  }

  /** The gateway takes new settings and listens on them at once (§7, the switch). */
  listenOn(channel: number | undefined, rate: number | undefined): void {
    this.channel = channel ?? this.channel;
    this.rate = rate ?? this.rate;
  }

  nextWake(): Mono | undefined {
    const times = [
      ...this.sensors.map((s) => s.nextWake()),
      this.#forwards[0]?.at,
      this.#deliveries[0]?.at,
      this.#results[0]?.at,
    ].filter((t): t is Mono => t !== undefined);
    return times.length === 0 ? undefined : mono(Math.min(...times));
  }

  wake(now: Mono): readonly Uint8Array[] {
    while (this.#deliveries[0] !== undefined && this.#deliveries[0].at <= now) {
      const delivery = this.#deliveries.shift();
      if (delivery === undefined) break;
      const address = new DataView(
        delivery.packet.buffer,
        delivery.packet.byteOffset + 1,
        4,
      ).getUint32(0, true);
      for (const sensor of this.sensors) {
        if (sensor.options.address === address)
          sensor.hear(delivery.packet, delivery.rate, delivery.at);
      }
    }
    this.sensors.forEach((sensor, index) => {
      const due = sensor.nextWake();
      if (due === undefined || due > now) return;
      for (const t of sensor.wake(now)) {
        this.#air.push({ sensor: index, t });
        this.#forwards.push({ at: mono(t.end + this.#delayUs), sensor: index, t });
      }
    });
    this.#forwards.sort((a, b) => a.at - b.at);
    this.#air = this.#air.filter((a) => a.t.end > now - KEEP_US);
    const frames: Uint8Array[] = [];
    while (this.#forwards[0] !== undefined && this.#forwards[0].at <= now) {
      const forward = this.#forwards.shift();
      if (forward === undefined) break;
      const { t } = forward;
      const collided = this.#air.some(
        (a) => a.t !== t && a.t.channel === t.channel && a.t.start < t.end && t.start < a.t.end,
      );
      const deaf = this.#busy.some((b) => b.from < t.end && t.start < b.until);
      const heard =
        !collided &&
        !deaf &&
        !this.unheard.has(forward.sensor) &&
        t.channel === this.channel &&
        t.dataRate === this.rate;
      this.heard.push({ sensor: forward.sensor, transmission: t, heard });
      if (heard)
        frames.push(
          forwardedFrame(t.packet, {
            endedAt: t.end,
            dataRate: t.dataRate,
            siteChannel: t.channel,
          }),
        );
    }
    while (this.#results[0] !== undefined && this.#results[0].at <= now) {
      const result = this.#results.shift();
      if (result !== undefined) frames.push(result.frame);
    }
    return frames;
  }

  receive(bytes: Uint8Array, now: Mono): readonly Uint8Array[] {
    const read = readRequest(bytes);
    if (read?.request.type !== MessageType.TransmitRequest) return [];
    const { request, counter } = read;
    const sf = spreadingFactor(request.dataRate) ?? 7;
    const airtime = Math.ceil(timeOnAirMs(sf, request.packet.length) * MS);
    const busyUntil = Math.max(now, ...this.#busy.map((b) => b.until));
    let start: number;
    let result: number = TransmitResultCode.Sent;
    if (request.when === TransmitWhen.AtTime) {
      const wanted = unwrapNear(request.gatewayTimeMicros, now);
      start = Math.max(wanted, busyUntil);
      if (start - wanted > TOO_LATE_US) result = TransmitResultCode.TooLate;
    } else {
      start = busyUntil;
      const latest =
        request.gatewayTimeMicros === 0 ? undefined : unwrapNear(request.gatewayTimeMicros, now);
      if (latest !== undefined && start > latest) result = TransmitResultCode.TooLate;
    }
    if (result === TransmitResultCode.Sent) {
      this.#busy = [
        ...this.#busy.filter((b) => b.until > now - KEEP_US),
        { from: mono(start), until: mono(start + airtime) },
      ];
      this.#deliveries.push({ at: mono(start), packet: request.packet, rate: request.dataRate });
      this.#deliveries.sort((a, b) => a.at - b.at);
      const address = new DataView(
        request.packet.buffer,
        request.packet.byteOffset + 1,
        4,
      ).getUint32(0, true);
      this.sent.push({ start: mono(start), rate: request.dataRate, address });
    }
    this.#results.push({ at: mono(start), frame: resultFrame(counter, result, start) });
    this.#results.sort((a, b) => a.at - b.at);
    return [];
  }
}

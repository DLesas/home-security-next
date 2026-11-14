/**
 * A lockstep controller for tests (hub-design.md section 11, "Lockstep"): the controller's side
 * of the wire, in TypeScript, with scripted boards, a gateway, sensors and sirens behind it, and
 * every message both ways kept as a transcript (`> ` to the hub, `< ` from it).
 *
 * It talks to the hub through a `HubEnd`: in this process (`LockstepHub` itself) or a real hub
 * process over the socket (`process.ts`). It steps time as section 11 says a controller must: it
 * advances only to the earliest of its own next event and the hub's last `wake`, so every frame
 * the hub sends leaves at the `to` of the advance, and the answers its devices make go in at a
 * later time.
 *
 * Boards start unpaired on USB, as the bench's do; the gateway is added by itself (D100), the
 * others by `hsn usb add`; once a board accepts its Provision it becomes its role, with the
 * address, key and site channel it was given.
 */
import {
  encodeUsbFrame,
  fromHex,
  type PairingData,
  Role,
  spreadingFactor,
  timeOnAirMs,
  toHex,
} from "@hsn/protocol";
import type {
  ControlCommand,
  ControlReply,
  LockstepFromHub,
  LockstepIdle,
  LockstepToHub,
} from "../../src/control-protocol/index.ts";
import { mono } from "../../src/core/model/time.ts";
import { ScriptedBoard } from "../unit/setup/support/board.ts";
import { SeededBytes } from "../world/entropy.ts";
import { ScriptedGateway } from "../world/scripted-gateway.ts";
import { ScriptedSensor, type Transmission } from "../world/scripted-sensor.ts";
import { ScriptedSiren } from "../world/scripted-siren.ts";

export const SECOND = 1_000_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** A USB or WebSocket link's latency, each way. */
const LINK_US = 1_000;
/** From a packet's end on the air to its forwarded copy reaching the hub. */
const FORWARD_US = 30_000;
const SITE_RATE = 5;
/** Rounds without the hub's or the devices' time moving before the controller gives up. */
const MAX_IDLE_ROUNDS = 1_000;

/** The hub as the controller reaches it: one message in, its answers out. */
export interface HubEnd {
  send(message: LockstepToHub): Promise<readonly LockstepFromHub[]>;
}

/** A board on USB and what it becomes. */
interface Board {
  readonly name: string;
  readonly role: number;
  readonly board: ScriptedBoard;
  readonly usb: string;
  plugged: boolean;
  gateway?: ScriptedGateway;
  sensor?: ScriptedSensor;
  siren?: ScriptedSiren;
  /** A siren's Wi-Fi link, while up; a gateway's, once it connects over Wi-Fi. */
  network?: string;
  /** The link a gateway uses now: its USB link, or its Wi-Fi link once it moved there. */
  gatewayLink?: string;
  /** When a device reconnects a network link the hub closed (§7: a gateway retries after 1 s). */
  reconnectAt?: number;
  /** A gateway's next status (every status interval, §6), and when it started. */
  statusAt?: number;
  bootedAt?: number;
}

interface Pending {
  readonly at: number;
  readonly message: LockstepToHub;
}

export class Controller {
  readonly transcript: string[] = [];
  readonly idles: LockstepIdle[] = [];
  readonly replies = new Map<number, ControlReply>();
  readonly boards: Board[] = [];
  readonly #end: HubEnd;
  readonly #random: SeededBytes;
  #now: number;
  #wake: number | null = null;
  #pending: Pending[] = [];
  #deliveries: { at: number; packet: Uint8Array; rate: number }[] = [];
  #forwards: { at: number; packet: Uint8Array; rate: number; channel: number }[] = [];
  #nextRequest = 1;
  #gatewayTaken = 0;
  /** Why the run stopped short, if it did: the hub refused a line, or time stood still. */
  failure: string | undefined;
  /** Whether a hub is running: while none is, the devices go on and what they send is lost. */
  #hubUp = false;

  constructor(end: HubEnd, at: number, seed = 1) {
    this.#end = end;
    this.#now = at;
    this.#random = new SeededBytes(seed);
  }

  get now(): number {
    return this.#now;
  }

  async #send(message: LockstepToHub): Promise<readonly LockstepFromHub[]> {
    this.transcript.push(`> ${JSON.stringify(message)}`);
    const answers = await this.#end.send(message);
    for (const answer of answers) {
      this.transcript.push(`< ${JSON.stringify(answer)}`);
      if (answer.type === "idle") this.#take(answer);
      if (answer.type === "error") this.failure = `the hub refused a line: ${answer.message}`;
    }
    return answers;
  }

  /** The `start` of a run (and of each hub restart). */
  async start(at: number, wall: number, trusted: boolean, seed: string): Promise<void> {
    this.#now = Math.max(this.#now, at);
    this.#hubUp = true;
    await this.#send({ type: "start", version: 2, at, wall, trusted, seed });
    // Every link that is up comes up again for the new hub.
    for (const b of this.boards) {
      if (b.plugged) this.#queue(at, { type: "linkUp", link: b.usb, kind: "usb", at });
      if (b.network !== undefined)
        this.#queue(at, { type: "linkUp", link: b.network, kind: "network", at });
    }
    for (const b of this.boards) {
      if (b.gateway !== undefined && (b.plugged || b.gatewayLink === b.network)) {
        const hello = b.gateway.hello();
        if (hello !== undefined) this.#frame(at + LINK_US, this.#linkOf(b), hello);
      }
      if (b.siren !== undefined && b.network !== undefined) b.siren.setWifi(true, mono(at));
    }
  }

  async stop(at: number): Promise<void> {
    await this.#send({ type: "stop", at });
    this.#afterHubGone(at);
  }

  /** The hub is gone (stopped, or killed by the caller): links drop, devices carry on. */
  #afterHubGone(at: number): void {
    this.#hubUp = false;
    this.#pending = [];
    this.#wake = null;
    for (const b of this.boards) if (b.siren?.wifiUp === true) b.siren.setWifi(false, mono(at));
  }

  killed(at: number): void {
    this.#afterHubGone(at);
  }

  /** A board plugged in, unpaired and a development build, as the bench's start (section 11). */
  plug(name: string, role: number, at = this.#now): Board {
    const chip = new Uint8Array([0xa0, role, 0, 0, this.boards.length, 1]);
    const b: Board = {
      name,
      role,
      board: new ScriptedBoard({ role, chipId: chip, development: true }),
      usb: `${name}:usb`,
      plugged: true,
    };
    b.board.onProvision = (pairing) => {
      this.#becomes(b, pairing);
    };
    this.boards.push(b);
    this.#queue(at, { type: "linkUp", link: b.usb, kind: "usb", at });
    return b;
  }

  /** USB power off (a sensor once paired): its link goes down. */
  unplug(name: string, at = this.#now): void {
    const b = this.board(name);
    if (b === undefined) return;
    b.plugged = false;
    this.#queue(at, { type: "linkDown", link: b.usb, at });
  }

  board(name: string): Board | undefined {
    return this.boards.find((b) => b.name === name);
  }

  /** An `hsn` command at `at`; its answer comes in the `idle` that covers it. */
  command(command: ControlCommand, at = this.#now): number {
    const id = this.#nextRequest++;
    this.#queue(at, {
      type: "control",
      at,
      request: { id, actor: "bench", command },
    });
    return id;
  }

  clock(at: number, wall: number, trusted: boolean): void {
    this.#queue(at, { type: "clock", at, wall, trusted });
  }

  /** Runs everything up to `to`: the devices, the air, and the hub, in lockstep. */
  async runTo(to: number): Promise<void> {
    let still = 0;
    while (this.failure === undefined) {
      const next = this.#nextEvent();
      if (next === undefined || next > to) break;
      const before = this.#now;
      this.#now = Math.max(this.#now, next);
      this.#devicesAt(this.#now);
      await this.#sendDue();
      if (this.#hubUp) await this.#send({ type: "advance", to: this.#now });
      still = this.#now === before ? still + 1 : 0;
      if (still > MAX_IDLE_ROUNDS) this.failure = `no progress at ${this.#now}`;
    }
    if (to > this.#now && this.failure === undefined) {
      this.#now = to;
      await this.#sendDue();
      if (this.#hubUp) await this.#send({ type: "advance", to });
    }
  }

  /**
   * The inputs due by now, and only those: one given for later would let the hub run past what
   * the controller knows of, and its answers would come back in the past.
   */
  async #sendDue(): Promise<void> {
    const due = this.#pending.filter((p) => p.at <= this.#now);
    this.#pending = this.#pending.filter((p) => p.at > this.#now);
    // With no hub, what the devices send is lost, as on a real network.
    if (this.#hubUp) for (const p of due) await this.#send(p.message);
  }

  #nextEvent(): number | undefined {
    const times = [
      this.#wake ?? undefined,
      ...this.#pending.map((p) => p.at),
      ...this.#deliveries.map((d) => d.at),
      ...this.#forwards.map((f) => f.at),
      ...this.boards.flatMap((b) => [
        b.sensor?.nextWake(),
        b.siren?.lora.nextWake(),
        b.network === undefined ? undefined : b.siren?.wifi.nextWake(),
        b.gateway?.nextWake(),
        b.plugged || b.gatewayLink === b.network ? b.statusAt : undefined,
        b.reconnectAt,
      ]),
    ].filter((t): t is number => t !== undefined);
    if (times.length === 0) return undefined;
    return Math.max(this.#now, Math.min(...times));
  }

  #queue(at: number, message: LockstepToHub): void {
    this.#pending.push({ at, message });
    this.#pending.sort((a, b) => a.at - b.at);
  }

  #frame(at: number, link: string, bytes: Uint8Array): void {
    this.#queue(at, { type: "frame", link, at, bytes: toHex(bytes) });
  }

  #gatewayBoard(): Board | undefined {
    return this.boards.find(
      (b) => b.gateway !== undefined && (b.plugged || b.gatewayLink === b.network),
    );
  }

  /** The link a gateway sends on now. */
  #linkOf(b: Board): string {
    return b.gatewayLink ?? b.usb;
  }

  /**
   * The gateway connects over Wi-Fi as well (§10: a gateway leaves USB for Wi-Fi): a new link,
   * a hello on it, and from then on everything it sends goes there. Once the new session is
   * proven the hub closes the old link (section 8), and says so in `idle.closed`.
   */
  gatewayOverNetwork(name: string, at = this.#now): void {
    const b = this.board(name);
    if (b?.gateway === undefined) return;
    b.network = `${name}:network`;
    b.gatewayLink = b.network;
    this.#queue(at, { type: "linkUp", link: b.network, kind: "network", at });
    const hello = b.gateway.hello();
    if (hello !== undefined) this.#frame(at + LINK_US, b.network, hello);
  }

  /**
   * A link the hub closed (version 2): its device sees it go down, as on a real WebSocket or
   * port. A network link the device still uses is connected again after 1 s, as a gateway
   * retries (§7) and a siren rejoins; a link it no longer uses (replaced) stays down, and a USB
   * port stays closed until the board is plugged in again, as the real hub's watch opens a port
   * only when it appears.
   */
  #closedByHub(link: string, at: number): void {
    const b = this.boards.find((x) => x.usb === link || x.network === link);
    if (b === undefined) return;
    if (link === b.usb) {
      b.plugged = false;
      return;
    }
    if (b.siren !== undefined) b.siren.setWifi(false, mono(at));
    if (b.gateway !== undefined && b.gatewayLink !== link) return;
    const again = at + SECOND;
    b.reconnectAt = again;
    this.#queue(again, { type: "linkUp", link, kind: "network", at: again });
  }

  /** What every device does at `now`: due deliveries, its own sends, the air's forwards. */
  #devicesAt(now: number): void {
    const gw = this.#gatewayBoard();
    for (const d of this.#deliveries.filter((x) => x.at <= now)) {
      const address = new DataView(d.packet.buffer, d.packet.byteOffset + 1, 4).getUint32(0, true);
      for (const b of this.boards) {
        if (b.sensor?.options.address === address) b.sensor.hear(d.packet, d.rate, mono(d.at));
        if (b.siren !== undefined && b.board.accepted.at(-1)?.address === address) {
          for (const answer of b.siren.lora.receive(d.packet, mono(now)))
            this.#onAir(answer, now, b.siren.held.sendRate, b.siren.held.siteChannel);
        }
      }
    }
    this.#deliveries = this.#deliveries.filter((x) => x.at > now);
    for (const b of this.boards) {
      if (b.reconnectAt !== undefined && b.reconnectAt <= now) {
        delete b.reconnectAt;
        const hello = b.gatewayLink === b.network ? b.gateway?.hello() : undefined;
        if (hello !== undefined && b.network !== undefined)
          this.#frame(now + LINK_US, b.network, hello);
        if (b.siren !== undefined) b.siren.setWifi(true, mono(now + LINK_US));
      }
      const sensorDue = b.sensor?.nextWake();
      if (b.sensor !== undefined && sensorDue !== undefined && sensorDue <= now) {
        for (const t of b.sensor.wake(mono(now))) this.#onAirT(t);
      }
      const siren = b.siren;
      if (siren !== undefined) {
        const loraDue = siren.lora.nextWake();
        if (loraDue !== undefined && loraDue <= now)
          for (const p of siren.lora.wake(mono(now)))
            this.#onAir(p, now, siren.held.sendRate, siren.held.siteChannel);
        const wifiDue = siren.wifi.nextWake();
        if (b.network !== undefined && wifiDue !== undefined && wifiDue <= now)
          for (const p of siren.wifi.wake(mono(now))) this.#frame(now + LINK_US, b.network, p);
      }
      const connected = b.plugged || (b.network !== undefined && b.gatewayLink === b.network);
      if (b.gateway !== undefined && connected && b.statusAt !== undefined && b.statusAt <= now) {
        const interval = b.gateway.settings?.statusIntervalSeconds ?? 30;
        b.statusAt = now + Math.max(1, interval) * SECOND;
        const status = b.gateway.status({
          settingsVersion: b.gateway.settings?.settingsVersion ?? 0,
          uptimeSeconds: Math.floor((now - (b.bootedAt ?? now)) / SECOND),
          airtimeHundredthsPercent: 12,
          noiseMedianDbm: -118,
          noiseHighestDbm: -110,
          normalNoiseDbm: -118,
          packetsReceived: 0,
          packetsCrcFailed: 0,
          wifiRssiDbm: 0,
          flags: { usbConnected: true, cellFitted: false, onMains: true },
        });
        if (status !== undefined) this.#frame(now + LINK_US, this.#linkOf(b), status);
      }
      const gwDue = b.gateway?.nextWake();
      if (b.gateway !== undefined && connected && gwDue !== undefined && gwDue <= now)
        for (const p of b.gateway.wake(mono(now))) this.#frame(now + LINK_US, this.#linkOf(b), p);
    }
    for (const f of this.#forwards.filter((x) => x.at <= now)) {
      const settings = gw?.gateway?.settings;
      const listening =
        settings?.siteChannel === f.channel && ((settings.listenDataRateMask >> f.rate) & 1) === 1;
      if (gw?.gateway === undefined || !listening) continue;
      const frame = gw.gateway.forward(f.packet, {
        endedAt: mono(f.at - FORWARD_US),
        rssiDbm: -92,
        snrQuarterDb: 24,
        dataRate: f.rate,
        siteChannel: f.channel,
      });
      if (frame !== undefined) this.#frame(now + LINK_US, this.#linkOf(gw), frame);
    }
    this.#forwards = this.#forwards.filter((x) => x.at > now);
  }

  #onAirT(t: Transmission): void {
    this.#forwards.push({
      at: t.end + FORWARD_US,
      packet: t.packet,
      rate: t.dataRate,
      channel: t.channel,
    });
  }

  #onAir(packet: Uint8Array, at: number, rate: number, channel: number): void {
    const airtime = Math.ceil(timeOnAirMs(spreadingFactor(rate) ?? 7, packet.length) * 1000);
    this.#forwards.push({ at: at + airtime + FORWARD_US, packet, rate, channel });
  }

  /** An `idle`: its frames to the devices, its answers kept, its wake. */
  #take(idle: LockstepIdle): void {
    this.idles.push(idle);
    this.#wake = idle.wake;
    for (const closed of idle.closed) this.#closedByHub(closed.link, closed.at);
    for (const reply of idle.replies) this.replies.set(reply.id, reply.reply);
    for (const frame of idle.frames) {
      const bytes = fromHex(frame.bytes);
      const b = this.boards.find((x) => x.usb === frame.link || x.network === frame.link);
      if (b === undefined) continue;
      const at = frame.at + LINK_US;
      if (frame.link === b.network && b.siren !== undefined) {
        for (const answer of b.siren.wifi.receive(bytes, mono(at)))
          this.#frame(at + LINK_US, frame.link, answer);
      } else if (b.gateway !== undefined) {
        for (const answer of b.gateway.receive(bytes, mono(at)))
          this.#frame(at + LINK_US, frame.link, answer);
        for (const t of b.gateway.transmissions.slice(this.#gatewayTaken)) {
          this.#deliveries.push({
            at: Math.max(at, b.gateway.hubTimeAt(t.startMicros)),
            packet: t.packet,
            rate: t.dataRate,
          });
        }
        this.#gatewayTaken = b.gateway.transmissions.length;
      } else {
        for (const answer of b.board.receive(bytes)) this.#frame(at + LINK_US, frame.link, answer);
      }
    }
  }

  /** A board that accepted its Provision restarts as its role (§10). */
  #becomes(b: Board, pairing: PairingData): void {
    const at = this.#now + 50_000;
    const random = new SeededBytes(pairing.address);
    if (b.role === Role.Gateway) {
      b.gateway = new ScriptedGateway({
        key: pairing.key,
        address: pairing.address,
        nextRandom: () => random.bytes(8),
      });
      this.#gatewayTaken = 0;
      b.bootedAt = at;
      b.statusAt = at + 30 * SECOND;
      const hello = b.gateway.hello();
      if (hello !== undefined) this.#frame(at, b.usb, hello);
    } else if (b.role === Role.Sensor) {
      b.sensor = new ScriptedSensor({
        key: pairing.key,
        address: pairing.address,
        channel: pairing.siteChannel,
        rate: SITE_RATE,
        random: () => this.#random.next() / 2 ** 32,
        startAt: mono(at),
      });
    } else if (b.role === Role.Siren) {
      b.siren = new ScriptedSiren({
        key: pairing.key,
        address: pairing.address,
        settings: { siteChannel: pairing.siteChannel },
        wifiUp: false,
      });
      b.network = `${b.name}:network`;
      this.#queue(at, { type: "linkUp", link: b.network, kind: "network", at });
      // Its Wi-Fi joins once the socket is up: Started goes there first (§6).
      b.siren.setWifi(true, mono(at + LINK_US));
    }
  }
}

export { encodeUsbFrame };

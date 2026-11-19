/**
 * A scripted board as a Bluetooth peripheral (m3-design.md section 5, "The board: window, code,
 * display, advertising"; protocol.md section 10, "Pairing over Bluetooth" and "The update service
 * over Bluetooth"): a sensor, a siren or a gateway, as the firmware will behave. Bluetooth is off
 * except in two windows, never both at once (D138):
 *
 * - **The pairing window**, 2 minutes (DS7): opened on an unpaired board at power-up and after a
 *   five-second hold; a paired board opens none in a release build (the hold is ignored and
 *   counted), but does in a development build (PR5). It closes when a Provision is accepted, after
 *   5 wrong codes, or at its end, and stays open while a phone is connected. While open, the board
 *   advertises protocomm's service with no service data and
 *   the name `hsn-pair-<last 4 hex of the chip>`, and serves protocomm's endpoints (`protocomm.ts`)
 *   with its security (`pairing-security.ts`) and the setup messages (`setup.ts`).
 * - **The update window**, only on the hub's offer with action 3 (`offerUpdate`): the update
 *   service's UUID and the name `hsn-<address in 8 hex>`, and the device side of the update
 *   (`update-service.ts`).
 *
 * One connection at a time: while a phone is connected the board does not advertise. A Provision
 * accepted is answered, then the board restarts as its role once the answer has been read (or
 * after `restartMs` if it never is): the connection goes, and `onProvisioned` hands the pairing
 * to whatever runs the role (the harness's air, a test). `powerOff` is a board that vanishes.
 *
 * Nothing secret leaves a board: its code is never sent, and no key is logged.
 */
import { type BleAir } from "../air/air.ts";
import type {
  AdvertData,
  ConnectionHandlers,
  Peripheral,
  PeripheralConnection,
  ServiceSpec,
} from "../air/gatt.ts";
import type { Clock } from "../clock.ts";
import { Role } from "../../../../packages/protocol/src/messages/common.ts";
import type { PairingData } from "../../../../packages/protocol/src/pairing.ts";
import {
  formatBoardQr,
  formatPairingCode,
  makePairingCode,
  pairAdvertName,
} from "../../../../packages/protocol/src/pairing/code.ts";
import {
  PAIR_PROTOCOL_LABEL,
  PAIRING_CODE,
  PROTOCOMM,
} from "../../../../packages/protocol/src/pairing/constants.ts";
import type { PairingCodeText } from "../../../../packages/protocol/src/pairing/types.ts";
import {
  BLUETOOTH_UPDATE,
  bluetoothUpdateName,
} from "../../../../packages/protocol/src/update/bluetooth.ts";
import { PAIRING_SERVICE, PAIRING_UUIDS, ProtocommConnection } from "./protocomm.ts";
import type { StartPairingSecurity } from "./pairing-security.ts";
import { security2Server } from "./security2-server.ts";
import { answerSetup, type FirmwareVersion, identityOf, type SetupHolder } from "./setup.ts";
import {
  type BluetoothOffer,
  type UpdateHost,
  UpdateService,
  type UpdateStatusReport,
} from "./update-service.ts";

/** The update service's GATT layout. */
const MIN_UPDATE_MTU = 185;

export const UPDATE_SERVICE: ServiceSpec = {
  uuid: BLUETOOTH_UPDATE.serviceUuid,
  characteristics: [
    { uuid: BLUETOOTH_UPDATE.rxUuid, writeWithoutResponse: true },
    { uuid: BLUETOOTH_UPDATE.txUuid, notify: true },
  ],
};

/** The slot not running on the boards (an ESP32-S3 with 8 MB of flash, 3 MB per slot ‡). */
export const DEFAULT_CAPACITY = 3 * 1024 * 1024;
/** Wrong codes in one window before the board stops listening. */
export const MAX_WRONG_CODES = PAIRING_CODE.maxTries;

export type BoardRole = typeof Role.Sensor | typeof Role.Siren | typeof Role.Gateway;

export interface BoardOptions {
  readonly role: BoardRole;
  /** The chip id, 6 bytes. */
  readonly chipId: Uint8Array;
  /** The id phones see; by default `bench-<role>-<last 4 hex of the chip>`. */
  readonly id?: string;
  readonly firmware?: FirmwareVersion;
  /** A development build (PR5): a paired board opens the pairing window and takes Provision. */
  readonly development?: boolean;
  /** The pairing code; by default made from the board's random numbers, as at first boot. */
  readonly code?: PairingCodeText;
  /** Paired already. */
  readonly pairing?: PairingData;
  /** The security layer (see `pairing-security.ts`); by default ESP-IDF security 2. */
  readonly security?: StartPairingSecurity;
  /** The board's random numbers (the code, Hello's device random). */
  readonly random?: (bytes: number) => Uint8Array;
  readonly maxMtu?: number;
  readonly rssi?: number;
  /** Bytes of the slot not running. */
  readonly capacity?: number;
  /** Storing a pairing fails. */
  readonly storageFails?: boolean;
  /** After a Provision is accepted, the restart comes this long after the write if its answer is not read. */
  readonly restartMs?: number;
  /** The pairing window's length. */
  readonly windowMs?: number;
  /**
   * Restart at once when a Provision is accepted, before the phone has read its answer: the
   * phone then never sees the result (a fault for `pair.finish`'s sake).
   */
  readonly restartBeforeResult?: boolean;
}

export interface BoardEvents {
  /** The setup endpoint received a decrypted request. The payload stays on the board. */
  readonly pairingSetup?: () => void;
  /** A Provision was accepted and the board restarted as its role. */
  readonly provisioned?: (pairing: PairingData, board: ScriptedBoard) => void;
  /** What the board would send over LoRa about an update: an Update status. */
  readonly updateStatus?: (status: UpdateStatusReport, board: ScriptedBoard) => void;
}

function defaultRandom(bytes: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const ROLE_WORD: Record<BoardRole, string> = {
  [Role.Sensor]: "sensor",
  [Role.Siren]: "siren",
  [Role.Gateway]: "gateway",
};

export class ScriptedBoard implements Peripheral, SetupHolder {
  readonly id: string;
  readonly rssi: number;
  readonly maxMtu: number;
  readonly role: BoardRole;
  readonly chipId: Uint8Array;
  readonly firmware: FirmwareVersion;
  readonly development: boolean;
  readonly code: PairingCodeText;
  readonly capacity: number;
  pairing: PairingData | undefined;
  /** Storing a pairing fails; a test may change it. */
  storageFails: boolean;

  // What a test may look at.
  powered = false;
  /** Wrong codes in the current pairing window. */
  wrongCodes = 0;
  /** Presses ignored: a paired release board opens no pairing window. */
  ignoredPresses = 0;
  /** Restarts after an accepted Provision. */
  restarts = 0;
  /** Connections taken, in all. */
  connections = 0;
  /** Every Update status it would have sent over LoRa. */
  readonly statuses: UpdateStatusReport[] = [];

  readonly #clock: Clock;
  readonly #events: BoardEvents;
  readonly #security: StartPairingSecurity;
  readonly #random: (bytes: number) => Uint8Array;
  readonly #restartMs: number;
  readonly #windowMs: number;
  readonly #restartBeforeResult: boolean;

  #pairingOpen = false;
  #pairingEnded = false;
  #cancelWindow: () => void = () => undefined;
  #updateAdvertising = false;
  #update: UpdateService | undefined;
  #connection: PeripheralConnection | undefined;
  #protocomm: ProtocommConnection | undefined;
  #restartPending = false;
  #cancelRestart: () => void = () => undefined;

  constructor(clock: Clock, options: BoardOptions, events: BoardEvents = {}) {
    this.#clock = clock;
    this.#events = events;
    this.role = options.role;
    this.chipId = options.chipId.slice();
    this.id = options.id ?? `bench-${ROLE_WORD[options.role]}-${hex(this.chipId).slice(-4)}`;
    this.rssi = options.rssi ?? -60;
    this.maxMtu = options.maxMtu ?? 517;
    this.firmware = options.firmware ?? { major: 1, minor: 0, patch: 0 };
    this.development = options.development ?? false;
    this.#random = options.random ?? defaultRandom;
    this.code = options.code ?? this.#makeCode();
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.pairing = options.pairing;
    this.storageFails = options.storageFails ?? false;
    this.#security = options.security ?? security2Server();
    this.#restartMs = options.restartMs ?? 1000;
    this.#windowMs = options.windowMs ?? PAIRING_CODE.windowMs;
    this.#restartBeforeResult = options.restartBeforeResult ?? false;
    if (this.pairing !== undefined) this.#update = this.#makeUpdate(this.pairing);
  }

  #makeCode(): PairingCodeText {
    const bytes = this.#random(5);
    let secret = 0n;
    for (const byte of bytes) secret = (secret << 8n) | BigInt(byte);
    secret &= (1n << BigInt(PAIRING_CODE.secretBits)) - 1n;
    const code = makePairingCode(secret);
    // A 35-bit secret is always in range.
    return code ?? ("00000000" as PairingCodeText);
  }

  // ----- What the display shows (D85) -----

  /** The QR code's text: `hsn://pair/1?c=<code>&d=<chip id>`. */
  get qr(): string {
    return formatBoardQr({ code: this.code, chipId: this.chipId });
  }

  /** The code as the display shows it, `XXXX-XXXX`. */
  get shownCode(): string {
    return formatPairingCode(this.code);
  }

  /** "Siren 4F2A". */
  get label(): string {
    const word = ROLE_WORD[this.role];
    return `${word.charAt(0).toUpperCase()}${word.slice(1)} ${hex(this.chipId).slice(-4).toUpperCase()}`;
  }

  // ----- The board's life -----

  get window(): "closed" | "pairing" | "update" {
    if (this.#pairingOpen) return "pairing";
    if (this.#update !== undefined && this.#update.session !== "closed") return "update";
    return "closed";
  }

  /** The update service, once paired: for a test to read. */
  get update(): UpdateService | undefined {
    return this.#update;
  }

  /** Power comes: an unpaired board opens its pairing window. */
  powerOn(): void {
    if (this.powered) return;
    this.powered = true;
    if (this.pairing === undefined) this.#openPairing();
  }

  /** The board vanishes: no more advertising, its phone's link is lost; flash stays. */
  powerOff(): void {
    if (!this.powered) return;
    this.powered = false;
    this.#closePairing();
    this.#cancelRestart();
    this.#restartPending = false;
    this.#update?.reset();
    this.#updateAdvertising = false;
    this.#dropConnection();
  }

  /** Completes the five-second hold under the cover. The pairing light shows and the code stays. */
  pressButton(): void {
    if (!this.powered) return;
    const updating = this.#update !== undefined && this.#update.session !== "closed";
    if ((this.pairing !== undefined && !this.development) || updating) {
      this.ignoredPresses += 1;
      return;
    }
    this.#openPairing();
  }

  /** The hub's Update offer with action 3, over LoRa: opens the update window. */
  offerUpdate(offer: BluetoothOffer): boolean {
    if (!this.powered || this.#update === undefined) return false;
    if (this.#pairingOpen) this.#closePairing();
    this.#update.offer(offer);
    return true;
  }

  #openPairing(): void {
    this.#cancelWindow();
    this.#pairingOpen = true;
    this.#pairingEnded = false;
    this.wrongCodes = 0;
    this.#cancelWindow = this.#clock.after(this.#windowMs, () => {
      // It stays open while a phone is connected.
      if (this.#connection === undefined) this.#closePairing();
      else this.#pairingEnded = true;
    });
  }

  #closePairing(): void {
    this.#cancelWindow();
    if (!this.#pairingOpen) return;
    this.#pairingOpen = false;
    this.#pairingEnded = false;
    if (this.#protocomm !== undefined) this.#dropConnection();
  }

  #dropConnection(): void {
    const connection = this.#connection;
    this.#connection = undefined;
    this.#protocomm?.close();
    this.#protocomm = undefined;
    connection?.disconnect();
  }

  // ----- Peripheral -----

  advertising(): AdvertData | null {
    if (!this.powered || this.#connection !== undefined) return null;
    if (this.#pairingOpen) {
      return {
        serviceUuids: [PROTOCOMM.serviceUuid],
        serviceData: [],
        localName: pairAdvertName(this.chipId) ?? null,
      };
    }
    if (this.#updateAdvertising && this.pairing !== undefined) {
      return {
        serviceUuids: [BLUETOOTH_UPDATE.serviceUuid],
        serviceData: [],
        localName: bluetoothUpdateName(this.pairing.address),
      };
    }
    return null;
  }

  accept(connection: PeripheralConnection): ConnectionHandlers | undefined {
    if (this.advertising() === null) return undefined;
    this.connections += 1;
    this.#connection = connection;
    return this.#pairingOpen ? this.#pairingHandlers(connection) : this.#updateHandlers(connection);
  }

  #pairingHandlers(connection: PeripheralConnection): ConnectionHandlers {
    const protocomm = new ProtocommConnection(
      {
        version: () => this.#version(),
        wrongCode: () => {
          this.#wrongCode();
        },
        setup: (message) => {
          this.#events.pairingSetup?.();
          const answered = answerSetup(this, message);
          if (!answered.ok) return answered;
          if (answered.value.effect === "provisioned") this.#accepted();
          return { ok: true, value: answered.value.answer };
        },
      },
      this.#security(this.code),
    );
    this.#protocomm = protocomm;
    return {
      services: [PAIRING_SERVICE],
      write: (characteristic, data) => protocomm.write(characteristic, data),
      read: (characteristic) => {
        const value = protocomm.read(characteristic);
        if (this.#restartPending && characteristic === PAIRING_UUIDS.setup) {
          // The Provision result has been read: the board restarts as its role.
          this.#clock.after(0, () => {
            this.#restart();
          });
        }
        return value;
      },
      subscribed: () => undefined,
      closed: () => {
        if (this.#connection !== connection) return;
        this.#connection = undefined;
        protocomm.close();
        this.#protocomm = undefined;
        if (this.#pairingEnded) this.#closePairing();
      },
    };
  }

  #updateHandlers(connection: PeripheralConnection): ConnectionHandlers {
    const update = this.#update;
    let up = false;
    return {
      services: [UPDATE_SERVICE],
      write: (characteristic, data, withResponse) => {
        if (characteristic !== BLUETOOTH_UPDATE.rxUuid || withResponse) {
          return { ok: false, error: "notPermitted" };
        }
        if (connection.mtu < MIN_UPDATE_MTU || data.length === 0) {
          return { ok: false, error: "invalidLength" };
        }
        update?.frame(data);
        return { ok: true };
      },
      read: () => ({ ok: false, error: "notPermitted" }),
      subscribed: (characteristic, on) => {
        if (characteristic !== BLUETOOTH_UPDATE.txUuid || this.#connection !== connection) return;
        if (on && !up) {
          up = true;
          update?.linkUp(connection.mtu);
        } else if (!on && up) {
          up = false;
          update?.linkDown();
        }
      },
      closed: () => {
        if (this.#connection !== connection) return;
        this.#connection = undefined;
        if (up) {
          up = false;
          update?.linkDown();
        }
      },
    };
  }

  #version(): Uint8Array {
    const { major, minor, patch } = this.firmware;
    return new TextEncoder().encode(
      JSON.stringify({
        v: PAIR_PROTOCOL_LABEL,
        role: this.role,
        chip: hex(this.chipId),
        firmware: `${major}.${minor}.${patch}`,
        sec: 2,
      }),
    );
  }

  #wrongCode(): void {
    this.wrongCodes += 1;
    if (this.wrongCodes >= MAX_WRONG_CODES) {
      // The board stops listening, once the refused write's error has gone back.
      this.#clock.after(0, () => {
        this.#closePairing();
      });
    }
  }

  /** SetupHolder: storing a pairing forgets the old first. */
  store(pairing: PairingData): boolean {
    this.pairing = undefined;
    this.#update = undefined;
    if (this.storageFails) return false;
    this.pairing = pairing;
    return true;
  }

  identity(): Uint8Array {
    return identityOf(this);
  }

  #accepted(): void {
    this.#restartPending = true;
    if (this.#restartBeforeResult) {
      this.#clock.after(0, () => {
        this.#restart();
      });
      return;
    }
    this.#cancelRestart = this.#clock.after(this.#restartMs, () => {
      this.#restart();
    });
  }

  #restart(): void {
    if (!this.#restartPending) return;
    this.#restartPending = false;
    this.#cancelRestart();
    this.restarts += 1;
    this.#closePairing();
    this.#dropConnection();
    const pairing = this.pairing;
    if (pairing === undefined) return;
    this.#update = this.#makeUpdate(pairing);
    this.#events.provisioned?.(pairing, this);
  }

  #makeUpdate(pairing: PairingData): UpdateService {
    const host: UpdateHost = {
      address: pairing.address,
      deviceKey: pairing.key,
      hubIdentity: pairing.hubIdentity,
      signingKey: pairing.firmwareSigningKey,
      role: this.role,
      capacity: this.capacity,
      random: (bytes) => this.#random(bytes),
      advertise: (on) => {
        this.#updateAdvertising = on;
      },
      // Like the ESP-IDF link, refuse both directions below the negotiated floor.
      notify: (frame) => {
        const link = this.#connection;
        return (
          link !== undefined &&
          link.mtu >= MIN_UPDATE_MTU &&
          link.notify(BLUETOOTH_UPDATE.txUuid, frame)
        );
      },
      disconnect: () => {
        this.#dropConnection();
      },
      report: (status) => {
        this.statuses.push(status);
        this.#events.updateStatus?.(status, this);
      },
    };
    return new UpdateService(this.#clock, host);
  }
}

/** Puts a board on the air and powers it on. */
export function placeBoard(air: BleAir, board: ScriptedBoard): ScriptedBoard {
  air.add(board);
  board.powerOn();
  return board;
}

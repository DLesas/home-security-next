/**
 * Bluetooth on the phone (m3-design.md sections 5 and 7): the central role, pairing's setup
 * session, and serving a firmware image to a sensor. Types only, frozen by step 0 as the design
 * gives them. P4 builds `BleCentral` on react-native-ble-plx and the update's `FirmwareServer`
 * over `@hsn/protocol/update`'s frames; `openSetupSession` runs `@hsn/protocol/pairing`'s security
 * 2 client over a `GattLink`; `tools/ble-bench`'s scripted boards and the simulators' bridge sit
 * behind the same `BleCentral` (P6). The web build has no Bluetooth (D93).
 */
import type { PairingCodeText } from "@hsn/protocol/pairing";
import type { Outcome } from "./split";

/** Bluetooth's state on this phone. */
export type BleState = "on" | "off" | "unauthorized" | "unsupported";

export type BleFault = "off" | "unauthorized" | "notFound" | "lost" | "timeout" | "failed";

/** One advertisement seen in a scan. */
export interface Advert {
  readonly id: string;
  readonly name: string | null;
  /** The advertised service data for the scanned service, if any (pairing's format 1). */
  readonly serviceData: Uint8Array | null;
  readonly rssi: number;
}

/** A connection to one board's GATT server. */
export interface GattLink {
  /** The MTU agreed. */
  readonly mtu: number;
  write(
    characteristic: string,
    data: Uint8Array,
    response: boolean,
  ): Promise<Outcome<void, BleFault>>;
  read(characteristic: string): Promise<Outcome<Uint8Array, BleFault>>;
  /** Subscribes to a characteristic's notifications; returns the unsubscribe. */
  watch(characteristic: string, data: (bytes: Uint8Array) => void): () => void;
  /** Called once when the link closes: null when this side closed it. */
  onClosed(closed: (fault: BleFault | null) => void): void;
  close(): void;
}

export interface BleCentral {
  state(): Promise<BleState>;
  /** Scans for boards advertising `service` (a UUID); returns the stop. */
  scan(service: string, found: (advert: Advert) => void): () => void;
  connect(id: string, wantMtu: number): Promise<Outcome<GattLink, BleFault>>;
}

// ----- Pairing (section 5) -----

export type PairFault = BleFault | "wrongCode" | "tooManyTries" | "protocol";

/** Pairing, layers 2 and 3 over a link: a protocomm security 2 session, then setup messages. */
export interface SetupSession {
  /** One §10 setup message written to `hsn-setup` inside the session, and the board's answer. */
  exchange(message: Uint8Array): Promise<Outcome<Uint8Array, PairFault>>;
  close(): void;
}

/** Reads `proto-ver`, then runs SRP6a with the board's code as the password over `prov-session`. */
export type OpenSetupSession = (
  link: GattLink,
  code: PairingCodeText,
) => Promise<Outcome<SetupSession, PairFault>>;

// ----- Update over Bluetooth (section 7; m3-updates-design.md section 5) -----

/** `firmware.bluetooth`'s reply, as the phone holds it: in memory only, until `expiresAtMs`. */
export interface BluetoothUpdate {
  readonly device: number;
  /** The device's address, a u32; the sensor advertises as `hsn-<address in 8 hex digits>`. */
  readonly address: number;
  /** 8 bytes. */
  readonly imageId: Uint8Array;
  readonly version: string;
  readonly fileBytes: number;
  readonly sha256: Uint8Array;
  /** 32 bytes, never written, logged or shown. */
  readonly sessionKey: Uint8Array;
  readonly windowS: number;
  /** Now plus `expiresInMs`, on the phone's clock. */
  readonly expiresAtMs: number;
  readonly needsWake: boolean;
}

export type UpdateFault = BleFault | "wrongTag" | "windowEnded" | "expired" | "protocol";

/** Serves the file to one sensor over the update service: Hello, Open, (Get, Data)…, Done. */
export interface FirmwareServer {
  serve(
    link: GattLink,
    update: BluetoothUpdate,
    file: Uint8Array,
    served: (highestOffset: number) => void,
  ): Promise<Outcome<{ readonly verified: boolean; readonly reason: number }, UpdateFault>>;
}

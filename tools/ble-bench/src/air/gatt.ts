/**
 * The peripheral's side of the scripted air: what a board shows to the air (its advertising and
 * its GATT server) and what the air tells it (a central connected, subscribed, wrote, read, went).
 * The limits are Bluetooth's, as NimBLE and the phones' stacks apply them:
 *
 * - **MTU.** The central asks for one; the link takes the smallest of the ask, the central's own
 *   limit and the peripheral's (never under 23, Bluetooth's default). An ATT payload is the MTU
 *   less 3.
 * - **Notifications** carry at most MTU − 3 bytes; a longer one is refused (`notify` is false).
 * - **Writes without response** carry at most MTU − 3 bytes; the central's stack refuses a longer
 *   one before it is sent.
 * - **Writes with response and reads** may be long (Bluetooth's prepared writes and blob reads,
 *   which iOS, Android and NimBLE do by themselves) up to an attribute's 512 bytes
 *   (`BLE_ATT_ATTR_MAX_LEN`, as protocomm's `PROTOCOMM_NIMBLE_MAX_PAYLOAD_LEN`).
 */

/** Bluetooth's default ATT MTU, the least a link has. */
export const MIN_MTU = 23;
/** An ATT payload is the MTU less its 3-byte header. */
export const ATT_HEADER_BYTES = 3;
/** The longest attribute value, and so the longest long write or long read. */
export const MAX_ATTRIBUTE_BYTES = 512;

/** An ATT error a peripheral answers a write or a read with (Bluetooth Core, vol 3, part F). */
export type AttError =
  /** The characteristic does not allow it, or is not there. */
  | "notPermitted"
  /** Too long, or empty where that is refused. */
  | "invalidLength"
  /** NimBLE's `BLE_ATT_ERR_UNLIKELY`: the server could not handle it. */
  | "unlikely"
  /** NimBLE's `BLE_ATT_ERR_INVALID_PDU`: protocomm's answer to a request its handler refused. */
  | "invalidPdu";

export interface CharacteristicSpec {
  readonly uuid: string;
  readonly read?: boolean;
  readonly write?: boolean;
  readonly writeWithoutResponse?: boolean;
  readonly notify?: boolean;
}

export interface ServiceSpec {
  readonly uuid: string;
  readonly characteristics: readonly CharacteristicSpec[];
}

/** What a board advertises: the advertisement and its scan response, as a central merges them. */
export interface AdvertData {
  /** Service UUIDs in the advertisement (lower case). */
  readonly serviceUuids: readonly string[];
  /** Service data, by service UUID. */
  readonly serviceData: readonly (readonly [uuid: string, data: Uint8Array])[];
  /** The local name, in the scan response. */
  readonly localName: string | null;
}

/** The air's handle on one connection, for the peripheral. */
export interface PeripheralConnection {
  /** The MTU agreed for this connection. */
  readonly mtu: number;
  /**
   * Sends a notification, in order with every other. False when the central has not subscribed
   * to it, it is longer than MTU − 3, or the connection is gone.
   */
  notify(characteristic: string, data: Uint8Array): boolean;
  /** The peripheral ends the connection (its central sees `lost`). */
  disconnect(): void;
}

/** What a peripheral does on one connection. */
export interface ConnectionHandlers {
  readonly services: readonly ServiceSpec[];
  write(
    characteristic: string,
    data: Uint8Array,
    withResponse: boolean,
  ): { readonly ok: true } | { readonly ok: false; readonly error: AttError };
  read(
    characteristic: string,
  ):
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: AttError };
  /** The central subscribed to (true) or left (false) a characteristic's notifications. */
  subscribed(characteristic: string, on: boolean): void;
  /** The connection ended; `byCentral` when the central closed it. */
  closed(byCentral: boolean): void;
}

/** A scripted peripheral the air can find and connect to. */
export interface Peripheral {
  /** The id a central sees (on iOS a UUID the phone makes, on Android the address). */
  readonly id: string;
  /** Its signal as a central hears it. */
  readonly rssi: number;
  /** The largest MTU its stack takes (NimBLE's `CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU`). */
  readonly maxMtu: number;
  /** What it advertises now, or null when it does not (off, or a central is connected). */
  advertising(): AdvertData | null;
  /**
   * A central connects. The peripheral's handlers for the connection, or undefined when it does
   * not take one now (not advertising, one connection already).
   */
  accept(connection: PeripheralConnection): ConnectionHandlers | undefined;
}

/** Whether a characteristic of `services` allows an operation. */
export function allows(
  services: readonly ServiceSpec[],
  characteristic: string,
  operation: "read" | "write" | "writeWithoutResponse" | "notify",
): boolean {
  const uuid = characteristic.toLowerCase();
  for (const service of services) {
    for (const spec of service.characteristics) {
      if (spec.uuid.toLowerCase() === uuid) return spec[operation] === true;
    }
  }
  return false;
}

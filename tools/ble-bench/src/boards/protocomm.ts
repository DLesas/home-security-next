/**
 * ESP-IDF's protocomm over Bluetooth Low Energy, as `components/protocomm/src/transports/`
 * `protocomm_nimble.c` and `src/common/protocomm.c` (v6.1.1, read on this Mac) carry it, with
 * pairing's endpoints (`PROTOCOMM` in `@hsn/protocol/pairing`): one GATT service, one
 * characteristic per endpoint, each read and written; a request is written (with response) and
 * its answer read back.
 *
 * What the transport does, and so what the scripted board does:
 *
 * - An endpoint's characteristic UUID is the service's with bytes 12 and 13 of its little-endian
 *   array replaced by the endpoint's 16-bit value: in the written form, characters 4 to 7.
 * - A write of no bytes is taken and ignored. A write over 512 bytes is refused
 *   (`BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN`).
 * - The handler's answer is kept for that characteristic, and a read returns the last one kept
 *   (nothing, before any). A handler that refuses fails the write (`BLE_ATT_ERR_INVALID_PDU`) and
 *   keeps the answer before.
 * - `proto-ver` answers in the clear, whatever was written. `prov-session` goes to the security's
 *   handler. Every other endpoint's request is decrypted, handled and its answer encrypted; a
 *   request that does not decrypt fails the write.
 * - At a disconnect the answers kept are cleared ("Avoid stale response reuse across sessions")
 *   and the security's session is closed.
 */
import { PROTOCOMM } from "../../../../packages/protocol/src/pairing/constants.ts";
import type { AttError, ServiceSpec } from "../air/gatt.ts";
import { MAX_ATTRIBUTE_BYTES } from "../air/gatt.ts";
import type { Outcome } from "../outcome.ts";
import type { PairingSecurityServer, SessionRefusal } from "./pairing-security.ts";

/** An endpoint's characteristic UUID, from the service's and its 16-bit value. */
export function endpointUuid(serviceUuid: string, uuid16: number): string {
  const service = serviceUuid.toLowerCase();
  return `${service.slice(0, 4)}${uuid16.toString(16).padStart(4, "0")}${service.slice(8)}`;
}

/** Pairing's three characteristics. */
export const PAIRING_UUIDS = {
  service: PROTOCOMM.serviceUuid,
  protoVersion: endpointUuid(PROTOCOMM.serviceUuid, PROTOCOMM.endpoints.protoVersion.uuid16),
  session: endpointUuid(PROTOCOMM.serviceUuid, PROTOCOMM.endpoints.session.uuid16),
  setup: endpointUuid(PROTOCOMM.serviceUuid, PROTOCOMM.endpoints.setup.uuid16),
} as const;

/** Pairing's GATT layout. */
export const PAIRING_SERVICE: ServiceSpec = {
  uuid: PAIRING_UUIDS.service,
  characteristics: [PAIRING_UUIDS.protoVersion, PAIRING_UUIDS.session, PAIRING_UUIDS.setup].map(
    (uuid) => ({ uuid, read: true, write: true }),
  ),
};

/** What the board answers on its endpoints. */
export interface ProtocommBoard {
  /** `proto-ver`'s answer, in the clear. */
  version(): Uint8Array;
  /** A `prov-session` request was refused as a mismatch: a wrong code. */
  wrongCode(): void;
  /** `hsn-setup`: one setup message, its answer, or a refusal (the write fails). */
  setup(message: Uint8Array): Outcome<Uint8Array, "refused">;
}

/** One connection's protocomm: its kept answers and its security's session. */
export class ProtocommConnection {
  readonly #answers = new Map<string, Uint8Array>();
  /** Writes refused, by endpoint name: for a test. */
  readonly refused: string[] = [];

  constructor(
    readonly board: ProtocommBoard,
    readonly security: PairingSecurityServer,
  ) {}

  write(
    characteristic: string,
    data: Uint8Array,
  ): { readonly ok: true } | { readonly ok: false; readonly error: AttError } {
    const uuid = characteristic.toLowerCase();
    if (data.length === 0) return { ok: true };
    if (data.length > MAX_ATTRIBUTE_BYTES) return { ok: false, error: "invalidLength" };
    const answer = this.#handle(uuid, data);
    if (answer === undefined) return { ok: false, error: "unlikely" };
    if (!answer.ok) {
      this.refused.push(this.#name(uuid));
      return { ok: false, error: "invalidPdu" };
    }
    if (answer.value.length > MAX_ATTRIBUTE_BYTES) return { ok: false, error: "invalidLength" };
    this.#answers.set(uuid, answer.value);
    return { ok: true };
  }

  read(characteristic: string): { readonly ok: true; readonly value: Uint8Array } {
    return {
      ok: true,
      value: (this.#answers.get(characteristic.toLowerCase()) ?? new Uint8Array()).slice(),
    };
  }

  /** The disconnect: answers kept are cleared, so none is read by the next connection. */
  close(): void {
    this.#answers.clear();
  }

  #name(uuid: string): string {
    if (uuid === PAIRING_UUIDS.protoVersion) return PROTOCOMM.endpoints.protoVersion.name;
    if (uuid === PAIRING_UUIDS.session) return PROTOCOMM.endpoints.session.name;
    if (uuid === PAIRING_UUIDS.setup) return PROTOCOMM.endpoints.setup.name;
    return uuid;
  }

  #handle(
    uuid: string,
    data: Uint8Array,
  ): Outcome<Uint8Array, SessionRefusal | "refused"> | undefined {
    if (uuid === PAIRING_UUIDS.protoVersion) return { ok: true, value: this.board.version() };
    if (uuid === PAIRING_UUIDS.session) {
      const answer = this.security.session(data);
      if (!answer.ok && answer.fault === "mismatch") this.board.wrongCode();
      return answer;
    }
    if (uuid === PAIRING_UUIDS.setup) {
      const plain = this.security.decrypt(data);
      if (!plain.ok) return plain;
      const answer = this.board.setup(plain.value);
      if (!answer.ok) return answer;
      return this.security.encrypt(answer.value);
    }
    return undefined;
  }
}

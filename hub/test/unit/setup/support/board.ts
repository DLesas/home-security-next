/**
 * A board on a USB link, answering setup messages exactly as the firmware's `SetupService` does
 * (firmware/core/src/device/setup.cpp; protocol.md §10):
 *
 * - Identify: its Identity.
 * - Provision: accepted by a development build at any time, and by a release gateway only while
 *   unpaired; otherwise refused. Accepting erases the old pairing first; a storage failure then
 *   answers refused with the pairing gone. A Provision that does not decode is "not valid".
 * - Erase: a development build erases its pairing and restarts, with no answer; a release build
 *   ignores it.
 * - Set role: an unlisted role, or a release build with a role stored, keeps the role; otherwise
 *   the role is stored (forgetting the pairing when it changes). The answer is its Identity.
 *
 * Tests can make it lose its answers (a board unplugged, or slow), or fail to store.
 */
import {
  decodeSetupMessage,
  encodeSetupMessage,
  HUB_IDENTITY_LENGTH,
  type PairingData,
  ProvisionResultCode,
  Role,
  type SetupMessage,
  SetupType,
} from "@hsn/protocol";
import type { Mono } from "../../../../src/core/model/time.ts";
import type { ScriptedDevice } from "../../../world/world.ts";

export interface BoardOptions {
  readonly role: number;
  readonly chipId: Uint8Array;
  readonly development: boolean;
  readonly firmware?: { readonly major: number; readonly minor: number; readonly patch: number };
  readonly pairing?: PairingData;
}

export class ScriptedBoard implements ScriptedDevice {
  role: number;
  readonly chipId: Uint8Array;
  readonly development: boolean;
  readonly firmware: { readonly major: number; readonly minor: number; readonly patch: number };
  pairing: PairingData | undefined;
  /** When false, the board takes messages but its answers are lost. */
  answers = true;
  /** When true, nothing reaches the board: a message the hub never sent, as after a crash. */
  deaf = false;
  /** Called with each pairing before the board stores it, for checks at that moment. */
  onProvision: ((pairing: PairingData) => void) | undefined;
  /** When true, storing a pairing fails, as `SetupService::provision` handles it. */
  storageFails = false;
  /** Every pairing it accepted, in order. */
  readonly accepted: PairingData[] = [];
  /** Every setup message it received. */
  readonly received: SetupMessage[] = [];
  restarts = 0;

  constructor(options: BoardOptions) {
    this.role = options.role;
    this.chipId = options.chipId;
    this.development = options.development;
    this.firmware = options.firmware ?? { major: 0, minor: 1, patch: 0 };
    this.pairing = options.pairing;
  }

  nextWake(): Mono | undefined {
    return undefined;
  }

  wake(): readonly Uint8Array[] {
    return [];
  }

  identity(): Uint8Array {
    return encodeSetupMessage({
      type: SetupType.Identity,
      role: this.role,
      chipId: this.chipId,
      firmwareVersion: this.firmware,
      paired: this.pairing !== undefined,
      hubIdentity: this.pairing?.hubIdentity ?? new Uint8Array(HUB_IDENTITY_LENGTH),
      developmentBuild: this.development,
    });
  }

  #result(result: number): readonly Uint8Array[] {
    return this.#answer(encodeSetupMessage({ type: SetupType.ProvisionResult, result }));
  }

  #answer(bytes: Uint8Array): readonly Uint8Array[] {
    return this.answers ? [bytes] : [];
  }

  receive(bytes: Uint8Array): readonly Uint8Array[] {
    if (this.deaf) return [];
    const decoded = decodeSetupMessage(bytes);
    if (!decoded.ok) {
      return bytes[1] === SetupType.Provision ? this.#result(ProvisionResultCode.NotValid) : [];
    }
    const message = decoded.value;
    this.received.push(message);
    switch (message.type) {
      case SetupType.Identify:
        return this.#answer(this.identity());
      case SetupType.Provision: {
        const allowed =
          this.development || (this.role === Role.Gateway && this.pairing === undefined);
        if (!allowed) return this.#result(ProvisionResultCode.Refused);
        this.onProvision?.(message.pairing);
        this.pairing = undefined;
        if (this.storageFails) return this.#result(ProvisionResultCode.Refused);
        this.pairing = message.pairing;
        this.accepted.push(message.pairing);
        this.restarts += 1;
        return this.#result(ProvisionResultCode.Accepted);
      }
      case SetupType.Erase:
        if (this.development) {
          this.pairing = undefined;
          this.restarts += 1;
        }
        return [];
      case SetupType.SetRole: {
        const known =
          message.role === Role.Sensor ||
          message.role === Role.Siren ||
          message.role === Role.Gateway;
        const stored = this.role !== 0;
        if (!known || (stored && !this.development) || this.role === message.role) {
          return this.#answer(this.identity());
        }
        if (stored) this.pairing = undefined;
        this.role = message.role;
        this.restarts += 1;
        return this.#answer(this.identity());
      }
      default:
        return [];
    }
  }
}

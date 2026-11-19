/**
 * The setup messages over Bluetooth (protocol.md section 10, "Setup messages, USB and Bluetooth
 * pairing", "Who accepts what"; m3-design.md section 5, layer 3): byte for byte as over USB, one
 * per request on `hsn-setup`, inside the session, with Bluetooth's rule:
 *
 * - **Identify** at any time in a session: the board's Identity.
 * - **Provision** only while unpaired, in every build (a paired board opens no pairing window);
 *   otherwise answered "refused". Accepting forgets the old pairing first, so a storage failure
 *   answers "refused" with no pairing kept (as `SetupService::provision` and `ScriptedBoard` in
 *   `hub/test/unit/setup/support/board.ts`). A Provision whose pairing data does not decode is
 *   "not valid".
 * - **Erase and Set role never** (USB only), nor anything not a setup message: the request is
 *   refused, and protocomm fails the write. How the firmware's `SetupService` will refuse them on
 *   this path is F1's to fix; the bench refuses the write, so the phone never reads an answer.
 */
import { Role } from "../../../../packages/protocol/src/messages/common.ts";
import type { PairingData } from "../../../../packages/protocol/src/pairing.ts";
import { HUB_IDENTITY_LENGTH } from "../../../../packages/protocol/src/pairing.ts";
import {
  decodeSetupMessage,
  encodeSetupMessage,
  ProvisionResultCode,
  SETUP_MARKER,
  SetupType,
} from "../../../../packages/protocol/src/usb/setup.ts";
import { fault, ok, type Outcome } from "../outcome.ts";

export interface FirmwareVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** What the setup messages read and change on a board. */
export interface SetupHolder {
  readonly role: Role;
  readonly chipId: Uint8Array;
  readonly firmware: FirmwareVersion;
  readonly pairing: PairingData | undefined;
  /** Stores a pairing, forgetting the old first; false when storing failed (none is kept). */
  store(pairing: PairingData): boolean;
}

/** The board's Identity message. */
export function identityOf(holder: SetupHolder): Uint8Array {
  return encodeSetupMessage({
    type: SetupType.Identity,
    role: holder.role,
    chipId: holder.chipId,
    firmwareVersion: holder.firmware,
    paired: holder.pairing !== undefined,
    hubIdentity: holder.pairing?.hubIdentity ?? new Uint8Array(HUB_IDENTITY_LENGTH),
    // The scripted boards are release builds: a paired board is never reached over Bluetooth.
    developmentBuild: false,
  });
}

function result(code: ProvisionResultCode): Uint8Array {
  return encodeSetupMessage({ type: SetupType.ProvisionResult, result: code });
}

/** What a setup message did, besides its answer. */
export type SetupEffect = "none" | "provisioned";

/** One setup message over Bluetooth: its answer and what it did, or a refusal of the write. */
export function answerSetup(
  holder: SetupHolder,
  message: Uint8Array,
): Outcome<{ readonly answer: Uint8Array; readonly effect: SetupEffect }, "refused"> {
  if (message[0] !== SETUP_MARKER) return fault("refused");
  const decoded = decodeSetupMessage(message);
  if (!decoded.ok) {
    return message[1] === SetupType.Provision
      ? ok({ answer: result(ProvisionResultCode.NotValid), effect: "none" })
      : fault("refused");
  }
  const setup = decoded.value;
  switch (setup.type) {
    case SetupType.Identify:
      return ok({ answer: identityOf(holder), effect: "none" });
    case SetupType.Provision: {
      if (holder.pairing !== undefined) {
        return ok({ answer: result(ProvisionResultCode.Refused), effect: "none" });
      }
      if (!holder.store(setup.pairing)) {
        return ok({ answer: result(ProvisionResultCode.Refused), effect: "none" });
      }
      return ok({ answer: result(ProvisionResultCode.Accepted), effect: "provisioned" });
    }
    default:
      // Erase, Set role, and a device's own messages: never over Bluetooth.
      return fault("refused");
  }
}

export { Role };

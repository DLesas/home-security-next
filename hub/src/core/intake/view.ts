/**
 * Read-only selectors over the intake module's slice that other modules may use (hub-design.md
 * section 2): a device's `device_state` row as intake holds it, and the authentic copies of a
 * siren's packets for its best gateway (section 8, "Which gateway a packet goes through").
 *
 * SPEC-QUESTION: `device_state` is one row per device, written as a full value (section 2), yet
 * its columns belong to several modules: the window and readings to intake, the estimates to
 * slots (sensors) and sirens, the uptime to gateways. The reading taken: intake writes the row of
 * every sensor and siren it accepts a packet from, and slots writes a sensor's row when its phase
 * changes (section 5: written now); both build it with `deviceStateRow`, so neither erases the
 * other's columns. Gateways' rows are the gateways module's own.
 */
import { encodeReplayWindow } from "@hsn/protocol";
import type { DeviceId } from "../model/ids.ts";
import { mono } from "../model/time.ts";
import type { DeviceStateRow } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import type { KeyUsed } from "../model/cipher.ts";
import type { KnownDevice } from "./state.ts";

export {
  afterCommit,
  afterSwitch,
  failingCommitWrites,
  type KeyChangeEntry,
  type KeyChangeMade,
  type KeyChanges,
  keyChangeAllowed,
  keyChangedDevice,
  keyChangesFromSnapshot,
  makeKeyChange,
  NO_KEY_CHANGES,
  recordedBody,
  sealKeyOf,
  switchedCounter,
  switchWrites,
  withKeyChange,
  withoutDevice,
} from "./rekey.ts";

/** What intake knows of a device, or undefined for one it does not open packets from. */
export function knownDevice(view: HubState, device: DeviceId): KnownDevice | undefined {
  return view.intake.devices.get(device);
}

/**
 * The `device_state` row of a sensor or siren: intake's columns as they are now, with
 * `estimates` from the module that owns them, or as the snapshot had them when none is given.
 */
export function deviceStateRow(
  view: HubState,
  device: DeviceId,
  estimates?: Uint8Array | null,
): DeviceStateRow | undefined {
  const known = view.intake.devices.get(device);
  if (known === undefined) return undefined;
  return {
    deviceId: device,
    boot: view.intake.boot,
    lastSeenMono: known.heardAt ?? mono(0),
    lastSeenMs: known.heardMs ?? 0,
    clockOk: known.heardTrusted,
    window: encodeReplayWindow(known.window),
    reading: known.reading,
    rssi: known.rssi,
    snrQ: known.snrQ,
    bestGatewayId: known.bestGateway,
    uptimeS: null,
    estimates: estimates === undefined ? known.estimates : estimates,
  };
}

/**
 * The key the newest packet under a key held at the backup opened under (`oldKeyPacket`, D141):
 * for a row both of whose keys were held at the backup, the key the device holds.
 */
export function lastOldKey(view: HubState, device: DeviceId): KeyUsed | undefined {
  return view.intake.rekey.get(device)?.lastKey;
}

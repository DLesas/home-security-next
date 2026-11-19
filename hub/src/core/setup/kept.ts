/**
 * What adding a board again writes before its Provision goes, over USB (`hsn usb add`) and from a
 * phone (`pair.prepare`) alike (hub-design.md section 9; m3-design section 5, "A chip the hub
 * holds as reset by its owner"):
 *
 * - the key and the hub's resume point of 1,024, written now (`keyWrites`);
 * - for a row the chip keeps (reset by its owner, state 3; or left behind by a forced move, state
 *   5) the same row, by its number and address: `deviceAdded` again, which the registry reads as
 *   the kept row provisioning again, under the name given now, and the device modules as a device
 *   new to them, so its counters and settings start again under its new key. A row left behind is
 *   first `deviceRemoved`, as a reset one already was, so nothing of its old key's state stays.
 */
import { err, ok, type Result } from "neverthrow";
import type { Effect } from "../model/effects.ts";
import { type CoreFault, coreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { type DeviceRow, DeviceState, Rekey } from "../model/rows.ts";
import { drawKey } from "./provision.ts";

/** The hub's resume point written at pairing: counters 1 to 1,023 are usable at once (section 4). */
export const PAIRING_RESUME_POINT = 1024;

/** The key and the hub's resume point for it, written now (section 9). */
export function keyWrites(device: DeviceId, key: Uint8Array): readonly Effect[] {
  return [
    {
      kind: "write",
      durability: "now",
      op: {
        table: "device_keys",
        op: "upsert",
        row: { deviceId: device, key, nextKey: null, rekey: Rekey.None },
      },
    },
    {
      kind: "write",
      durability: "now",
      op: {
        table: "send_counters",
        op: "upsert",
        row: { deviceId: device, resumePoint: PAIRING_RESUME_POINT },
      },
    },
  ];
}

/** A plan to provision a kept row: its number and address, a new key, and what goes first. */
export interface KeptPlan {
  readonly device: DeviceId;
  readonly address: number;
  readonly key: Uint8Array;
  readonly before: readonly (Internal | Effect)[];
}

/** The kept row `row` provisioned again as `name`, with a key drawn from the input's entropy. */
export function keptPlan(
  ctx: Context,
  row: DeviceRow,
  role: number,
  name: string,
): Result<KeptPlan, CoreFault> {
  if (row.state !== DeviceState.ResetByOwner && row.state !== DeviceState.LeftBehind)
    return err(
      coreFault(ctx.event, "core/setup", "a kept row that is neither reset nor left behind", {
        device: row.id,
      }),
    );
  return drawKey(ctx).andThen((key) =>
    ok({
      device: row.id,
      address: row.address,
      key,
      before: [
        ...(row.state === DeviceState.LeftBehind
          ? [{ kind: "deviceRemoved", device: row.id } satisfies Internal]
          : []),
        {
          kind: "deviceAdded",
          device: row.id,
          role,
          address: row.address,
          name,
        } satisfies Internal,
        ...keyWrites(row.id, key),
      ],
    }),
  );
}

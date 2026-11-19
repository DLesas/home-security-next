/**
 * Channel version 2's events: version 1's (`APP_EVENTS`, unchanged for a version 1 session), with
 * the `device` event carrying the version 2 device object, the `notification` event version 2's
 * notification (with `happenedAtMs`, D102), the `hub` event's two new `what` values
 * (docs/m4-design.md section 9) and the new `deviceUpdate` event (docs/m3-updates-design.md
 * section 4). Frozen by the joint step 0; open to additions until the first release (D119).
 */
import { z } from "zod";
import { APP_EVENTS } from "./events.ts";
import {
  deviceObjectV2,
  deviceUpdateState,
  imageRef,
  notificationObjectV2,
  updateHold,
  updateMethod,
  updateReason,
} from "./objects-v2.ts";
import { deviceRef } from "./values.ts";

/** The `hub` event's `what` in version 2: version 1's, then `relay` and `updateOffered` (RD 9). */
export const HUB_EVENT_WHATS_V2 = [
  ...APP_EVENTS.hub.unwrap().shape.what.options,
  /** The relay link's state or setting changed (`relay.status` says how). */
  "relay",
  /** A relay offered a hub release (`update.offers` says which). */
  "updateOffered",
] as const;

export const APP_EVENTS_V2 = {
  ...APP_EVENTS,
  device: APP_EVENTS.device.unwrap().extend({ device: deviceObjectV2 }).readonly(),
  /** A notification, with when its event happened (D102). */
  notification: notificationObjectV2,
  hub: APP_EVENTS.hub
    .unwrap()
    .extend({ what: z.enum(HUB_EVENT_WHATS_V2) })
    .readonly(),
  /**
   * A device's firmware update moved (m3-updates section 4), to people with manage system, in the
   * `devices` topic: at each transition, and at most once every 2 seconds ‡ of progress.
   */
  deviceUpdate: z
    .strictObject({
      device: deviceRef,
      image: imageRef,
      state: deviceUpdateState,
      held: updateHold.nullable(),
      method: updateMethod,
      /** Bytes the device holds, up to its last checkpoint. */
      bytes: z.int().min(0),
      /** The file's bytes: the header and the image. */
      of: z.int().min(0),
      reason: updateReason.optional(),
    })
    .readonly(),
} as const;

/** The topic each new event of version 2 belongs to (section 6, `subscribe`). */
export const NEW_EVENT_TOPICS_V2 = { deviceUpdate: "devices" } as const;

export type AppEventNameV2 = keyof typeof APP_EVENTS_V2;
export const APP_EVENT_NAMES_V2 = Object.keys(APP_EVENTS_V2) as readonly AppEventNameV2[];
export type AppEventBodyV2<N extends AppEventNameV2> = z.infer<(typeof APP_EVENTS_V2)[N]>;

/** An event of version 2, typed by name. */
export type AppEventV2 = {
  readonly [N in AppEventNameV2]: {
    readonly t: "evt";
    readonly rev: number;
    readonly ev: N;
    readonly body: AppEventBodyV2<N>;
  };
}[AppEventNameV2];

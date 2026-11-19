/**
 * Firmware updates in channel version 2 (docs/m3-updates-design.md section 4, "What the app
 * shows" and "App operations and events"; owner U8 for these two pieces only):
 *
 * - **Device objects' `update`**: `{state, held, method}` or null, from firmware's view
 *   (`deviceUpdateOf`), on every device object a version 2 session is given.
 * - **`deviceUpdate` events**: firmware's `deviceUpdateEvent` bodies, exactly as made, to every
 *   version 2 session subscribed to `devices` whose person has *manage system*; a version 1 session
 *   never sees one, nor any version 2 object.
 *
 * Both are wired: `versions.ts` gives device objects their update on a version 2 session, and
 * `v2-live.ts` sends `deviceUpdate` through `deviceUpdateFrames`.
 */
import { APP_PROTO_LATEST, type AppEventV2, type DeviceObjectV2 } from "@hsn/protocol/app";
import { deviceUpdateOf } from "../firmware/view.ts";
import type { CoreDeps } from "../model/handler.ts";
import type { ConnId } from "../model/ids.ts";
import type { DeviceUpdateEventBody } from "../model/messages.ts";
import type { DeviceRow } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { actorOfClient, hasGlobal } from "../people/view.ts";
import { deviceObject } from "./objects.ts";
import type { AppSlice } from "./state.ts";

/** The version 2 device object: version 1's, with its update (null when it has none). */
export function deviceObjectV2(
  view: HubState,
  deps: CoreDeps,
  row: DeviceRow,
): DeviceObjectV2 | undefined {
  const object = deviceObject(view, deps, row);
  return object === undefined ? undefined : { ...object, update: deviceUpdateOf(view, row.id) };
}

/** A `deviceUpdate` frame for one session. */
export interface DeviceUpdateFrame {
  readonly conn: ConnId;
  readonly message: Extract<AppEventV2, { readonly ev: "deviceUpdate" }>;
}

/**
 * The `deviceUpdate` frames of one body: each version 2 session in the `devices` topic whose actor
 * has manage system, in the order of the sessions, all with `rev`.
 */
export function deviceUpdateFrames(
  slice: AppSlice,
  view: HubState,
  body: DeviceUpdateEventBody,
  rev: number,
): readonly DeviceUpdateFrame[] {
  const frames: DeviceUpdateFrame[] = [];
  for (const session of slice.sessions.values()) {
    if (session.proto < APP_PROTO_LATEST || !session.topics.has("devices")) continue;
    const actor = actorOfClient(view, session.client);
    if (actor === undefined || !hasGlobal(view, actor, "manageSystem")) continue;
    frames.push({ conn: session.conn, message: { t: "evt", rev, ev: "deviceUpdate", body } });
  }
  return frames;
}

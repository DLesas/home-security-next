/**
 * Firmware updates in channel version 2, the two pieces `app` builds (docs/m3-updates-design.md
 * section 4): device objects' `update` from firmware's view, and `deviceUpdate` frames to the
 * version 2 sessions in the `devices` topic whose person has manage system, and to no other.
 */
import { describe, expect, test } from "bun:test";
import type { Topic } from "@hsn/protocol/app";
import { deviceObjectV2, deviceUpdateFrames } from "../../../src/core/app/updates.ts";
import type { Session } from "../../../src/core/app/state.ts";
import { encodeIds } from "../../../src/core/firmware/codes.ts";
import { clientId, connId, imageId, personId, rolloutId } from "../../../src/core/model/ids.ts";
import type { DeviceUpdateEventBody } from "../../../src/core/model/messages.ts";
import {
  ClientKind,
  DeviceUpdateState,
  ImageKind,
  RolloutStage,
  UpdateHeld,
  UpdateMethod,
} from "../../../src/core/model/rows.ts";
import type { StoreOp } from "../../../src/core/model/store.ts";
import { RekeyHub } from "../../scenarios/sensors/whole/support.ts";

const ANNA = personId(1);
const BEN = personId(2);

function client(id: number, person: typeof ANNA): StoreOp {
  return {
    table: "clients",
    op: "upsert",
    row: {
      id: clientId(id),
      personId: person,
      staticKey: new Uint8Array(32).fill(id),
      kind: ClientKind.Phone,
      name: `c${id}`,
      linkedByClient: null,
      createdMs: 0,
      removedMs: null,
      lastSeq: 0,
      lastSeenMs: null,
      backupKeyEpoch: null,
    },
  };
}

async function hub(): Promise<RekeyHub> {
  return RekeyHub.create({
    seed: (m) => [
      // User management on (D13), so Ben has no manage system.
      { table: "people_settings", op: "upsert", row: { userManagement: true } },
      {
        table: "people",
        op: "upsert",
        row: { id: ANNA, name: "Anna", createdMs: 0, removedMs: null, revision: 1 },
      },
      {
        table: "people",
        op: "upsert",
        row: { id: BEN, name: "Ben", createdMs: 0, removedMs: null, revision: 1 },
      },
      {
        table: "person_roles",
        op: "upsert",
        row: { personId: ANNA, manageUsers: false, manageSystem: true, revision: 1 },
      },
      {
        table: "person_roles",
        op: "upsert",
        row: { personId: BEN, manageUsers: false, manageSystem: false, revision: 1 },
      },
      client(3, ANNA),
      client(4, BEN),
      {
        table: "firmware_images",
        op: "upsert",
        row: {
          id: imageId(1),
          imageId: new Uint8Array(8).fill(1),
          sha256: new Uint8Array(32).fill(1),
          version: 0x020000,
          kind: ImageKind.Official,
          roles: 0b1110,
          bytes: 1000,
          header: new Uint8Array(128),
          manifest: "{}",
          file: "1.bin",
          addedMs: 0,
          addedBy: "t",
          removedMs: null,
        },
      },
      {
        table: "rollouts",
        op: "upsert",
        row: {
          id: rolloutId(1),
          image: imageId(1),
          devices: encodeIds([m.siren.id]),
          pilots: encodeIds([]),
          stage: RolloutStage.Rest,
          approvedBy: "t",
          approvedMs: 0,
          soakUntilMs: null,
          pausedReason: null,
          pausedDevice: null,
          endedMs: null,
        },
      },
      {
        table: "device_updates",
        op: "upsert",
        row: {
          deviceId: m.siren.id,
          rolloutId: rolloutId(1),
          state: DeviceUpdateState.Planned,
          method: UpdateMethod.OwnLink,
          held: UpdateHeld.Battery,
          bytes: 0,
          attempts: 0,
          sameVersion: false,
          lastReason: null,
          sinceMs: 0,
          bleNonce: null,
          bleExpiresMs: null,
          remindedMs: null,
        },
      },
    ],
  });
}

function session(conn: number, client: number, proto: number, topics: readonly Topic[]): Session {
  return {
    conn: connId(conn),
    client: clientId(client),
    listener: "lan",
    proto,
    app: "test",
    topics: new Set(topics),
    visible: new Set(),
  };
}

describe("device objects in version 2", () => {
  test("carry firmware's update, or null for a device with none", async () => {
    const h = await hub();
    const view = h.loop.state;
    const row = (id: number) => view.registry.devices.get(id as never) ?? expect.unreachable();
    const deps = { rules: h.rules } as never;
    const siren = deviceObjectV2(view, deps, row(h.members.siren.id));
    expect(siren?.update?.state).toBe("planned");
    expect(siren?.update).toEqual({ state: "planned", held: null, method: "ownLink" });
    const sensor = deviceObjectV2(view, deps, row(h.members.sensors[0]?.id ?? 0));
    expect(sensor?.update).toBeNull();
    expect(sensor?.name).toBe("front");
  });
});

describe("deviceUpdate frames", () => {
  test("to version 2 sessions in `devices` whose person has manage system, the body as made", async () => {
    const h = await hub();
    const view = h.loop.state;
    const sessions = new Map(
      [
        session(1, 3, 2, ["devices"]), // Anna, v2, devices: yes
        session(2, 3, 1, ["devices"]), // Anna, v1: never a version 2 frame
        session(3, 3, 2, ["arming"]), // not in the topic
        session(4, 4, 2, ["devices"]), // Ben, no manage system
        session(5, 99, 2, ["devices"]), // no such client
      ].map((s) => [s.conn, s]),
    );
    const body: DeviceUpdateEventBody = {
      device: h.members.siren.id,
      image: 1,
      state: "fetching",
      held: null,
      method: "ownLink",
      bytes: 64,
      of: 1128,
    };
    const frames = deviceUpdateFrames({ ...view.app, sessions }, view, body, 7);
    expect(frames).toEqual([
      { conn: connId(1), message: { t: "evt", rev: 7, ev: "deviceUpdate", body } },
    ]);
  });
});

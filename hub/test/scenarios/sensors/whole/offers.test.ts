/**
 * Update offers on every role and path, through the whole hub (docs/m3-updates-design.md sections
 * 4 and 5): firmware decides, the module that owns the key seals and sends. A sensor's offer only
 * in answer to its packet, bound to it, by the way it came (the gateway, or the Wi-Fi it joined for
 * its update); a reply's "update available" flag and a heartbeat answered while an offer waits; a
 * siren's on its Wi-Fi, after what is in flight; a gateway's in its session; update packets written
 * now; a transfer frame no grant covers counted and nothing more.
 */
import { describe, expect, test } from "bun:test";
import { type Message, MessageType, UpdateAction, UpdateHolding } from "@hsn/protocol";
import { encodeIds } from "../../../../src/core/firmware/codes.ts";
import { imageId, rolloutId } from "../../../../src/core/model/ids.ts";
import {
  DeviceUpdateState,
  ImageKind,
  RolloutStage,
  UpdateHeld,
  UpdateMethod,
} from "../../../../src/core/model/rows.ts";
import type { StoreOp } from "../../../../src/core/model/store.ts";
import { heartbeat, type Members, RekeyHub, SECOND, type Sensor } from "./support.ts";

const IMAGE_ID = new Uint8Array(8).fill(1);

/** An image in the store and a rollout under way to every device, each planned (D139). */
function rollout(members: Members): readonly StoreOp[] {
  const all = [members.gateway.id, ...members.sensors.map((s) => s.id), members.siren.id];
  return [
    {
      table: "firmware_images",
      op: "upsert",
      row: {
        id: imageId(1),
        imageId: IMAGE_ID,
        sha256: new Uint8Array(32).fill(1),
        version: 0x020000,
        kind: ImageKind.Official,
        roles: 0b1110,
        bytes: 1_000_000,
        header: new Uint8Array(128),
        manifest: "{}",
        file: "1.bin",
        addedMs: 0,
        addedBy: "test",
        removedMs: null,
      },
    },
    {
      table: "rollouts",
      op: "upsert",
      row: {
        id: rolloutId(1),
        image: imageId(1),
        devices: encodeIds(all),
        pilots: encodeIds([]),
        stage: RolloutStage.Rest,
        approvedBy: "test",
        approvedMs: 0,
        soakUntilMs: null,
        pausedReason: null,
        pausedDevice: null,
        endedMs: null,
      },
    },
    ...all.map((deviceId): StoreOp => ({
      table: "device_updates",
      op: "upsert",
      row: {
        deviceId,
        rolloutId: rolloutId(1),
        state: DeviceUpdateState.Planned,
        method: UpdateMethod.OwnLink,
        held: UpdateHeld.No,
        bytes: 0,
        attempts: 0,
        sameVersion: false,
        lastReason: null,
        sinceMs: 0,
        bleNonce: null,
        bleExpiresMs: null,
        remindedMs: null,
      },
    })),
  ];
}

const FLAGS = {
  doorOpen: false,
  coverOpen: false,
  usbPower: false,
  charging: false,
  replyWanted: false,
  localAlarmSounded: false,
  buzzing: false,
  listeningAtSendRate: false,
};

/** A heartbeat with a good battery (4.5 V), asking for a reply or not. */
function beat(replyWanted: boolean, version = 1): Message {
  return heartbeat({
    settingsVersion: version,
    batteryCode: 200,
    flags: { ...FLAGS, replyWanted },
  });
}

function query(): Message {
  return {
    type: MessageType.UpdateQuery,
    imageId: new Uint8Array(8),
    held: UpdateHolding.Nothing,
    bytesHeld: 0,
    batteryCode: 200,
    flags: { hasWifiDetails: true, externalPower: false },
  };
}

function sensor(hub: RekeyHub, index: number): Sensor {
  return hub.members.sensors[index] ?? expect.unreachable("no such sensor");
}

/** The last Update offer the device took. */
function lastOffer(device: { readonly took: readonly Message[] }) {
  const last = device.took.findLast((m) => m.type === MessageType.UpdateOffer);
  return last?.type === MessageType.UpdateOffer ? last : undefined;
}

describe("a sensor's offers", () => {
  test("the reply flag and the heartbeat rule follow firmware's offerWaiting, both ways", async () => {
    const hub = await RekeyHub.create({ seed: rollout });
    const front = sensor(hub, 0);
    hub.advance(5 * SECOND);
    // Heard first, with a reply wanted: the reply says an update is available.
    hub.radio(front.packet(beat(true)));
    const reply = front.took.at(-1);
    expect(reply?.type === MessageType.Reply && reply.flags.updateAvailable).toBe(true);
    // A heartbeat that asks for nothing and holds the current version is answered all the same.
    hub.advance(3 * 60 * SECOND);
    const before = front.took.length;
    hub.radio(front.packet(beat(false)));
    expect(front.took.length).toBe(before + 1);
    const again = front.took.at(-1);
    expect(again?.type === MessageType.Reply && again.flags.updateAvailable).toBe(true);
    expect(hub.reports).toEqual([]);
  });

  test("with no rollout: no flag, and a quiet heartbeat gets no reply (D72, as before M3)", async () => {
    const hub = await RekeyHub.create();
    const front = sensor(hub, 0);
    hub.advance(5 * SECOND);
    hub.radio(front.packet(beat(true)));
    const reply = front.took.at(-1);
    expect(reply?.type === MessageType.Reply && reply.flags.updateAvailable).toBe(false);
    hub.advance(3 * 60 * SECOND);
    const before = front.took.length;
    hub.radio(front.packet(beat(false)));
    expect(front.took.length).toBe(before);
  });

  test("a query is answered with the offer alone, bound to it, by its gateway; written now", async () => {
    const hub = await RekeyHub.create({ seed: rollout });
    const front = sensor(hub, 0);
    hub.advance(5 * SECOND);
    hub.radio(front.packet(beat(true)));
    hub.advance(2 * SECOND);
    const replies = front.took.length;
    hub.radio(front.packet(query()));
    // One answer, the offer: no reply besides it (the sensor took exactly one more packet, bound
    // to the query's counter, which `Sensor.receive` checks).
    expect(front.took.length).toBe(replies + 1);
    const offer = lastOffer(front);
    expect(front.took.at(-1)).toBe(offer);
    expect(offer?.action).toBe(UpdateAction.JoinWifiAndFetch);
    expect(offer?.imageId).toEqual(IMAGE_ID);
    // The query's row reached the disk with it, not in the routine batch (R13).
    const row = hub.store.db
      .query<{ n: number }, [number, number]>(
        `SELECT count(*) AS n FROM rx_event WHERE device_id = ? AND type = ?`,
      )
      .get(front.id, MessageType.UpdateQuery);
    expect(row?.n).toBe(1);
    // The offer's own row, as sent through the gateway.
    expect(
      hub.records.some(
        (r) =>
          r.kind === "tx" && r.row.deviceId === front.id && r.row.type === MessageType.UpdateOffer,
      ),
    ).toBe(true);
  });

  test("on the Wi-Fi it joins for its update: its query on that link, the offer back on it", async () => {
    const hub = await RekeyHub.create({ seed: rollout });
    const front = sensor(hub, 0);
    hub.advance(5 * SECOND);
    hub.radio(front.packet(beat(true)));
    const link = hub.openDeviceLink(front);
    const sentBefore = hub.left.length;
    hub.linkFrame(link, front.packet(query()));
    const offer = lastOffer(front);
    expect(offer?.action).toBe(UpdateAction.Fetch);
    // Sent on that link, and a grant for it given to the shell.
    expect(hub.left.slice(sentBefore).some((s) => s.link === link)).toBe(true);
    expect(hub.grants).toContainEqual({ link, granted: true });
    // A heartbeat on that link is still refused: a sensor's status stays on LoRa (§5).
    hub.linkFrame(link, front.packet(beat(true)));
    hub.flush();
    const onWifi = hub.store.db
      .query<{ n: number }, [number]>(
        `SELECT count(*) AS n FROM rx_routine WHERE device_id = ? AND path = 1`,
      )
      .get(front.id);
    expect(onWifi?.n).toBe(0);
    expect(front.took.at(-1)).toBe(offer);
  });
});

describe("a siren's and a gateway's offers", () => {
  test("the gateway is offered in its session; the siren on its Wi-Fi once it is heard there", async () => {
    const hub = await RekeyHub.create({ seed: rollout });
    const { gateway, siren } = hub.members;
    // The gateway, on its link at the start: fetch on the link the offer came by.
    expect(lastOffer(gateway)?.action).toBe(UpdateAction.Fetch);
    expect(hub.grants.some((g) => g.link === hub.gatewayLink && g.granted)).toBe(true);
    // The siren is offered nothing until its Wi-Fi carries a packet of its own.
    expect(siren.took.some((m) => m.type === MessageType.UpdateOffer)).toBe(false);
    hub.advance(5 * SECOND);
    hub.sirenWifi(siren.report(1));
    expect(lastOffer(siren)?.action).toBe(UpdateAction.Fetch);
    expect(hub.grants.some((g) => g.link === hub.sirenLink && g.granted)).toBe(true);
  });
});

describe("frames", () => {
  test("a transfer frame on a link with no grant is counted transferNotGranted, nothing more", async () => {
    const hub = await RekeyHub.create();
    const front = sensor(hub, 0);
    const link = hub.openDeviceLink(front);
    const sent = hub.left.length;
    hub.linkFrame(link, Uint8Array.from([0xf2, 0x01, ...new Uint8Array(14)]));
    hub.flush();
    const row = hub.store.db
      .query<{ n: number }, [string]>(`SELECT sum(count) AS n FROM rejects WHERE reason = ?`)
      .get("transferNotGranted");
    expect(row?.n).toBe(1);
    expect(hub.left.length).toBe(sent);
  });

  test("a siren's offer waits for the command in flight, then goes on its Wi-Fi", async () => {
    const hub = await RekeyHub.create({ seed: rollout });
    const { siren } = hub.members;
    // "Report now" went at the start, and waits for a report that names it.
    hub.advance(SECOND);
    hub.sirenWifi(siren.report(0, 1, 0));
    const state = hub.loop.state.sirens.sirens.get(siren.id);
    expect(state?.inFlight).toBeDefined();
    expect(state?.offer?.action).toBe(UpdateAction.Fetch);
    expect(siren.took.some((m) => m.type === MessageType.UpdateOffer)).toBe(false);
    // Its answer confirms the command; the offer goes now, on Wi-Fi.
    hub.advance(SECOND);
    hub.sirenWifi(siren.report(1));
    expect(hub.loop.state.sirens.sirens.get(siren.id)?.offer).toBeUndefined();
    expect(lastOffer(siren)?.action).toBe(UpdateAction.Fetch);
  });

  test("an update query is written now by itself, with nothing else to commit it (R13)", async () => {
    const hub = await RekeyHub.create();
    const front = sensor(hub, 0);
    hub.advance(5 * SECOND);
    // A reply first, so its counter's resume point is written then and not with the offer.
    hub.radio(front.packet(beat(true)));
    hub.advance(3 * 60 * SECOND);
    hub.radio(front.packet(query()));
    // No rollout: firmware writes nothing, yet the query reached the disk at once.
    const rows = hub.store.db
      .query<{ n: number }, [number]>(
        `SELECT count(*) AS n FROM rx_event WHERE device_id = ? AND type = 6`,
      )
      .get(front.id);
    expect(rows?.n).toBe(1);
    expect(lastOffer(front)?.action).toBe(UpdateAction.Nothing);
    // Staged "now" itself, not carried by another item's commit.
    const staged = hub.stagedLog.find(
      (i) =>
        i.kind === "record" &&
        i.record.kind === "rx" &&
        i.record.row.type === MessageType.UpdateQuery,
    );
    expect(staged?.durability).toBe("now");
  });
});

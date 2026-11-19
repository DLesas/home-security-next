/**
 * A restore from a backup made in the middle of a key change (the coordinator's ruling of
 * 2026-11-18, D141): the backup held a pending `next_key`, so both of the row's keys were held at
 * the backup and the row is `BothHeld`. A packet under either is not acted on; it says which key
 * the device holds, which the hub keeps, with a fresh next key, dropping the other. Each case with
 * a recorded packet under each key replayed after the restore, and two restores in a row from the
 * same backup.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { toHex } from "@hsn/protocol";
import type { DecisionKind } from "../../../../src/core/model/decisions.ts";
import type { DeviceId } from "../../../../src/core/model/ids.ts";
import { Rekey } from "../../../../src/core/model/rows.ts";
import { doorOpen, heartbeat, MINUTE, RekeyHub, SECOND, type Sensor } from "./support.ts";

function count(hub: RekeyHub, kind: DecisionKind, device?: DeviceId): number {
  return hub.decisions(kind, device).length;
}

function front(hub: RekeyHub): Sensor {
  return hub.members.sensors[0] ?? expect.unreachable("no sensor");
}

/**
 * A hub restored once (backup A), whose front sensor then has a Key change pending that it has not
 * taken (it answered a replay), and a backup B made then: B's row is K0 with K1 pending. Returns B
 * and K1. The front sensor is armed.
 */
async function midChange(): Promise<{
  readonly hub: RekeyHub;
  readonly b: string;
  readonly k1: string;
}> {
  const hub = await RekeyHub.create();
  const s = front(hub);
  hub.command({ kind: "arm", sensors: "all", continue: true });
  hub.advance(SECOND);
  const old = s.packet(heartbeat());
  hub.radio(old);
  const a = hub.backup();
  hub.advance(SECOND);
  hub.radio(s.packet(heartbeat()));
  hub.restore(a);
  // The replay draws the Key change; the sensor, on another exchange, does not take it.
  hub.advance(MINUTE);
  hub.radio(old);
  expect(s.keyChanges).toBe(0);
  const row = hub.keyRows().find((r) => r.id === s.id);
  expect(row?.rekey).toBe(Rekey.Required);
  const k1 = row?.next ?? expect.unreachable("no pending key");
  return { hub, b: hub.backup(), k1 };
}

describe("both keys held at the backup", () => {
  describe("a sensor", () => {
    let backup: Awaited<ReturnType<typeof midChange>>;
    beforeEach(async () => {
      backup = await midChange();
    });

    test("the device still on its old key: a packet under it settles the row; replays never act", () => {
      const { hub, b, k1 } = backup;
      const s = front(hub);
      const k0 = toHex(s.key);
      // Recorded after backup B, under the old key: an armed opening. Within 10 s ‡ of the last Key
      // change, so none answers it and the sensor stays on its old key.
      hub.advance(SECOND);
      const recorded = s.packet(doorOpen(0, 2));
      hub.radio(recorded);
      hub.advance(SECOND);
      hub.radio(s.packet(heartbeat()));
      expect(s.keyChanges).toBe(0);
      for (const gateway of [false, true]) {
        // Twice in a row from the same backup, nothing heard between (the gateway off the first
        // time: a device heard between would have changed its key after the backup, and be lost to
        // the second, the one case section 7 cannot cover): each time the same mark.
        hub.restore(b, gateway);
        expect(hub.keyRows().find((r) => r.id === s.id)).toMatchObject({
          key: k0,
          next: k1,
          rekey: Rekey.BothHeld,
        });
      }
      const started = count(hub, "countdown_started", s.id);
      // The replay settles it under the old key (it says nothing else): K2 made, K1 dropped.
      hub.advance(MINUTE);
      hub.radio(recorded);
      expect(count(hub, "countdown_started", s.id)).toBe(started);
      const settled = hub.keyRows().find((r) => r.id === s.id);
      expect(settled?.key).toBe(k0);
      expect(settled?.rekey).toBe(Rekey.Required);
      expect(settled?.next).not.toBe(k1);
      expect(settled?.next).not.toBeNull();
      // The real sensor, under its old key, 10 s ‡ later: the same K2, which it takes.
      hub.advance(11 * SECOND);
      hub.radio(s.packet(doorOpen(0, 2)));
      expect(toHex(s.key)).toBe(settled?.next ?? "");
      expect(count(hub, "countdown_started", s.id)).toBe(started);
      // It says it again under K2: the switch, and the opening counts.
      hub.advance(2 * SECOND);
      hub.radio(s.retry(doorOpen(2, 2)));
      expect(count(hub, "key_changed", s.id)).toBe(1);
      expect(count(hub, "countdown_started", s.id)).toBe(started + 1);
      // The recording after the switch: nothing.
      hub.command({ kind: "disarm", sensors: "all" });
      hub.command({ kind: "arm", sensors: "all", continue: true });
      hub.advance(MINUTE);
      hub.radio(recorded);
      expect(count(hub, "countdown_started", s.id)).toBe(started + 1);
    });

    test("the device already on the pending key: a packet under it settles the row the other way", () => {
      const { hub, b, k1 } = backup;
      const s = front(hub);
      const k0Packet = s.packet(heartbeat());
      // After backup B the sensor takes K1 and is switched to it; recorded under K1: an opening.
      hub.advance(MINUTE);
      hub.radio(k0Packet);
      expect(toHex(s.key)).toBe(k1);
      hub.advance(2 * SECOND);
      const recordedK1 = s.packet(doorOpen(0, 2));
      hub.radio(recordedK1);
      expect(count(hub, "key_changed", s.id)).toBe(1);
      hub.advance(SECOND);
      hub.radio(s.packet(heartbeat()));

      hub.restore(b);
      expect(hub.keyRows().find((r) => r.id === s.id)?.rekey).toBe(Rekey.BothHeld);
      const started = count(hub, "countdown_started", s.id);
      // The K1 recording, replayed: no switch, no countdown; it settles the row on K1.
      hub.advance(MINUTE);
      hub.radio(recordedK1);
      expect(count(hub, "key_changed", s.id)).toBe(1);
      expect(count(hub, "countdown_started", s.id)).toBe(started);
      const settled = hub.keyRows().find((r) => r.id === s.id);
      expect(settled?.key).toBe(k1);
      expect(settled?.rekey).toBe(Rekey.Required);
      expect(settled?.next).not.toBeNull();
      // The K0 recording: K0 was dropped, so it is a stranger's now.
      const sent = count(hub, "key_change_sent", s.id);
      hub.advance(MINUTE);
      hub.radio(k0Packet);
      expect(count(hub, "key_change_sent", s.id)).toBe(sent);
      // The real sensor under K1: the Key change, taken; then K2 switches it.
      hub.radio(s.packet(heartbeat()));
      expect(toHex(s.key)).toBe(settled?.next ?? "");
      hub.advance(2 * SECOND);
      hub.radio(s.packet(doorOpen(0, 2)));
      expect(count(hub, "key_changed", s.id)).toBe(2);
      expect(count(hub, "countdown_started", s.id)).toBe(started + 1);
    });
  });

  test("a gateway: the hello under its old key settles the row, then it switches", async () => {
    const hub = await RekeyHub.create();
    const g = hub.members.gateway;
    const recordedHello = g.sent.at(-3) ?? expect.unreachable("no hello");
    const a = hub.backup();
    // Restored with the gateway away; a recorded hello replayed draws a Key change it never sees.
    hub.restore(a, false);
    hub.reconnectGateway(recordedHello);
    expect(count(hub, "key_change_sent", g.id)).toBe(1);
    expect(g.keyChanges).toBe(0);
    const k1 = hub.keyRows().find((r) => r.id === g.id)?.next ?? expect.unreachable();
    const b = hub.backup();
    hub.restore(b, false);
    const row = hub.keyRows().find((r) => r.id === g.id);
    expect(row).toMatchObject({ key: toHex(g.key), next: k1, rekey: Rekey.BothHeld });
    // The real gateway, under its old key: a Key change sealed under that key, in place of the
    // welcome, carrying a fresh key; it takes it, says hello under it, and is switched.
    hub.reconnectGateway();
    expect(g.keyChanges).toBe(1);
    expect(toHex(g.key)).not.toBe(k1);
    expect(count(hub, "key_changed", g.id)).toBe(1);
    expect(hub.keyRows().find((r) => r.id === g.id)).toEqual({
      id: g.id,
      key: toHex(g.key),
      next: null,
      rekey: Rekey.None,
    });
  });
});

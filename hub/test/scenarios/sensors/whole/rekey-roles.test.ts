/**
 * The key change after a restore for a siren and a gateway, the rule of one Key change every
 * 10 s ‡ at its edges, a sensor out of range for a month, two restores in a row, and that no key is
 * ever in an output (D141, docs/m3-updates-design.md section 7).
 */
import { describe, expect, test } from "bun:test";
import { MessageType, SirenReportReason, toHex } from "@hsn/protocol";
import type { DecisionKind } from "../../../../src/core/model/decisions.ts";
import type { DeviceId } from "../../../../src/core/model/ids.ts";
import { Rekey } from "../../../../src/core/model/rows.ts";
import { doorOpen, heartbeat, MINUTE, RekeyHub, SECOND, type Sensor } from "./support.ts";

const DAY = 24 * 60 * MINUTE;

function count(hub: RekeyHub, kind: DecisionKind, device?: DeviceId): number {
  return hub.decisions(kind, device).length;
}

function front(hub: RekeyHub): Sensor {
  return hub.members.sensors[0] ?? expect.unreachable("no sensor");
}

describe("a siren", () => {
  test("gets its Key change at the restored hub's start in place of report now, then switches", async () => {
    const hub = await RekeyHub.create();
    const { siren } = hub.members;
    const backup = hub.backup();
    hub.advance(5 * SECOND);
    const recorded = siren.report(SirenReportReason.Regular);
    hub.sirenWifi(recorded);
    const tookBefore = siren.took.length;
    hub.restore(backup);
    // At the start, once the gateway's session is up: a Key change, not "report now".
    expect(siren.keyChanges).toBe(1);
    expect(siren.took.slice(tookBefore).map((m) => m.type)).toEqual([MessageType.KeyChange]);
    expect(count(hub, "key_change_sent", siren.id)).toBe(1);
    // The recording, replayed on Wi-Fi: not acted on, and no Key change within 10 s ‡.
    hub.sirenWifi(recorded);
    expect(count(hub, "key_change_sent", siren.id)).toBe(1);
    // Its report under the new key switches it; the hub's counters to it start again.
    hub.advance(2 * SECOND);
    hub.sirenWifi(siren.report(SirenReportReason.CommandAnswer));
    expect(count(hub, "key_changed", siren.id)).toBe(1);
    const row = hub.keyRows().find((r) => r.id === siren.id);
    expect(row).toEqual({ id: siren.id, key: toHex(siren.key), next: null, rekey: Rekey.None });
    expect(hub.resumePoint(siren.id)).toBe(1024);
    // A test sounds it under the new key: the siren takes it.
    expect(hub.command({ kind: "sirenTest", name: "hall" })?.ok).toBe(true);
    expect(siren.took.at(-1)?.type).toBe(MessageType.SirenCommand);
    // The recording after the switch: a stranger's.
    hub.advance(MINUTE);
    hub.sirenWifi(recorded);
    expect(count(hub, "key_change_sent", siren.id)).toBe(1);
    expect(hub.reports.filter((r) => !r.includes("transferGrant"))).toEqual([]);
  });
});

describe("a gateway", () => {
  test("its old-key hello gets a Key change in place of the welcome; its replay after, nothing", async () => {
    const hub = await RekeyHub.create();
    const { gateway } = hub.members;
    const backup = hub.backup();
    const oldHello = gateway.sent.at(-3) ?? expect.unreachable("no hello");
    hub.restore(backup);
    expect(gateway.keyChanges).toBe(1);
    expect(count(hub, "key_change_sent", gateway.id)).toBe(1);
    expect(count(hub, "key_changed", gateway.id)).toBe(1);
    expect(hub.keyRows().find((r) => r.id === gateway.id)?.rekey).toBe(Rekey.None);
    // Its session under the new key works: it carries a sensor's packet (an old-key one: a Key change).
    const s = front(hub);
    hub.radio(s.packet(heartbeat()));
    expect(count(hub, "key_change_sent", s.id)).toBe(1);
    // A hello recorded before the restore, replayed: badTag now, no Key change, no session.
    const welcomes = gateway.took.filter((m) => m.type === MessageType.Welcome).length;
    hub.gatewayFrame(oldHello);
    expect(count(hub, "key_change_sent", gateway.id)).toBe(1);
    expect(gateway.took.filter((m) => m.type === MessageType.Welcome).length).toBe(welcomes);
  });
});

describe("one Key change every 10 s ‡", () => {
  test("a packet 9.999 s after one draws none; one at 10 s draws the same key again", async () => {
    const hub = await RekeyHub.create();
    const s = front(hub);
    const backup = hub.backup();
    hub.restore(backup);
    hub.advance(SECOND);
    const replayed = s.packet(heartbeat());
    hub.radio(replayed);
    expect(count(hub, "key_change_sent", s.id)).toBe(1);
    const first = hub.keyRows().find((r) => r.id === s.id)?.next;
    hub.advance(10 * SECOND - 1_000);
    hub.radio(s.sent.at(-1) ?? replayed);
    expect(count(hub, "key_change_sent", s.id)).toBe(1);
    hub.advance(1_000);
    hub.radio(replayed);
    expect(count(hub, "key_change_sent", s.id)).toBe(2);
    // The same key, written again with it.
    expect(hub.keyRows().find((r) => r.id === s.id)?.next).toBe(first ?? null);
    expect(s.keyChanges).toBe(1);
  });
});

describe("a sensor out of range", () => {
  test("for 30 days keeps its old key; heard again, it changes and its door counts", async () => {
    const hub = await RekeyHub.create();
    const s = front(hub);
    hub.command({ kind: "arm", sensors: "all", continue: true });
    const backup = hub.backup();
    hub.restore(backup);
    hub.advance(30 * DAY);
    expect(hub.keyRows().find((r) => r.id === s.id)).toMatchObject({
      rekey: Rekey.Required,
      next: null,
    });
    hub.radio(s.packet(doorOpen(0, 2)));
    expect(count(hub, "countdown_started", s.id)).toBe(0);
    expect(s.keyChanges).toBe(1);
    // It says again what it was saying, under the new key: the opening, its age counting on.
    hub.advance(2 * SECOND);
    hub.radio(s.retry(doorOpen(2, 2)));
    expect(count(hub, "key_changed", s.id)).toBe(1);
    expect(count(hub, "countdown_started", s.id)).toBe(1);
  });
});

describe("the switch and a replay in the same turn", () => {
  test("a recording taken in the turn that switches the sensor, before the commit, is refused", async () => {
    const hub = await RekeyHub.create();
    const s = front(hub);
    hub.command({ kind: "arm", sensors: "all", continue: true });
    hub.advance(SECOND);
    // Counters it used out of the hub's hearing, so the recording's is not one the new key's
    // window holds after the switch (a duplicate there would hide the rule this test is for).
    for (let i = 0; i < 4; i++) s.packet(heartbeat());
    const recorded = s.packet(doorOpen(0, 2));
    hub.radio(recorded);
    hub.command({ kind: "disarm", sensors: "all" });
    hub.command({ kind: "arm", sensors: "all", continue: true });
    hub.advance(3 * MINUTE);
    hub.radio(s.packet(heartbeat()));
    const backup = hub.backup();
    hub.restore(backup);
    hub.advance(SECOND);
    hub.radio(s.packet(heartbeat()));
    expect(s.keyChanges).toBe(1);
    const started = count(hub, "countdown_started", s.id);
    const doors = () =>
      hub.records.filter(
        (r) =>
          r.kind === "rx" &&
          r.row.deviceId === s.id &&
          r.row.type === MessageType.DoorChanged &&
          !r.row.oldKey,
      ).length;
    const accepted = doors();
    // The switching heartbeat and the recorded opening reach the hub together: the store has
    // not yet committed the switch when the recording is opened, so the old key still opens it.
    hub.advance(2 * SECOND);
    hub.radioTogether([s.packet(heartbeat()), recorded]);
    expect(count(hub, "key_changed", s.id)).toBe(1);
    // Refused, as a stranger's: never accepted, so nothing acts on it.
    expect(doors()).toBe(accepted);
    expect(count(hub, "countdown_started", s.id)).toBe(started);
    expect(count(hub, "report_while_disarmed", s.id)).toBe(0);
    expect(count(hub, "key_change_sent", s.id)).toBe(1);
  });
});

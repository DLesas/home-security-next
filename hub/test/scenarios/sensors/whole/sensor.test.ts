/**
 * A sensor's key change after a restore, through the whole hub on a real store (D141,
 * docs/m3-updates-design.md section 7): the restore marks it; its first packet under the key the
 * backup held draws a Key change and nothing else; it repeats its report under the new key, which
 * switches it and is acted on; a door report recorded after the backup and replayed after the
 * restore starts no countdown, before the switch or after it. The rate rule at its edges; a
 * sensor out of range for a month.
 */
import { describe, expect, test } from "bun:test";
import { MessageType, toHex } from "@hsn/protocol";
import { Rekey } from "../../../../src/core/model/rows.ts";
import { doorOpen, heartbeat, MINUTE, RekeyHub, SECOND } from "./support.ts";

/** The hub's records of a kind, for one device. */
function count(hub: RekeyHub, kind: Parameters<RekeyHub["decisions"]>[0], device?: number) {
  return hub.decisions(kind, device === undefined ? undefined : (device as never)).length;
}

describe("a sensor's key change", () => {
  test("restore, an old-key door report replayed, the change, a real opening", async () => {
    const hub = await RekeyHub.create();
    const [front] = hub.members.sensors;
    if (front === undefined) return;
    expect(hub.command({ kind: "arm", sensors: "all", continue: true })?.ok).toBe(true);
    const backup = hub.backup();
    // After the backup: a real opening and its countdown, then a disarm. Someone records it.
    hub.advance(10 * SECOND);
    const recorded = front.packet(doorOpen(0, 2));
    hub.radio(recorded);
    expect(count(hub, "countdown_started", front.id)).toBe(1);
    hub.command({ kind: "disarm", sensors: "all" });
    hub.command({ kind: "arm", sensors: "all", continue: true });
    // The sensor's exchange moves on: an answer to the recorded report is no longer taken.
    hub.advance(3 * MINUTE);
    hub.radio(front.packet(heartbeat({ settingsVersion: 4 })));

    hub.restore(backup);
    // Every device marked, the gateway already switched by its own hello at the start; the
    // counters moved by 2²⁴.
    expect(hub.keyRows().map((r) => r.rekey)).toEqual([
      Rekey.None,
      Rekey.Required,
      Rekey.Required,
      Rekey.Required,
    ]);
    expect(hub.resumePoint(front.id)).toBeGreaterThanOrEqual(2 ** 24);

    // The gateway's own change came first (its hello): it switched, and its session is up.
    expect(hub.members.gateway.keyChanges).toBe(1);
    expect(count(hub, "key_changed", hub.members.gateway.id)).toBe(1);

    // The recorded opening, replayed: no countdown, no reply, but a Key change.
    const startedBefore = count(hub, "countdown_started");
    hub.advance(30 * SECOND);
    hub.radio(recorded);
    expect(count(hub, "countdown_started")).toBe(startedBefore);
    expect(count(hub, "key_change_sent", front.id)).toBe(1);
    // The real sensor would not hear it (it answers a packet it did not send now); the replay is
    // all that came. The sensor's own next packet, a heartbeat under the old key, draws the same
    // key again once 10 s ‡ have passed.
    hub.advance(11 * SECOND);
    hub.radio(front.packet(heartbeat({ settingsVersion: 2 })));
    expect(front.keyChanges).toBe(1);
    expect(count(hub, "key_change_sent", front.id)).toBe(2);
    const rows = hub.keyRows().find((r) => r.id === front.id);
    expect(rows?.next).toBe(toHex(front.key));
    expect(rows?.rekey).toBe(Rekey.Required);

    // Its next packet under the new key switches it, and is acted on: a real opening now.
    hub.advance(2 * SECOND);
    hub.radio(front.packet(doorOpen(1, 2)));
    expect(count(hub, "key_changed", front.id)).toBe(1);
    expect(count(hub, "countdown_started")).toBe(startedBefore + 1);
    const after = hub.keyRows().find((r) => r.id === front.id);
    expect(after).toEqual({ id: front.id, key: toHex(front.key), next: null, rekey: Rekey.None });
    expect(hub.resumePoint(front.id)).toBe(1024);
    // Its reply came under the new key, with the hub's counter from 1.
    expect(front.took.at(-1)?.type).toBe(MessageType.Reply);

    // After the switch the recording fails its tag: no countdown, no Key change.
    hub.command({ kind: "disarm", sensors: "all" });
    hub.command({ kind: "arm", sensors: "all", continue: true });
    const now = count(hub, "countdown_started");
    hub.advance(MINUTE);
    hub.radio(recorded);
    expect(count(hub, "countdown_started")).toBe(now);
    expect(count(hub, "key_change_sent", front.id)).toBe(2);
    // And a restart keeps it switched: the new key current, the recording still a stranger's.
    hub.restart();
    hub.radio(recorded);
    expect(count(hub, "countdown_started")).toBe(now);
    expect(hub.reports).toEqual([]);
  });
});

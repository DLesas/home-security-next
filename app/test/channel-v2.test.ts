/**
 * The channel client at version 2 (`src/hub/channel.ts`, `src/hub/handshake.ts`; m3-design.md
 * section 3: the phone speaks version 2 only), against the test hub end speaking 1 and 2. A
 * version 1 session is unchanged (`channel.test.ts`, `real-hub.test.ts`); at version 2 replies
 * and events are read by version 2's schemas, a refusal only version 2 names reaches `request`'s
 * callers as `protoUnsupported` and `forward`'s as it is, and an event only version 2 names goes
 * to `newEvent`, never to the store.
 */
import { describe, expect, test } from "bun:test";
import {
  APP_OPS,
  APP_OPS_V2,
  BUSY_BECAUSE_V2,
  type AppEventV2,
  type AppOpName,
} from "@hsn/protocol/app";
import { Channel, type ChannelStatus } from "../src/hub/channel";
import { linkClient, PROTO_RANGE } from "../src/hub/handshake";
import { memoryRecordStore } from "../src/platform/client-key";
import { HubEnd } from "./support/hub-end";
import { manualTimers, settle } from "./support/timers";

async function sessionAt(proto: readonly [number, number]) {
  const hub = new HubEnd();
  hub.speaks = [1, 2];
  const timers = manualTimers();
  const secret = hub.tokenWithSecret("ownDevice", 1);
  const linked = await linkClient(
    hub.connect,
    { kind: "secret", secret, identity: hub.identity },
    { name: "Test", kind: "web" },
    timers,
    proto,
  );
  if (!linked.ok) throw new Error(linked.fault);
  const statuses: ChannelStatus[] = [];
  const snapshots: unknown[] = [];
  const events: string[] = [];
  const newEvents: AppEventV2[] = [];
  const channel = new Channel({
    connect: hub.connect,
    store: memoryRecordStore(linked.value.record),
    timers,
    app: "0.1.0",
    proto,
    listener: {
      status: (s) => statuses.push(s),
      snapshot: (s) => snapshots.push(s),
      event: (e) => events.push(e.ev),
      newEvent: (e) => newEvents.push(e),
    },
  });
  await channel.start();
  await settle(40);
  return { hub, channel, statuses, snapshots, events, newEvents, timers };
}

describe("the channel at version 2", () => {
  test("version 2's table keeps every version 1 row's `change`, so `seq` is given as before", () => {
    for (const op of Object.keys(APP_OPS) as AppOpName[])
      expect({ op, change: APP_OPS_V2[op].change }).toEqual({ op, change: APP_OPS[op].change });
    expect(PROTO_RANGE).toEqual([1, 1]);
  });

  test("a session agreed at 2: the snapshot read by version 2's schema", async () => {
    const s = await sessionAt([2, 2]);
    const open = s.statuses.find((st) => st.kind === "open");
    expect(open?.kind === "open" && open.hello.proto).toBe(2);
    expect(s.snapshots).toHaveLength(1);
    expect(s.snapshots[0]).toMatchObject({
      backupKeyEpoch: null,
      push: null,
      hub: { appsPort: 8444 },
    });
  });

  test("a version 1 snapshot on a version 2 session is not taken: the session closes", async () => {
    const s = await sessionAt([2, 2]);
    s.hub.handle("snapshot", () => ({ ok: true, body: { ...s.hub.snapshot, rev: s.hub.rev } }));
    s.hub.dropAll();
    await settle(20);
    s.timers.advance(1000);
    await settle(60);
    expect(s.snapshots).toHaveLength(1);
    expect(s.statuses.at(-1)?.kind).toBe("waiting");
  });

  test("a refusal only version 2 names: `protoUnsupported` to `request`, as it is to `forward`", async () => {
    const s = await sessionAt([2, 2]);
    const refusal = {
      code: "invalid",
      detail: { field: "identity", reason: "pairedElsewhere" },
    } as const;
    s.hub.handleV2("people.list", () => ({ ok: false, error: refusal }));
    expect(await s.channel.request("people.list", {})).toEqual({
      ok: false,
      error: { code: "protoUnsupported", detail: { speaks: [1, 2] } },
    });
    expect(await s.channel.forward("people.list", {})).toEqual({ ok: false, error: refusal });
    // A refusal of version 1's goes to both as it is.
    s.hub.handleV2("people.list", () => ({
      ok: false,
      error: { code: "consoleOnly", detail: {} },
    }));
    expect(await s.channel.request("people.list", {})).toEqual({
      ok: false,
      error: { code: "consoleOnly", detail: {} },
    });
  });

  test("an event only version 2 names goes to `newEvent`; one of version 1's names to the store", async () => {
    const s = await sessionAt([2, 2]);
    const body = {
      device: 3,
      image: 1,
      state: "planned",
      held: null,
      method: "ownLink",
      bytes: 0,
      of: 1000,
    };
    s.hub.rev += 1;
    s.hub.emitFrame({ t: "evt", rev: s.hub.rev, ev: "deviceUpdate", body });
    s.hub.emit("backupKeyChanged", { epoch: 2 });
    await settle(40);
    expect(s.newEvents.map((e) => e.ev)).toEqual(["deviceUpdate"]);
    expect(s.events).toEqual(["backupKeyChanged"]);
    expect(s.statuses.at(-1)?.kind).toBe("open");
  });

  test("every version 2 busy reason reaches the shared screens unchanged", async () => {
    const s = await sessionAt([2, 2]);
    for (const because of BUSY_BECAUSE_V2) {
      const refusal = { code: "busy", detail: { because } } as const;
      s.hub.handleV2("device.remove", () => ({ ok: false, error: refusal }));
      expect(await s.channel.request("device.remove", { device: 3 })).toEqual({
        ok: false,
        error: refusal,
      });
    }
  });

  test("an event that is not version 2's, or a frame with a field too many, closes the session", async () => {
    for (const bad of [
      { t: "evt", rev: 50, ev: "nothing", body: {} },
      { t: "evt", rev: 50, ev: "backupKeyChanged", body: { epoch: -1 } },
      { t: "evt", rev: 50, ev: "backupKeyChanged", body: { epoch: 1 }, extra: true },
      { t: "evt", rev: -1, ev: "backupKeyChanged", body: { epoch: 1 } },
      { t: "event", rev: 50, ev: "backupKeyChanged", body: { epoch: 1 } },
    ]) {
      const s = await sessionAt([2, 2]);
      s.hub.emitFrame(bad);
      await settle(40);
      expect({ bad, kind: s.statuses.at(-1)?.kind }).toEqual({ bad, kind: "waiting" });
    }
  });

  test("a hub that speaks only 1 and a client that offers only 2: no session, refused before message 2", async () => {
    const hub = new HubEnd();
    hub.speaks = [1, 1];
    const secret = hub.tokenWithSecret("ownDevice", 1);
    const linked = await linkClient(
      hub.connect,
      { kind: "secret", secret, identity: hub.identity },
      { name: "Test", kind: "web" },
      manualTimers(),
      [2, 2],
    );
    expect(linked).toEqual({ ok: false, fault: "refused" });
  });
});

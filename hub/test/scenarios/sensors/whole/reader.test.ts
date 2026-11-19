/**
 * The reader gives the core everything migration 3's tables hold (the joint step 0's
 * `M3M4Snapshot`): a short run of the real core writes them through the real writer (a rollout
 * begun by `rollout.start`, a phone registered by `push.register`, a key change pending after a
 * restore), the hub stops, and the core booted from the real reader on the reopened store has the
 * same firmware, relay, sensors and intake state as it had: the rows, the pending key and the
 * marks. Without the reader's part, a restart forgets each of them, and no module's own test, which
 * builds its snapshot by hand, would show it.
 */
import { describe, expect, test } from "bun:test";
import type { Handler } from "../../../../src/core/model/handler.ts";
import { clientId, imageId, personId } from "../../../../src/core/model/ids.ts";
import type { Internal } from "../../../../src/core/model/messages.ts";
import { ClientKind, ImageKind, Rekey } from "../../../../src/core/model/rows.ts";
import type { HubState } from "../../../../src/core/model/state.ts";
import type { StoreOp } from "../../../../src/core/model/store.ts";
import { makeCore, MODULES } from "../../../../src/core/step.ts";
import { heartbeat, type Members, RekeyHub, SECOND } from "./support.ts";

const PHONE = clientId(4);
const ANNA = personId(1);

/** A person with a phone, and an image in the store. */
function seed(members: Members): readonly StoreOp[] {
  return [
    {
      table: "people",
      op: "upsert",
      row: { id: ANNA, name: "Anna", createdMs: 0, removedMs: null, revision: 1 },
    },
    {
      table: "clients",
      op: "upsert",
      row: {
        id: PHONE,
        personId: ANNA,
        staticKey: new Uint8Array(32).fill(4),
        kind: ClientKind.Phone,
        name: "phone",
        linkedByClient: null,
        createdMs: 0,
        removedMs: null,
        lastSeq: 0,
        lastSeenMs: null,
        backupKeyEpoch: null,
      },
    },
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
        bytes: 1_000_000,
        header: new Uint8Array(128),
        manifest: "{}",
        file: "1.bin",
        addedMs: 0,
        addedBy: "test",
        removedMs: null,
      },
    },
    // The front sensor's key held at a backup: its first packet will make its new key.
    {
      table: "device_keys",
      op: "upsert",
      row: {
        deviceId: members.sensors[0]?.id ?? expect.unreachable(),
        key: members.sensors[0]?.key ?? new Uint8Array(16),
        nextKey: null,
        rekey: Rekey.Required,
      },
    },
  ];
}

/**
 * The control module as the real one, with one stand-in: `push.register` reaches the relay as
 * from Anna's phone, as the app channel's version 2 routing will give it (step 2), since `hsn`
 * may not register a phone.
 */
const control: Handler<"control"> = (slice, message, ctx) =>
  MODULES.control.handle(slice, message, ctx).map((handled) => ({
    slice: handled.slice,
    out: handled.out.map((o): (typeof handled.out)[number] =>
      o.kind === "v2OpRequest" && o.op.op === "push.register"
        ? ({
            ...o,
            actor: { kind: "person", person: ANNA, client: PHONE, name: "Anna (client 4)" },
          } satisfies Internal)
        : o,
    ),
  }));

/** The state the reader must give back: what each module rebuilds from the tables. */
function durable(state: HubState) {
  return {
    images: [...state.firmware.images.values()],
    rollouts: [...state.firmware.rollouts.values()].map((r) => r.row),
    updates: [...state.firmware.updates.values()].map((u) => u.row),
    rekey: [...state.firmware.rekey],
    relaySettings: state.relay.settings,
    targets: [...state.relay.targets.values()],
    pending: [...state.sensors.keys.entries].map(([d, e]) => [d, e.bothHeld, e.pending]),
    intakeRekey: [...state.intake.rekey].map(([d, r]) => [d, r.bothHeld]),
  };
}

describe("the reader and migration 3", () => {
  test("a rollout, a phone and a pending key change survive a restart, each as it was", async () => {
    const hub = await RekeyHub.create({
      seed,
      core: makeCore({ ...MODULES, control: { ...MODULES.control, handle: control } }),
    });
    const front = hub.members.sensors[0] ?? expect.unreachable();
    const started = hub.command({
      kind: "op",
      operation: { op: "rollout.start", body: { image: 1, devices: "all" } },
    });
    expect(started?.ok).toBe(true);
    const registered = hub.command({
      kind: "op",
      operation: {
        op: "push.register",
        body: {
          platform: "apns",
          environment: "production",
          token: "ab".repeat(32),
          keyId: "04".repeat(8),
          key: Buffer.from(new Uint8Array(32).fill(9)).toString("base64url"),
        },
      },
    });
    expect(registered?.ok).toBe(true);
    hub.advance(SECOND);
    hub.radio(front.packet(heartbeat()));
    const before = durable(hub.loop.state);
    expect(before.rollouts.length).toBe(1);
    expect(before.updates.length).toBeGreaterThan(0);
    expect(before.targets.length).toBe(1);
    expect(before.pending.length).toBe(1);
    expect(before.pending[0]?.[0]).toBe(front.id);
    expect(before.pending[0]?.[2]).toBeInstanceOf(Uint8Array);
    hub.restart();
    expect(durable(hub.loop.state)).toEqual(before);
    expect(hub.reports.filter((r) => !r.includes("not built"))).toEqual([]);
  });
});

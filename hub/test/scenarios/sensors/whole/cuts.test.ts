/**
 * A power cut at every point of a key change after a restore (D141; hub-design.md section 4's
 * table): before the commit that holds the new key, after it and before the Key change leaves,
 * after it left; and the same around the switch's commit. Each time the hub starts again from its
 * disk and the change finishes: the sensor ends on a key the hub holds as its only key, its next
 * opening counts, and the hub never sent two packets with one counter under one key.
 */
import { describe, expect, test } from "bun:test";
import { toHex } from "@hsn/protocol";
import type { StagedEffect } from "../../../../src/ports/writer.ts";
import { Rekey } from "../../../../src/core/model/rows.ts";
import { type CutPoint, doorOpen, heartbeat, RekeyHub, SECOND, type Sensor } from "./support.ts";

/** The decisions of a kind for a device that reached the disk (a cut loses the rest). */
function committed(hub: RekeyHub, kind: string, device: number): number {
  hub.flush();
  return (
    hub.store.db
      .query<{ n: number }, [string, number]>(
        `SELECT count(*) AS n FROM decisions WHERE kind = ? AND device_id = ?`,
      )
      .get(kind, device)?.n ?? 0
  );
}

function front(hub: RekeyHub): Sensor {
  return hub.members.sensors[0] ?? expect.unreachable("no sensor");
}

/** The device a `device_keys` write is for. */
function keyRowDevice(op: Extract<StagedEffect, { kind: "write" }>["op"]): number | undefined {
  if (op.table !== "device_keys") return undefined;
  switch (op.op) {
    case "upsert":
      return op.row.deviceId;
    case "pendingKey":
    case "delete":
      return op.key.deviceId;
  }
}

/** A commit that holds a `device_keys` write of `device` that `match` likes. */
function keyWrite(
  device: number,
  match: (op: Extract<StagedEffect, { kind: "write" }>["op"]) => boolean,
): (items: readonly StagedEffect[]) => boolean {
  return (items) =>
    items.some((i) => i.kind === "write" && keyRowDevice(i.op) === device && match(i.op));
}

const POINTS: readonly CutPoint[] = ["beforeCommit", "afterCommit", "afterSends"];
const STEPS = {
  /** The commit that holds the new key, with the Key change waiting on it. */
  newKey: (op: Extract<StagedEffect, { kind: "write" }>["op"]) => op.op === "pendingKey",
  /** The switch's commit: the new key as the only key. */
  switch: (op: Extract<StagedEffect, { kind: "write" }>["op"]) =>
    op.op === "upsert" && op.table === "device_keys" && op.row.rekey === Rekey.None,
} as const;

describe("a power cut during a sensor's key change", () => {
  for (const step of ["newKey", "switch"] as const) {
    for (const point of POINTS) {
      test(`at the ${step} commit, ${point}: the change finishes after the restart`, async () => {
        const hub = await RekeyHub.create();
        const s = front(hub);
        hub.command({ kind: "arm", sensors: "all", continue: true });
        hub.restore(hub.backup());
        const match = STEPS[step];
        hub.cutAt(point, keyWrite(s.id, match));
        // The sensor carries on: each try under the key it holds, until its opening counts.
        let tries = 0;
        while (committed(hub, "countdown_started", s.id) === 0 && tries < 8) {
          tries += 1;
          hub.advance(11 * SECOND);
          hub.radio(s.packet(tries % 2 === 0 ? doorOpen(0, 2) : heartbeat()));
        }
        expect(hub.cut).toBe(false);
        expect(hub.run).toBeGreaterThanOrEqual(2);
        expect(committed(hub, "countdown_started", s.id)).toBe(1);
        expect(committed(hub, "key_changed", s.id)).toBe(1);
        const row = hub.keyRows().find((r) => r.id === s.id);
        expect(row).toEqual({ id: s.id, key: toHex(s.key), next: null, rekey: Rekey.None });
        expect(s.keyChanges).toBe(1);
        // No counter under one key ever carried two contents.
        const seen = new Map<string, string>();
        for (const n of s.nonces) {
          const at = `${n.key}:${n.counter}`;
          expect(seen.get(at) ?? n.bytes).toBe(n.bytes);
          seen.set(at, n.bytes);
        }
      });
    }
  }
});

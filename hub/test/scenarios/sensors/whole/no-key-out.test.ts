/**
 * No key ever leaves the hub but inside a sealed packet and its own `device_keys` row (D141,
 * hub-design.md section 2; rule 6): after a whole key change of a sensor, a siren and a gateway,
 * with replays, a restart and a third-state row, every key any device held is searched for, in hex
 * (both cases), base64 and base64url, in every record the loop staged, every answer, every report,
 * and every row of every audit table on disk.
 */
import { describe, expect, test } from "bun:test";
import { SirenReportReason, toHex } from "@hsn/protocol";
import { doorOpen, heartbeat, MINUTE, RekeyHub, SECOND, type Sensor } from "./support.ts";

const AUDIT_TABLES = [
  "rx_routine",
  "rx_event",
  "tx_routine",
  "tx_event",
  "decisions",
  "device_log",
  "hub_events",
  "commands",
  "rejects",
] as const;

function forms(key: Uint8Array): readonly string[] {
  const hex = toHex(key);
  const base64 = Buffer.from(key).toString("base64");
  return [
    hex,
    hex.toUpperCase(),
    base64,
    base64.replace(/=+$/, ""),
    Buffer.from(key).toString("base64url"),
  ];
}

/** Everything as text, bytes as lowercase hex. */
function text(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v instanceof Uint8Array ? toHex(v) : typeof v === "bigint" ? v.toString() : v,
  );
}

function front(hub: RekeyHub): Sensor {
  return hub.members.sensors[0] ?? expect.unreachable("no sensor");
}

describe("no key in any output", () => {
  test("after the changes of every role, replays and a restart", async () => {
    const hub = await RekeyHub.create();
    const s = front(hub);
    const { siren } = hub.members;
    hub.command({ kind: "arm", sensors: "all", continue: true });
    const recorded = s.packet(doorOpen(0, 2));
    hub.radio(recorded);
    hub.command({ kind: "disarm", sensors: "all" });
    const backup = hub.backup();
    hub.restore(backup);
    hub.advance(MINUTE);
    hub.radio(recorded);
    hub.radio(s.packet(heartbeat()));
    hub.advance(11 * SECOND);
    hub.radio(s.packet(heartbeat()));
    hub.advance(2 * SECOND);
    hub.radio(s.packet(heartbeat()));
    hub.sirenWifi(siren.report(SirenReportReason.CommandAnswer));
    hub.restart();
    hub.radio(recorded);
    hub.flush();
    const all = [...hub.members.sensors, siren, hub.members.gateway];
    const keys = all.flatMap((d) => d.keys);
    expect(keys.length).toBeGreaterThanOrEqual(all.length + 3);
    const outputs = [text(hub.records), text(hub.told), text(hub.reports)];
    for (const table of AUDIT_TABLES) {
      const rows = hub.store.db.query(`SELECT * FROM "${table}"`).all();
      outputs.push(text(rows));
    }
    for (const output of outputs) {
      for (const key of keys)
        for (const form of forms(key)) expect(output.includes(form)).toBe(false);
    }
    // And the records do hold the Key changes, with their bodies zeroed.
    const keyChanges = hub.records.filter((r) => r.kind === "tx" && r.row.type === 0x84);
    expect(keyChanges.length).toBeGreaterThanOrEqual(3);
    for (const r of keyChanges) {
      if (r.kind === "tx") expect(r.row.body).toEqual(new Uint8Array(16));
    }
  });
});

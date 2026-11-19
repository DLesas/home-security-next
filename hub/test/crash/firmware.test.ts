/**
 * Power cuts in firmware updates and the key change after a restore (docs/m3-updates-design.md
 * section 8, "Hub tests": "a crash at every transition of a rollout"; section 6, "The hub loses
 * power at any stage"; section 7; hub-design.md section 4's table): the hub cut off before the
 * commit, after it and before its sends, and after its sends, at
 *
 * - **the grant**: a sensor's offer to fetch on the Wi-Fi it joined, with the grant on that link;
 * - **the go-ahead**: "install now", committed before it is sent;
 * - **the key change's commits**, for a siren and a gateway (a sensor's are `scenarios/sensors/
 *   whole/cuts.test.ts`): the commit holding the new key, and the switch;
 * - **the restore's marking**: `applyRestore` cut off at each piece, the mark's included;
 * - **staging**: the image's file stored and its row lost.
 *
 * After each cut the hub starts again from its disk (`synchronous = FULL`: exactly what was
 * committed) and the device carries on as the firmware does; the step comes to its end, and no
 * (key, counter) pair ever carried two packets.
 */
import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Message,
  MessageType,
  Role,
  toHex,
  UpdateAction,
  UpdateHolding,
  UpdateStage,
} from "@hsn/protocol";
import { encodeIds } from "../../src/core/firmware/codes.ts";
import { imageId, jobId, rolloutId } from "../../src/core/model/ids.ts";
import {
  DeviceUpdateState,
  type FirmwareImageRow,
  ImageKind,
  PacketPath,
  Rekey,
  RolloutStage,
  UpdateHeld,
  UpdateMethod,
} from "../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";
import type { StoreOp } from "../../src/core/model/store.ts";
import type { StagedEffect } from "../../src/ports/writer.ts";
import { RestorePieces } from "../../src/shell/backup/restore.ts";
import { checkStore } from "../../src/shell/firmware/store.ts";
import { FirmwareStaging } from "../../src/shell/firmware/stage.ts";
import {
  BACKUP_KEY,
  type CutPoint,
  heartbeat,
  type Members,
  RekeyHub,
  SECOND,
  type Sensor,
} from "../scenarios/sensors/whole/support.ts";
import { espImage, tempFolder, testHubKeys } from "../unit/shell-firmware/support.ts";

const POINTS: readonly CutPoint[] = ["beforeCommit", "afterCommit", "afterSends"];
const IMAGE_ID = new Uint8Array(8).fill(1);
const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");
const IMAGE: FirmwareImageRow = {
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
};

/** An image in the store and a rollout under way to every device, each planned (D139). */
function rollout(members: Members): readonly StoreOp[] {
  const all = [members.gateway.id, ...members.sensors.map((s) => s.id), members.siren.id];
  return [
    {
      table: "firmware_images",
      op: "upsert",
      row: IMAGE,
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
        sameVersion: false,
        state: DeviceUpdateState.Planned,
        method: UpdateMethod.OwnLink,
        held: UpdateHeld.No,
        bytes: 0,
        attempts: 0,
        lastReason: null,
        sinceMs: 0,
        bleNonce: null,
        bleExpiresMs: null,
        remindedMs: null,
      },
    })),
  ];
}

function query(holding: number = UpdateHolding.Nothing, bytesHeld = 0): Message {
  return {
    type: MessageType.UpdateQuery,
    imageId: holding === UpdateHolding.Nothing ? new Uint8Array(8) : IMAGE_ID,
    held: holding,
    bytesHeld,
    batteryCode: 200,
    flags: { hasWifiDetails: true, externalPower: false },
  };
}

function status(stage: number, bytesWritten = 1_000_128): Message {
  return {
    type: MessageType.UpdateStatus,
    imageId: IMAGE_ID,
    stage,
    reason: 0,
    bytesWritten,
  };
}

function beat(): Message {
  return heartbeat({
    settingsVersion: 1,
    batteryCode: 200,
    flags: {
      doorOpen: false,
      coverOpen: false,
      usbPower: false,
      charging: false,
      replyWanted: true,
      localAlarmSounded: false,
      buzzing: false,
      listeningAtSendRate: false,
    },
  });
}

function front(hub: RekeyHub): Sensor {
  return hub.members.sensors[0] ?? expect.unreachable("no sensor");
}

/** The device_updates row of `device` as committed, or undefined. */
function updateRow(hub: RekeyHub, device: number): { state: number; held: number } | undefined {
  hub.flush();
  return (
    hub.store.db
      .query<{ state: number; held: number }, [number]>(
        `SELECT state, held FROM device_updates WHERE device_id = ?`,
      )
      .get(device) ?? undefined
  );
}

/** A commit holding a `device_updates` upsert of `device` in `state`. */
function updateWrite(device: number, state: number): (items: readonly StagedEffect[]) => boolean {
  return (items) =>
    items.some(
      (i) =>
        i.kind === "write" &&
        i.op.table === "device_updates" &&
        i.op.op === "upsert" &&
        i.op.row.deviceId === device &&
        i.op.row.state === state,
    );
}

/** A commit holding the record of `device`'s Update query on its own Wi-Fi link. */
function queryOnLink(device: number): (items: readonly StagedEffect[]) => boolean {
  return (items) =>
    items.some(
      (i) =>
        i.kind === "record" &&
        i.record.kind === "rx" &&
        i.record.row.deviceId === device &&
        i.record.row.type === MessageType.UpdateQuery &&
        i.record.row.path === PacketPath.Wifi,
    );
}

/** The loop's deadline guard never engaged (shell/loop.ts): no deadline left at or before its time. */
function guardQuiet(hub: RekeyHub): void {
  expect(hub.reports.filter((r) => r.includes("deadline was left"))).toEqual([]);
}

/** Under each key, no counter of the hub's ever carried two different packets. */
function noCounterTwice(device: {
  readonly nonces: readonly { key: string; counter: number; bytes: string }[];
}): void {
  const seen = new Map<string, string>();
  for (const n of device.nonces) {
    const at = `${n.key}:${n.counter}`;
    expect(seen.get(at) ?? n.bytes).toBe(n.bytes);
    seen.set(at, n.bytes);
  }
}

/** The last Update offer the device took. */
function lastOffer(device: { readonly took: readonly Message[] }) {
  const last = device.took.findLast((m) => m.type === MessageType.UpdateOffer);
  return last?.type === MessageType.UpdateOffer ? last : undefined;
}

describe("a power cut at the grant: a sensor's offer to fetch on its Wi-Fi", () => {
  for (const point of POINTS) {
    test(`${point}: after the restart its query on a new link is offered and granted`, async () => {
      const hub = await RekeyHub.create({ seed: rollout });
      const s = front(hub);
      hub.advance(5 * SECOND);
      hub.radio(s.packet(beat()));
      hub.radio(s.packet(query()));
      expect(lastOffer(s)?.action).toBe(UpdateAction.JoinWifiAndFetch);
      // The commit of its query on the link, whose answer is the offer to fetch and the grant.
      hub.cutAt(point, queryOnLink(s.id));
      const first = hub.openDeviceLink(s);
      hub.linkFrame(first, s.packet(query()));
      expect(hub.cut).toBe(false);
      expect(hub.run).toBe(1);
      // The device saw its link go with the hub; it joins again and asks again (section 5, "A
      // break"), on a new link, holding nothing yet.
      hub.advance(2 * SECOND);
      const again = hub.openDeviceLink(s);
      const grants = hub.grants.length;
      hub.linkFrame(again, s.packet(query()));
      expect(lastOffer(s)?.action).toBe(UpdateAction.Fetch);
      expect(hub.grants.slice(grants)).toContainEqual({ link: again, granted: true });
      expect(updateRow(hub, s.id)?.state).toBe(DeviceUpdateState.Offered);
      noCounterTwice(s);
      guardQuiet(hub);
    });
  }
});

test("after a SQLite restart, Started alone cannot confirm a same-version rollout", async () => {
  const hub = await RekeyHub.create({
    seed: () => [{ table: "firmware_images", op: "upsert", row: { ...IMAGE, version: 0x010000 } }],
  });
  const sensor = front(hub);
  const approved = hub.command({
    kind: "op",
    operation: { op: "rollout.start", body: { image: IMAGE.id, devices: [sensor.id] } },
  });
  expect(approved?.ok).toBe(true);
  hub.advance(5 * SECOND);
  hub.radio(sensor.packet(beat()));
  hub.radio(sensor.packet(query()));
  const link = hub.openDeviceLink(sensor);
  hub.linkFrame(link, sensor.packet(query()));
  hub.radio(sensor.packet(status(UpdateStage.Verified)));
  expect(updateRow(hub, sensor.id)?.state).toBe(DeviceUpdateState.Installing);

  hub.restart();
  hub.radio(
    sensor.packet({
      type: MessageType.Started,
      role: Role.Sensor,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      resetCause: 3,
      lastFatalError: 0,
      settingsVersion: 1,
    }),
  );
  expect(updateRow(hub, sensor.id)?.state).toBe(DeviceUpdateState.Installing);
  expect(
    hub.store.db
      .query("SELECT same_version, attempts FROM device_updates WHERE device_id = ?")
      .get(sensor.id),
  ).toEqual({ same_version: 1, attempts: 0 });
  hub.radio(sensor.packet(status(UpdateStage.Confirmed)));
  expect(updateRow(hub, sensor.id)?.state).toBe(DeviceUpdateState.Confirmed);
});

describe("a power cut at the go-ahead, committed before it is sent", () => {
  for (const point of POINTS) {
    test(`${point}: the verified sensor is told to install exactly once it is heard`, async () => {
      const hub = await RekeyHub.create({ seed: rollout });
      const s = front(hub);
      hub.advance(5 * SECOND);
      hub.radio(s.packet(beat()));
      hub.radio(s.packet(query()));
      const link = hub.openDeviceLink(s);
      hub.linkFrame(link, s.packet(query()));
      hub.advance(30 * SECOND);
      hub.cutAt(point, updateWrite(s.id, DeviceUpdateState.Installing));
      hub.radio(s.packet(status(UpdateStage.Verified)));
      expect(hub.cut).toBe(false);
      expect(hub.run).toBe(1);
      const committed = updateRow(hub, s.id)?.state;
      // Before the commit: nothing of it survives; after it: the go-ahead is on the disk.
      expect(committed).toBe(
        point === "beforeCommit" ? DeviceUpdateState.Offered : DeviceUpdateState.Installing,
      );
      // The sensor, unanswered (or answered, after the sends), says again what it holds: the go-
      // ahead comes then, whatever the cut, and it installs.
      hub.advance(10 * SECOND);
      hub.radio(s.packet(query(UpdateHolding.Verified, 1_000_128)));
      expect(lastOffer(s)?.action).toBe(UpdateAction.InstallNow);
      expect(updateRow(hub, s.id)?.state).toBe(DeviceUpdateState.Installing);
      noCounterTwice(s);
      guardQuiet(hub);
    });
  }
});

describe("a power cut during a siren's and a gateway's key change (D141)", () => {
  const STEPS = {
    newKey: (op: Extract<StagedEffect, { kind: "write" }>["op"]) => op.op === "pendingKey",
    switch: (op: Extract<StagedEffect, { kind: "write" }>["op"]) =>
      op.op === "upsert" && op.table === "device_keys" && op.row.rekey === Rekey.None,
  } as const;
  function keyWrite(
    device: number,
    match: (op: Extract<StagedEffect, { kind: "write" }>["op"]) => boolean,
  ): (items: readonly StagedEffect[]) => boolean {
    return (items) =>
      items.some((i) => {
        if (i.kind !== "write" || i.op.table !== "device_keys") return false;
        const id = i.op.op === "upsert" ? i.op.row.deviceId : i.op.key.deviceId;
        return id === device && match(i.op);
      });
  }
  for (const step of ["newKey", "switch"] as const) {
    for (const point of POINTS) {
      test(`the siren at the ${step} commit, ${point}: it ends on a key the hub holds`, async () => {
        const hub = await RekeyHub.create();
        const { siren } = hub.members;
        const file = hub.backup();
        hub.cutAt(point, keyWrite(siren.id, STEPS[step]));
        hub.restore(file);
        // The siren reports every 30 s on its Wi-Fi, under the key it holds, until it is switched.
        for (let i = 0; i < 8 && hub.keyRows().find((r) => r.id === siren.id)?.rekey !== 0; i++) {
          hub.advance(30 * SECOND);
          hub.sirenWifi(siren.report(1));
        }
        expect(hub.cut).toBe(false);
        const row = hub.keyRows().find((r) => r.id === siren.id);
        expect(row).toEqual({ id: siren.id, key: toHex(siren.key), next: null, rekey: 0 });
        noCounterTwice(siren);
        guardQuiet(hub);
      });
      test(`the gateway at the ${step} commit, ${point}: it ends on a key the hub holds`, async () => {
        const hub = await RekeyHub.create();
        const { gateway } = hub.members;
        const file = hub.backup();
        hub.cutAt(point, keyWrite(gateway.id, STEPS[step]));
        hub.restore(file);
        for (let i = 0; i < 8 && hub.keyRows().find((r) => r.id === gateway.id)?.rekey !== 0; i++) {
          hub.advance(5 * SECOND);
          hub.reconnectGateway();
        }
        expect(hub.cut).toBe(false);
        const row = hub.keyRows().find((r) => r.id === gateway.id);
        expect(row).toEqual({ id: gateway.id, key: toHex(gateway.key), next: null, rekey: 0 });
        noCounterTwice(gateway);
        guardQuiet(hub);
      });
    }
  }
});

describe("a power cut in the restore's marking (applyRestore)", () => {
  test("cut off at every piece: the hub is as it was; a whole restore then marks every device", async () => {
    const hub = await RekeyHub.create();
    const file = hub.backup();
    const keysBefore = hub.keyRows();
    const dataDir = hub.store.path.slice(0, hub.store.path.lastIndexOf("/"));
    for (let cutAfter = 0; ; cutAfter++) {
      const pieces = new RestorePieces({
        dataDir,
        uploadPath: file,
        key: BACKUP_KEY,
        migrationsFolder: MIGRATIONS,
        rules: DEFAULT_RULES,
      });
      let outcome;
      let taken = 0;
      while (taken <= cutAfter && (outcome = pieces.next()) === undefined) taken++;
      if (outcome !== undefined) break;
      // The power goes: the process is gone, its scratch files left as they are.
      // The hub, started again, never opens them: its database is untouched, nothing is marked.
      hub.restart();
      expect(hub.keyRows()).toEqual(keysBefore);
      expect(existsSync(join(dataDir, "hub.db.restore"))).toBe(false);
    }
    hub.restore(file, false);
    // Every sensor is marked, not yet heard (a siren is changed at the start, at once).
    for (const sensor of hub.members.sensors)
      expect(hub.keyRows().find((r) => r.id === sensor.id)?.rekey).toBe(Rekey.Required);
    expect(hub.keyRows().find((r) => r.id === hub.members.gateway.id)?.rekey).toBe(Rekey.Required);
  });
});

describe("a power cut in staging: the image's file stored, its row not committed", () => {
  test("at the next start the store's check removes the file no row names; staged again, it is whole", async () => {
    const folder = tempFolder("crash-stage");
    const keys = await testHubKeys();
    const upload = join(folder.path, "upload.bin");
    await Bun.write(upload, espImage({ version: "1.4.0", size: 50_000 }));
    const staging = new FirmwareStaging({
      job: jobId(1),
      path: upload,
      own: { version: "1.4.0" },
      dataDir: folder.path,
      keys: [],
      rules: DEFAULT_RULES.firmware,
      signer: () => ok(keys.signer),
    });
    let outcome;
    while ((outcome = staging.next()) === undefined);
    expect(outcome.kind).toBe("firmwareStaged");
    const stored = readdirSync(join(folder.path, "firmware")).filter((n) => n.endsWith(".bin"));
    expect(stored).toHaveLength(1);
    // The power goes before the core's commit of `firmware_images`: no row names the file.
    const checked = checkStore(folder.path, [])._unsafeUnwrap();
    expect(checked.damaged).toEqual([]);
    expect(readdirSync(join(folder.path, "firmware")).filter((n) => n.endsWith(".bin"))).toEqual(
      [],
    );
    expect(checked.removed.length).toBeGreaterThanOrEqual(1);
    folder.remove();
  });
});

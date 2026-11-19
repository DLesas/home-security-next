/**
 * The key change after a restore (D141, m3-updates-design section 7), as the modules that own a
 * device's key (`sensors`, `sirens`, `gateways`, HD 2) make it. Intake decides what a packet is
 * (`oldKeyPacket`, or the switch); the owner answers, writes and keeps the counters. These pure
 * pieces are the same for the three owners and are reached through `intake/view.ts`.
 *
 * - **The new key** is made from the input's entropy at the device's first packet under a key the
 *   hub held at the backup, and kept in the owner's slice only until the switch: it reaches the core
 *   otherwise only in the boot snapshot (`rekeyKeys`), and leaves it only inside a Key change (0x84)
 *   and its own `device_keys` write. It is never in a record, a decision, an error or a message
 *   other than those.
 * - **The write** goes with every Key change, the same key again included, written now: the send
 *   gate then holds a Key change back until its key is committed (hub-design.md section 4). It
 *   names only the next key (`PendingKeyOp`), except when a row both of whose keys were held at the
 *   backup is heard under its next key: that key, which the core holds as a pending key, becomes
 *   the row's key, with the fresh key as next, in one whole-row write that drops the other.
 * - **At most one Key change per device every 10 s ‡** (`HubRules.keyChange.everyMs`), counted from
 *   the last one sealed, in memory: a restart may send one sooner, which costs one packet.
 * - **The switch**, at the device's first packet under its new key (`key_changed`, made by intake
 *   or `gateways`): the row becomes `key = next_key`, `next_key` null, `rekey` none, and the hub's
 *   counter to the device starts again at 1 with its resume point at 1,024 (§4), both written now.
 *   The owner seals to it under `next` for the rest of the run (`KeyStore`: the new key keeps that
 *   name until the hub restarts).
 */
import { err, ok, type Result } from "neverthrow";
import {
  KEY_LENGTH,
  MessageType,
  type MessageOf,
  ResumeStep,
  type SendCounter,
} from "@hsn/protocol";
import type { KeyUsed } from "../model/cipher.ts";
import type { Effect } from "../model/effects.ts";
import { type CoreFault, coreFault } from "../model/errors.ts";
import { type CommitOutcome, type DurableSnapshot, EMPTY_M3M4_SNAPSHOT } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { Rekey } from "../model/rows.ts";
import type { HubRules } from "../model/rules.ts";
import { type Mono, msBetween } from "../model/time.ts";

const ORIGIN = "core/intake/rekey";

/** One device's key change, as the module that owns its key keeps it (memory). */
export interface KeyChangeEntry {
  /** Both of the row's keys were held at the backup (`Rekey.BothHeld`). */
  readonly bothHeld: boolean;
  /** The pending next key, when there is one. */
  readonly pending: Uint8Array | undefined;
  /** When the last Key change to it was sealed, in this run. */
  readonly sentAt: Mono | undefined;
}

/** What the owning module keeps of the key changes of its devices. */
export interface KeyChanges {
  readonly entries: ReadonlyMap<DeviceId, KeyChangeEntry>;
  /** Devices switched to their new key in this run: packets to them are sealed under `next`. */
  readonly switched: ReadonlySet<DeviceId>;
  /**
   * A commit failed since the last that succeeded: until one does, every packet sealed to a device
   * switched in this run carries its resume point written now again, so the send gate holds it
   * back until the switch is surely committed (its counters restarted at 1 under a key that may
   * not be written yet, hub-design.md section 4).
   */
  readonly commitFailing: boolean;
}

export const NO_KEY_CHANGES: KeyChanges = {
  entries: new Map(),
  switched: new Set(),
  commitFailing: false,
};

/** The key changes of `owned` devices that were not finished at the last commit. */
export function keyChangesFromSnapshot(
  snapshot: DurableSnapshot,
  owned: (device: DeviceId) => boolean,
): KeyChanges {
  const m3m4 = snapshot.m3m4 ?? EMPTY_M3M4_SNAPSHOT;
  const both = new Set(m3m4.rekeyBothHeld ?? []);
  const entries = new Map<DeviceId, KeyChangeEntry>();
  for (const device of m3m4.rekey) {
    if (!owned(device)) continue;
    const pending = m3m4.rekeyKeys.get(device);
    entries.set(device, { bothHeld: both.has(device), pending, sentAt: undefined });
  }
  return { entries, switched: new Set(), commitFailing: false };
}

/** Whether a Key change to the device may be sealed now (at most one every 10 s ‡). */
export function keyChangeAllowed(entry: KeyChangeEntry, now: Mono, rules: HubRules): boolean {
  return entry.sentAt === undefined || msBetween(entry.sentAt, now) >= rules.keyChange.everyMs;
}

/** The key the owner seals a packet to the device under: `next` once switched in this run. */
export function sealKeyOf(changes: KeyChanges, device: DeviceId): KeyUsed {
  return changes.switched.has(device) ? "next" : "current";
}

/** A Key change to make: its message, the key to seal it under, its writes, and the entry after. */
export interface KeyChangeMade {
  readonly message: MessageOf<typeof MessageType.KeyChange>;
  readonly sealUnder: KeyUsed;
  readonly writes: readonly Effect[];
  readonly entry: KeyChangeEntry;
}

function fault(ctx: Context, message: string, device: DeviceId): CoreFault {
  return coreFault(ctx.event, ORIGIN, message, { device });
}

function write(op: Extract<Effect, { kind: "write" }>["op"]): Effect {
  return { kind: "write", durability: "now", op };
}

/**
 * The Key change answering a packet under a key held at the backup that opened under `keyUsed`
 * (for a sensor, siren or gateway alike), or the one a siren gets at the hub's start (`current`).
 */
export function makeKeyChange(
  ctx: Context,
  device: DeviceId,
  entry: KeyChangeEntry,
  keyUsed: KeyUsed,
): Result<KeyChangeMade, CoreFault> {
  const fresh = entry.bothHeld || entry.pending === undefined;
  const drawn = fresh ? ctx.entropy.take(KEY_LENGTH) : ok(entry.pending);
  if (drawn.isErr()) return err(drawn.error);
  const newKey = drawn.value;
  const after: KeyChangeEntry = { bothHeld: false, pending: newKey, sentAt: ctx.now.mono };
  const message = { type: MessageType.KeyChange, newKey } as const;
  if (entry.bothHeld && keyUsed === "next") {
    // The device holds the backup's pending key: it becomes the key, the old one is dropped.
    const held = entry.pending;
    if (held === undefined) return err(fault(ctx, "a next key opened, but none is held", device));
    return ok({
      message,
      sealUnder: "next",
      entry: after,
      writes: [
        write({
          table: "device_keys",
          op: "upsert",
          row: { deviceId: device, key: held, nextKey: newKey, rekey: Rekey.Required },
        }),
      ],
    });
  }
  return ok({
    message,
    sealUnder: "current",
    entry: after,
    writes: [
      write({
        table: "device_keys",
        op: "pendingKey",
        key: { deviceId: device },
        nextKey: newKey,
        rekey: Rekey.Required,
      }),
    ],
  });
}

/** The counter to a device right after its switch: 1, with its resume point saved at 1,024 (§4). */
export function switchedCounter(rules: HubRules): SendCounter {
  return { step: ResumeStep.Hub, next: 1, resumePoint: rules.keyChange.resumePoint };
}

/** The switch's writes, now: the row's new key, and the counter's resume point (D141). */
export function switchWrites(
  ctx: Context,
  device: DeviceId,
  entry: KeyChangeEntry | undefined,
): Result<readonly Effect[], CoreFault> {
  const key = entry?.pending;
  if (key === undefined) return err(fault(ctx, "a switch with no pending key", device));
  return ok([
    write({
      table: "device_keys",
      op: "upsert",
      row: { deviceId: device, key, nextKey: null, rekey: Rekey.None },
    }),
    write({
      table: "send_counters",
      op: "upsert",
      row: { deviceId: device, resumePoint: ctx.deps.rules.keyChange.resumePoint },
    }),
  ]);
}

/** `changes` after the device's switch: its entry and key gone, sealed under `next` from now. */
export function afterSwitch(changes: KeyChanges, device: DeviceId): KeyChanges {
  const entries = new Map(changes.entries);
  entries.delete(device);
  return { ...changes, entries, switched: new Set(changes.switched).add(device) };
}

/** `changes` with one entry replaced. */
export function withKeyChange(
  changes: KeyChanges,
  device: DeviceId,
  entry: KeyChangeEntry,
): KeyChanges {
  return { ...changes, entries: new Map(changes.entries).set(device, entry) };
}

/** `changes` without a removed device. */
export function withoutDevice(changes: KeyChanges, device: DeviceId): KeyChanges {
  if (!changes.entries.has(device) && !changes.switched.has(device)) return changes;
  const entries = new Map(changes.entries);
  entries.delete(device);
  const switched = new Set(changes.switched);
  switched.delete(device);
  return { ...changes, entries, switched };
}

/**
 * The resume point written again with a packet sealed to a device switched in this run while a
 * commit is failing (`KeyChanges.commitFailing`); nothing otherwise.
 */
export function failingCommitWrites(
  changes: KeyChanges,
  device: DeviceId,
  counter: SendCounter,
): readonly Effect[] {
  if (!changes.commitFailing || !changes.switched.has(device)) return [];
  return [
    write({
      table: "send_counters",
      op: "upsert",
      row: { deviceId: device, resumePoint: counter.resumePoint },
    }),
  ];
}

/** `changes` after a commit's outcome: failing from a failure until a recovery. */
export function afterCommit(changes: KeyChanges, outcome: CommitOutcome): KeyChanges {
  if (outcome.kind !== "failed" && outcome.kind !== "recovered") return changes;
  const failing = outcome.kind === "failed";
  return failing === changes.commitFailing ? changes : { ...changes, commitFailing: failing };
}

/** The device a `key_changed` decision names, when the message is one: its switch (D141). */
export function keyChangedDevice(message: Internal): DeviceId | undefined {
  if (message.kind !== "auditRecord" || message.record.kind !== "decision") return undefined;
  const row = message.record.row;
  return row.kind === "key_changed" ? (row.deviceId ?? undefined) : undefined;
}

/**
 * A packet's body as its `tx` row keeps it (section 6: the plaintext after the type byte), with a
 * Key change's new key zeroed, as a Provision's key is in `usb_sent` (section 6): a key is never in
 * a record (D141).
 */
export function recordedBody(type: number, body: Uint8Array): Uint8Array {
  return type === MessageType.KeyChange ? new Uint8Array(body.length) : body;
}

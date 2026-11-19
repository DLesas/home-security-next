/**
 * The phone's key and vault (`src/platform/keys.native.ts`, `src/platform/vault.ts`; m3-design.md
 * sections 2 and 4) over an in-memory secure store: the key made and used; the records of several
 * hubs kept apart; every failure of the store as a result the app can show; `seq` written before
 * it is used, across a kill at each point; a link and a removal cut short at each write; and the
 * backup keys, 16 epochs and the 17th.
 */
import { describe, expect, test } from "bun:test";
import { nodeSha256 } from "@hsn/protocol";
import { appIdentityBytes, formatIdentity, x25519StaticKey } from "@hsn/protocol/app";
import { reserveSeq, type StoredClient } from "../src/platform/client-key";
import { keyPairOf, makeClientKey, staticKeyOf } from "../src/platform/keys.native";
import { BACKUP_EPOCHS_KEPT, type HeldBackupKey } from "../src/platform/records";
import {
  chosenRecordStore,
  HUBS_ITEM,
  itemsOf,
  memorySecureItems,
  phoneRecords,
  storeFaultOf,
  type VaultFault,
  vaultFaultOf,
  withBackupKey,
} from "../src/platform/vault";
import { settle } from "./support/timers";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A hub's identity and static key, from a seed. */
function hubOf(seed: number): { identity: string; staticKey: Uint8Array } {
  const key = x25519StaticKey(new Uint8Array(32).fill(seed));
  if (!key.ok) throw new Error("hub key");
  return {
    identity: formatIdentity(appIdentityBytes(nodeSha256, key.value.publicKey)),
    staticKey: key.value.publicKey,
  };
}

const HUB_A = hubOf(7);
const HUB_B = hubOf(8);

function recordFor(
  hub: { identity: string; staticKey: Uint8Array },
  seed: number,
  lastSeq = 0,
): StoredClient<Uint8Array> {
  const pair = keyPairOf(new Uint8Array(32).fill(seed));
  if (pair === undefined) throw new Error("pair");
  return {
    key: pair,
    hub: { identity: hub.identity, staticKey: hub.staticKey, client: 4, person: 2 },
    lastSeq,
    reach: {
      addresses: ["192.168.1.20"],
      appsPort: 8444,
      lastAddress: null,
      relayUrl: null,
      homeName: "",
    },
  };
}

const backup = (epoch: number, seed = epoch + 1): HeldBackupKey => ({
  epoch,
  key: new Uint8Array(32).fill(seed),
});

/** A vault with hub A linked, on its own disk. */
async function linked(lastSeq = 0) {
  const disk = new Map<string, string>();
  const vault = phoneRecords(memorySecureItems(disk));
  const added = await vault.add(recordFor(HUB_A, 1, lastSeq), backup(3), true);
  if (!added.ok) throw new Error("add");
  return { disk, vault };
}

/** A promise's value, or "dead" when it does not settle: a call into a killed process. */
async function orDead<T>(pending: Promise<T>): Promise<T | "dead"> {
  return Promise.race([pending, settle(20).then(() => "dead" as const)]);
}

describe("the phone's key", () => {
  test("32 random bytes whose public half is X25519's; two keys differ", async () => {
    const a = await makeClientKey();
    const b = await makeClientKey();
    if (!a.ok || !b.ok) throw new Error("no key");
    expect(a.value.privateKey).toHaveLength(32);
    const check = x25519StaticKey(a.value.privateKey);
    expect(check.ok && hex(check.value.publicKey)).toBe(hex(a.value.publicKey));
    expect(hex(a.value.privateKey)).not.toBe(hex(b.value.privateKey));
  });

  test("a random source that answers zeros, the same bytes twice, or nothing at all is refused", async () => {
    expect(await makeClientKey((bytes) => bytes)).toEqual({ ok: false, fault: "failed" });
    expect(await makeClientKey((bytes) => bytes.fill(9))).toEqual({ ok: false, fault: "failed" });
    let n = 0;
    expect(
      (
        await makeClientKey((bytes) => {
          n += 1;
          return bytes.fill(n);
        })
      ).ok,
    ).toBe(true);
    const scope = globalThis as { crypto?: unknown };
    const real = scope.crypto;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    const without = await makeClientKey();
    Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
    expect(without).toEqual({ ok: false, fault: "failed" });
  });

  test("its Diffie-Hellman agrees with the other side's; a key read wrong gives zeros, which Noise refuses", async () => {
    const a = keyPairOf(new Uint8Array(32).fill(1));
    const b = keyPairOf(new Uint8Array(32).fill(2));
    if (a === undefined || b === undefined) throw new Error("pair");
    const ab = await staticKeyOf(a).dh(b.publicKey);
    const ba = await staticKeyOf(b).dh(a.publicKey);
    expect(hex(ab)).toBe(hex(ba));
    expect(ab.some((x) => x !== 0)).toBe(true);
    const short = { privateKey: new Uint8Array(31), publicKey: a.publicKey };
    expect(await staticKeyOf(short).dh(b.publicKey)).toEqual(new Uint8Array(32));
    expect(keyPairOf(new Uint8Array(31))).toBeUndefined();
  });
});

describe("records, one hub and several", () => {
  test("a link reads back whole; its items are the design's, the list written last", async () => {
    const disk = new Map<string, string>();
    const items = memorySecureItems(disk);
    const vault = phoneRecords(items);
    const record = recordFor(HUB_A, 1, 5);
    expect((await vault.add(record, backup(3), true)).ok).toBe(true);
    const names = itemsOf(HUB_A.identity);
    expect(names).toEqual({
      key: `hub.${HUB_A.identity}.key`,
      record: `hub.${HUB_A.identity}.record`,
      backup: `hub.${HUB_A.identity}.backup`,
    });
    if (names === undefined) throw new Error("names");
    expect(items.writes).toEqual([names.key, names.record, names.backup, HUBS_ITEM]);
    const read = await vault.hub(HUB_A.identity).read();
    expect(read.ok && read.value).toEqual(record);
    expect(await vault.list()).toEqual({ ok: true, value: [HUB_A.identity] });
    expect(await vault.chosen()).toEqual({ ok: true, value: HUB_A.identity });
    // The private key is only in its own item; the record holds its public half.
    expect(disk.get(names.key)).toBe(b64(record.key.privateKey));
    expect(disk.get(names.record)).not.toContain(b64(record.key.privateKey));
  });

  test("two hubs: two keys, two seqs, removed apart", async () => {
    const disk = new Map<string, string>();
    const vault = phoneRecords(memorySecureItems(disk));
    await vault.add(recordFor(HUB_A, 1), backup(1), true);
    await vault.add(recordFor(HUB_B, 2), backup(9));
    expect(await vault.list()).toEqual({ ok: true, value: [HUB_A.identity, HUB_B.identity] });
    expect(await vault.chosen()).toEqual({ ok: true, value: HUB_A.identity });
    expect(await reserveSeq(vault.hub(HUB_A.identity))).toBe(1);
    expect(await reserveSeq(vault.hub(HUB_A.identity))).toBe(2);
    expect(await reserveSeq(vault.hub(HUB_B.identity))).toBe(1);
    const a = await vault.hub(HUB_A.identity).read();
    const b = await vault.hub(HUB_B.identity).read();
    if (!a.ok || !b.ok || a.value === undefined || b.value === undefined) throw new Error("read");
    expect(hex(a.value.key.privateKey)).not.toBe(hex(b.value.key.privateKey));
    expect(await vault.backupKeys.held(HUB_B.identity)).toEqual({ ok: true, value: [backup(9)] });
    expect((await vault.remove(HUB_A.identity)).ok).toBe(true);
    expect(await vault.list()).toEqual({ ok: true, value: [HUB_B.identity] });
    expect(await vault.chosen()).toEqual({ ok: true, value: null });
    expect(await vault.hub(HUB_A.identity).read()).toEqual({ ok: true, value: undefined });
    expect([...disk.keys()].filter((k) => k.includes(HUB_A.identity))).toEqual([]);
    const still = await vault.hub(HUB_B.identity).read();
    expect(still.ok && still.value?.lastSeq).toBe(1);
  });

  test("a hub not listed reads as not linked; a write under another hub's name is refused", async () => {
    const { vault } = await linked();
    expect(await vault.hub(HUB_B.identity).read()).toEqual({ ok: true, value: undefined });
    expect(await vault.hub(HUB_B.identity).update((r) => r)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await vault.hub(HUB_B.identity).write(recordFor(HUB_A, 1))).toEqual({
      ok: false,
      fault: "failed",
    });
    expect(await vault.hub("not an identity").read()).toEqual({ ok: true, value: undefined });
    expect(await vault.choose(HUB_B.identity)).toEqual({ ok: false, fault: "failed" });
  });

  test("fifty changes at once take fifty different numbers, each on disk before it is given", async () => {
    const { vault, disk } = await linked();
    const store = vault.hub(HUB_A.identity);
    const given: number[] = [];
    const onDisk: number[] = [];
    await Promise.all(
      Array.from({ length: 50 }, () =>
        reserveSeq(store).then((seq) => {
          given.push(seq ?? -1);
          const text = disk.get(itemsOf(HUB_A.identity)?.record ?? "") ?? "{}";
          onDisk.push((JSON.parse(text) as { lastSeq: number }).lastSeq);
        }),
      ),
    );
    expect([...given].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // When each number was given, the disk already held it (or a later one).
    for (const [i, seq] of given.entries()) expect(onDisk[i]).toBeGreaterThanOrEqual(seq);
  });

  test("the chosen hub's store: not linked with none chosen; a write links and chooses; a clear removes", async () => {
    const vault = phoneRecords(memorySecureItems());
    const chosen = chosenRecordStore(vault);
    expect(await chosen.read()).toEqual({ ok: true, value: undefined });
    expect(await chosen.update((r) => r)).toEqual({ ok: true, value: undefined });
    expect((await chosen.write(recordFor(HUB_A, 1))).ok).toBe(true);
    expect(await vault.chosen()).toEqual({ ok: true, value: HUB_A.identity });
    expect(await reserveSeq(chosen)).toBe(1);
    expect((await chosen.clear()).ok).toBe(true);
    expect(await vault.list()).toEqual({ ok: true, value: [] });
    expect(await chosen.read()).toEqual({ ok: true, value: undefined });
  });
});

describe("every failure of the store, as a result the app can show", () => {
  test("locked (restarted, not yet unlocked): the channel's 'unavailable', `locked` in full; read again once unlocked", async () => {
    const disk = new Map<string, string>();
    const items = memorySecureItems(disk);
    const vault = phoneRecords(items);
    await vault.add(recordFor(HUB_A, 1), backup(1), true);
    items.fail("locked");
    expect(await chosenRecordStore(vault).read()).toEqual({ ok: false, fault: "unavailable" });
    expect(vault.status.getState().fault).toBe("locked");
    expect(await reserveSeq(vault.hub(HUB_A.identity))).toBeUndefined();
    items.fail(null);
    const read = await vault.hub(HUB_A.identity).read();
    expect(read.ok && read.value?.hub.identity).toBe(HUB_A.identity);
    expect(vault.status.getState()).toEqual({ fault: null, identity: null });
  });

  test("denied: 'unavailable', `denied` in full", async () => {
    const items = memorySecureItems();
    items.fail("denied");
    const refused = phoneRecords(items);
    expect(await refused.list()).toEqual({ ok: false, fault: "unavailable" });
    expect(refused.status.getState()).toEqual({ fault: "denied", identity: null });
    expect(storeFaultOf("denied")).toBe("unavailable");
  });

  test("full: the next seq is not written, so the change is not sent; `full` in full", async () => {
    const { disk } = await linked(7);
    const items = memorySecureItems(disk);
    const again = phoneRecords(items);
    items.failNext({ op: "set", fault: "full" });
    expect(await reserveSeq(again.hub(HUB_A.identity))).toBeUndefined();
    expect(again.status.getState()).toEqual({ fault: "full", identity: HUB_A.identity });
    expect(storeFaultOf("full")).toBe("failed");
    // Nothing was taken: the next number is the one after the last on disk.
    expect(await reserveSeq(again.hub(HUB_A.identity))).toBe(8);
  });

  test("a full store at linking: the hub is not listed, so the phone is not linked to it", async () => {
    const items = memorySecureItems();
    const vault = phoneRecords(items);
    items.failNext({ op: "set", name: HUBS_ITEM, fault: "full" });
    expect(await vault.add(recordFor(HUB_A, 1), backup(1), true)).toEqual({
      ok: false,
      fault: "failed",
    });
    expect(await vault.list()).toEqual({ ok: true, value: [] });
    expect(vault.status.getState().fault).toBe("full");
  });

  test("corrupt items: each reads as `corrupt`, never as another record", async () => {
    const names = itemsOf(HUB_A.identity);
    if (names === undefined) throw new Error("names");
    const other = keyPairOf(new Uint8Array(32).fill(66));
    const breakages: readonly [string, (disk: Map<string, string>) => void][] = [
      ["record not JSON", (d) => d.set(names.record, "{not json")],
      ["record gone", (d) => d.delete(names.record)],
      ["key gone (Android drops what it cannot decrypt)", (d) => d.delete(names.key)],
      ["key not base64url", (d) => d.set(names.key, "***")],
      ["key of 31 bytes", (d) => d.set(names.key, b64(new Uint8Array(31).fill(1)))],
      [
        "key not the record's",
        (d) => d.set(names.key, b64(other?.privateKey ?? new Uint8Array(32))),
      ],
      [
        "record of another hub",
        (d) =>
          d.set(names.record, (d.get(names.record) ?? "").replace(HUB_A.identity, HUB_B.identity)),
      ],
      [
        "record's seq negative",
        (d) =>
          d.set(names.record, (d.get(names.record) ?? "").replace('"lastSeq":0', '"lastSeq":-1')),
      ],
      [
        "record of another version",
        (d) => d.set(names.record, (d.get(names.record) ?? "").replace('"v":1', '"v":2')),
      ],
    ];
    for (const [what, breakIt] of breakages) {
      const { disk } = await linked();
      breakIt(disk);
      const vault = phoneRecords(memorySecureItems(disk));
      const read = await vault.hub(HUB_A.identity).read();
      expect({ what, read }).toEqual({ what, read: { ok: false, fault: "failed" } });
      expect(vault.status.getState()).toEqual({ fault: "corrupt", identity: HUB_A.identity });
    }
  });

  test("a corrupt list of hubs, or a corrupt backup item, reads as `corrupt`; a new backup key is still kept", async () => {
    const { disk } = await linked();
    disk.set(HUBS_ITEM, '{"v":1,"hubs":["NOT AN IDENTITY"],"chosen":null,"gone":[]}');
    const vault = phoneRecords(memorySecureItems(disk));
    expect(await vault.list()).toEqual({ ok: false, fault: "failed" });
    expect(vault.status.getState().fault).toBe("corrupt");
    const fresh = await linked();
    fresh.disk.set(itemsOf(HUB_A.identity)?.backup ?? "", "garbage");
    const v2 = phoneRecords(memorySecureItems(fresh.disk));
    expect(await v2.backupKeys.held(HUB_A.identity)).toEqual({ ok: false, fault: "failed" });
    expect((await v2.backupKeys.keep(HUB_A.identity, backup(4))).ok).toBe(true);
    expect(await v2.backupKeys.held(HUB_A.identity)).toEqual({ ok: true, value: [backup(4)] });
  });

  test("the store's own errors, as expo-secure-store 58.0.3 words them, become faults; nothing else of them passes", () => {
    const cases: readonly [unknown, VaultFault][] = [
      [{ code: "ERR_KEY_CHAIN", message: "User interaction is not allowed." }, "locked"],
      [
        new Error(
          "Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: User interaction is not allowed.",
        ),
        "locked",
      ],
      [
        new Error(
          "Could not decrypt the value for key 'hub.x.key' under keychain 'key_v1'. Caused by: x",
        ),
        "corrupt",
      ],
      [new Error("Unable to decode the provided data."), "corrupt"],
      [new Error("An error occurred when accessing the keystore: lost"), "denied"],
      [new Error("Authentication failed. Provided passphrase/PIN is incorrect"), "denied"],
      [new Error("No keychain is available. You may need to restart your computer."), "denied"],
      [new Error("write failed: No space left on device"), "full"],
      [new Error("SQLITE_FULL"), "full"],
      [new Error("I/O error."), "failed"],
      ["a string", "failed"],
      [undefined, "failed"],
    ];
    for (const [error, fault] of cases)
      expect({ error, fault: vaultFaultOf(error) }).toEqual({ error, fault });
    expect(storeFaultOf("locked")).toBe("unavailable");
    expect(storeFaultOf("corrupt")).toBe("failed");
    expect(storeFaultOf("failed")).toBe("failed");
  });

  test("no fault, status or item but the key's own carries the key", async () => {
    const { vault, disk } = await linked();
    const read = await vault.hub(HUB_A.identity).read();
    if (!read.ok || read.value === undefined) throw new Error("read");
    const secret = b64(read.value.key.privateKey);
    const keyItem = itemsOf(HUB_A.identity)?.key ?? "";
    for (const [name, value] of disk) if (name !== keyItem) expect(value).not.toContain(secret);
    disk.set(keyItem, "***");
    const broken = phoneRecords(memorySecureItems(disk));
    const failed = await broken.hub(HUB_A.identity).read();
    expect(JSON.stringify([failed, broken.status.getState()])).not.toContain(secret);
  });
});

describe("seq across a kill at each point (m2-design.md section 8)", () => {
  test("whatever write the process dies after, the next number is above every number given out", async () => {
    for (let k = 0; k <= 4; k++) {
      const { disk } = await linked(10);
      const items = memorySecureItems(disk);
      const store = phoneRecords(items).hub(HUB_A.identity);
      items.killAfter(k);
      const given: number[] = [];
      for (let i = 0; i < 6; i++) {
        const seq = await orDead(reserveSeq(store));
        if (seq === "dead" || seq === undefined) break;
        // Given out, so it may have been sent: a kill between this and the send skips it.
        given.push(seq);
      }
      expect(items.killed).toBe(true);
      expect(given).toEqual(Array.from({ length: k }, (_, i) => 11 + i));
      // The app starts again on what the store kept.
      const next = await reserveSeq(phoneRecords(memorySecureItems(disk)).hub(HUB_A.identity));
      expect({ k, next }).toEqual({ k, next: 11 + k });
      expect(next).toBeGreaterThan(Math.max(10, ...given));
    }
  });

  test("a kill before the write lands gives the number to nobody: it is the next one again, never sent", async () => {
    const { disk } = await linked(3);
    const items = memorySecureItems(disk);
    items.killAfter(0);
    expect(await orDead(reserveSeq(phoneRecords(items).hub(HUB_A.identity)))).toBe("dead");
    expect(await reserveSeq(phoneRecords(memorySecureItems(disk)).hub(HUB_A.identity))).toBe(4);
  });
});

describe("a link and a removal cut short at each write", () => {
  test("a link killed before its list is written leaves the phone not linked; linking again works", async () => {
    for (let k = 0; k < 4; k++) {
      const disk = new Map<string, string>();
      const items = memorySecureItems(disk);
      items.killAfter(k);
      expect(await orDead(phoneRecords(items).add(recordFor(HUB_A, 1), backup(1), true))).toBe(
        "dead",
      );
      const after = phoneRecords(memorySecureItems(disk));
      expect(await after.list()).toEqual({ ok: true, value: [] });
      expect(await chosenRecordStore(after).read()).toEqual({ ok: true, value: undefined });
      expect((await after.add(recordFor(HUB_A, 5), backup(2), true)).ok).toBe(true);
      const read = await after.hub(HUB_A.identity).read();
      expect(read.ok && hex(read.value?.key.privateKey ?? new Uint8Array())).toBe(
        hex(new Uint8Array(32).fill(5)),
      );
    }
  });

  test("a removal killed after its commit is finished at the next start: no item of the hub is left", async () => {
    for (let k = 0; k <= 4; k++) {
      const { disk } = await linked();
      const items = memorySecureItems(disk);
      items.killAfter(k);
      await orDead(phoneRecords(items).remove(HUB_A.identity));
      const after = phoneRecords(memorySecureItems(disk));
      const listed = await after.list();
      if (k === 0) {
        // Killed before the commit: still linked, whole.
        expect(listed).toEqual({ ok: true, value: [HUB_A.identity] });
        expect((await after.hub(HUB_A.identity).read()).ok).toBe(true);
        continue;
      }
      expect(listed).toEqual({ ok: true, value: [] });
      expect((await after.sweep()).ok).toBe(true);
      expect([...disk.keys()].filter((name) => name.startsWith("hub."))).toEqual([]);
      expect(JSON.parse(disk.get(HUBS_ITEM) ?? "{}")).toEqual({
        v: 1,
        hubs: [],
        chosen: null,
        gone: [],
      });
    }
  });
});

describe("backup keys (m3-design.md section 4)", () => {
  test("sixteen epochs are kept, newest first; the seventeenth drops the oldest", async () => {
    const vault = phoneRecords(memorySecureItems());
    for (let epoch = 0; epoch < BACKUP_EPOCHS_KEPT; epoch++)
      expect((await vault.backupKeys.keep(HUB_A.identity, backup(epoch))).ok).toBe(true);
    const sixteen = await vault.backupKeys.held(HUB_A.identity);
    expect(sixteen.ok && sixteen.value.map((k) => k.epoch)).toEqual(
      Array.from({ length: 16 }, (_, i) => 15 - i),
    );
    expect((await vault.backupKeys.keep(HUB_A.identity, backup(16))).ok).toBe(true);
    const seventeen = await vault.backupKeys.held(HUB_A.identity);
    expect(seventeen.ok && seventeen.value.map((k) => k.epoch)).toEqual(
      Array.from({ length: 16 }, (_, i) => 16 - i),
    );
    expect(seventeen.ok && seventeen.value[0]).toEqual(backup(16));
  });

  test("an epoch already held is replaced; one arriving late takes its place by epoch; one older than sixteen kept is dropped", () => {
    let held: readonly HeldBackupKey[] = [];
    for (const epoch of [3, 1, 2]) held = withBackupKey(held, backup(epoch));
    expect(held.map((k) => k.epoch)).toEqual([3, 2, 1]);
    held = withBackupKey(held, backup(2, 99));
    expect(held).toEqual([backup(3), backup(2, 99), backup(1)]);
    let full: readonly HeldBackupKey[] = [];
    for (let epoch = 10; epoch < 26; epoch++) full = withBackupKey(full, backup(epoch));
    expect(withBackupKey(full, backup(9))).toEqual(full);
  });

  test("the epoch the hub confirmed: LinkResult's at linking, then each confirmation, null once it is no longer held", async () => {
    const { vault } = await linked();
    const keys = vault.backupKeys;
    expect(await keys.confirmed(HUB_A.identity)).toEqual({ ok: true, value: 3 });
    await keys.keep(HUB_A.identity, backup(4));
    expect(await keys.confirmed(HUB_A.identity)).toEqual({ ok: true, value: 3 });
    expect(await keys.confirm(HUB_A.identity, 9)).toEqual({ ok: false, fault: "failed" });
    expect((await keys.confirm(HUB_A.identity, 4)).ok).toBe(true);
    expect(await keys.confirmed(HUB_A.identity)).toEqual({ ok: true, value: 4 });
    for (let epoch = 5; epoch < 5 + BACKUP_EPOCHS_KEPT; epoch++)
      await keys.keep(HUB_A.identity, backup(epoch));
    expect(await keys.confirmed(HUB_A.identity)).toEqual({ ok: true, value: null });
  });

  test("a key that is not 32 bytes, or a negative epoch, is refused", async () => {
    const vault = phoneRecords(memorySecureItems());
    expect(
      await vault.backupKeys.keep(HUB_A.identity, { epoch: 1, key: new Uint8Array(31) }),
    ).toEqual({
      ok: false,
      fault: "failed",
    });
    expect(
      await vault.backupKeys.keep(HUB_A.identity, { epoch: -1, key: new Uint8Array(32) }),
    ).toEqual({
      ok: false,
      fault: "failed",
    });
  });
});

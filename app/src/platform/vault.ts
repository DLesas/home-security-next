/**
 * The phone's vault (m3-design.md section 2, "Keys and storage on the phone"; section 4, "Keeping
 * the key"): what a phone keeps per hub, over its secure store, as `HubRecords`. Platform-neutral:
 * the store itself is a `SecureItems`, expo-secure-store's on a phone (`vault-items.native.ts`),
 * memory in tests, so every rule here runs under `bun test`.
 *
 * Its items, each readable after the first unlock and on this device only (the store's options):
 *
 * - `hubs`: the linked hubs in the order they were linked, the chosen one, and those being
 *   removed. Its write is each link's and each removal's commit point: an item of a hub not
 *   listed is never read, so a kill part way through a link leaves the phone not linked to it.
 * - `hub.<identity>.key`: the client's private key, 32 bytes as base64url.
 * - `hub.<identity>.record`: the rest of the record (`StoredClient` without the private half),
 *   JSON, about 500 bytes: the hub, the public key, the last `seq` and where the hub is reached.
 * - `hub.<identity>.backup`: the backup keys the hub gave, up to 16 epochs, newest first, and the
 *   epoch the hub has recorded as held (`LinkResult`'s, then each `backup.keyHeld` answered), so
 *   a key written but not yet confirmed (a kill between the two) is confirmed at the next session.
 *
 * **`seq`** (m2-design.md section 8): `update` reads the record, changes it and writes it back,
 * and resolves only once the write has resolved, so `reserveSeq` has the next number on disk
 * before the request that carries it is sent; one hub's changes run one at a time, so two
 * requests can never take the same number.
 *
 * **Failures** reach the channel as `Stored`'s two faults (`unavailable`: try again later;
 * `failed`), and in full as a `VaultFault` in `status`, which the pages read to say what is wrong.
 * Nothing here logs, and no fault carries an item's value or the store's own message.
 */
import { parseIdentity } from "@hsn/protocol/app";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { RecordStore, Stored, StoreFault, StoredClient } from "./client-key";
import { keyPairOf } from "./keys.native";
import {
  BACKUP_EPOCHS_KEPT,
  type BackupKeys,
  type HeldBackupKey,
  type HubReach,
  type HubRecords,
} from "./records";
import type { Outcome } from "./split";

/**
 * Why the secure store could not do what was asked, in full:
 *
 * - `locked`: the phone has restarted and not been unlocked since, so an item readable "after the
 *   first unlock" cannot be read yet (iOS's `errSecInteractionNotAllowed`). It passes: the app
 *   tries again when it comes to the front.
 * - `denied`: the system refused the app its store (the Keystore or the keychain refused).
 * - `corrupt`: an item that does not read back as the vault wrote it, or a hub listed whose key
 *   or record is gone (Android deletes an item it cannot decrypt, as after a reinstall).
 * - `full`: no room to write.
 * - `failed`: anything else.
 */
export type VaultFault = "locked" | "denied" | "corrupt" | "full" | "failed";

/** The secure store as the vault uses it: one string per name. Never throws. */
export interface SecureItems {
  /** The item, or null when there is none. */
  get(name: string): Promise<Outcome<string | null, VaultFault>>;
  /** Writes the item; resolves once it is written. */
  set(name: string, value: string): Promise<Outcome<undefined, VaultFault>>;
  /** Deletes the item; one that is not there is deleted already. */
  delete(name: string): Promise<Outcome<undefined, VaultFault>>;
}

/**
 * What the store's own error says, as a fault: from expo-secure-store 58.0.3's messages (read in
 * its sources): iOS's `KeyChainException` reasons and Android's exception texts. Anything not
 * recognised is `failed`. The message itself goes no further.
 */
export function vaultFaultOf(error: unknown): VaultFault {
  const textOf = (value: unknown): string =>
    typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const fields =
    typeof error === "object" && error !== null ? (error as Readonly<Record<string, unknown>>) : {};
  const text = `${textOf(fields.code)} ${textOf(fields.message)} ${textOf(error)}`;
  if (/User interaction is not allowed|errSecInteractionNotAllowed|-25308/iu.test(text))
    return "locked";
  if (/No space left|ENOSPC|SQLITE_FULL|disk is full|disk full|errSecDiskFull|-34\b/iu.test(text))
    return "full";
  if (
    /Could not decrypt|Unable to decode|errSecDecode|unknown encoding scheme|Could not parse the encrypted/iu.test(
      text,
    )
  )
    return "corrupt";
  if (
    /Authentication failed|User canceled|Could not authenticate|accessing the keystore|No keychain is available/iu.test(
      text,
    )
  )
    return "denied";
  return "failed";
}

/** How the channel sees a fault: one that passes (`unavailable`), or one that does not. */
export function storeFaultOf(fault: VaultFault): StoreFault {
  return fault === "locked" || fault === "denied" ? "unavailable" : "failed";
}

/** The vault's last fault, for the pages: null once the hub's record reads or writes again. */
export interface VaultStatus {
  readonly fault: VaultFault | null;
  /** The hub it concerns, or null for the list of hubs. */
  readonly identity: string | null;
}

/** `BackupKeys`, with the epoch the hub has recorded this phone as holding. */
export interface PhoneBackupKeys extends BackupKeys {
  /** The epoch the hub last confirmed (`LinkResult`'s, or a `backup.keyHeld` answered); null for none. */
  confirmed(identity: string): Promise<Stored<number | null>>;
  /** Records that the hub confirmed `epoch`; only an epoch held is confirmed. */
  confirm(identity: string, epoch: number): Promise<Stored<undefined>>;
}

/** The phone's records: `HubRecords`, with the hub chosen for the session (M5: one at a time). */
export interface PhoneRecords extends HubRecords<Uint8Array> {
  readonly backupKeys: PhoneBackupKeys;
  /**
   * A new link, as `HubRecords.add`; with `choose`, the hub becomes the chosen one in the same
   * write that lists it.
   */
  add(
    record: StoredClient<Uint8Array>,
    backupKey: HeldBackupKey | null,
    choose?: boolean,
  ): Promise<Stored<StoredClient<Uint8Array>>>;
  /** The hub the session is for; null when none is (not linked, or just removed). */
  chosen(): Promise<Stored<string | null>>;
  choose(identity: string | null): Promise<Stored<undefined>>;
  /**
   * Deletes what a removal left behind when it was cut short (a kill between its commit and its
   * deletions): run once at start.
   */
  sweep(): Promise<Stored<undefined>>;
  readonly status: StoreApi<VaultStatus>;
}

const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });

// ----- base64url, for the bytes in items -----

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64url(text: unknown, length: number): Uint8Array | undefined {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/u.test(text)) return undefined;
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = (() => {
    try {
      return atob(padded);
    } catch {
      return undefined;
    }
  })();
  if (binary === undefined) return undefined;
  const out = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return out.length === length && toBase64url(out) === text ? out : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

// ----- The items' names and contents -----

/** The item names of one hub; undefined for an identity that is not one (and so names nothing). */
export function itemsOf(
  identity: string,
): { readonly key: string; readonly record: string; readonly backup: string } | undefined {
  if (parseIdentity(identity) === undefined) return undefined;
  return {
    key: `hub.${identity}.key`,
    record: `hub.${identity}.record`,
    backup: `hub.${identity}.backup`,
  };
}

export const HUBS_ITEM = "hubs";

/** The `hubs` item. */
interface HubList {
  readonly hubs: readonly string[];
  readonly chosen: string | null;
  /** Hubs removed whose items may still be there. */
  readonly gone: readonly string[];
}

const NO_HUBS: HubList = { hubs: [], chosen: null, gone: [] };

function readHubList(text: string | null): HubList | undefined {
  if (text === null) return NO_HUBS;
  const value = parseJson(text);
  if (typeof value !== "object" || value === null) return undefined;
  const list = value as { readonly v?: unknown; hubs?: unknown; chosen?: unknown; gone?: unknown };
  const names = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && parseIdentity(x) !== undefined);
  if (list.v !== 1 || !names(list.hubs) || !names(list.gone)) return undefined;
  if (list.chosen !== null && (typeof list.chosen !== "string" || !list.hubs.includes(list.chosen)))
    return undefined;
  return { hubs: list.hubs, chosen: list.chosen, gone: list.gone };
}

function writeHubList(list: HubList): string {
  return JSON.stringify({ v: 1, hubs: list.hubs, chosen: list.chosen, gone: list.gone });
}

function readReach(value: unknown): HubReach | undefined | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Partial<Record<keyof HubReach, unknown>>;
  const addresses = r.addresses;
  if (!Array.isArray(addresses) || !addresses.every((a) => typeof a === "string")) return undefined;
  if (!isInt(r.appsPort, 1, 65_535)) return undefined;
  if (r.lastAddress !== null && typeof r.lastAddress !== "string") return undefined;
  if (r.relayUrl !== null && typeof r.relayUrl !== "string") return undefined;
  if (typeof r.homeName !== "string") return undefined;
  return {
    addresses,
    appsPort: r.appsPort,
    lastAddress: r.lastAddress,
    relayUrl: r.relayUrl,
    homeName: r.homeName,
  };
}

/** The record item: everything of `StoredClient` but the private half. */
function writeRecord(record: StoredClient<Uint8Array>): string {
  return JSON.stringify({
    v: 1,
    identity: record.hub.identity,
    staticKey: toBase64url(record.hub.staticKey),
    client: record.hub.client,
    person: record.hub.person,
    publicKey: toBase64url(record.key.publicKey),
    lastSeq: record.lastSeq,
    ...(record.reach === undefined ? {} : { reach: record.reach }),
  });
}

/** The record from its two items, or undefined when they do not read back as written, or disagree. */
function readRecord(
  identity: string,
  recordText: string,
  keyText: string,
): StoredClient<Uint8Array> | undefined {
  const value = parseJson(recordText);
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Readonly<Record<string, unknown>>;
  const staticKey = fromBase64url(r.staticKey, 32);
  const publicKey = fromBase64url(r.publicKey, 32);
  const privateKey = fromBase64url(keyText, 32);
  const reach = readReach(r.reach);
  if (r.v !== 1 || r.identity !== identity || staticKey === undefined || publicKey === undefined)
    return undefined;
  if (!isInt(r.client, 1) || (r.person !== null && !isInt(r.person, 1)) || !isInt(r.lastSeq, 0))
    return undefined;
  if (privateKey === undefined || reach === undefined) return undefined;
  // The key read back must be the one the record names.
  const pair = keyPairOf(privateKey);
  privateKey.fill(0);
  if (pair === undefined || toBase64url(pair.publicKey) !== toBase64url(publicKey))
    return undefined;
  return {
    key: pair,
    hub: { identity, staticKey, client: r.client, person: r.person },
    lastSeq: r.lastSeq,
    ...(reach === null ? {} : { reach }),
  };
}

/** The backup item: the keys, and the epoch the hub confirmed. */
interface BackupItem {
  readonly keys: readonly HeldBackupKey[];
  readonly confirmed: number | null;
}

const NO_BACKUPS: BackupItem = { keys: [], confirmed: null };

function readBackups(text: string | null): BackupItem | undefined {
  if (text === null) return NO_BACKUPS;
  const value = parseJson(text);
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as {
    readonly v?: unknown;
    readonly keys?: unknown;
    readonly confirmed?: unknown;
  };
  if (item.v !== 1 || !Array.isArray(item.keys)) return undefined;
  if (item.confirmed !== null && !isInt(item.confirmed, 0)) return undefined;
  const keys: HeldBackupKey[] = [];
  for (const entry of item.keys as unknown[]) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const e = entry as { readonly epoch?: unknown; readonly key?: unknown };
    const key = fromBase64url(e.key, 32);
    if (!isInt(e.epoch, 0) || key === undefined) return undefined;
    keys.push({ epoch: e.epoch, key });
  }
  return { keys, confirmed: item.confirmed };
}

function writeBackups(item: BackupItem): string {
  return JSON.stringify({
    v: 1,
    keys: item.keys.map((k) => ({ epoch: k.epoch, key: toBase64url(k.key) })),
    confirmed: item.confirmed,
  });
}

/** The keys kept: `key` added (in place of one of its epoch), newest first, at most 16. */
export function withBackupKey(
  held: readonly HeldBackupKey[],
  key: HeldBackupKey,
): readonly HeldBackupKey[] {
  return [key, ...held.filter((k) => k.epoch !== key.epoch)]
    .sort((a, b) => b.epoch - a.epoch)
    .slice(0, BACKUP_EPOCHS_KEPT);
}

function validRecord(record: StoredClient<Uint8Array>): boolean {
  return (
    parseIdentity(record.hub.identity) !== undefined &&
    record.hub.staticKey.length === 32 &&
    record.key.publicKey.length === 32 &&
    record.key.privateKey.length === 32 &&
    isInt(record.hub.client, 1) &&
    isInt(record.lastSeq, 0) &&
    (record.reach === undefined || readReach(record.reach) !== undefined)
  );
}

// ----- The vault -----

/** Runs each task after the last one has settled, whatever its outcome. */
function queue(): <T>(task: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = last.then(task, task);
    last = run;
    return run;
  };
}

/** The phone's records over its secure store. */
export function phoneRecords(items: SecureItems): PhoneRecords {
  const status = createStore<VaultStatus>()(() => ({ fault: null, identity: null }));
  const listQueue = queue();
  const hubQueues = new Map<string, <T>(task: () => Promise<T>) => Promise<T>>();
  const inQueue = (identity: string) => {
    let q = hubQueues.get(identity);
    if (q === undefined) {
      q = queue();
      hubQueues.set(identity, q);
    }
    return q;
  };

  const failed = <T>(fault: VaultFault, identity: string | null): Stored<T> => {
    status.setState({ fault, identity }, true);
    return { ok: false, fault: storeFaultOf(fault) };
  };
  /**
   * A read or write of `identity` worked: its fault, or one of the list's, has passed; but a full
   * store is known to have room again only from a write.
   */
  const cleared = (identity: string | null, by: "read" | "write"): void => {
    const now = status.getState();
    if (now.fault === null || (now.fault === "full" && by === "read")) return;
    if (now.identity === identity || now.identity === null)
      status.setState({ fault: null, identity: null }, true);
  };

  async function readList(): Promise<Outcome<HubList, VaultFault>> {
    const text = await items.get(HUBS_ITEM);
    if (!text.ok) return text;
    const list = readHubList(text.value);
    return list === undefined ? { ok: false, fault: "corrupt" } : ok(list);
  }

  async function writeList(list: HubList): Promise<Outcome<undefined, VaultFault>> {
    return items.set(HUBS_ITEM, writeHubList(list));
  }

  /** One hub's record, read from its items: undefined when it is not listed. */
  async function readHub(
    identity: string,
  ): Promise<Outcome<StoredClient<Uint8Array> | undefined, VaultFault>> {
    const names = itemsOf(identity);
    if (names === undefined) return ok(undefined);
    const list = await readList();
    if (!list.ok) return list;
    if (!list.value.hubs.includes(identity)) return ok(undefined);
    const recordText = await items.get(names.record);
    if (!recordText.ok) return recordText;
    const keyText = await items.get(names.key);
    if (!keyText.ok) return keyText;
    // Listed, so both were written: one missing was lost (Android drops what it cannot decrypt).
    if (recordText.value === null || keyText.value === null) return { ok: false, fault: "corrupt" };
    const record = readRecord(identity, recordText.value, keyText.value);
    return record === undefined ? { ok: false, fault: "corrupt" } : ok(record);
  }

  /** Writes a hub's key (when it is not the one there) and record. */
  async function writeHub(
    record: StoredClient<Uint8Array>,
    keyChanged: boolean,
  ): Promise<Outcome<undefined, VaultFault>> {
    const names = itemsOf(record.hub.identity);
    if (names === undefined) return { ok: false, fault: "failed" };
    if (keyChanged) {
      const key = await items.set(names.key, toBase64url(record.key.privateKey));
      if (!key.ok) return key;
    }
    return items.set(names.record, writeRecord(record));
  }

  async function deleteItems(identity: string): Promise<Outcome<undefined, VaultFault>> {
    const names = itemsOf(identity);
    if (names === undefined) return ok(undefined);
    for (const name of [names.key, names.backup, names.record]) {
      const deleted = await items.delete(name);
      if (!deleted.ok) return deleted;
    }
    return ok(undefined);
  }

  /** The backup item of a hub, read in its queue. */
  async function readBackupItem(identity: string): Promise<Outcome<BackupItem, VaultFault>> {
    const names = itemsOf(identity);
    if (names === undefined) return ok(NO_BACKUPS);
    const text = await items.get(names.backup);
    if (!text.ok) return text;
    const item = readBackups(text.value);
    return item === undefined ? { ok: false, fault: "corrupt" } : ok(item);
  }

  const backupKeys: PhoneBackupKeys = {
    held: (identity) =>
      inQueue(identity)(async () => {
        const item = await readBackupItem(identity);
        if (!item.ok) return failed(item.fault, identity);
        return ok([...item.value.keys].sort((a, b) => b.epoch - a.epoch));
      }),
    keep: (identity, key) =>
      inQueue(identity)(async () => {
        const names = itemsOf(identity);
        if (names === undefined || !isInt(key.epoch, 0) || key.key.length !== 32)
          return failed("failed", identity);
        const item = await readBackupItem(identity);
        if (!item.ok && item.fault !== "corrupt") return failed(item.fault, identity);
        // Keys that no longer read cannot be kept; the new one still is, so the phone is not left
        // without the current key for an old item's fault.
        const before = item.ok ? item.value : NO_BACKUPS;
        const keys = withBackupKey(before.keys, key);
        const confirmed = keys.some((k) => k.epoch === before.confirmed) ? before.confirmed : null;
        const written = await items.set(names.backup, writeBackups({ keys, confirmed }));
        return written.ok ? ok(undefined) : failed(written.fault, identity);
      }),
    confirmed: (identity) =>
      inQueue(identity)(async () => {
        const item = await readBackupItem(identity);
        return item.ok ? ok(item.value.confirmed) : failed(item.fault, identity);
      }),
    confirm: (identity, epoch) =>
      inQueue(identity)(async () => {
        const names = itemsOf(identity);
        const item = await readBackupItem(identity);
        if (!item.ok) return failed(item.fault, identity);
        if (names === undefined || !item.value.keys.some((k) => k.epoch === epoch))
          return failed("failed", identity);
        const written = await items.set(
          names.backup,
          writeBackups({ keys: item.value.keys, confirmed: epoch }),
        );
        return written.ok ? ok(undefined) : failed(written.fault, identity);
      }),
  };

  async function add(
    record: StoredClient<Uint8Array>,
    backupKey: HeldBackupKey | null,
    choose = false,
  ): Promise<Stored<StoredClient<Uint8Array>>> {
    const identity = record.hub.identity;
    if (!validRecord(record)) return failed("failed", identity);
    // The hub's items first, the list last: a kill before the list's write leaves it not linked.
    const linked = await inQueue(identity)(async () => {
      const wrote = await writeHub(record, true);
      if (!wrote.ok) return wrote;
      if (backupKey === null) return ok(undefined);
      const names = itemsOf(identity);
      if (names === undefined) return { ok: false as const, fault: "failed" as const };
      const text = await items.get(names.backup);
      if (!text.ok) return text;
      // `LinkResult`'s epoch is recorded as held by the hub at linking (m3-design.md section 4).
      const before = readBackups(text.value) ?? NO_BACKUPS;
      return items.set(
        names.backup,
        writeBackups({ keys: withBackupKey(before.keys, backupKey), confirmed: backupKey.epoch }),
      );
    });
    if (!linked.ok) return failed(linked.fault, identity);
    const listed = await listQueue(async () => {
      const list = await readList();
      if (!list.ok) return list;
      const hubs = list.value.hubs.includes(identity)
        ? list.value.hubs
        : [...list.value.hubs, identity];
      return writeList({
        hubs,
        chosen: choose ? identity : list.value.chosen,
        gone: list.value.gone.filter((g) => g !== identity),
      });
    });
    if (!listed.ok) return failed(listed.fault, null);
    cleared(identity, "write");
    return ok(record);
  }

  async function remove(identity: string): Promise<Stored<undefined>> {
    // The commit point: the hub leaves the list (and is marked gone), then its items go.
    const committed = await listQueue(async () => {
      const list = await readList();
      if (!list.ok) return list;
      return writeList({
        hubs: list.value.hubs.filter((h) => h !== identity),
        chosen: list.value.chosen === identity ? null : list.value.chosen,
        gone: list.value.gone.includes(identity) ? list.value.gone : [...list.value.gone, identity],
      });
    });
    if (!committed.ok) return failed(committed.fault, null);
    const deleted = await inQueue(identity)(() => deleteItems(identity));
    if (!deleted.ok) return failed(deleted.fault, identity);
    const done = await listQueue(async () => {
      const list = await readList();
      if (!list.ok) return list;
      return writeList({ ...list.value, gone: list.value.gone.filter((g) => g !== identity) });
    });
    if (!done.ok) return failed(done.fault, null);
    cleared(identity, "write");
    return ok(undefined);
  }

  function hub(identity: string): RecordStore<Uint8Array> {
    return {
      read: () =>
        inQueue(identity)(async () => {
          const read = await readHub(identity);
          if (!read.ok) return failed(read.fault, identity);
          cleared(identity, "read");
          return ok(read.value);
        }),
      write: (record) =>
        record.hub.identity === identity
          ? add(record, null)
          : Promise.resolve(failed("failed", identity)),
      update: (change) =>
        inQueue(identity)(async () => {
          const read = await readHub(identity);
          if (!read.ok) return failed(read.fault, identity);
          if (read.value === undefined) return ok(undefined);
          const next = change(read.value);
          if (next.hub.identity !== identity || !validRecord(next))
            return failed("failed", identity);
          const keyChanged =
            toBase64url(next.key.privateKey) !== toBase64url(read.value.key.privateKey);
          const wrote = await writeHub(next, keyChanged);
          if (!wrote.ok) return failed(wrote.fault, identity);
          cleared(identity, "write");
          return ok(next);
        }),
      clear: () => remove(identity),
    };
  }

  return {
    status,
    backupKeys,
    add,
    remove,
    hub,
    list: () =>
      listQueue(async () => {
        const list = await readList();
        if (!list.ok) return failed(list.fault, null);
        cleared(null, "read");
        return ok(list.value.hubs);
      }),
    chosen: () =>
      listQueue(async () => {
        const list = await readList();
        if (!list.ok) return failed(list.fault, null);
        cleared(null, "read");
        return ok(list.value.chosen);
      }),
    choose: (identity) =>
      listQueue(async () => {
        const list = await readList();
        if (!list.ok) return failed(list.fault, null);
        if (identity !== null && !list.value.hubs.includes(identity)) return failed("failed", null);
        const wrote = await writeList({ ...list.value, chosen: identity });
        return wrote.ok ? ok(undefined) : failed(wrote.fault, null);
      }),
    sweep: async () => {
      const list = await listQueue(readList);
      if (!list.ok) return failed(list.fault, null);
      for (const identity of list.value.gone) {
        const done = await remove(identity);
        if (!done.ok) return done;
      }
      return ok(undefined);
    },
  };
}

/**
 * The chosen hub's record, as the channel takes one `RecordStore`: not linked while no hub is
 * chosen. A link writes through it (`write`), and chooses that hub.
 */
export function chosenRecordStore(records: PhoneRecords): RecordStore<Uint8Array> {
  return {
    read: async () => {
      const chosen = await records.chosen();
      if (!chosen.ok) return chosen;
      return chosen.value === null ? ok(undefined) : records.hub(chosen.value).read();
    },
    write: (record) => records.add(record, null, true),
    update: async (change) => {
      const chosen = await records.chosen();
      if (!chosen.ok) return chosen;
      return chosen.value === null ? ok(undefined) : records.hub(chosen.value).update(change);
    },
    clear: async () => {
      const chosen = await records.chosen();
      if (!chosen.ok) return chosen;
      return chosen.value === null ? ok(undefined) : records.remove(chosen.value);
    },
  };
}

// ----- In memory, for tests -----

/** A failure to give, once, at a given call. */
export interface ItemFault {
  readonly op: "get" | "set" | "delete";
  /** Only for this item; any item when not given. */
  readonly name?: string;
  readonly fault: VaultFault;
}

/** The secure store in memory, with its failures and a kill for tests. */
export interface MemoryItems extends SecureItems {
  /** What is on "disk": survives a kill, as the phone's store does. */
  readonly disk: Map<string, string>;
  /** Every write and delete, in order, by name. */
  readonly writes: string[];
  /** The next call that matches fails, once. */
  failNext(fault: ItemFault): void;
  /** Every call fails with this until `fail(null)`: a locked phone, a store refused. */
  fail(fault: VaultFault | null): void;
  /**
   * The process dies after `n` more writes or deletes: those happen, and nothing after them does;
   * every later call never resolves, as nothing runs in a dead process.
   */
  killAfter(n: number): void;
  readonly killed: boolean;
}

export function memorySecureItems(disk = new Map<string, string>()): MemoryItems {
  let once: ItemFault[] = [];
  let always: VaultFault | null = null;
  let writesLeft = Number.POSITIVE_INFINITY;
  let killed = false;
  const writes: string[] = [];
  const never = new Promise<never>(() => undefined);
  const faultFor = (op: ItemFault["op"], name: string): VaultFault | undefined => {
    if (always !== null) return always;
    const at = once.findIndex((f) => f.op === op && (f.name === undefined || f.name === name));
    if (at < 0) return undefined;
    const found = once[at];
    once = once.filter((_, i) => i !== at);
    return found?.fault;
  };
  return {
    disk,
    writes,
    get killed() {
      return killed;
    },
    failNext: (fault) => {
      once = [...once, fault];
    },
    fail: (fault) => {
      always = fault;
    },
    killAfter: (n) => {
      writesLeft = n;
    },
    get: (name) => {
      if (killed) return never;
      const fault = faultFor("get", name);
      return Promise.resolve(
        fault === undefined ? ok(disk.get(name) ?? null) : { ok: false, fault },
      );
    },
    set: (name, value) => {
      if (killed) return never;
      if (writesLeft <= 0) {
        killed = true;
        return never;
      }
      const fault = faultFor("set", name);
      if (fault !== undefined) return Promise.resolve({ ok: false, fault });
      writesLeft -= 1;
      disk.set(name, value);
      writes.push(name);
      return Promise.resolve(ok(undefined));
    },
    delete: (name) => {
      if (killed) return never;
      if (writesLeft <= 0) {
        killed = true;
        return never;
      }
      const fault = faultFor("delete", name);
      if (fault !== undefined) return Promise.resolve({ ok: false, fault });
      writesLeft -= 1;
      disk.delete(name);
      writes.push(`-${name}`);
      return Promise.resolve(ok(undefined));
    },
  };
}

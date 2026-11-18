/**
 * What a phone keeps per hub (m3-design.md section 2, "Keys and storage on the phone"; section
 * 4, "Keeping the key"). Types only, frozen by step 0; the phone's implementation over
 * expo-secure-store is P2's (wave 1). A browser keeps one hub's record and no backup key, in
 * IndexedDB (`keys.web.ts`).
 *
 * The phone's items: `hubs` (the list), and per hub `hub.<identity>.key` (the client's private
 * key), `hub.<identity>.record` (the rest of `StoredClient`, JSON, about 500 bytes) and
 * `hub.<identity>.backup` (its backup keys). Each is readable after the first unlock, on this
 * device only, so a lock-screen Disarm can read it and a phone backup carries none of it.
 */
import type { RecordStore, Stored, StoredClient } from "./client-key";
import type { PlatformSecret } from "./keys";

/** Where a phone reaches one hub, kept in its record (m3-design.md section 2, "Reaching the hub at home"). */
export interface HubReach {
  /** The hub's home-network addresses as it last named them: the code's `a=`, then `hub.info`'s `addresses`. */
  readonly addresses: readonly string[];
  /** The apps' port: the code's `p=`, then `hub.info`'s `appsPort`. */
  readonly appsPort: number;
  /** The address that last worked, tried first; null before the first session. */
  readonly lastAddress: string | null;
  /** The hub's relay: `hub.info`'s `relay`, else the code's `r=`; null for the deployment's default. */
  readonly relayUrl: string | null;
  /** The home's name on this phone (M5): "Home", then "Home 2". */
  readonly homeName: string;
}

/** A backup key as a phone holds it (D78, D99): `LinkResult.backupKey` and `backup.key`'s reply. */
export interface HeldBackupKey {
  readonly epoch: number;
  /** 32 bytes. Never shown, logged, put in a store, an event or a crash report. */
  readonly key: Uint8Array;
}

/** How many epochs of backup keys a phone keeps per hub; past it, the oldest goes (section 4). */
export const BACKUP_EPOCHS_KEPT = 16;

/** A phone's backup keys, per hub (m3-design.md section 4). */
export interface BackupKeys {
  /** The keys held for a hub, newest epoch first. */
  held(identity: string): Promise<Stored<readonly HeldBackupKey[]>>;
  /**
   * Keeps a key, written before it resolves (only then does the phone send `backup.keyHeld`);
   * the oldest beyond `BACKUP_EPOCHS_KEPT` goes. An epoch already held is replaced.
   */
  keep(identity: string, key: HeldBackupKey): Promise<Stored<undefined>>;
}

/**
 * The hubs a phone is linked to, one `RecordStore` each (m3-design.md section 2): one key per
 * hub, so two hubs cannot tell they share a phone. A browser uses one record and no list, so M5's
 * several hubs need no migration of the web's.
 */
export interface HubRecords<S = PlatformSecret> {
  /** The linked hubs' identities, in the order they were linked (the item `hubs`). */
  list(): Promise<Stored<readonly string[]>>;
  /** One hub's record, key and last `seq`, as the channel uses it. */
  hub(identity: string): RecordStore<S>;
  /**
   * A new link: the record, its key and the backup key `LinkResult` gave (a phone's always has
   * one), written before it resolves, and only then the hub listed. A failed write leaves the
   * phone not linked to that hub, and the link fails.
   */
  add(record: StoredClient<S>, backupKey: HeldBackupKey | null): Promise<Stored<StoredClient<S>>>;
  /**
   * A hub gone from this phone (the `session` event says it was removed, five refused handshakes,
   * or the person removed the home): its record, key, backup keys and push key deleted, and it
   * leaves the list.
   */
  remove(identity: string): Promise<Stored<undefined>>;
  readonly backupKeys: BackupKeys;
}

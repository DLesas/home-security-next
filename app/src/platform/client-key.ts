/**
 * The client's key and what it keeps per hub (m2-design.md sections 5 and 8, "Keys and sequence
 * numbers"; m3-design.md section 2, "Keys and storage on the phone"). Shared by both builds; how
 * a key is made and used is each platform's (`keys.ts`, `keys.web.ts`, `keys.native.ts`).
 *
 * - A browser's static key is Web Crypto's X25519, **non-extractable** (spike K1,
 *   docs/spikes/K1-browser-key.md); a phone's is 32 bytes in its secure store. Either way its
 *   Diffie-Hellman sits behind the Noise code's `StaticKey`, so the protocol package's Noise runs
 *   unchanged on it.
 * - Per hub the client keeps the hub's identity and static key, its own key, its client id and
 *   person, and its last `seq`. The next `seq` is written to storage before the request is sent,
 *   so a crash in between skips a number and never reuses one.
 *
 * Nothing here logs, and the key never leaves this record: it is not in the live store, not in a
 * message between tabs, not in the address.
 */
import type { StaticKey } from "@hsn/protocol/app";
import type { PlatformSecret } from "./keys";
import type { HubReach } from "./records";
import type { NotBuilt, Outcome } from "./split";

/**
 * The client's key pair: the private half as its platform holds it (`S`, the platform's
 * `PlatformSecret`), the public half its 32 bytes. Shared code never looks inside the private
 * half: it keeps it in the record and hands it back to its platform's `staticKeyOf`.
 */
export interface ClientKeyPair<S = PlatformSecret> {
  readonly privateKey: S;
  readonly publicKey: Uint8Array;
}

/** The hub this browser is linked to (M2: one; several hubs are M5's). */
export interface LinkedHub {
  /** The hub's app identity, 26 characters of base32. */
  readonly identity: string;
  /** The hub's static key, 32 bytes, pinned since linking. */
  readonly staticKey: Uint8Array;
  readonly client: number;
  readonly person: number | null;
}

/** What the client keeps per hub: its key, the hub, and the last `seq` it used. */
export interface StoredClient<S = PlatformSecret> {
  readonly key: ClientKeyPair<S>;
  readonly hub: LinkedHub;
  readonly lastSeq: number;
  /** Where a phone reaches the hub at home and away (m3-design.md section 2); a browser has none. */
  readonly reach?: HubReach;
}

/** Why storage failed. */
export type StoreFault = "unavailable" | "failed";

export type Stored<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: StoreFault };

/**
 * Where one hub's record lives: IndexedDB in a browser (`keys.web.ts`), the phone's secure store
 * (`keys.native.ts`), memory in tests. `update` reads, changes and writes the record in one
 * transaction and resolves only once it is written.
 */
export interface RecordStore<S = PlatformSecret> {
  read(): Promise<Stored<StoredClient<S> | undefined>>;
  write(record: StoredClient<S>): Promise<Stored<StoredClient<S>>>;
  update(
    change: (record: StoredClient<S>) => StoredClient<S>,
  ): Promise<Stored<StoredClient<S> | undefined>>;
  clear(): Promise<Stored<undefined>>;
}

/** Why a key could not be made: the browser's three, and a phone's while it is not built. */
export type KeyFault = "noWebCrypto" | "extractable" | "failed" | NotBuilt["fault"];

/** What a platform gives the shared code for its key, `S` being its `PlatformSecret`. */
export interface ClientKeys<S> {
  /** Makes a new static key for one hub (one per link, so two hubs cannot tell they share a client). */
  readonly makeClientKey: () => Promise<Outcome<ClientKeyPair<S>, KeyFault>>;
  /** The key as the Noise code's `StaticKey`. */
  readonly staticKeyOf: (pair: ClientKeyPair<S>) => StaticKey;
}

/**
 * The next `seq`, written to storage before it is returned (section 8): one above the last used.
 * Undefined when there is no record or storage failed; the request is then not sent.
 */
export async function reserveSeq<S>(store: RecordStore<S>): Promise<number | undefined> {
  const updated = await store.update((record) => ({ ...record, lastSeq: record.lastSeq + 1 }));
  return updated.ok ? updated.value?.lastSeq : undefined;
}

/**
 * After `seqTooLow {last}` (section 5; a restored hub raises every client's last by 2³²): the
 * stored last `seq` moves up to the hub's, never down.
 */
export async function raiseSeq<S>(store: RecordStore<S>, last: number): Promise<boolean> {
  const updated = await store.update((record) => ({
    ...record,
    lastSeq: Math.max(record.lastSeq, last),
  }));
  return updated.ok && updated.value !== undefined;
}

/** A record store in memory, for tests. A browser without IndexedDB cannot be linked (section 5). */
export function memoryRecordStore<S = PlatformSecret>(initial?: StoredClient<S>): RecordStore<S> {
  let record = initial;
  return {
    read: () => Promise.resolve({ ok: true, value: record }),
    write: (next) => {
      record = next;
      return Promise.resolve({ ok: true, value: next });
    },
    update: (change) => {
      if (record !== undefined) record = change(record);
      return Promise.resolve({ ok: true, value: record });
    },
    clear: () => {
      record = undefined;
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
}

/**
 * The browser's own key and what it keeps per hub (m2-design.md sections 5 and 8, "Keys and
 * sequence numbers"; spike K1, docs/spikes/K1-browser-key.md).
 *
 * - The client's static key is made by Web Crypto's X25519 as a **non-extractable** key: script
 *   on the page can use it while it runs, never read it out. A key that comes back extractable is
 *   refused, and the browser cannot be linked.
 * - Its Diffie-Hellman is `deriveBits`, behind the Noise code's `StaticKey`, so the protocol
 *   package's Noise runs unchanged on it.
 * - Per hub the client keeps the hub's identity and static key, its own key, its client id and
 *   person, and its last `seq`. The next `seq` is written to storage before the request is sent,
 *   so a crash in between skips a number and never reuses one.
 *
 * Nothing here logs, and the key never leaves this record: it is not in the live store, not in a
 * message between tabs, not in the address.
 */
import type { StaticKey } from "@hsn/protocol/app";

/** The client's key pair: the private half a non-extractable `CryptoKey`, the public half its 32 bytes. */
export interface ClientKeyPair {
  readonly privateKey: CryptoKey;
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

/** What the browser keeps: its key, the hub, and the last `seq` it used. */
export interface StoredClient {
  readonly key: ClientKeyPair;
  readonly hub: LinkedHub;
  readonly lastSeq: number;
}

/** Why storage failed. */
export type StoreFault = "unavailable" | "failed";

export type Stored<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: StoreFault };

/**
 * Where the record lives: IndexedDB in a browser (`keys.web.ts`), memory in tests. `update` reads,
 * changes and writes the record in one transaction and resolves only once it is written.
 */
export interface RecordStore {
  read(): Promise<Stored<StoredClient | undefined>>;
  write(record: StoredClient): Promise<Stored<StoredClient>>;
  update(change: (record: StoredClient) => StoredClient): Promise<Stored<StoredClient | undefined>>;
  clear(): Promise<Stored<undefined>>;
}

/** Why a key could not be made. */
export type KeyFault = "noWebCrypto" | "extractable" | "failed";

function isKeyPair(key: CryptoKey | CryptoKeyPair): key is CryptoKeyPair {
  return "privateKey" in key;
}

/**
 * Makes the client's static key: X25519, non-extractable, usable only for `deriveBits`. A browser
 * that cannot make one, or makes one that can be read out, cannot be linked (section 5).
 */
/** Web Crypto's `subtle`, which a page that is not a secure context does not have, whatever the types say. */
export function webSubtle(): SubtleCrypto | undefined {
  return (globalThis as { readonly crypto?: { readonly subtle?: SubtleCrypto } }).crypto?.subtle;
}

export async function makeClientKey(
  subtle: SubtleCrypto | undefined = webSubtle(),
): Promise<
  | { readonly ok: true; readonly value: ClientKeyPair }
  | { readonly ok: false; readonly fault: KeyFault }
> {
  if (subtle === undefined) return { ok: false, fault: "noWebCrypto" };
  let made: CryptoKey | CryptoKeyPair;
  try {
    made = await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  } catch {
    return { ok: false, fault: "noWebCrypto" };
  }
  if (!isKeyPair(made)) return { ok: false, fault: "failed" };
  if (made.privateKey.extractable) return { ok: false, fault: "extractable" };
  try {
    const publicKey = new Uint8Array(await subtle.exportKey("raw", made.publicKey));
    return publicKey.length === 32
      ? { ok: true, value: { privateKey: made.privateKey, publicKey } }
      : { ok: false, fault: "failed" };
  } catch {
    return { ok: false, fault: "failed" };
  }
}

/**
 * The key as the Noise code's `StaticKey`: its Diffie-Hellman through `deriveBits`. A low-order
 * public key makes Web Crypto refuse, which the Noise code takes as an all-zero result.
 */
export function staticKeyOf(
  pair: ClientKeyPair,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): StaticKey {
  return {
    publicKey: pair.publicKey,
    dh: async (theirPublic) => {
      const theirs = await subtle.importKey(
        "raw",
        theirPublic.slice(),
        { name: "X25519" },
        true,
        [],
      );
      const bits = await subtle.deriveBits(
        { name: "X25519", public: theirs },
        pair.privateKey,
        256,
      );
      return new Uint8Array(bits);
    },
  };
}

/**
 * The next `seq`, written to storage before it is returned (section 8): one above the last used.
 * Undefined when there is no record or storage failed; the request is then not sent.
 */
export async function reserveSeq(store: RecordStore): Promise<number | undefined> {
  const updated = await store.update((record) => ({ ...record, lastSeq: record.lastSeq + 1 }));
  return updated.ok ? updated.value?.lastSeq : undefined;
}

/**
 * After `seqTooLow {last}` (section 5; a restored hub raises every client's last by 2³²): the
 * stored last `seq` moves up to the hub's, never down.
 */
export async function raiseSeq(store: RecordStore, last: number): Promise<boolean> {
  const updated = await store.update((record) => ({
    ...record,
    lastSeq: Math.max(record.lastSeq, last),
  }));
  return updated.ok && updated.value !== undefined;
}

/** A record store in memory, for tests. A browser without IndexedDB cannot be linked (section 5). */
export function memoryRecordStore(initial?: StoredClient): RecordStore {
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

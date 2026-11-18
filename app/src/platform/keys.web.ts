/**
 * The browser's key and record (m2-design.md section 8, `keys.web.ts`; spike K1), the web build's
 * side of `keys.ts`.
 *
 * - The client's static key is made by Web Crypto's X25519 as a **non-extractable** key: script
 *   on the page can use it while it runs, never read it out. A key that comes back extractable is
 *   refused, and the browser cannot be linked. Its Diffie-Hellman is `deriveBits`.
 * - The record lives in IndexedDB: one object store, one record, holding the non-extractable
 *   `CryptoKey` itself (a structured clone, which IndexedDB keeps without ever exposing the key's
 *   bytes), the hub, and the last `seq`. Each `update` is one read-write transaction, resolved
 *   only when it is complete: so the next `seq` is on disk before the request that carries it is
 *   sent.
 */
import type { StaticKey } from "@hsn/protocol/app";
import type { ClientKeyPair, KeyFault, RecordStore, Stored, StoredClient } from "./client-key";
import type { Outcome } from "./split";

/**
 * The browser's private half: a non-extractable Web Crypto key. tsc reads it as every platform's
 * (`keys.ts`), so the record's types below need no argument.
 */
export type PlatformSecret = CryptoKey;

function isKeyPair(key: CryptoKey | CryptoKeyPair): key is CryptoKeyPair {
  return "privateKey" in key;
}

/** Web Crypto's `subtle`, which a page that is not a secure context does not have, whatever the types say. */
export function webSubtle(): SubtleCrypto | undefined {
  return (globalThis as { readonly crypto?: { readonly subtle?: SubtleCrypto } }).crypto?.subtle;
}

/**
 * Makes the client's static key: X25519, non-extractable, usable only for `deriveBits`. A browser
 * that cannot make one, or makes one that can be read out, cannot be linked (section 5).
 */
export async function makeClientKey(
  subtle: SubtleCrypto | undefined = webSubtle(),
): Promise<Outcome<ClientKeyPair, KeyFault>> {
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

const DATABASE = "hsn-app";
const VERSION = 1;
const STORE = "client";
const KEY = "hub";

function isStoredClient(value: unknown): value is StoredClient {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StoredClient>;
  return (
    typeof record.lastSeq === "number" &&
    typeof record.hub?.identity === "string" &&
    record.hub.staticKey instanceof Uint8Array &&
    record.key?.publicKey instanceof Uint8Array &&
    typeof record.key.privateKey === "object"
  );
}

function open(factory: IDBFactory): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DATABASE, VERSION);
    } catch {
      resolve(undefined);
      return;
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      resolve(undefined);
    };
    request.onblocked = () => {
      resolve(undefined);
    };
  });
}

/** Runs one transaction; resolves with its result once it is complete, or a fault. */
function run<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<Stored<T>> {
  return new Promise((resolve) => {
    let result: { value: T } | undefined;
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE, mode);
      body(transaction.objectStore(STORE), (value) => {
        result = { value };
      });
    } catch {
      resolve({ ok: false, fault: "failed" });
      return;
    }
    transaction.oncomplete = () => {
      resolve(
        result === undefined ? { ok: false, fault: "failed" } : { ok: true, value: result.value },
      );
    };
    transaction.onerror = () => {
      resolve({ ok: false, fault: "failed" });
    };
    transaction.onabort = () => {
      resolve({ ok: false, fault: "failed" });
    };
  });
}

/** The record store over IndexedDB; `unavailable` when the browser has none or refuses it. */
export function indexedDbRecordStore(
  factory: IDBFactory | undefined = (globalThis as { readonly indexedDB?: IDBFactory }).indexedDB,
): RecordStore {
  let database: Promise<IDBDatabase | undefined> | undefined;
  const db = () => {
    database ??= factory === undefined ? Promise.resolve(undefined) : open(factory);
    return database;
  };
  const unavailable = { ok: false, fault: "unavailable" } as const;
  return {
    read: async () => {
      const d = await db();
      if (d === undefined) return unavailable;
      return run<StoredClient | undefined>(d, "readonly", (store, done) => {
        const request = store.get(KEY);
        request.onsuccess = () => {
          const value: unknown = request.result;
          done(isStoredClient(value) ? value : undefined);
        };
      });
    },
    write: async (record) => {
      const d = await db();
      if (d === undefined) return unavailable;
      return run<StoredClient>(d, "readwrite", (store, done) => {
        store.put(record, KEY).onsuccess = () => {
          done(record);
        };
      });
    },
    update: async (change) => {
      const d = await db();
      if (d === undefined) return unavailable;
      return run<StoredClient | undefined>(d, "readwrite", (store, done) => {
        const request = store.get(KEY);
        request.onsuccess = () => {
          const value: unknown = request.result;
          if (!isStoredClient(value)) {
            done(undefined);
            return;
          }
          const next = change(value);
          store.put(next, KEY).onsuccess = () => {
            done(next);
          };
        };
      });
    },
    clear: async () => {
      const d = await db();
      if (d === undefined) return unavailable;
      return run<undefined>(d, "readwrite", (store, done) => {
        store.delete(KEY).onsuccess = () => {
          done(undefined);
        };
      });
    },
  };
}

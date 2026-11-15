/**
 * The browser's record in IndexedDB (m2-design.md section 8, `keys.web.ts`; spike K1): one object
 * store, one record, holding the non-extractable `CryptoKey` itself (a structured clone, which
 * IndexedDB keeps without ever exposing the key's bytes), the hub, and the last `seq`.
 *
 * Each `update` is one read-write transaction, resolved only when it is complete: so the next
 * `seq` is on disk before the request that carries it is sent.
 */
import type { RecordStore, Stored, StoredClient } from "./client-key";

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

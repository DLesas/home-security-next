/**
 * The phone's own client code (`app/src/hub/`, `app/src/platform/`), loaded at run time.
 *
 * Why not imported: those files reach `app/src/platform/keys.ts`, which binds the web build's
 * `keys.web.ts`, whose IndexedDB types need the DOM library; the app's own tsconfig has it, the
 * repository's root tsconfig (which checks `hub/test/`) does not, and a test here may not change
 * either. So the modules are imported by a path tsc does not follow, and typed below by the parts
 * these tests use, written from the app's own declarations (`wire.ts`, `handshake.ts`,
 * `channel.ts`, `finder.ts`, `client-key.ts`, `restore.ts`). Bun runs the app's code itself: a
 * change of its behaviour fails these tests; a change of a signature fails them at run time, not
 * in the type check, which is this file's one cost.
 */
import { join } from "node:path";
import type { StaticKey } from "@hsn/protocol/app";
import type { Connect, Timers, Wire, WireHandlers } from "../../../app/src/hub/wire.ts";
import { REPO } from "./processes.ts";

export type { Connect, Timers, Wire, WireHandlers };

/** `Outcome` of the app's `platform/split.ts`. */
export type Outcome<T, F> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: F };

/** `ClientKeyPair` and `StoredClient` of `client-key.ts`, with the phone's 32-byte secret. */
export interface ClientKeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

export interface StoredClient {
  readonly key: ClientKeyPair;
  readonly hub: {
    readonly identity: string;
    readonly staticKey: Uint8Array;
    readonly client: number;
    readonly person: number | null;
  };
  readonly lastSeq: number;
}

export type Stored<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: string };

export interface RecordStore {
  read(): Promise<Stored<StoredClient | undefined>>;
  write(record: StoredClient): Promise<Stored<StoredClient>>;
  update(change: (record: StoredClient) => StoredClient): Promise<Stored<StoredClient | undefined>>;
  clear(): Promise<Stored<undefined>>;
}

export interface ClientKeys {
  readonly makeClientKey: () => Promise<Outcome<ClientKeyPair, string>>;
  readonly staticKeyOf: (pair: ClientKeyPair) => StaticKey;
}

/** `finder.ts`'s `CodeReach` and `PhoneLinkSecret`, and `RestoreCode`. */
export interface CodeReach {
  readonly addresses: readonly string[];
  readonly port: number;
  readonly relay?: string;
}

export type PhoneLinkSecret =
  | {
      readonly kind: "secret";
      readonly secret: Uint8Array;
      readonly identity: string | undefined;
      readonly reach?: CodeReach;
    }
  | { readonly kind: "typed"; readonly code: unknown; readonly reach?: CodeReach };

export interface RestoreCode {
  readonly identity: string;
  readonly secret: Uint8Array;
  readonly reach: CodeReach;
}

export type PhoneCode =
  | { readonly kind: "link"; readonly from: "qr" | "linkAddress"; readonly secret: PhoneLinkSecret }
  | { readonly kind: "typed"; readonly secret: PhoneLinkSecret }
  | { readonly kind: "restore"; readonly restore: RestoreCode }
  | { readonly kind: "pair"; readonly text: string };

/** `handshake.ts`'s `linkClient` result. */
export interface LinkedClient {
  readonly record: StoredClient;
  readonly result: {
    readonly client: number;
    readonly person: number | null;
    readonly backupKey?: { readonly key: string; readonly epoch: number };
  };
}

/** `channel.ts`'s `ChannelStatus`, as far as these tests read it, and `AnyOutcome`. */
export interface ChannelStatus {
  readonly kind:
    "loading" | "notLinked" | "noStorage" | "connecting" | "open" | "waiting" | "removed";
}

export type AnyOutcome =
  | { readonly ok: true; readonly body: unknown; readonly repeat: boolean }
  | { readonly ok: false; readonly error: unknown }
  | { readonly ok: false; readonly local: string };

export interface ChannelListener {
  status(status: ChannelStatus): void;
  snapshot(snapshot: unknown, hello: unknown): void;
  event(event: { readonly ev: string; readonly body: unknown }): void;
  newEvent?(event: { readonly ev: string; readonly body: unknown }): void;
}

export interface Channel {
  start(): Promise<void>;
  stop(): void;
  forward(op: string, body: unknown): Promise<AnyOutcome>;
}

export interface ChannelDeps {
  readonly connect: Connect;
  readonly store: RecordStore;
  readonly timers: Timers;
  readonly app: string;
  readonly listener: ChannelListener;
  readonly proto?: readonly [number, number];
  readonly keys?: ClientKeys;
}

/** `restore.ts`'s `restoreHub` and its outcome, as far as these tests read it. */
export type RestoreOutcome =
  | { readonly ok: true; readonly offer: { readonly identity: string } }
  | { readonly ok: false; readonly fault: string };

export interface RestoreDeps {
  readonly connect: Connect;
  readonly timers: Timers;
  readonly app: string;
  readonly proto: readonly [number, number];
  readonly held: (
    identity: string,
  ) => Promise<Stored<readonly { readonly epoch: number; readonly key: Uint8Array }[]>>;
}

/** What the tests use of the phone's code. */
export interface PhoneModules {
  readonly readCode: (text: string) => Outcome<PhoneCode, string>;
  readonly linkClient: (
    connect: Connect,
    secret: PhoneLinkSecret,
    request: { readonly name: string; readonly kind: "phone" },
    timers: Timers,
    proto: readonly [number, number],
    keys: ClientKeys,
  ) => Promise<Outcome<LinkedClient, string>>;
  readonly Channel: new (deps: ChannelDeps) => Channel;
  readonly memoryRecordStore: (initial?: StoredClient) => RecordStore;
  readonly reserveSeq: (store: RecordStore) => Promise<number | undefined>;
  readonly PHONE_PROTO: readonly [number, number];
  readonly keys: ClientKeys;
  readonly restoreHub: (code: RestoreCode, deps: RestoreDeps) => Promise<RestoreOutcome>;
  /** `finder.ts`: a phone's socket at home, and the order it tries a hub's addresses in. */
  readonly hubSocketConnect: (make: MakeSocket, timers: Timers) => unknown;
  readonly targetsConnect: (
    socket: unknown,
    targets: readonly {
      readonly identity: string | null;
      readonly addresses: readonly string[];
      readonly port: number;
    }[],
    reaching: { answered(address: string, port: number): void; localNetworkDenied(): void },
  ) => Connect;
}

/** `finder.ts`'s `MakeSocket`: a WebSocket with the `Origin` the hub's checks ask for. */
export type MakeSocket = (url: string, origin: string) => unknown;

const APP = join(REPO, "app", "src");

/** Imports a module of the app by a path tsc does not follow (see above). */
async function appModule(path: string): Promise<Record<string, unknown>> {
  const file = join(APP, path);
  return (await import(file)) as Record<string, unknown>;
}

let loaded: PhoneModules | undefined;

/** The phone's code, loaded once. */
export async function phoneModules(): Promise<PhoneModules> {
  if (loaded !== undefined) return loaded;
  const [finder, handshake, channel, clientKey, restore, keys] = await Promise.all([
    appModule("hub/finder.ts"),
    appModule("hub/handshake.ts"),
    appModule("hub/channel.ts"),
    appModule("platform/client-key.ts"),
    appModule("hub/restore.ts"),
    appModule("platform/keys.native.ts"),
  ]);
  loaded = {
    readCode: finder.readCode as PhoneModules["readCode"],
    linkClient: handshake.linkClient as PhoneModules["linkClient"],
    Channel: channel.Channel as PhoneModules["Channel"],
    memoryRecordStore: clientKey.memoryRecordStore as PhoneModules["memoryRecordStore"],
    reserveSeq: clientKey.reserveSeq as PhoneModules["reserveSeq"],
    PHONE_PROTO: restore.PHONE_PROTO as PhoneModules["PHONE_PROTO"],
    keys: keys as unknown as ClientKeys,
    restoreHub: restore.restoreHub as PhoneModules["restoreHub"],
    hubSocketConnect: finder.hubSocketConnect as PhoneModules["hubSocketConnect"],
    targetsConnect: finder.targetsConnect as PhoneModules["targetsConnect"],
  };
  return loaded;
}

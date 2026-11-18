/**
 * What a step asks the shell to do (hub-design.md section 2, "Effects"). The shell performs
 * them in the order of section 4: stage writes and records, flush if any is "now", then the
 * sends, closes and answers, each send through the send gate.
 */
import type { AuditRecord } from "./audit.ts";
import type {
  AppMessage,
  AppOpBody,
  BluetoothSessionObject,
  PushContent,
  PushEnvironment,
  PushPlatform,
} from "@hsn/protocol/app";
import type { ControlReply } from "./control.ts";
import type {
  ClientId,
  ConnId,
  DeviceId,
  ImageId,
  JobId,
  LinkId,
  OutboxId,
  PersonId,
  RequestId,
  SendRef,
  TokenId,
} from "./ids.ts";
import type { Durability, StoreOp } from "./store.ts";

/** One hub counter a send's bytes use, for the send gate (section 4). */
export interface CounterUse {
  readonly device: DeviceId;
  readonly counter: number;
}

/** How often the writer must commit: every second while a countdown or the alarm runs (D112, D113). */
export type CadenceMs = 1_000 | 300_000;

/**
 * Why a transfer grant was revoked, by the transfer frames' Gone reason later Gets on its link are
 * answered with (`GoneReason`'s `Paused` and `NotGranted`, m3-updates-design section 5).
 */
export type TransferRevokeReason = "paused" | "notGranted";

export type Effect =
  | { readonly kind: "write"; readonly durability: Durability; readonly op: StoreOp }
  | { readonly kind: "record"; readonly durability: Durability; readonly record: AuditRecord }
  /** A countdown or the alarm started or ended. */
  | { readonly kind: "cadence"; readonly everyMs: CadenceMs }
  | {
      readonly kind: "send";
      readonly link: LinkId;
      readonly bytes: Uint8Array;
      readonly ref: SendRef;
      /** Every hub counter in `bytes`: one on a siren's WebSocket, two in a transmit request. */
      readonly counters: readonly CounterUse[];
    }
  | { readonly kind: "close"; readonly link: LinkId; readonly reason: string }
  | { readonly kind: "respond"; readonly request: RequestId; readonly reply: ControlReply }
  /** Advertise the hub by mDNS with its identity (§10). */
  | { readonly kind: "advertise"; readonly identity: Uint8Array; readonly port: number }
  // M2 (m2-design.md section 2).
  /** A reply or an event, for the shell to encrypt and send on one session, in order (section 5). */
  | { readonly kind: "appSend"; readonly conn: ConnId; readonly message: AppMessage }
  /** Close every session of a removed client. */
  | { readonly kind: "closeClient"; readonly client: ClientId; readonly reason: string }
  /**
   * A link or restore token the shell may now accept, by the `lookup` text `LinkHello.find`
   * carries, with its pre-shared key; or no longer (both null). `purpose` picks the handshake's
   * prologue (section 5), never the token's number.
   */
  | ({
      readonly kind: "linkSecret";
      readonly token: TokenId;
      readonly purpose: "link" | "restore";
      /** Linking: a new person whose name was not given, so message 2 asks for one; false for a restore. */
      readonly askName: boolean;
    } & (
      | { readonly lookup: string; readonly psk: Uint8Array }
      | { readonly lookup: null; readonly psk: null }
    ))
  /** Close one link or restore handshake's connection the core refused (section 5). */
  | {
      readonly kind: "closeConn";
      readonly conn: ConnId;
      readonly reason: "linkRefused" | "restoreRefused";
    }
  /** Write a backup, stream an export, unpack or switch an update, read or apply a restore (section 9). */
  | { readonly kind: "fileJob"; readonly job: JobId; readonly work: FileWork }
  /**
   * A history page (section 7, "History"): `app` has checked the person and computed what they may
   * see; the shell reads the page (committed rows merged with the staged ones), filters it, and
   * sends the reply itself on that connection's queue, with the request's `id`.
   */
  | {
      readonly kind: "historyRead";
      readonly conn: ConnId;
      readonly id: number;
      readonly query: HistoryQuery;
      readonly allowed: HistoryFilter;
    }
  /**
   * `hub.status` (section 6): `app` has checked manage system; the shell replies from the writer
   * and the size guard, as `hsn status` does, on that connection's queue with the request's `id`.
   */
  | { readonly kind: "hubStatusRead"; readonly conn: ConnId; readonly id: number }
  // The joint step 0 of M3 and M4 (docs/m3-m4-plan.md). The relay's (m4-design section 4):
  /** Open the relay link to `url`, or close it (null: none). At boot and when the setting changes. */
  | { readonly kind: "relayConnect"; readonly url: string | null }
  /**
   * The whole roster, each time it changes: the shell seals each target's two alerts with its
   * push key (`PushKeys`) and sends `roster {rev, targets}`.
   */
  | { readonly kind: "relayRoster"; readonly rev: number; readonly targets: readonly RosterEntry[] }
  /** Seal `content` with the client's push key and send it in the turn's `push` frame (D126). */
  | {
      readonly kind: "pushSend";
      readonly id: OutboxId;
      readonly client: ClientId;
      readonly content: PushContent;
    }
  /**
   * A phone's push key for `PushKeys`, as `linkSecret` is for `LinkSecrets`: written now; null
   * deletes it. The key leaves the core only here (it came in `push.register`'s body).
   */
  | {
      readonly kind: "pushKey";
      readonly client: ClientId;
      /** 8 bytes. */
      readonly keyId: Uint8Array;
      /** 32 bytes, or null to delete. */
      readonly key: Uint8Array | null;
    }
  // The firmware module's (m3-updates-design section 4):
  /**
   * Let the shell serve `0xF2` Get frames on `link` from the store file (`Transfers.grant`): the
   * image named by its id, the header first, then the payload.
   */
  | {
      readonly kind: "transferGrant";
      readonly link: LinkId;
      readonly image: ImageId;
      /** The image id, 8 bytes, as Get frames name it. */
      readonly imageId: Uint8Array;
      /** The 128-byte image header. */
      readonly header: Uint8Array;
      /** The payload's file in the store. */
      readonly file: string;
    }
  /**
   * Stop serving on `link` (`Transfers.revoke`); later Gets are answered Gone with `reason`:
   * `paused` while a countdown or alarm runs (the device resumes from its checkpoint when it ends,
   * m3-updates-design section 4), `notGranted` otherwise and when `reason` is absent.
   */
  | {
      readonly kind: "transferRevoke";
      readonly link: LinkId;
      readonly reason?: TransferRevokeReason;
    }
  /**
   * `firmware.bluetooth`'s reply (m3-updates-design section 5): the core has committed the
   * session's nonce; the shell derives the session key from the device key (`KeyStore`) and sends
   * the reply itself, as `historyRead` does. The key never enters the core.
   */
  | {
      readonly kind: "bluetoothSession";
      readonly to:
        | { readonly kind: "app"; readonly conn: ConnId; readonly id: number }
        | { readonly kind: "control"; readonly request: RequestId };
      readonly device: DeviceId;
      /** The device's address, the key derivation's input. */
      readonly address: number;
      /** 8 bytes, from the input's entropy. */
      readonly nonce: Uint8Array;
      /** The reply without its `sessionKey`, which the shell adds. */
      readonly reply: Omit<BluetoothSessionObject, "sessionKey">;
    };

/**
 * One push target as the core gives it to the shell (m4-design section 5): the shell turns it into
 * the wire's `RosterTarget`, sealing `unreachable` and `back` with the client's push key.
 */
export interface RosterEntry {
  readonly client: ClientId;
  /** 8 bytes. */
  readonly keyId: Uint8Array;
  readonly platform: PushPlatform;
  readonly environment: PushEnvironment;
  readonly token: string;
  /** The relay's alert when the hub goes quiet: kind `hub_unreachable`, `n.seq` 0 (D127). */
  readonly unreachable: PushContent;
  /** ... and when it is back: kind `hub_back`. */
  readonly back: PushContent;
}

/** `history.query`'s body, as section 6's schema has it. */
export type HistoryQuery = AppOpBody<"history.query">;

/** What the person may see of history (section 7, "History"). */
export interface HistoryFilter {
  /** Rows naming these devices, or every device's. */
  readonly devices: readonly DeviceId[] | "all";
  /** Their own requests and notifications; null for the console and the hub computer. */
  readonly person: PersonId | null;
  /** The person's clients: `commands` rows whose actor ends in ` (client <n>)` for one of them. */
  readonly clients: readonly ClientId[];
  /** Rows naming no device: manage system only. */
  readonly hub: boolean;
}

/** A file the client uploaded on that connection, named by its `job` (section 6). */
export interface UploadRef {
  readonly conn: ConnId;
  readonly job: number;
}

/** What a `fileJob` asks of the shell (section 2; section 9). */
export type FileWork =
  /** A backup into the folder, keeping the newest `keep`; also deletes this hub's files of older epochs. */
  | {
      readonly kind: "backup";
      readonly folder: string;
      readonly keep: number;
      readonly key: Uint8Array;
      readonly epoch: number;
    }
  /** The backup streamed to a session as `fileChunk` events, never written to the hub's disk. */
  | {
      readonly kind: "export";
      readonly conn: ConnId;
      readonly history: boolean;
      readonly key: Uint8Array;
      readonly epoch: number;
    }
  /** A release the client uploaded: check its signature, unpack it beside the running version. */
  | { readonly kind: "stageUpdate"; readonly upload: UploadRef }
  /** Stop cleanly and have the launcher switch to the staged version (D54). */
  | { readonly kind: "switchUpdate"; readonly version: string }
  /** A backup file uploaded on the console: read its header only. */
  | { readonly kind: "readRestore"; readonly upload: UploadRef }
  /** Decrypt, check and prepare the restored database beside `hub.db`, with the phone's key. */
  | { readonly kind: "applyRestore"; readonly upload: UploadRef; readonly key: Uint8Array }
  /** Put the restored database in place and exit 70, so the launcher starts it (section 9). */
  | { readonly kind: "switchRestore" }
  // The joint step 0 of M3 and M4 (docs/m3-m4-plan.md).
  /**
   * Fetch an offered release over the relay link into `uploads/` in pieces (m4-design section 6),
   * then stage it: a hub release as `stageUpdate` (ending `updateStaged`), a firmware release as
   * `stageFirmware` (ending `firmwareStaged`). `release` names which; `file`, `bytes` and
   * `sha256` are the offer's, checked against the cap before any byte is fetched.
   */
  | {
      readonly kind: "fetchRelease";
      readonly release: "hub" | "firmware";
      readonly file: string;
      readonly bytes: number;
      /** 32 bytes. */
      readonly sha256: Uint8Array;
    }
  /**
   * An uploaded firmware file (m3-updates-design section 3): a `.hsnf` release (`own` null), or an
   * owner's own build, confirmed on the console. Checked, copied into the store, its header made
   * and signed: `firmwareStaged`.
   */
  | {
      readonly kind: "stageFirmware";
      readonly upload: UploadRef;
      readonly own: { readonly version: string } | null;
    }
  /** Remove an image's file from the store (the row is the core's): `firmwareRemoved`. */
  | { readonly kind: "removeFirmware"; readonly image: ImageId; readonly file: string }
  /** Stream an image's header and payload to a session as `fileChunk` events (`firmware.download`). */
  | {
      readonly kind: "sendFirmware";
      readonly conn: ConnId;
      readonly header: Uint8Array;
      readonly file: string;
    };

/** Every effect kind; internal messages must use other kinds, so the dispatcher can tell them apart. */
export const EFFECT_KINDS = [
  "write",
  "record",
  "cadence",
  "send",
  "close",
  "respond",
  "advertise",
  "appSend",
  "closeClient",
  "linkSecret",
  "fileJob",
  "historyRead",
  "closeConn",
  "hubStatusRead",
  // The joint step 0 of M3 and M4.
  "relayConnect",
  "relayRoster",
  "pushSend",
  "pushKey",
  "transferGrant",
  "transferRevoke",
  "bluetoothSession",
] as const satisfies readonly Effect["kind"][];

/** Compile-time proof that `EFFECT_KINDS` lists every effect kind. */
export type EffectKindsComplete =
  Exclude<Effect["kind"], (typeof EFFECT_KINDS)[number]> extends never ? true : never;
export const EFFECT_KINDS_COMPLETE: EffectKindsComplete = true;

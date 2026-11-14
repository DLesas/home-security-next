/**
 * What a step asks the shell to do (hub-design.md section 2, "Effects"). The shell performs
 * them in the order of section 4: stage writes and records, flush if any is "now", then the
 * sends, closes and answers, each send through the send gate.
 */
import type { AuditRecord } from "./audit.ts";
import type { AppMessage, AppOpBody } from "@hsn/protocol/app";
import type { ControlReply } from "./control.ts";
import type {
  ClientId,
  ConnId,
  DeviceId,
  JobId,
  LinkId,
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
   * A link or restore token the shell may now accept (its pre-shared key), or no longer (null);
   * `purpose` picks the handshake's prologue (section 5), never the token's number.
   */
  | {
      readonly kind: "linkSecret";
      readonly token: TokenId;
      readonly purpose: "link" | "restore";
      readonly psk: Uint8Array | null;
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
    };

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
  | { readonly kind: "switchRestore" };

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
] as const satisfies readonly Effect["kind"][];

/** Compile-time proof that `EFFECT_KINDS` lists every effect kind. */
export type EffectKindsComplete =
  Exclude<Effect["kind"], (typeof EFFECT_KINDS)[number]> extends never ? true : never;
export const EFFECT_KINDS_COMPLETE: EffectKindsComplete = true;

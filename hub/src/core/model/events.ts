/**
 * What the shell gives the core (hub-design.md section 2, "Events"): one `Input` per step, each
 * stamped with the time and carrying 32 fresh random bytes. The shell knows nothing of the
 * protocol: a frame is bytes from a link, and the core decides what it is.
 */
import type { AppRequest, LinkRequest } from "@hsn/protocol/app";
import type { ControlCommand } from "./control.ts";
import type {
  BootId,
  ClientId,
  ConnId,
  DeviceId,
  JobId,
  LinkId,
  RequestId,
  SendRef,
  TokenId,
} from "./ids.ts";
import type {
  AlarmRow,
  AlarmSirenRow,
  AlarmTriggerRow,
  BackupKeyRow,
  BackupStateRow,
  BootRow,
  CountdownRow,
  DeviceRow,
  DeviceStateRow,
  ClientReplyRow,
  ClientRow,
  GatewayConfigRow,
  GroupMemberRow,
  GroupRow,
  GroupSirenRow,
  HealthStateRow,
  HubAppKeys,
  HubSigningKeys,
  LinkTokenRow,
  ModeGroupRow,
  ModeRow,
  ModeStateRow,
  NotificationPrefsRow,
  NotificationReadRow,
  NotificationRow,
  PeopleSettingsRow,
  PermissionRow,
  PersonRoleRow,
  PersonRow,
  ScheduleRow,
  ScheduleStateRow,
  UpdateStateRow,
  LossDailyRow,
  PreviousExit,
  SendCounterRow,
  SensorConfigRow,
  SirenConfigRow,
  SiteRow,
} from "./rows.ts";
import type { Now } from "./time.ts";

/** Random bytes in every input, from the system's secure generator (section 2). */
export const INPUT_ENTROPY_BYTES = 32;

/** One step's input. */
export interface Input {
  readonly now: Now;
  /** `INPUT_ENTROPY_BYTES` bytes; the core takes what it needs through `ctx.entropy`. */
  readonly entropy: Uint8Array;
  readonly event: HubEvent;
}

/** A link is a USB serial port or a WebSocket (section 3). */
export type LinkKind = "usb" | "network";

/** Why a link closed. */
export type LinkCloseReason =
  /** The far end closed it, or the port went away. */
  | "remote"
  /** A read or write error. */
  | "error"
  /** A WebSocket idle for 60 s ‡ (section 3). */
  | "idle"
  /** A text message on a WebSocket, closed with code 1003 (section 3). */
  | "textMessage"
  /** The core asked for it with a `close` effect. */
  | "closedByHub"
  /** The hub is stopping. */
  | "stopping";

/** Why a `send` effect did not leave (sections 3 and 4). */
export type LinkErrorCode =
  /** The link was closed. */
  | "closed"
  /** The write failed. */
  | "writeFailed"
  /** The WebSocket reported back-pressure. */
  | "backPressure"
  /** The WebSocket dropped the message. */
  | "dropped"
  /** The link's queue passed 64 frames, and the newest was dropped. */
  | "queueFull"
  /** The send gate held it back: a counter it uses is not yet below its durable resume point. */
  | "notDurable";

/** A flush failed, or flushing works again after a failure (section 5, "A failed flush"). */
export type CommitOutcome =
  | {
      readonly kind: "failed";
      readonly message: string;
      /** Refused at the size guard's hard stop: the database is full (section 6). */
      readonly full?: boolean;
    }
  | { readonly kind: "recovered" }
  /** A routine commit that also trimmed history (section 6, "The size guard"). */
  | { readonly kind: "trimmed"; readonly report: TrimReport }
  /**
   * Trimming is on, and a routine commit found nothing it may delete: everything left is inside
   * the protected ages. Told once a trimming episode, before commits start failing at the stop.
   */
  | { readonly kind: "trimExhausted"; readonly inUseBytes: number }
  /** The pages in use are back under the lower mark: trimming has ended. */
  | { readonly kind: "trimEnded"; readonly inUseBytes: number };

/** What one trimming commit deleted, and where history now starts (section 6, D110). */
export interface TrimReport {
  /** Rows deleted from `rx_routine`, `tx_routine` and `rejects`. */
  readonly routineRows: number;
  /** Rows deleted from the event tables and the lower levels of the two logs. */
  readonly eventRows: number;
  /** The wall time of the oldest routine row left, or null when none is. */
  readonly oldestRoutineMs: number | null;
  /** The wall time of the oldest event row left, or null when none is. */
  readonly oldestEventMs: number | null;
  /** The pages in use after the commit, in bytes. */
  readonly inUseBytes: number;
}

/** How this run began (section 10, "The top-level handler"). */
export interface BootInfo {
  /** This run's row in `boots`. */
  readonly id: BootId;
  readonly previousExit: PreviousExit;
  readonly cause: string | undefined;
}

/**
 * Everything read from the database at start (section 7, "Hub restart"): the configuration
 * tables, the readings, the countdowns and the alarm. Keys stay in the shell (`KeyStore`); of
 * the hub's keys only the public half and the identity are here, for Provision (section 9).
 */
export interface DurableSnapshot {
  readonly devices: readonly DeviceRow[];
  readonly sendCounters: readonly SendCounterRow[];
  readonly hubKeys: HubSigningKeys | undefined;
  readonly site: SiteRow | undefined;
  readonly sensorConfig: readonly SensorConfigRow[];
  readonly sirenConfig: readonly SirenConfigRow[];
  readonly gatewayConfig: readonly GatewayConfigRow[];
  readonly countdowns: readonly CountdownRow[];
  readonly alarm: AlarmRow | undefined;
  readonly alarmTriggers: readonly AlarmTriggerRow[];
  readonly alarmSirens: readonly AlarmSirenRow[];
  /** The previous run's boot row, if any; the core writes this run's (section 7, "Hub restart"). */
  readonly previousBoot: BootRow | undefined;
  /**
   * Device 0's row is the last commit mark (section 5). SPEC-QUESTION: section 6 names no
   * column for the highest counter accepted in a gateway's hello, which section 5 writes now; the
   * reading taken is that a gateway's `window` holds it, its row written now with the hello.
   */
  readonly deviceState: readonly DeviceStateRow[];
  /** The last 7 days, for D107's n. */
  readonly lossDaily: readonly LossDailyRow[];
  /**
   * The committed key of each device still provisioning, so a retry after a restart sends the same
   * address and key (section 9). The only keys the core is given; they leave it only in the
   * Provision message (section 2).
   */
  readonly provisioningKeys: ReadonlyMap<DeviceId, Uint8Array>;
  /** M2's configuration and small state (m2-design.md section 4). */
  readonly m2: M2Snapshot;
}

/**
 * M2's tables as read at start (m2-design.md section 4), every one small and read whole. Link
 * tokens come without their keys (`LinkSecrets` holds those, section 2); the app keys without
 * any private half; `client_replies` whole, as `seq` needs them after a restart (section 5). The
 * single rows are undefined only on a database without migration 2's rows (a test's).
 */
export interface M2Snapshot {
  /** Undefined until the shell has made them, at the first start of M2. */
  readonly appKeys: HubAppKeys | undefined;
  /** `layout`'s. */
  readonly modeState: ModeStateRow | undefined;
  /** `people`'s. */
  readonly peopleSettings: PeopleSettingsRow | undefined;
  /** `schedules`'. */
  readonly scheduleState: ScheduleStateRow | undefined;
  /** `upkeep`'s. */
  readonly backupState: BackupStateRow | undefined;
  /**
   * `upkeep`'s: the backup key, which it keeps in its slice because a phone's `LinkResult`, the
   * `backup.key` reply and the backup and export jobs carry it (section 2). Undefined until
   * `upkeep` makes it at the first start of M2. It never enters a record or an event.
   */
  readonly backupKey: BackupKeyRow | undefined;
  readonly people: readonly PersonRow[];
  readonly clients: readonly ClientRow[];
  readonly clientReplies: readonly ClientReplyRow[];
  readonly permissions: readonly PermissionRow[];
  readonly personRoles: readonly PersonRoleRow[];
  readonly linkTokens: readonly LinkTokenRow[];
  readonly groups: readonly GroupRow[];
  readonly groupMembers: readonly GroupMemberRow[];
  readonly groupSirens: readonly GroupSirenRow[];
  readonly modes: readonly ModeRow[];
  readonly modeGroups: readonly ModeGroupRow[];
  readonly schedules: readonly ScheduleRow[];
  readonly healthState: readonly HealthStateRow[];
  readonly notificationPrefs: readonly NotificationPrefsRow[];
  readonly updateState: UpdateStateRow | undefined;
  /**
   * The notifications and reads of the last 7 days ‡ before the last commit's wall time (section
   * 7), so what is unread survives a restart; older ones are history only.
   */
  readonly notifications: readonly NotificationRow[];
  readonly notificationReads: readonly NotificationReadRow[];
}

/** An M2 snapshot with nothing in it: a hub before its first M2 start, and the tests' default. */
export const EMPTY_M2_SNAPSHOT: M2Snapshot = {
  appKeys: undefined,
  modeState: undefined,
  peopleSettings: undefined,
  scheduleState: undefined,
  backupState: undefined,
  backupKey: undefined,
  people: [],
  clients: [],
  clientReplies: [],
  permissions: [],
  personRoles: [],
  linkTokens: [],
  groups: [],
  groupMembers: [],
  groupSirens: [],
  modes: [],
  modeGroups: [],
  schedules: [],
  healthState: [],
  notificationPrefs: [],
  updateState: undefined,
  notifications: [],
  notificationReads: [],
};

/** Why the control socket refused a line before the core saw it (section 9). */
export type ControlLineRejection =
  /** Not JSON. */
  | "notJson"
  /** JSON that is not a request the schemas know. */
  | "badShape"
  /** Longer than the longest request line. */
  | "tooLong"
  /** The connection ended inside a line. */
  | "partial"
  /** More requests waiting on one connection than it may hold. */
  | "tooMany"
  /** A line on a connection that is following, which takes no more requests. */
  | "following"
  /** A reply from the core that did not pass the schema (a fault in the core). */
  | "badReply";

/** Something the shell refused before the core could see it, so the core can record it (D110). */
export type InputRejection =
  | {
      readonly source: "control";
      readonly reason: ControlLineRejection;
      /** The line's length; never its content, which may hold a password. */
      readonly bytes: number;
      /** Zod's paths and codes for a `badShape`, without the values. */
      readonly issues: readonly string[];
    }
  /**
   * A USB frame that failed COBS decoding, or was too long (section 10); or, in lockstep, a frame
   * on a link the hub had closed.
   */
  | {
      readonly source: "frame";
      readonly link: LinkId;
      readonly reason: "badFrame" | "tooLong" | "closedLink";
    }
  /** An app request the shell refused before the core saw it (m2-design.md section 2). */
  | {
      readonly source: "app";
      readonly conn: ConnId;
      readonly reason: AppRejection;
      readonly bytes: number;
      readonly issues: readonly string[];
    }
  /**
   * An input the core faulted on (section 10): its state stayed as it was. The loop hands it
   * back as the next input, so its record takes the next number like any other and `seq` stays
   * in time order (section 6).
   */
  | {
      readonly source: "core";
      readonly event: HubEvent["kind"];
      readonly origin: string;
      readonly message: string;
      readonly detail: Readonly<Record<string, string | number | boolean>>;
    };

// M2 (m2-design.md section 2, "New events and effects").

/** Which app listener a connection came in on (section 5). */
export type AppListener = "lan" | "console";

/** Why an app connection closed (section 5). */
export type ConnCloseReason =
  /** The client closed it, or the network dropped it. */
  | "remote"
  /** A transport message failed to decrypt: Noise sessions do not recover. */
  | "decryptFailed"
  /** Nothing authenticated from the client for 60 s ‡. */
  | "liveness"
  /** The 24-hour lifetime ‡. */
  | "lifetime"
  /** The client's fifth session closed its oldest ‡. */
  | "replaced"
  /** The core asked for it with `closeClient`: the client was removed. */
  | "removed"
  /** A text message, or bytes that are not one Noise message. */
  | "badFrame"
  /** The hub is stopping. */
  | "stopping";

/** Why a handshake was refused (m2-design.md section 5), for `client_refused`. */
export type ClientRefusalReason =
  | "unknownKey"
  | "removedKey"
  | "consoleOnLan"
  | "noVersion"
  | "timeout"
  | "malformed"
  | "rateLimited"
  /** `LinkHello.find` named no token: counted per address, no token's tries. */
  | "unknownToken";

/**
 * Something the shell must report that is not a refused input (m2-design.md section 9): a closed
 * union, so each new code is a reviewed change. `audit` records each as a hub event of origin
 * `shell`, under its cap, at the level `M2_HUB_EVENTS` gives.
 */
export type ShellWarningCode = "data_folder_was_open";

/** Why the shell refused a request before the core saw it (section 2), so the core records it. */
export type AppRejection =
  /** Not UTF-8 JSON. */
  | "notJson"
  /** JSON that is not a request the version's schemas know. */
  | "badShape"
  /** A change without `seq`, or a read with one. */
  | "seqRule"
  /** An operation the agreed version does not name. */
  | "notInVersion";

/** Why a file job failed (section 2). */
export type FileFailure =
  | "unreachable"
  | "full"
  | "badFile"
  | "badSignature"
  | "wrongSystem"
  | "notNewer"
  | "wrongKey"
  /**
   * The job's upload is not there (never finished, or freed): the operation that named it is
   * answered `notFound {what: "upload"}`, not `badFile`.
   */
  | "noUpload"
  | "io";

/** What a file job came to (`fileReady`, section 2). */
export type FileOutcome =
  | {
      readonly kind: "backupWritten";
      readonly name: string;
      readonly bytes: number;
      /** The folder is on the data folder's disk (their devices compared): `backup_folder_on_data_disk`. */
      readonly sameDiskAsData: boolean;
    }
  | { readonly kind: "exportSent"; readonly bytes: number }
  | { readonly kind: "updateStaged"; readonly version: string }
  /** A restore file's header (`readRestore`). */
  | {
      readonly kind: "restoreRead";
      /** The app identity's 16 bytes of the hub the file came from. */
      readonly identity: Uint8Array;
      readonly epoch: number;
      readonly madeMs: number;
      readonly lastChangeMs: number;
    }
  /** The restored database is prepared beside `hub.db` (`applyRestore`). */
  | { readonly kind: "restoreReady" }
  | { readonly kind: "failed"; readonly reason: FileFailure; readonly message: string };

/** Every input event (section 2). */
export type HubEvent =
  /** The first input of every run. */
  | { readonly kind: "boot"; readonly snapshot: DurableSnapshot; readonly boot: BootInfo }
  | {
      readonly kind: "linkOpened";
      readonly link: LinkId;
      readonly linkKind: LinkKind;
      /** A serial port's path, or a WebSocket's peer address. */
      readonly label: string;
    }
  | { readonly kind: "linkClosed"; readonly link: LinkId; readonly reason: LinkCloseReason }
  /** One packet or setup message: one WebSocket message, or one decoded USB frame. */
  | { readonly kind: "frame"; readonly link: LinkId; readonly bytes: Uint8Array }
  | {
      readonly kind: "sendFailed";
      readonly link: LinkId;
      readonly ref: SendRef;
      readonly error: LinkErrorCode;
    }
  | { readonly kind: "commit"; readonly outcome: CommitOutcome }
  | {
      readonly kind: "command";
      readonly request: RequestId;
      /**
       * The control connection, numbered from the shell's one counter with the app connections
       * (m2-design.md section 6), so an upload on it is `UploadRef {conn, job}`.
       */
      readonly conn: ConnId;
      /** The user name the CLI reports (section 9). */
      readonly actor: string;
      readonly command: ControlCommand;
    }
  /** Something the shell refused before the core saw it: recorded, never acted on. */
  | { readonly kind: "inputRejected"; readonly rejection: InputRejection }
  /** A wake came: due timers run, as they do at the start of every step. */
  | { readonly kind: "tick" }
  // M2 (m2-design.md section 2).
  /** A session is proven: the hub decrypted the client's first transport message (section 5). */
  | {
      readonly kind: "clientConnected";
      readonly conn: ConnId;
      readonly client: ClientId;
      readonly listener: AppListener;
      /** The channel version agreed. */
      readonly proto: number;
      /** The app's own version, from `ClientHello`. */
      readonly app: string;
    }
  /** An authenticated, decrypted, schema-checked request (section 2). */
  | {
      readonly kind: "clientRequest";
      readonly conn: ConnId;
      readonly client: ClientId;
      readonly request: AppRequest;
    }
  | { readonly kind: "clientClosed"; readonly conn: ConnId; readonly reason: ConnCloseReason }
  /** An XXpsk3 handshake completed with a token's key: the core decides whether it links. */
  | {
      readonly kind: "linkCompleted";
      readonly conn: ConnId;
      readonly token: TokenId;
      /** The new client's static public key. */
      readonly staticKey: Uint8Array;
      readonly listener: AppListener;
      readonly link: LinkRequest;
    }
  /** A link handshake that named a token and failed: a wrong key, or a malformed message. */
  | {
      readonly kind: "linkFailed";
      readonly token: TokenId;
      readonly reason: "badPsk" | "malformed";
      /** The peer's IP address as text, for the failures counted per address (section 5). */
      readonly address: string;
    }
  /**
   * The hub's facts for the link formats and `hub.info` (section 2): after `boot` and whenever one
   * changes (the shell checks addresses every minute ‡ and renews the certificate, section 5).
   * `app` keeps them; its view gives `hubFacts()`.
   */
  | {
      readonly kind: "hubFacts";
      /** The hub's own version. */
      readonly version: string;
      /** Every address the computer has on the home network. */
      readonly addresses: readonly string[];
      /** The apps' listener's port (8444 ‡), as it really opened: a link address and QR code name it. */
      readonly appsPort: number;
      /** The console listener's port (8445 ‡), as it really opened: the console's address names it. */
      readonly consolePort: number;
      /** The TLS certificate's SHA-256. */
      readonly certificateSha256: Uint8Array;
    }
  /**
   * Refused handshakes (section 5): at most one per address per minute, `count` standing for those
   * held back; past 64 ‡ addresses in a minute the rest as one, with the address `"many"`. `app`
   * records `client_refused`, routine, a warning past 10 an hour from one address.
   */
  | {
      readonly kind: "clientRefused";
      readonly address: string;
      readonly reason: ClientRefusalReason;
      readonly count: number;
    }
  /** A warning from the shell (section 9): recorded by `audit` as a hub event of origin `shell`. */
  | {
      readonly kind: "shellWarning";
      readonly code: ShellWarningCode;
      readonly message: string;
      readonly detail: string | null;
    }
  /** The hub computer's time zone, at boot and when it changes (checked every hour ‡). */
  | { readonly kind: "timeZone"; readonly zone: string }
  /** A backup, export, update or restore file the shell finished. */
  | { readonly kind: "fileReady"; readonly job: JobId; readonly outcome: FileOutcome }
  /** A restore handshake completed with a restore token: messages 1 to 3 (section 9). */
  | { readonly kind: "restoreOpened"; readonly conn: ConnId; readonly token: TokenId }
  /** The phone's backup key, after message 4 (section 5, restore's message 5). */
  | {
      readonly kind: "restoreKey";
      readonly conn: ConnId;
      readonly token: TokenId;
      readonly key: Uint8Array;
      readonly epoch: number;
    };

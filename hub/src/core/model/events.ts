/**
 * What the shell gives the core (hub-design.md section 2, "Events"): one `Input` per step, each
 * stamped with the time and carrying 32 fresh random bytes. The shell knows nothing of the
 * protocol: a frame is bytes from a link, and the core decides what it is.
 */
import type { ControlCommand } from "./control.ts";
import type { BootId, DeviceId, LinkId, RequestId, SendRef } from "./ids.ts";
import type {
  AlarmRow,
  AlarmSirenRow,
  AlarmTriggerRow,
  BootRow,
  CountdownRow,
  DeviceRow,
  DeviceStateRow,
  GatewayConfigRow,
  HubKeysRow,
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
  readonly hubKeys: Omit<HubKeysRow, "signingPrivate"> | undefined;
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
}

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
      /** The user name the CLI reports (section 9). */
      readonly actor: string;
      readonly command: ControlCommand;
    }
  /** Something the shell refused before the core saw it: recorded, never acted on. */
  | { readonly kind: "inputRejected"; readonly rejection: InputRejection }
  /** A wake came: due timers run, as they do at the start of every step. */
  | { readonly kind: "tick" };

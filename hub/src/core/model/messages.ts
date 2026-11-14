/**
 * The internal messages the thirteen modules exchange (hub-design.md section 2, the module table,
 * and sections 7 and 8). Modules talk only through these: plain data on one queue, handled in
 * the fixed module order. Every input event is also a message, under its own kind.
 */
import type { Message, TransmitPriority } from "@hsn/protocol";
import type { AppError, AppOp } from "@hsn/protocol/app";
import type { AuditRecord } from "./audit.ts";
import type { ControlCommand, ControlReply } from "./control.ts";
import type { RejectReason } from "./errors.ts";
import type { HubEvent } from "./events.ts";
import type {
  ClientId,
  ConnId,
  DeviceId,
  LinkId,
  ModeId,
  PersonId,
  RequestId,
  ScheduleId,
  SendRef,
  Seq,
} from "./ids.ts";
import type { M2ModuleName } from "./modules.ts";
import type { ArmState, MoveStageName, TxOutcome } from "./rows.ts";
import type { Durability } from "./store.ts";
import type { Mono } from "./time.ts";
import type { TimerKey } from "./timers.ts";

/** How a device packet reached the hub (§5 "Paths"; `path` of section 6). */
export type Arrival =
  | {
      readonly path: "lora";
      /** The gateway that forwarded it, and the link its session is on. */
      readonly gateway: DeviceId;
      readonly link: LinkId;
      /** The forwarded packet's gateway counter. */
      readonly gatewayCounter: number;
      /** When the packet finished arriving, on the gateway's microsecond clock (§6). */
      readonly gatewayMicros: number;
      /** The same moment on the hub's clock, through the session's clock mapping (section 8). */
      readonly endedAt: Mono;
      readonly rssiDbm: number;
      readonly snrQuarterDb: number;
      readonly dataRate: number;
      readonly siteChannel: number;
      /** The gateway's own link, as its packets' `path` (section 6). */
      readonly gatewayLink: "usb" | "network";
    }
  | { readonly path: "wifi"; readonly link: LinkId }
  | { readonly path: "usb"; readonly link: LinkId };

/** What a siren should do, as the alarm module decides it (section 8). */
export type SirenShould =
  | { readonly kind: "off" }
  | { readonly kind: "sound"; readonly until: Mono }
  | { readonly kind: "test"; readonly until: Mono };

/** When a radio packet should go, for a transmit request (§6). */
export type RadioTiming =
  /** At a moment on one gateway's clock: a heartbeat reply, 1 s † after the heartbeat's end. */
  | { readonly kind: "at"; readonly gateway: DeviceId; readonly gatewayMicros: number }
  /** As soon as possible, starting no later than `latest` on the hub's clock, or with no limit. */
  | { readonly kind: "asap"; readonly latest: Mono | undefined };

/** What a radio packet is, for the reply rules and the records (sections 7 and 8). */
export type RadioPurpose =
  "heartbeatReply" | "eventReply" | "disarmedNotice" | "sirenCommand" | "sirenSettings";

/** A copy of a device packet heard through a gateway (section 8, "Which gateway"). */
export interface HeardCopy {
  readonly device: DeviceId;
  readonly gateway: DeviceId;
  readonly snrQuarterDb: number;
  readonly rssiDbm: number;
  readonly at: Mono;
}

/** Where a rejected frame came from, for `rejects.via` (section 6). */
export type RejectSource = { readonly device: DeviceId } | { readonly link: LinkId };

/** Which sensors a request names: every sensor, or these. */
export type SensorSelection = "all" | readonly DeviceId[];

/** The sensor settings `hsn sensor set` changes (section 9). */
export type SensorSettingsChange = Omit<
  Extract<ControlCommand, { readonly kind: "sensorSet" }>,
  "kind" | "name"
>;

/** The site settings `hsn site set` changes (section 9). */
export type SiteSettingsChange = Omit<
  Extract<ControlCommand, { readonly kind: "siteSet" }>,
  "kind"
>;

/** What `hsn site change` asks for (section 9). */
export type SiteChangeAction =
  /** `hsn site change channel=… rate=…`: start a move; a field left out stays as it is. */
  | {
      readonly kind: "start";
      readonly channel: number | undefined;
      readonly rate: number | undefined;
    }
  /** `hsn site change status`: answered from the core's state. */
  | { readonly kind: "status" }
  /** `hsn site change cancel`: only while announcing. */
  | { readonly kind: "cancel" }
  /** `hsn site change force [--yes]`: without `yes`, it names who would be left behind and changes nothing. */
  | { readonly kind: "force"; readonly yes: boolean };

/** Fields every request from the control module carries. */
interface Requested {
  readonly request: RequestId;
  /** Who asked, for the decision records (AL8). */
  readonly actor: string;
  /** The `commands` record of the command, which the decisions it causes name (D110). */
  readonly record: Seq;
}

// M2 (m2-design.md section 2).

/**
 * Who an M2 request comes from: the hub computer (`hsn`, every permission, HD 9), the console
 * client (every permission, D61), a person through one of their clients, or a schedule entry,
 * with its own authority and never asking for confirmation (section 7, "Schedules").
 */
export type Actor =
  | { readonly kind: "computer"; readonly name: string }
  | { readonly kind: "console"; readonly client: ClientId }
  | {
      readonly kind: "person";
      readonly person: PersonId;
      readonly client: ClientId;
      /** `"Anna (client 7)"`, as `commands.actor` holds it (section 4). */
      readonly name: string;
    }
  | { readonly kind: "schedule"; readonly schedule: ScheduleId; readonly name: string };

/** Where a request's answer goes: a control request, an app request, or nowhere (a schedule). */
export type AnswerTo =
  | { readonly kind: "control"; readonly request: RequestId }
  | {
      readonly kind: "app";
      readonly conn: ConnId;
      readonly client: ClientId;
      /** The request's own `id`, for the reply. */
      readonly id: number;
      /** The change's `seq`, committed with the reply (section 3). */
      readonly seq: number | undefined;
    }
  | { readonly kind: "none" };

/** An operation's outcome as its owner gives it: the reply's body, or one of section 5's errors. */
export type OpOutcome =
  { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly error: AppError };

/** The confirmation a person's request carries (D50, AL12); a schedule's never asks (AL7). */
export interface Confirmation {
  readonly openDoors: boolean;
  readonly lowBattery: boolean;
}

/** Messages that are not input events. */
export type DomainMessage =
  // Timers (section 2).
  /** A due timer, delivered to its owner only, before the step's event. */
  | { readonly kind: "timer"; readonly key: TimerKey; readonly at: Mono }

  // clock (module 1).
  /** The wall clock became trusted, or stopped being so; `stepMs` is its step when it did. */
  | {
      readonly kind: "wallTrustChanged";
      readonly trusted: boolean;
      readonly stepMs: number | undefined;
    }
  /** How long the hub was down became known (section 5, D113). */
  | {
      readonly kind: "downtimeKnown";
      readonly downtimeMs: number;
      readonly source: "wallClock" | "gatewayUptime";
    }

  // registry, setup (modules 2 and 4).
  /** A device was added: provisioning has begun (section 9, D100). */
  | {
      readonly kind: "deviceAdded";
      readonly device: DeviceId;
      /** A protocol `Role`. */
      readonly role: number;
      readonly address: number;
      readonly name: string;
    }
  /** A board answered Provision (§10): accepted, refused or not valid. */
  | { readonly kind: "provisionAnswered"; readonly device: DeviceId; readonly result: number }
  /** A device was removed: its key deleted, its history kept. */
  | { readonly kind: "deviceRemoved"; readonly device: DeviceId }
  /** A forced site move left this sensor behind: the registry sets it to state 5 (D115). */
  | {
      readonly kind: "deviceLeftBehind";
      readonly device: DeviceId;
      readonly move: number;
      readonly cause: Seq | undefined;
    }

  // links (module 3).
  /** A USB setup message (0xF1…) on a USB link (§10). */
  | { readonly kind: "setupFrame"; readonly link: LinkId; readonly bytes: Uint8Array }
  /** A packet on a link that carries, or may carry, a gateway. */
  | { readonly kind: "gatewayPacket"; readonly link: LinkId; readonly bytes: Uint8Array }

  // gateways, links (modules 6 and 3).
  /** A device packet to open: one forwarded by a gateway, or one on a siren's own link. */
  | { readonly kind: "devicePacket"; readonly bytes: Uint8Array; readonly arrival: Arrival }
  /** A gateway's session was proven (section 8): sirens waiting to send may do so. */
  | { readonly kind: "gatewayUp"; readonly gateway: DeviceId; readonly link: LinkId }
  /** A gateway's session ended: its link closed, or it went silent. */
  | { readonly kind: "gatewayDown"; readonly gateway: DeviceId }
  /** The outcome of a `radioOut` (section 7, "A busy gateway"). */
  | {
      readonly kind: "radioResult";
      readonly ref: SendRef;
      readonly device: DeviceId;
      readonly gateway: DeviceId | undefined;
      /** The transmit request's gateway counter (`tx_*.request_counter`), when one was sent. */
      readonly requestCounter: number | undefined;
      /** The counter of the transmit result packet that reported it (`tx_*.result_counter`). */
      readonly resultCounter: number | undefined;
      readonly outcome: TxOutcome;
      readonly sentGatewayMicros: number | undefined;
    }

  // intake (module 7).
  /** An authentic packet, accepted by the replay window (section 8, "Accepting a device packet"). */
  | {
      readonly kind: "accepted";
      readonly device: DeviceId;
      /** A protocol `Role`. */
      readonly role: number;
      readonly counter: number;
      readonly message: Message;
      readonly arrival: Arrival;
      /** The sequence number of this packet's `rx` record, for the decisions it causes. */
      readonly record: Seq;
      /** True when its counter is the highest accepted from the device: readings follow it. */
      readonly newest: boolean;
    }
  /** A rejected frame or packet, to be counted (HB15). */
  | {
      readonly kind: "rejected";
      readonly source: RejectSource;
      readonly reason: RejectReason;
      readonly address: number | undefined;
      /** The frame's first 16 bytes. */
      readonly sample: Uint8Array;
      /**
       * For a `duplicate` copy through a gateway: which gateway heard it and how well, since a
       * siren's copies count towards its best gateway (section 8).
       */
      readonly copy: HeardCopy | undefined;
    }

  // alarm (module 8).
  /** A sensor's arming state changed (section 8). */
  | {
      readonly kind: "armedChanged";
      readonly sensor: DeviceId;
      readonly arm: ArmState;
      readonly cause: Seq | undefined;
    }
  /** A disarm cancelled a running countdown: the notice goes to its newest report (D24, §4). */
  | {
      readonly kind: "countdownCancelled";
      readonly sensor: DeviceId;
      readonly newestCounter: number;
      readonly replyGateway: DeviceId | undefined;
      readonly replyRate: number;
      readonly cause: Seq;
    }
  /** What a siren should do changed (section 8, "What the siren should do"). */
  | {
      readonly kind: "sirenIntent";
      readonly siren: DeviceId;
      readonly should: SirenShould;
      readonly cause: Seq;
    }

  // sensors, sirens (modules 9 and 11).
  /** A packet to send by radio through a gateway, as a transmit request (section 8). */
  | {
      readonly kind: "radioOut";
      readonly ref: SendRef;
      readonly device: DeviceId;
      /** The sealed device packet. */
      readonly packet: Uint8Array;
      /** The hub counter `packet` uses, for the send gate. */
      readonly counter: number;
      /** The gateway to use first: the one that delivered the answered packet, or the best. */
      readonly gateway: DeviceId | undefined;
      readonly timing: RadioTiming;
      readonly dataRate: number;
      readonly powerDbm: number;
      readonly priority: TransmitPriority;
      readonly purpose: RadioPurpose;
    }

  // control (module 5), from a `command` input, to the module that owns the change.
  | ({
      readonly kind: "armRequest";
      readonly sensors: SensorSelection;
      readonly continueOpen: boolean;
    } & Requested)
  | ({ readonly kind: "disarmRequest"; readonly sensors: SensorSelection } & Requested)
  | ({
      readonly kind: "sensorSettingsRequest";
      readonly sensor: DeviceId;
      readonly change: SensorSettingsChange;
    } & Requested)
  | ({
      readonly kind: "gatewaySettingsRequest";
      readonly gateway: DeviceId;
      /** The gateway's name, for the answer. */
      readonly name: string;
      /** The settings that change; the others stay (`hsn gateway set`). */
      readonly change: {
        readonly statusIntervalS?: number;
        readonly interferenceDb?: number;
        readonly interferenceS?: number;
        readonly defaultPowerDbm?: number;
        readonly sirenPowerDbm?: number;
      };
    } & Requested)
  | ({
      readonly kind: "sirenSettingsRequest";
      readonly siren: DeviceId;
      readonly maxSoundS: number;
    } & Requested)
  | ({
      readonly kind: "sirenTestRequest";
      readonly siren: DeviceId;
      readonly seconds: number | undefined;
    } & Requested)
  | ({ readonly kind: "siteSettingsRequest"; readonly change: SiteSettingsChange } & Requested)
  | ({
      readonly kind: "siteWifiRequest";
      readonly name: Uint8Array;
      readonly password: Uint8Array;
    } & Requested)
  | ({ readonly kind: "siteSurveyRequest" } & Requested)
  /** `hsn site change …`: start, show, cancel or force a site move (D115, section 9), for site. */
  | ({ readonly kind: "siteChangeRequested"; readonly action: SiteChangeAction } & Requested)
  | ({
      readonly kind: "deviceRenameRequest";
      readonly device: DeviceId;
      readonly name: string;
    } & Requested)
  | ({ readonly kind: "deviceRemoveRequest"; readonly device: DeviceId } & Requested)
  | ({
      readonly kind: "usbAddRequest";
      readonly link: LinkId;
      readonly name: string;
      /** A protocol `Role` to set first (§10, Set role), or none. */
      readonly role: number | undefined;
    } & Requested)
  | ({ readonly kind: "usbEraseRequest"; readonly link: LinkId } & Requested)
  /** The module that handled a request gives its answer back to control. */
  | { readonly kind: "answer"; readonly request: RequestId; readonly reply: ControlReply }

  // site (module 9): the site move of D115 (section 8, "Changing the site's channel or rate").
  /** The move's stage and target, whenever they change; sensors, gateways and sirens act on it. */
  | {
      readonly kind: "siteMove";
      /** The move's id (`site.move_id`). */
      readonly move: number;
      readonly stage: MoveStageName;
      /** The target channel, or undefined when it stays as it is. */
      readonly channel: number | undefined;
      /** The target sending rate, or undefined when it stays as it is. */
      readonly rate: number | undefined;
      readonly forced: boolean;
    }
  /** A sensor's newest packet names a version that carries the move (section 8). */
  | {
      readonly kind: "siteConfirmed";
      readonly move: number;
      readonly sensor: DeviceId;
      readonly cause: Seq;
    }
  /** A device was first heard on the new channel and rate after the switch (section 8). */
  | {
      readonly kind: "siteFollowed";
      readonly move: number;
      readonly device: DeviceId;
      readonly cause: Seq;
    }

  // audit (module 13).
  /** A record for audit to apply the warning cap to and pass on as a `record` effect (section 5). */
  | { readonly kind: "auditRecord"; readonly durability: Durability; readonly record: AuditRecord }

  // M2 (m2-design.md section 2's module table).
  /**
   * An app operation for the module that owns it (`OP_OWNERS`), from control (the hub computer),
   * app (a person or the console) or schedules: checked, made, and answered with `opAnswer`.
   */
  | {
      readonly kind: "opRequest";
      readonly owner: M2ModuleName;
      readonly op: AppOp;
      readonly actor: Actor;
      readonly answerTo: AnswerTo;
      /** The request's `commands` record, which the decisions it causes name (D110). */
      readonly record: Seq;
    }
  /** The owner's answer: control turns it into a `respond`, app into an `appSend` reply. */
  | { readonly kind: "opAnswer"; readonly answerTo: AnswerTo; readonly outcome: OpOutcome }
  /** control: `hsn open` asks people for a one-time console token (section 5, "The console"). */
  | ({ readonly kind: "consoleTokenRequest" } & Requested)
  /** people: a client was linked; its sessions may start. */
  | { readonly kind: "clientAdded"; readonly client: ClientId; readonly person: PersonId | null }
  /** people: a client was removed; the shell closes its sessions (`closeClient`). */
  | { readonly kind: "clientRemoved"; readonly client: ClientId }
  /**
   * layout: an arming request resolved to sensors (a mode switch, a group, a sensor), for alarm,
   * which arms them as built (HD 8) and answers, or refuses with `needsConfirmation`.
   */
  | {
      readonly kind: "armSensors";
      readonly sensors: readonly DeviceId[];
      /** Set when the request was a switch to this mode; alarm records the per-sensor decisions. */
      readonly mode: ModeId | undefined;
      readonly confirm: Confirmation | undefined;
      readonly actor: Actor;
      readonly answerTo: AnswerTo;
      readonly record: Seq;
    }
  /** layout: a disarm resolved to sensors; a schedule's holds back its triggers (D117). */
  | {
      readonly kind: "disarmSensors";
      readonly sensors: readonly DeviceId[];
      readonly mode: ModeId | undefined;
      /** A schedule's disarm leaves the triggers and counting sensors armed (D117). */
      readonly holdBack: boolean;
      readonly actor: Actor;
      readonly answerTo: AnswerTo;
      readonly record: Seq;
    };

/** Every message on the dispatcher's queue: input events and domain messages. */
export type Internal = HubEvent | DomainMessage;

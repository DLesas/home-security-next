/**
 * The firmware module's slice (docs/m3-updates-design.md section 4): the firmware store's index,
 * releases offered by the relay, rollouts, each device's update state, Bluetooth sessions and the
 * transfer grants in force.
 *
 * What is a row (migration 3, written now unless said): `firmware_images` (every image, removed ones
 * kept for their numbers), `rollouts` (each one; at most one not ended) and `device_updates` (one per
 * device, its `bytes` routine). What is memory, rebuilt after a restart: the relay's offers, the file
 * jobs in flight, the grants (a device asks again on its link, and a siren or gateway is offered
 * again when it is next heard), what each device was last told, what its last Started and update
 * query said, the `deviceUpdate` body last sent, and which gateway a person forced.
 */
import type { ReleaseOffer } from "@hsn/protocol/app";
import type { UpdateAction } from "@hsn/protocol";
import {
  type DeviceId,
  type ImageId,
  JOB_RANGES,
  type JobId,
  type LinkId,
  type RolloutId,
  type Seq,
} from "../model/ids.ts";
import type { AnswerTo, DeviceUpdateEventBody } from "../model/messages.ts";
import type { DeviceUpdateRow, FirmwareImageRow, RolloutRow, UpdateHeld } from "../model/rows.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** A firmware release a relay offered (m4-design section 6), its firmware entries only. */
export type FirmwareOffer = Extract<ReleaseOffer, { readonly kind: "firmware" }>;

/** A rollout with its device lists decoded from the row's blobs. */
export interface Rollout {
  readonly row: RolloutRow;
  readonly devices: readonly DeviceId[];
  readonly pilots: readonly DeviceId[];
}

/** The last offer a device was given, and on which link (undefined: by LoRa, in a reply). */
export interface Told {
  readonly action: UpdateAction;
  readonly link: LinkId | undefined;
  /** The Bluetooth nonce an offer of action 3 carried, so a new session is offered again. */
  readonly nonce: Uint8Array | undefined;
}

/** A device's `deviceUpdate` event body (m3-updates section 4), as last published. */
export type DeviceUpdateEvent = DeviceUpdateEventBody;
export type DeviceUpdateEventReason = NonNullable<DeviceUpdateEvent["reason"]>;

/** One device's update: its row, and what is kept in memory beside it. */
export interface DeviceEntry {
  readonly row: DeviceUpdateRow;
  /** The last offer it was given this run; undefined after a restart, so it is offered again. */
  readonly told: Told | undefined;
  /** How to recognize a sensor still verified after an unanswered go-ahead. */
  readonly sensorGoAhead?:
    | {
        readonly kind: "radio";
        readonly counter: number;
        readonly endedAt: Mono;
        readonly rate: number;
      }
    | { readonly kind: "restored"; readonly bootedAt: Mono }
    | undefined;
  /** Its `deviceUpdate` body as last sent to `app` (`deviceUpdateEvent`), for the progress bound. */
  readonly event: DeviceUpdateEvent | undefined;
  /** When progress was last published, for the 2 s ‡ bound. */
  readonly eventAt: Mono | undefined;
  /** "Gateway always busy" holds in this rollout (memory: a restart allows three more). */
  readonly busyHolds: number;
  /** When its armed hold began, for D91's reminder. */
  readonly armedSince: Mono | undefined;
  /** A person chose "update now anyway" for this gateway (`rollout.resume` with `force`). */
  readonly forced: boolean;
  /** After a cancel, the device holds part of an image it should discard: told "nothing" once. */
  readonly discard: boolean;
  /**
   * A hold the device itself reported (Update status refused: battery or armed), kept until what
   * the hub knows of it changes (its arming, or a new battery reading), so the hub does not offer
   * again what the device has just refused. `percent` is the hub's reading when it refused.
   */
  readonly deviceHeld: { readonly held: UpdateHeld; readonly percent: number | null } | undefined;
}

/** What the device's own packets said last (memory). */
export interface Seen {
  /** Its last Started said the running image is on trial. */
  readonly onTrial: boolean;
  /** Its last update query: it holds Wi-Fi details; undefined before any. */
  readonly wifiDetails: boolean | undefined;
  /** Its last update query: on USB power or mains. */
  readonly externalPower: boolean;
  /** The device's own link (Wi-Fi or USB) it was last heard on; undefined when none is open. */
  readonly link: LinkId | undefined;
}

/** A file job the module waits for. */
export type FirmwareJob =
  /** `firmware.upload`: answered when staged. */
  | {
      readonly kind: "upload";
      readonly answerTo: AnswerTo;
      readonly actor: string;
      readonly record: Seq;
      /** The upload's own number (`UploadRef.job`), for `notFound {what: "upload"}`. */
      readonly upload: number;
    }
  /** `firmware.fetch`: already answered `{job}`; staged as an upload is. */
  | {
      readonly kind: "fetch";
      readonly actor: string;
      readonly record: Seq;
      readonly version: string;
    }
  /** `firmware.remove`'s file. */
  | { readonly kind: "remove"; readonly image: ImageId }
  /** `firmware.download`'s stream. */
  | { readonly kind: "download" };

/** A grant in force on a link: which device pulls which image there. */
export interface Grant {
  readonly device: DeviceId;
  readonly image: ImageId;
}

export interface FirmwareSlice {
  readonly booted: boolean;
  readonly timers: readonly TimerOf<"firmware">[];
  /** Every image row, removed ones too (`removedMs` set). */
  readonly images: ReadonlyMap<ImageId, FirmwareImageRow>;
  readonly nextImage: number;
  /** Every rollout, by id; at most one has `endedMs` null. */
  readonly rollouts: ReadonlyMap<RolloutId, Rollout>;
  readonly nextRollout: number;
  readonly updates: ReadonlyMap<DeviceId, DeviceEntry>;
  readonly seen: ReadonlyMap<DeviceId, Seen>;
  /** The relay's current firmware offers (memory). */
  readonly offers: readonly FirmwareOffer[];
  /** Versions already recorded as offered this run (`firmware_release_offered` once each). */
  readonly offeredVersions: ReadonlySet<string>;
  readonly jobs: ReadonlyMap<JobId, FirmwareJob>;
  readonly nextJob: number;
  /** Grants by link. While `suspended`, the shell holds none of them (a countdown or alarm runs). */
  readonly grants: ReadonlyMap<LinkId, Grant>;
  readonly suspended: boolean;
  /** A countdown, an alarm or a site move ran at the last message: holds are looked at again when it changes. */
  readonly climate: Climate;
  /** Devices whose key change after a restore is not finished (D141): `device_keys.rekey`. */
  readonly rekey: ReadonlySet<DeviceId>;
}

/** What holds every install back: a countdown, an alarm, a site move (D115). */
export type Climate = "quiet" | "countdown" | "alarm" | "siteMove";

/** The slice before the boot event. */
export const EMPTY_FIRMWARE_SLICE: FirmwareSlice = {
  booted: false,
  timers: [],
  images: new Map(),
  nextImage: 1,
  rollouts: new Map(),
  nextRollout: 1,
  updates: new Map(),
  seen: new Map(),
  offers: [],
  offeredVersions: new Set(),
  jobs: new Map(),
  nextJob: JOB_RANGES.firmware.first,
  grants: new Map(),
  suspended: false,
  climate: "quiet",
  rekey: new Set(),
};

/** A device's memory before anything was heard from it. */
export const UNSEEN: Seen = {
  onTrial: false,
  wifiDetails: undefined,
  externalPower: false,
  link: undefined,
};

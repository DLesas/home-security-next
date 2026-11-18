/**
 * Ids (hub-design.md sections 2 and 6). Each is a number branded with its kind, so a device id
 * cannot be passed where a link id is expected. The functions below are the one place a plain
 * number becomes an id.
 */

import { MODULE_ORDER, type ModuleName } from "./modules.ts";

/** A row id of `devices` (section 6). Device 0 is the hub itself. */
export type DeviceId = number & { readonly __brand: "DeviceId" };

/** A row id of `boots`: one per run of the hub (sections 5 and 6). */
export type BootId = number & { readonly __brand: "BootId" };

/** The shell's name for one open link during this run (section 3); never stored. */
export type LinkId = number & { readonly __brand: "LinkId" };

/**
 * The name of one request to a module, so its `answer` can find it (section 9). The shell numbers
 * control requests from 1, below 2³²; `app` numbers the requests it sends M1a's modules from
 * `APP_REQUEST_BASE` (m2-design.md section 2, "Requests for M1a's modules"), so `control` and
 * `app` each take only the answers to their own.
 */
export type RequestId = number & { readonly __brand: "RequestId" };

/** The first request number `app` gives M1a's modules: 2⁴⁰ ‡, above any control request. */
export const APP_REQUEST_BASE = 2 ** 40;

/** Whether a request number is one of `app`'s (from `APP_REQUEST_BASE`), not the shell's. */
export function isAppRequest(request: RequestId): boolean {
  return request >= APP_REQUEST_BASE;
}

/** The core's name for one `send` effect, so a `sendFailed` input can name it (section 2). */
export type SendRef = number & { readonly __brand: "SendRef" };

/**
 * A record's sequence number and row id: boot × 2³² + n, n counting this boot's records
 * (section 2). It grows with time, also across restarts.
 */
export type Seq = number & { readonly __brand: "Seq" };

// M2 (m2-design.md sections 2 and 4).

/** A row id of `people`. */
export type PersonId = number & { readonly __brand: "PersonId" };
/** A row id of `clients`: one linked browser or phone, or the console. */
export type ClientId = number & { readonly __brand: "ClientId" };
/** The shell's name for one app connection during this run (section 2); never stored. */
export type ConnId = number & { readonly __brand: "ConnId" };
/**
 * A token the shell may accept a handshake with: a link token (a row id of `link_tokens`) or a
 * restore token (never stored), in the two ranges of `TOKEN_RANGES`. A typed code's 4-character
 * token id is its lookup, not a `TokenId`.
 */
export type TokenId = number & { readonly __brand: "TokenId" };
/** A row id of `groups`. */
export type GroupId = number & { readonly __brand: "GroupId" };
/** A row id of `modes`. Away and Disarmed are made by migration 2 (D90). */
export type ModeId = number & { readonly __brand: "ModeId" };
/** A row id of `schedules`. */
export type ScheduleId = number & { readonly __brand: "ScheduleId" };

// The joint step 0 of M3 and M4 (docs/m3-m4-plan.md).
/** A row id of `firmware_images` (m3-updates-design section 4). */
export type ImageId = number & { readonly __brand: "ImageId" };
/** A row id of `rollouts`. */
export type RolloutId = number & { readonly __brand: "RolloutId" };
/** A row id of `push_outbox` (m4-design section 4); also the push item's `id` on the relay link. */
export type OutboxId = number & { readonly __brand: "OutboxId" };
/** The core's name for one file job (a backup, an export, an update), for `fileReady`. */
export type JobId = number & { readonly __brand: "JobId" };

export function personId(id: number): PersonId {
  return id as PersonId;
}
export function clientId(id: number): ClientId {
  return id as ClientId;
}
export function connId(id: number): ConnId {
  return id as ConnId;
}
export function tokenId(id: number): TokenId {
  return id as TokenId;
}

/**
 * The two ranges of `TokenId` (m2-design.md section 5, "Token numbers"), so link and restore
 * tokens, which share `linkSecret` and the shell's table of keys, never meet: link tokens 1 to
 * 2³¹ − 1, allocated by `people` as `link_tokens.id`, the next above the highest ever stored;
 * restore tokens from 2³¹, allocated by `upkeep` in memory, counting up from 2³¹ at each boot.
 * Each module ignores `linkFailed` for tokens outside its range.
 */
export const TOKEN_RANGES = {
  link: { first: 1, last: 2 ** 31 - 1, owner: "people" },
  restore: { first: 2 ** 31, last: Number.MAX_SAFE_INTEGER, owner: "upkeep" },
} as const;

/** Which range a token is in. */
export function tokenPurpose(token: TokenId): "link" | "restore" {
  return token >= TOKEN_RANGES.restore.first ? "restore" : "link";
}
export function groupId(id: number): GroupId {
  return id as GroupId;
}
export function modeId(id: number): ModeId {
  return id as ModeId;
}
export function scheduleId(id: number): ScheduleId {
  return id as ScheduleId;
}

export function imageId(id: number): ImageId {
  return id as ImageId;
}

export function rolloutId(id: number): RolloutId {
  return id as RolloutId;
}

export function outboxId(id: number): OutboxId {
  return id as OutboxId;
}
export function jobId(id: number): JobId {
  return id as JobId;
}

/**
 * The ranges of `JobId`, one per module that starts file jobs, so a `fileReady` names one module's
 * job only and each module ignores the others': `upkeep`'s (backups, exports, hub updates,
 * restores) counted from 1 at each boot, below 2³¹; `firmware`'s (staging, fetching, removing and
 * sending images, m3-updates-design section 4) counted from 2³¹ at each boot. Every job number is
 * at most 2³² − 1, as `{job}` replies carry it (`jobRef`).
 */
export const JOB_RANGES = {
  upkeep: { first: 1, last: 2 ** 31 - 1, owner: "upkeep" },
  firmware: { first: 2 ** 31, last: 2 ** 32 - 1, owner: "firmware" },
} as const;

/** The module whose range a job number is in, or undefined for one outside every range. */
export function jobOwner(
  job: JobId,
): (typeof JOB_RANGES)[keyof typeof JOB_RANGES]["owner"] | undefined {
  for (const range of Object.values(JOB_RANGES))
    if (Number.isInteger(job) && job >= range.first && job <= range.last) return range.owner;
  return undefined;
}

/** The two fixed modes' ids, made by migration 2 (D90). */
export const AWAY_MODE: ModeId = modeId(1);
export const DISARMED_MODE: ModeId = modeId(2);

export function deviceId(id: number): DeviceId {
  return id as DeviceId;
}

export function bootId(id: number): BootId {
  return id as BootId;
}

export function linkId(id: number): LinkId {
  return id as LinkId;
}

export function requestId(id: number): RequestId {
  return id as RequestId;
}

export function sendRef(ref: number): SendRef {
  return ref as SendRef;
}

/** How many send references each module has: its own range of the `SendRef` space. */
export const SEND_REFS_PER_MODULE = 2 ** 40;

/**
 * The `n`th send reference of `module` (section 2): (the module's place in `MODULE_ORDER` + 1) ×
 * 2⁴⁰ + n, so references are unique across modules within a run, and `sendRefModule` tells
 * whose a `sendFailed` is. References are not kept across a restart; `n` wraps within the range.
 */
export function moduleSendRef(module: ModuleName, n: number): SendRef {
  const place = MODULE_ORDER.indexOf(module) + 1;
  return sendRef(place * SEND_REFS_PER_MODULE + (n % SEND_REFS_PER_MODULE));
}

/** The module a send reference belongs to, or undefined for one no module made. */
export function sendRefModule(ref: SendRef): ModuleName | undefined {
  return MODULE_ORDER[Math.floor(ref / SEND_REFS_PER_MODULE) - 1];
}

/** A sequence number as read back from a row; `recordSeq` makes new ones. */
export function seq(value: number): Seq {
  return value as Seq;
}

/** The hub's own row in `devices` and `device_state`, whose state row is the commit mark (section 5). */
export const HUB_DEVICE: DeviceId = deviceId(0);

/** n's share of a sequence number: the boot id is multiplied by this (section 2). */
export const RECORDS_PER_BOOT = 2 ** 32;

/** The largest boot id whose sequence numbers stay exact in a double (below 2⁵³). */
export const MAX_BOOT_ID = 2 ** 21 - 1;

/**
 * The sequence number of record `n` of `boot`, or `undefined` when either is out of range: a
 * boot past MAX_BOOT_ID, or more records in one boot than 2³² (section 2).
 */
export function recordSeq(boot: BootId, n: number): Seq | undefined {
  const inRange =
    Number.isInteger(boot) &&
    boot >= 0 &&
    boot <= MAX_BOOT_ID &&
    Number.isInteger(n) &&
    n >= 0 &&
    n < RECORDS_PER_BOOT;
  return inRange ? ((boot * RECORDS_PER_BOOT + n) as Seq) : undefined;
}

/** The boot a sequence number belongs to. */
export function seqBoot(seq: Seq): BootId {
  return bootId(Math.floor(seq / RECORDS_PER_BOOT));
}

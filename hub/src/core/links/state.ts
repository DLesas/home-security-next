/**
 * The links module's slice (hub-design.md section 2, module 3): the link table (each open
 * link's kind, label and what it carries) and the device directory the frames are sorted by
 * (section 8, "Accepting a device packet"). It holds no timers.
 */
import type { LinkKind } from "../model/events.ts";
import type { DeviceId, LinkId } from "../model/ids.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** What a link carries, as far as the hub knows (section 7, "Gateway connection"). */
export type LinkCarrier =
  /** Nothing proven yet: a new link, or one whose gateway moved away. */
  | { readonly kind: "unknown" }
  /** A gateway's proven session (`gatewayUp`). */
  | { readonly kind: "gateway"; readonly device: DeviceId }
  /** A siren whose packet was accepted on it (§10, "What uses it"). */
  | { readonly kind: "siren"; readonly device: DeviceId };

/** One open link. */
export interface LinkEntry {
  readonly link: LinkId;
  readonly kind: LinkKind;
  /** A serial port's path, or a WebSocket's peer address. */
  readonly label: string;
  readonly openedAt: Mono;
  readonly carrier: LinkCarrier;
}

/** A link that closed, kept so a rejection counted after its close can still name it. */
export interface ClosedLink {
  readonly link: LinkId;
  readonly kind: LinkKind;
  readonly label: string;
}

/** A device the frames can come from: its address and protocol `Role`. */
export interface DirectoryEntry {
  readonly device: DeviceId;
  readonly address: number;
  readonly role: number;
}

/** The links module's slice (section 2, module 3). */
export interface LinksSlice {
  readonly timers: readonly TimerOf<"links">[];
  readonly open: ReadonlyMap<LinkId, LinkEntry>;
  /** The most recently closed links, newest last, at most `CLOSED_LINKS_KEPT`. */
  readonly closed: readonly ClosedLink[];
  readonly byAddress: ReadonlyMap<number, DirectoryEntry>;
  readonly byDevice: ReadonlyMap<DeviceId, DirectoryEntry>;
}

/**
 * How many closed links keep their label. A rejection is counted in the step that closed its
 * link, so one is enough for that; 64 covers a burst of WebSocket reconnections (this design).
 */
export const CLOSED_LINKS_KEPT = 64;

/** The slice before the boot event. */
export const EMPTY_LINKS_SLICE: LinksSlice = {
  timers: [],
  open: new Map(),
  closed: [],
  byAddress: new Map(),
  byDevice: new Map(),
};

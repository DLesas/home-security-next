/**
 * What `hub-net`'s native side and its TypeScript side say to each other (m3-design.md section 2,
 * "Our module, `hub-net`"), and the readers that take the native side's answers and events as
 * `unknown`: whatever arrives, a shape this file does not know is dropped, never thrown on.
 *
 * - **Sessions.** The TypeScript side numbers each browse and passes the number to `start`; every
 *   event names its session, so an event of a browse already stopped (or one that arrives before
 *   `start`'s answer) is told apart without a race.
 * - **One browse at a time** on the native side: `start` stops any other first. `stop` stops only
 *   the session it names.
 * - **Nothing is asked of the person here.** `permission` reads; `ask` is Android's request for
 *   `ACCESS_LOCAL_NETWORK`, called by a page that has explained first (docs/app-design.md, "On a
 *   phone", rule 7). iOS has no way to read or ask (`unreadable`).
 * - **The native side decides nothing about the record.** It passes the TXT record as it has it:
 *   iOS the record's bytes (`raw`), Android its key-value map (`entries`), each value as bytes or
 *   null for a key without `=`. `record.ts` reads them.
 */

/** The service the hub advertises (protocol.md section 10, "Finding the hub"). */
export const HUB_SERVICE = "_hsn-hub._tcp";

/** The event's name, on both platforms. */
export const HUB_NET_EVENT = "hubNet";

/** iOS's `kDNSServiceErr_PolicyDenied` (dns_sd.h): the local network was refused. */
export const DNS_POLICY_DENIED = -65_570;

/** Android 17's `NsdManager.FAILURE_PERMISSION_DENIED`: `ACCESS_LOCAL_NETWORK` is not held. */
export const NSD_PERMISSION_DENIED = 7;

/** The native module, as the TypeScript side uses it; `native.ts` binds the real one. */
export interface HubNetNative {
  /** Starts browsing for `type` as session `session`; resolves with a `StartAnswer`. */
  start(type: string, session: number): Promise<unknown>;
  /** Stops session `session`, if it is the one running. */
  stop(session: number): Promise<unknown>;
  /** The local network permission as it stands: a `NativePermission`. */
  permission(): Promise<unknown>;
  /** Android: asks for `ACCESS_LOCAL_NETWORK`. iOS: reads, as `permission`. */
  ask(): Promise<unknown>;
  /** Listens to the module's events; the answer stops listening. */
  listen(listener: (event: unknown) => void): () => void;
}

/** How a start ended: browsing, or refused before anything began. */
export type StartAnswer =
  | { readonly kind: "started" }
  | { readonly kind: "refused"; readonly why: "unsupported" | "failed"; readonly code: number };

/** Where an error code comes from: dns_sd's, POSIX's, NsdManager's, or another. */
export type CodeDomain = "dns" | "posix" | "nsd" | "other";

/** A TXT record as the platform gives it. */
export type NativeTxt =
  | { readonly kind: "raw"; readonly bytes: Uint8Array }
  | {
      readonly kind: "entries";
      readonly entries: readonly (readonly [string, Uint8Array | null])[];
    };

/** An event of one browse. */
export type NativeEvent =
  /** A service resolved, or changed: its instance name, SRV port, addresses and TXT record. */
  | {
      readonly kind: "service";
      readonly session: number;
      readonly name: string;
      readonly port: number;
      readonly addresses: readonly string[];
      readonly txt: NativeTxt;
    }
  /** A service went away. */
  | { readonly kind: "lost"; readonly session: number; readonly name: string }
  /**
   * The browse's state: `ready`; `waiting` for something (iOS's Network framework, which waits
   * with dns_sd's `PolicyDenied` while the local network is refused); `failed`, after which the
   * native side has stopped the browse.
   */
  | {
      readonly kind: "state";
      readonly session: number;
      readonly state: "ready" | "waiting" | "failed";
      readonly domain: CodeDomain;
      readonly code: number;
    }
  /** Whether the phone has a local network to browse: Wi-Fi or Ethernet. */
  | { readonly kind: "network"; readonly session: number; readonly local: boolean };

/** The local network permission as the native side reads it. */
export interface NativePermission {
  readonly state: "granted" | "denied" | "undetermined" | "unreadable";
  readonly canAskAgain: boolean;
}

// ----- Readers -----

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSession = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isCode = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

/** A list of bytes, as both platforms send them (numbers 0 to 255); undefined when it is not one. */
export function readBytes(value: unknown): Uint8Array | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: readonly unknown[] = value;
  const out = new Uint8Array(list.length);
  for (const [i, item] of list.entries()) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 255)
      return undefined;
    out[i] = item;
  }
  return out;
}

function readTxt(value: unknown): NativeTxt | undefined {
  if (!isFields(value)) return undefined;
  if ("raw" in value) {
    const bytes = readBytes(value.raw);
    return bytes === undefined ? undefined : { kind: "raw", bytes };
  }
  const entries = value.entries;
  if (!isFields(entries)) return undefined;
  const out: (readonly [string, Uint8Array | null])[] = [];
  for (const [key, item] of Object.entries(entries)) {
    if (item === null) out.push([key, null]);
    else {
      const bytes = readBytes(item);
      if (bytes === undefined) return undefined;
      out.push([key, bytes]);
    }
  }
  return { kind: "entries", entries: out };
}

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && (value as readonly unknown[]).every((a) => typeof a === "string");

const DOMAINS: readonly CodeDomain[] = ["dns", "posix", "nsd", "other"];
const STATES = ["ready", "waiting", "failed"] as const;

/** One event from the native side; undefined for anything else. */
export function readEvent(value: unknown): NativeEvent | undefined {
  if (!isFields(value) || !isSession(value.session)) return undefined;
  const session = value.session;
  switch (value.kind) {
    case "service": {
      const { name, port, addresses } = value;
      const txt = readTxt(value.txt);
      if (typeof name !== "string" || name === "" || !isCode(port) || !isStringList(addresses))
        return undefined;
      if (txt === undefined) return undefined;
      return { kind: "service", session, name, port, addresses, txt };
    }
    case "lost":
      return typeof value.name === "string" && value.name !== ""
        ? { kind: "lost", session, name: value.name }
        : undefined;
    case "state": {
      const state = STATES.find((s) => s === value.state);
      const domain = DOMAINS.find((d) => d === value.domain);
      if (state === undefined || domain === undefined || !isCode(value.code)) return undefined;
      return { kind: "state", session, state, domain, code: value.code };
    }
    case "network":
      return typeof value.local === "boolean"
        ? { kind: "network", session, local: value.local }
        : undefined;
    default:
      return undefined;
  }
}

/** `start`'s answer; anything else, a rejection included, is a failure to start. */
export function readStartAnswer(value: unknown): StartAnswer {
  if (isFields(value) && value.started === true) return { kind: "started" };
  const code = isFields(value) && isCode(value.code) ? value.code : 0;
  const why = isFields(value) && value.refused === "unsupported" ? "unsupported" : "failed";
  return { kind: "refused", why, code };
}

const PERMISSION_STATES = ["granted", "denied", "undetermined", "unreadable"] as const;

/** The permission the native side read; undefined for anything else. */
export function readPermission(value: unknown): NativePermission | undefined {
  if (!isFields(value) || typeof value.canAskAgain !== "boolean") return undefined;
  const state = PERMISSION_STATES.find((s) => s === value.state);
  return state === undefined ? undefined : { state, canAskAgain: value.canAskAgain };
}

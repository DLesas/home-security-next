/**
 * The browse for hubs, over the native side (`contract.ts`): found, updated and lost hubs as the
 * system's callbacks report them, the window a `HubFinder` browses for, the faults the app words,
 * a count of the records left out, and what the browses have taught about the local network.
 *
 * - **Started when asked, stopped when not needed.** The native browse runs while at least one
 *   `watch` is open (a `browse(ms)` is one for `ms`), and is stopped as the last one closes: the
 *   phone's battery is the budget. Nothing polls; the only timer is the window's end.
 * - **Found, updated, lost** are per advertised instance (`hsn-<id>`). A record that becomes
 *   malformed, or loses its addresses, is lost; one that becomes good is found.
 * - **Only finding is trusted to the record**: the phone proves the hub by its Noise key. A
 *   record with a key missing or malformed is left out and counted (`diagnostics`), never thrown
 *   on; so is an event the native side should not have sent.
 * - **Faults, never throws.** The local network refused; no Wi-Fi; no browse on this build
 *   (`unsupported`); the system's browse failing (`failed`). Nothing found is not a fault.
 */
import type { FoundHub } from "../../../src/platform/finder";
import type { LocalNetwork } from "../../../src/platform/local-network-types";
import type { Permission } from "../../../src/platform/scanner";
import {
  type CodeDomain,
  DNS_POLICY_DENIED,
  HUB_SERVICE,
  type HubNetNative,
  NSD_PERMISSION_DENIED,
  readEvent,
  readPermission,
  readStartAnswer,
} from "./contract";
import { readAddresses, readHubRecord, type RecordFault, txtOf } from "./record";

/** The one timer the browse needs: the end of a window. */
export interface After {
  after(ms: number, run: () => void): () => void;
}

/**
 * Why a browse found nothing to try: the local network refused (Android's permission, iOS's
 * answer); no Wi-Fi or Ethernet to browse on; no browse in this build; the system's browse failed.
 */
export type HubNetFault = "localNetworkDenied" | "wifiOff" | "unsupported" | "failed";

/** A hub a browse found: what `FoundHub` carries, with its instance name and device identity. */
export interface BrowsedHub extends FoundHub {
  /** The advertised instance's name (`hsn-<id>`). */
  readonly name: string;
  /** `id`: the hub identity devices use (protocol.md section 9), for a diagnostic only. */
  readonly id: string;
}

/** What a watcher is told, in order. */
export type HubChange =
  | { readonly kind: "found" | "updated"; readonly hub: BrowsedHub }
  | { readonly kind: "lost"; readonly name: string }
  /** A fault while browsing, which may clear (null): iOS waits while the local network is refused. */
  | { readonly kind: "fault"; readonly fault: HubNetFault | null }
  /** The browse stopped by itself, with why: refused at start, or the system's browse failed. */
  | { readonly kind: "ended"; readonly fault: HubNetFault };

/** What the last browse (or this one) saw, for a diagnostic: never an address or a key. */
export interface BrowseDiagnostics {
  readonly browsing: boolean;
  /** Hubs found, good records with an address to try. */
  readonly found: number;
  /** Records left out, by why. */
  readonly ignored: Readonly<Record<RecordFault, number>>;
  /** Events from the native side that were not understood (none, unless the two sides differ). */
  readonly unreadEvents: number;
  /** Why nothing is found now, as `browse` would answer: `wifiOff` included. */
  readonly fault: HubNetFault | null;
}

export interface HubBrowser {
  /** Watches for hubs, the browse running while any watcher is open; the answer stops watching. */
  readonly watch: (listener: (change: HubChange) => void) => () => void;
  /** Browses for `ms` and answers the hubs found then, one per app identity, or why none. */
  readonly browse: (
    ms: number,
  ) => Promise<
    | { readonly ok: true; readonly value: readonly BrowsedHub[] }
    | { readonly ok: false; readonly fault: HubNetFault }
  >;
  readonly diagnostics: () => BrowseDiagnostics;
  /** The local network permission, as the system and the browses tell it (rule 7's pages). */
  readonly localNetwork: LocalNetwork;
}

type Entry =
  | { readonly kind: "hub"; readonly hub: BrowsedHub; readonly at: number }
  | { readonly kind: "ignored"; readonly fault: RecordFault }
  /** A good record not yet resolved to an address. */
  | { readonly kind: "waiting" };

const sameHub = (a: BrowsedHub, b: BrowsedHub) =>
  a.id === b.id &&
  a.identity === b.identity &&
  a.appsPort === b.appsPort &&
  a.addresses.length === b.addresses.length &&
  a.addresses.every((x, i) => x === b.addresses[i]);

const GRANTED: Permission = { state: "granted", canAskAgain: true };
const UNDETERMINED: Permission = { state: "undetermined", canAskAgain: true };

/** Whether an error code says the local network was refused: iOS's dns_sd, Android 17's NSD. */
export function isDenial(domain: CodeDomain, code: number): boolean {
  return (
    (domain === "dns" && code === DNS_POLICY_DENIED) ||
    (domain === "nsd" && code === NSD_PERMISSION_DENIED)
  );
}

export function hubBrowser(native: HubNetNative | null, timers: After): HubBrowser {
  const watchers = new Set<(change: HubChange) => void>();
  const entries = new Map<string, Entry>();
  /** The session running, or null; sessions are numbered here (`contract.ts`). */
  let session: number | null = null;
  let lastSession = 0;
  let stopListening: (() => void) | undefined;
  let fault: HubNetFault | null = null;
  let network: boolean | null = null;
  let unreadEvents = 0;
  let clock = 0;
  /** What browses taught about iOS's local network, which iOS gives no way to read. */
  const learnt = { denied: false, seen: false };

  const tell = (change: HubChange) => {
    for (const watcher of [...watchers]) watcher(change);
  };

  const setFault = (next: HubNetFault | null) => {
    if (next === fault) return;
    fault = next;
    tell({ kind: "fault", fault: next });
  };

  const hubs = (): BrowsedHub[] =>
    [...entries.values()].flatMap((e) => (e.kind === "hub" ? [e.hub] : []));

  const leave = (name: string, next: Entry | undefined) => {
    const before = entries.get(name);
    if (next === undefined) entries.delete(name);
    else entries.set(name, next);
    if (before?.kind === "hub") tell({ kind: "lost", name });
  };

  /** Ends the running session by itself (refused, or the system's browse failed). */
  const ended = (why: HubNetFault) => {
    session = null;
    stopListening?.();
    stopListening = undefined;
    fault = why;
    tell({ kind: "ended", fault: why });
  };

  const onEvent = (raw: unknown) => {
    const event = readEvent(raw);
    if (event === undefined) {
      unreadEvents++;
      return;
    }
    if (event.session !== session) return;
    switch (event.kind) {
      case "service": {
        const read = readHubRecord(txtOf(event.txt));
        if (!read.ok) {
          leave(event.name, { kind: "ignored", fault: read.fault });
          return;
        }
        const addresses = readAddresses(event.addresses);
        if (addresses.length === 0) {
          leave(event.name, { kind: "waiting" });
          return;
        }
        const hub: BrowsedHub = { name: event.name, ...read.record, addresses };
        const before = entries.get(event.name);
        learnt.seen = true;
        learnt.denied = false;
        if (fault === "localNetworkDenied") setFault(null);
        if (before?.kind === "hub" && sameHub(before.hub, hub)) return;
        entries.set(event.name, { kind: "hub", hub, at: ++clock });
        tell({ kind: before?.kind === "hub" ? "updated" : "found", hub });
        return;
      }
      case "lost":
        leave(event.name, undefined);
        return;
      case "network":
        network = event.local;
        return;
      case "state": {
        const denied = isDenial(event.domain, event.code);
        if (denied) learnt.denied = true;
        if (event.state === "failed") ended(denied ? "localNetworkDenied" : "failed");
        else if (event.state === "waiting" && denied) setFault("localNetworkDenied");
        else if (event.state === "ready" && fault !== null) {
          // Ready again, as iOS is once the person allows the local network.
          learnt.denied = false;
          setFault(null);
        }
        return;
      }
    }
  };

  const begin = () => {
    if (native === null) {
      fault = "unsupported";
      tell({ kind: "ended", fault: "unsupported" });
      return;
    }
    const mine = ++lastSession;
    session = mine;
    entries.clear();
    fault = null;
    network = null;
    unreadEvents = 0;
    stopListening = native.listen(onEvent);
    native.start(HUB_SERVICE, mine).then(
      (answer) => {
        const read = readStartAnswer(answer);
        if (session !== mine || read.kind === "started") return;
        ended(read.why);
      },
      () => {
        if (session === mine) ended("failed");
      },
    );
  };

  const end = () => {
    const running = session;
    session = null;
    stopListening?.();
    stopListening = undefined;
    if (running !== null && native !== null)
      native.stop(running).then(
        () => undefined,
        () => undefined,
      );
  };

  const watch = (listener: (change: HubChange) => void) => {
    watchers.add(listener);
    if (session === null) begin();
    else {
      for (const hub of hubs()) listener({ kind: "found", hub });
      if (fault !== null) listener({ kind: "fault", fault });
    }
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      watchers.delete(listener);
      if (watchers.size === 0) end();
    };
  };

  /** The hubs to try: one per app identity, the one most lately changed. */
  const answer = (): Awaited<ReturnType<HubBrowser["browse"]>> => {
    const latest = new Map<string, { hub: BrowsedHub; at: number }>();
    for (const e of entries.values())
      if (e.kind === "hub" && (latest.get(e.hub.identity)?.at ?? -1) < e.at)
        latest.set(e.hub.identity, { hub: e.hub, at: e.at });
    const found = [...latest.values()].map((l) => l.hub);
    if (found.length > 0) return { ok: true, value: found };
    if (fault !== null) return { ok: false, fault };
    if (network === false) return { ok: false, fault: "wifiOff" };
    return { ok: true, value: [] };
  };

  const browse: HubBrowser["browse"] = (ms) =>
    new Promise((resolve) => {
      // A holder, since the watch may end the browse before it returns (no native module).
      const nothing = (): void => undefined;
      const run = { done: false, stop: nothing, cancel: nothing };
      const finish = () => {
        if (run.done) return;
        run.done = true;
        run.cancel();
        const result = answer();
        run.stop();
        resolve(result);
      };
      run.stop = watch((change) => {
        if (change.kind === "ended") finish();
      });
      if (run.done) run.stop();
      else run.cancel = timers.after(Math.max(0, Number.isFinite(ms) ? ms : 0), finish);
    });

  const diagnostics = (): BrowseDiagnostics => {
    const ignored: Record<RecordFault, number> = {
      missingKey: 0,
      malformedKey: 0,
      malformedTxt: 0,
    };
    for (const e of entries.values()) if (e.kind === "ignored") ignored[e.fault]++;
    const answered = answer();
    return {
      browsing: session !== null,
      found: hubs().length,
      ignored,
      unreadEvents,
      fault: answered.ok ? null : answered.fault,
    };
  };

  /** iOS cannot read the permission: what the browses saw stands in. */
  const fromNative = (read: Promise<unknown>): Promise<Permission> =>
    read.then(
      (value) => {
        const permission = readPermission(value);
        if (permission === undefined) return UNDETERMINED;
        if (permission.state !== "unreadable")
          return { state: permission.state, canAskAgain: permission.canAskAgain };
        // iOS asks once; after a refusal only the Settings app can allow it.
        if (learnt.denied) return { state: "denied", canAskAgain: false };
        return learnt.seen ? GRANTED : UNDETERMINED;
      },
      () => UNDETERMINED,
    );

  const localNetwork: LocalNetwork = {
    permission: () =>
      native === null ? Promise.resolve(UNDETERMINED) : fromNative(native.permission()),
    ask: () => (native === null ? Promise.resolve(UNDETERMINED) : fromNative(native.ask())),
  };

  return { watch, browse, diagnostics, localNetwork };
}

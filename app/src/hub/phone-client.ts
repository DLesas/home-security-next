/**
 * The hub client on a phone (m3-design.md sections 2 to 4), built from platform-neutral pieces so
 * every rule runs under `bun test`: `start.native.ts` gives it the phone's secure store, React
 * Native's WebSocket, the browse (P1's, once built) and its links; tests give it memory, Bun's
 * WebSocket and stand-ins.
 *
 * - **Records.** The vault (`platform/vault.ts`) keeps one record and one key per hub; the session
 *   is the chosen hub's. `seq` is written before each change is sent (`reserveSeq`, through the
 *   channel). A vault that cannot be read shows as the channel's `noStorage`, with the vault's own
 *   fault in `vault` (`locked` after a restart before the first unlock); `resume` reads it again
 *   when the app comes to the front.
 * - **Reaching the hub** (`finder.ts`): the address that last worked, the hub's own list, then a
 *   browse; the address that answers is written back, and `hub.info`'s `addresses` (version 2)
 *   replace the code's `a=` once the hub names them, its `relay` the code's `r=`.
 * - **Away from home** (`relay.ts`; m3-design.md section 6): the relay last, for a session, a link
 *   and a restore, when the phone has one for the hub (`hub.info`'s, the code's `r=`, the
 *   deployment's default). While on the relay the phone tries home again every 60 s † and when the
 *   app comes to the front, and moves its session home when home answers. `reach` says which path
 *   the session takes, and what the relay's last close meant.
 * - **Linking** by a code's addresses (`PhoneLinkSecret.reach`), or, for a typed code with no
 *   address, each hub a browse finds in turn: a hub that does not hold the code closes before
 *   message 2, which costs no try. The record, its key and `LinkResult`'s backup key are written
 *   together before the hub is listed and chosen.
 * - **The backup key** (`restore.ts`'s keeper) on each session; **restore** from a code.
 * - **Removal**: the `session` event deletes the hub's record, key and backup keys. Refusals before
 *   message 2, however many, delete nothing: they are also what a hub that speaks no version in
 *   common, or a full one, answers (m2-design.md section 8: "keeps its keys until a new link").
 */
import {
  type AppEvent,
  type AppEventV2,
  type AppOpBody,
  type AppOpName,
  hubInfoV2,
  type LinkRequest,
  type RestoreOffer,
} from "@hsn/protocol/app";
import { createStore, type StoreApi } from "zustand/vanilla";
import { Channel, type ChannelListener, type RequestOutcome } from "./channel";
import type { CodeSource, HubClient, LocalState } from "./client";
import { storeListener } from "./client";
import {
  browseFor,
  hubSocketConnect,
  type HubTarget,
  isReachableHomeHost,
  type MakeSocket,
  reachOf,
  type RestoreCode,
  storedHubConnect,
  targetsConnect,
} from "./finder";
import { type LinkFailure, type LinkSecret, linkClient, type ProtoRange } from "./handshake";
import { fromBase64url } from "./files";
import { BackupKeyKeeper, restoreHub, type RestoreOutcome, snapshotEpoch } from "./restore";
import type { ArrivedCode } from "./start-types";
import {
  homeThenRelay,
  type MakeRelaySocket,
  type PathInUse,
  type RelayBuild,
  type RelayClosed,
  relayClosedOf,
  relayConnect,
  relayUrlFor,
} from "./relay";
import type { Connect, Timers } from "./wire";
import { createLiveStore } from "../state/live";
import type { ClientKeys, RecordStore, StoredClient } from "../platform/client-key";
import type { FinderFault, HubFinder } from "../platform/finder";
import type { PlatformSecret } from "../platform/keys";
import type { HeldBackupKey, HubReach } from "../platform/records";
import {
  chosenRecordStore,
  type PhoneRecords,
  phoneRecords,
  type SecureItems,
  type VaultStatus,
} from "../platform/vault";

export interface PhoneDeps {
  readonly items: SecureItems;
  readonly makeSocket: MakeSocket;
  readonly finder: HubFinder;
  readonly timers: Timers;
  /** The app's version, as `ClientHello.app` carries it. */
  readonly app: string;
  /** The channel versions offered: version 2 only in the app (`PHONE_PROTO`). */
  readonly proto: ProtoRange;
  /** The phone's key functions (`platform/keys.native.ts`). */
  readonly keys: ClientKeys<Uint8Array>;
  /** The path through the relay; without it the phone reaches its hubs at home only. */
  readonly relay?: PhoneRelay;
}

/** While on the relay, the phone tries home again this often † (m3-design.md section 6). */
export const HOME_AGAIN_MS = 60_000;

/** What the phone's path through the relay needs (`relay.ts`). */
export interface PhoneRelay {
  /** React Native's own WebSocket on a phone; Bun's in tests. */
  readonly make: MakeRelaySocket;
  /**
   * The deployment's default relay (`defaultRelayUrl(DEPLOYMENT)`), used when neither the hub
   * nor the code names one; null while the deployment's domain is the placeholder (RD 2).
   */
  readonly defaultUrl: string | null;
  /** `ws://` relays are taken in a development build only. */
  readonly build: RelayBuild;
  /** How often to try home again while on the relay; `HOME_AGAIN_MS` when not given. */
  readonly homeAgainMs?: number;
}

/** What the phone knows of reaching its hub, for the pages: never an address's secret, never a key. */
export interface ReachState {
  /** The system refused the local network (iOS's question answered no; Android 17's permission). */
  readonly localNetworkDenied: boolean;
  /** Why the last browse found nothing to try; null when it did, or none was needed. */
  readonly browse: FinderFault | null;
  /** The path of the session open now: at home or through the relay; null while none is open. */
  readonly path: PathInUse | null;
  /**
   * What the relay's last close said, while no session is open: the hub not connected to it
   * (4404), or the relay busy (1013, 4429). Null once a session opens, by either path.
   */
  readonly relayClosed: RelayClosed | null;
}

/** Nothing known yet of reaching the hub. */
export const NO_REACH: ReachState = {
  localNetworkDenied: false,
  browse: null,
  path: null,
  relayClosed: null,
};

export interface PhoneClient {
  readonly client: HubClient;
  /** Sends the phone's operations on the already negotiated version 2 channel. */
  readonly forward: Channel["forward"];
  /** Receives events introduced in version 2, without changing the version 1 store. */
  onNewEvent(listener: (event: AppEventV2) => void): () => void;
  readonly records: PhoneRecords;
  /** The vault's last fault, in full (`locked`, `denied`, `corrupt`, `full`, `failed`). */
  readonly vault: StoreApi<VaultStatus>;
  readonly reach: StoreApi<ReachState>;
  /** A restore from a scanned `hsn://restore/1` code; on success the hub is chosen and reached. */
  restore(code: RestoreCode, offered?: (offer: RestoreOffer) => void): Promise<RestoreOutcome>;
  /**
   * The app came to the front: a vault that could not be read, or a hub not reached, is tried
   * again; a session on the relay tries home.
   */
  resume(): void;
  /** The backup-key keeper of the session open now, if any. */
  keeper(): BackupKeyKeeper | undefined;
}

/**
 * The phone's records and keys as the shared channel's types name them. On a phone `PlatformSecret`
 * is `Uint8Array` (`keys.native.ts`), so these are the same types; the web's type check, which also
 * reads this file, takes the web's `CryptoKey`, hence the one cast, here only.
 */
function platformStore(phone: RecordStore<Uint8Array>): RecordStore {
  return phone as unknown as RecordStore;
}

function platformKeys(phone: ClientKeys<Uint8Array>): ClientKeys<PlatformSecret> {
  return phone as unknown as ClientKeys<PlatformSecret>;
}

/** A link's record as the phone keeps it: the private half must be the phone's 32 bytes. */
function phoneRecord(record: StoredClient): StoredClient<Uint8Array> | undefined {
  const key: unknown = record.key.privateKey;
  return key instanceof Uint8Array && key.length === 32
    ? (record as unknown as StoredClient<Uint8Array>)
    : undefined;
}

function backupKeyOf(
  payload: { readonly key: string; readonly epoch: number } | undefined,
): HeldBackupKey | null {
  if (payload === undefined) return null;
  const key = fromBase64url(payload.key);
  return key?.length === 32 ? { epoch: payload.epoch, key } : null;
}

export function startPhoneClient(deps: PhoneDeps): PhoneClient {
  const records = phoneRecords(deps.items);
  const chosen = chosenRecordStore(records);
  const socket = hubSocketConnect(deps.makeSocket, deps.timers);
  const live = createLiveStore();
  const local = createStore<LocalState>()(() => ({ link: { kind: "idle" } }));
  const reach = createStore<ReachState>()(() => NO_REACH);
  const taps = new Set<(event: AppEvent) => void>();
  let current: { readonly identity: string; readonly reach: HubReach } | undefined;
  let keeper: BackupKeyKeeper | undefined;
  let asked:
    | { readonly secret: LinkSecret; readonly from: CodeSource; readonly request: LinkRequest }
    | undefined;

  /** Changes a hub's reach in its record, and in `current` when it is the chosen hub's. */
  async function updateReach(identity: string, change: (reach: HubReach) => HubReach) {
    const updated = await records.hub(identity).update((record) => ({
      ...record,
      reach: change(record.reach ?? emptyReach()),
    }));
    if (updated.ok && updated.value !== undefined && current?.identity === identity)
      remember(updated.value);
  }

  const reaching = {
    answered: (address: string, port: number) => {
      reach.setState({ localNetworkDenied: false });
      const hub = current;
      if (hub === undefined) return;
      if (hub.reach.lastAddress === address && hub.reach.appsPort === port) return;
      void updateReach(hub.identity, (was) => ({ ...was, lastAddress: address, appsPort: port }));
    },
    localNetworkDenied: () => {
      reach.setState({ localNetworkDenied: true });
    },
  };

  /** Remembers the chosen hub's record as the channel reads it, for the session's `Connect`. */
  const remembering: RecordStore<Uint8Array> = {
    read: async () => {
      const read = await chosen.read();
      if (read.ok) remember(read.value);
      return read;
    },
    write: (record) => chosen.write(record),
    update: async (change) => {
      const updated = await chosen.update(change);
      if (updated.ok) remember(updated.value);
      return updated;
    },
    clear: () => chosen.clear(),
  };
  function remember(record: StoredClient<Uint8Array> | undefined): void {
    current =
      record === undefined
        ? undefined
        : { identity: record.hub.identity, reach: record.reach ?? emptyReach() };
  }

  // ----- The relay -----

  const relays =
    deps.relay === undefined
      ? undefined
      : relayConnect(deps.relay.make, deps.timers, deps.relay.build, {
          // Each close says what it says: a later one that is not the relay's word clears it.
          closed: (code) => {
            reach.setState({ relayClosed: relayClosedOf(code) ?? null });
          },
        });

  /** The relay's `Connect` to a hub, or undefined when the phone has no away path to it. */
  function relayFor(
    identity: string | null | undefined,
    named: string | null | undefined,
  ): Connect | undefined {
    if (relays === undefined || deps.relay === undefined || identity === null) return undefined;
    if (identity === undefined) return undefined;
    const relayUrl = relayUrlFor(named, deps.relay.defaultUrl);
    if (relayUrl === undefined) return undefined;
    const made = relays({ relayUrl, identity });
    return made.ok ? made.value : undefined;
  }

  /** The chosen hub at home, in section 2's order. */
  const home = storedHubConnect(socket, deps.finder, () => current, reaching);
  /** The path the channel's last socket took, told as it opens. */
  let lastPath: PathInUse | undefined;
  const sessionConnect = homeThenRelay(
    home,
    () => relayFor(current?.identity, current?.reach.relayUrl),
    (path) => {
      lastPath = path;
    },
  );

  // ----- Coming home again -----

  const homeAgainMs = deps.relay?.homeAgainMs ?? HOME_AGAIN_MS;
  let cancelHomeAgain: (() => void) | undefined;
  let tryingHome = false;

  function stopHomeAgain(): void {
    cancelHomeAgain?.();
    cancelHomeAgain = undefined;
  }

  function homeAgainLater(): void {
    stopHomeAgain();
    cancelHomeAgain = deps.timers.after(homeAgainMs, () => {
      cancelHomeAgain = undefined;
      void tryHome();
    });
  }

  /** Tries home while the relay is live, then either moves to home or schedules another try. */
  async function tryHome(): Promise<void> {
    if (tryingHome || reach.getState().path !== "relay") return;
    tryingHome = true;
    stopHomeAgain();
    let answered: { address: string; port: number } | undefined;
    const homeProbe = storedHubConnect(socket, deps.finder, () => current, {
      localNetworkDenied: reaching.localNetworkDenied,
      answered: (address, port) => {
        answered = { address, port };
      },
    });
    await channel.moveTo(homeProbe, () => {
      lastPath = "home";
      if (answered !== undefined) reaching.answered(answered.address, answered.port);
    });
    tryingHome = false;
    if (reach.getState().path === "relay") homeAgainLater();
  }

  const tap = (event: AppEvent) => {
    for (const listener of taps) listener(event);
  };
  const store = storeListener(live, deps.timers, tap);
  const newEvents = new Set<(event: AppEventV2) => void>();
  const listener: ChannelListener = {
    status: (status) => {
      store.status(status);
      if (status.kind === "open") {
        const path = lastPath ?? null;
        reach.setState({ path, relayClosed: null });
        if (path === "relay") homeAgainLater();
        else stopHomeAgain();
      } else {
        if (reach.getState().path !== null) reach.setState({ path: null });
        stopHomeAgain();
      }
      if (status.kind === "open") {
        const hub = current;
        keeper =
          hub === undefined
            ? undefined
            : new BackupKeyKeeper(
                records.backupKeys,
                hub.identity,
                status.hello.proto,
                (op, body) => channel.forward(op, body),
              );
      } else keeper = undefined;
      if (status.kind === "removed") {
        // This phone was removed from the hub: its record, key and backup keys go.
        const hub = current;
        current = undefined;
        if (hub !== undefined) void records.remove(hub.identity);
      }
    },
    snapshot: (snapshot, hello) => {
      store.snapshot(snapshot, hello);
      if (hello.proto >= 2) learnAddresses(snapshot.hub);
      void keeper?.sessionStarted(snapshotEpoch(snapshot));
    },
    event: (event) => {
      store.event(event);
      void keeper?.event(event.ev);
    },
    newEvent: (event) => {
      for (const receive of newEvents) receive(event);
    },
  };

  /**
   * `hub.info`'s home addresses and port (version 2) replace the code's `a=` and `p=`, when it
   * names any; its relay replaces the code's `r=`, when it names one (RD 3).
   */
  function learnAddresses(info: unknown): void {
    const hub = current;
    const parsed = hubInfoV2.safeParse(info);
    if (hub === undefined || !parsed.success) return;
    const named = parsed.data.addresses.map((a) => a.toLowerCase()).filter(isReachableHomeHost);
    const addresses = named.length === 0 ? hub.reach.addresses : named;
    const appsPort = named.length === 0 ? hub.reach.appsPort : parsed.data.appsPort;
    const relayUrl = parsed.data.relay?.url ?? hub.reach.relayUrl;
    const same =
      addresses.join(",") === hub.reach.addresses.join(",") &&
      appsPort === hub.reach.appsPort &&
      relayUrl === hub.reach.relayUrl;
    if (same) return;
    void updateReach(hub.identity, (was) => ({ ...was, addresses, appsPort, relayUrl }));
  }

  const channel = new Channel({
    connect: sessionConnect,
    store: platformStore(remembering),
    timers: deps.timers,
    app: deps.app,
    listener,
    proto: deps.proto,
    keys: platformKeys(deps.keys),
  });

  const restart = () => {
    channel.stop();
    void channel.start();
  };

  /** Tries the code's addresses before browsing for the same hub, and uses the relay last. */
  async function* linkWays(secret: LinkSecret): AsyncGenerator<HubTarget | Connect> {
    const code = reachOf(secret);
    const identity = secret.kind === "secret" ? (secret.identity ?? null) : null;
    if (code !== undefined && code.addresses.length > 0) {
      yield { identity, addresses: code.addresses, port: code.port };
      // An explicit address for a typed code is the only address it tries.
      if (identity === null) return;
    }
    const found = await browseFor(deps.finder, identity, reaching);
    reach.setState({ browse: found.ok ? null : found.fault });
    if (found.ok) {
      for (const target of found.value) {
        const addresses =
          target.port === code?.port
            ? target.addresses.filter((address) => !code.addresses.includes(address))
            : target.addresses;
        if (addresses.length > 0) yield { ...target, addresses };
      }
    }
    const away = relayFor(identity, code?.relay);
    if (away !== undefined) yield away;
  }

  async function link(secret: LinkSecret, from: CodeSource, request: LinkRequest): Promise<void> {
    local.setState({ link: { kind: "linking", from } });
    // A phone always links as one, so the hub gives it the backup key (m2-design.md section 5).
    const asPhone: LinkRequest = { ...request, kind: "phone" };
    const code = reachOf(secret);
    let failure: LinkFailure = "unreachable";
    for await (const way of linkWays(secret)) {
      let answered: string | null = null;
      const target = typeof way === "function" ? code : way;
      const connect =
        typeof way === "function"
          ? way
          : targetsConnect(socket, [way], {
              answered: (address) => {
                answered = address;
                reach.setState({ localNetworkDenied: false });
              },
              localNetworkDenied: reaching.localNetworkDenied,
            });
      const linked = await linkClient(
        connect,
        secret,
        asPhone,
        deps.timers,
        deps.proto,
        platformKeys(deps.keys),
      );
      // A hub that does not hold the code closes before message 2, which costs no try: the next.
      if (!linked.ok && (linked.fault === "refused" || linked.fault === "unreachable")) {
        failure = linked.fault;
        continue;
      }
      if (!linked.ok && linked.fault === "needsName") {
        // Kept here, in memory only, until the name comes.
        asked = { secret, from, request };
        local.setState({ link: { kind: "askingName", from } });
        return;
      }
      if (!linked.ok) {
        local.setState({ link: { kind: "failed", from, failure: linked.fault } });
        return;
      }
      const record = phoneRecord(linked.value.record);
      if (record === undefined) {
        local.setState({ link: { kind: "failed", from, failure: "storage" } });
        return;
      }
      const kept: StoredClient<Uint8Array> = {
        ...record,
        reach: {
          addresses: target?.addresses ?? [],
          appsPort: target?.port ?? 0,
          lastAddress: answered,
          relayUrl: code?.relay ?? null,
          // Named by the person on this phone (M5); empty until then.
          homeName: "",
        },
      };
      const added = await records.add(kept, backupKeyOf(linked.value.result.backupKey), true);
      if (!added.ok) {
        local.setState({ link: { kind: "failed", from, failure: "storage" } });
        return;
      }
      local.setState({ link: { kind: "linked", from } });
      restart();
      return;
    }
    local.setState({ link: { kind: "failed", from, failure } });
  }

  const client: HubClient = {
    live,
    local,
    start: () => {
      void records.sweep().then(() => channel.start());
    },
    stop: () => {
      stopHomeAgain();
      channel.stop();
      reach.setState({ path: null });
    },
    request: <N extends AppOpName>(op: N, body: AppOpBody<N>): Promise<RequestOutcome<N>> =>
      channel.request(op, body),
    link,
    giveName: async (name) => {
      const waiting = asked;
      asked = undefined;
      if (waiting === undefined) return;
      await link(waiting.secret, waiting.from, { ...waiting.request, person: { name } });
    },
    unreadable: () => {
      local.setState({ link: { kind: "failed", from: "address", failure: "unreadable" } });
    },
    forget: async () => {
      await chosen.clear();
      restart();
    },
    onEvent: (listener) => {
      taps.add(listener);
      return () => {
        taps.delete(listener);
      };
    },
  };

  return {
    client,
    forward: (op, body) => channel.forward(op, body),
    onNewEvent: (receive) => {
      newEvents.add(receive);
      return () => {
        newEvents.delete(receive);
      };
    },
    records,
    vault: records.status,
    reach,
    keeper: () => keeper,
    resume: () => {
      const kind = live.getState().connection.kind;
      if (kind === "noStorage" || kind === "waiting") restart();
      else void tryHome();
    },
    restore: async (code, offered) => {
      const restoreHome = storedHubConnect(
        socket,
        deps.finder,
        () => ({
          identity: code.identity,
          reach: { ...emptyReach(), addresses: code.reach.addresses, appsPort: code.reach.port },
        }),
        {
          answered: () => {
            reach.setState({ localNetworkDenied: false });
          },
          localNetworkDenied: reaching.localNetworkDenied,
        },
      );
      const outcome = await restoreHub(code, {
        connect: homeThenRelay(restoreHome, () => relayFor(code.identity, code.reach.relay)),
        timers: deps.timers,
        app: deps.app,
        proto: deps.proto,
        held: (identity) => records.backupKeys.held(identity),
        ...(offered === undefined ? {} : { offered }),
      });
      if (!outcome.ok) return outcome;
      // The restored hub has the old identity and app key, and the file holds this phone's
      // client: the hub is reached at the code's addresses from now on.
      const identity = outcome.offer.identity;
      const listed = await records.list();
      if (listed.ok && listed.value.includes(identity)) {
        await records.hub(identity).update((record) => ({
          ...record,
          reach: {
            ...(record.reach ?? { relayUrl: null, homeName: "" }),
            addresses: code.reach.addresses,
            appsPort: code.reach.port,
            lastAddress: null,
          },
        }));
        await records.choose(identity);
        restart();
      }
      return outcome;
    },
  };
}

function emptyReach(): HubReach {
  return { addresses: [], appsPort: 0, lastAddress: null, relayUrl: null, homeName: "" };
}

// ----- Codes that arrive from outside -----

/** Where links opened in the app come from: expo-linking's on a phone, a stand-in in tests. */
export interface LinkSource {
  /** The link the app was started with, if any. */
  initial(): Promise<string | null>;
  /** Links opened while the app runs; returns the unsubscribe. */
  listen(opened: (url: string) => void): () => void;
}

/** The deep links that carry a code: link, restore and pairing (m3-design.md section 3). */
const CODE_LINKS = /^hsn:\/\/(?:link|restore|pair)\/1\?/iu;

/** Whether a link opened in the app carries a code (not, say, a route of the app's own). */
export function isCodeLink(url: string): boolean {
  return CODE_LINKS.test(url.trim());
}

/**
 * Codes arriving as links: the one the app was opened with is held until claimed, once; one that
 * arrives later goes to the listeners, or is held when there are none. Only the newest is held,
 * in memory; nothing else of a link is kept.
 */
export function arrivals(source: LinkSource): {
  readonly claim: () => ArrivedCode | undefined;
  readonly on: (listener: (code: ArrivedCode) => void) => () => void;
} {
  let held: ArrivedCode | undefined;
  const listeners = new Set<(code: ArrivedCode) => void>();
  const arrived = (url: string | null) => {
    if (url === null || !isCodeLink(url)) return;
    const code: ArrivedCode = { from: "deepLink", text: url.trim() };
    if (listeners.size === 0) held = code;
    else for (const listener of listeners) listener(code);
  };
  void source.initial().then(arrived, () => undefined);
  source.listen(arrived);
  return {
    claim: () => {
      const code = held;
      held = undefined;
      return code;
    },
    on: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

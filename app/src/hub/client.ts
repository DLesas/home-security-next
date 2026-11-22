/**
 * The hub client the screens use: requests through the session (this tab's, or the tab that holds
 * it), linking, and the live store. `start.web.ts` builds it for the web; tests build it on an
 * in-memory socket and record store.
 */
import {
  APP_PROTO_LATEST,
  type AppEvent,
  type AppEventV2,
  type LinkRequest,
} from "@hsn/protocol/app";
import { createStore, type StoreApi } from "zustand/vanilla";
import { Channel, type ChannelListener, type Requester } from "./channel";
import { type LinkFailure, linkBrowser, type LinkSecret, type ProtoRange } from "./handshake";
import type { RecordStore } from "../platform/client-key";
import {
  applyEvent,
  applySnapshot,
  applyStatus,
  createLiveStore,
  type LiveStore,
} from "../state/live";
import { type Bus, type Locks, Tabs } from "./tabs";
import type { Connect, Timers } from "./wire";

/** Where a code came from, which decides the name this browser is linked under. */
export type CodeSource = "console" | "linkAddress" | "typed" | "qr";

/** This tab's linking, as the screens show it (kept per tab, never shared). */
export type LinkView =
  | { readonly kind: "idle" }
  | { readonly kind: "linking"; readonly from: CodeSource }
  /** The hub asks for the new person's name (message 2's `askName`); the code waits in memory. */
  | { readonly kind: "askingName"; readonly from: CodeSource }
  | {
      readonly kind: "failed";
      readonly from: CodeSource | "address";
      readonly failure: LinkFailure | "storage" | "unreadable" | "badCode";
    }
  | { readonly kind: "linked"; readonly from: CodeSource };

export interface LocalState {
  readonly link: LinkView;
}

/** The version 2 requests and additional live events shared by the web and phone builds. */
export interface Version2Channel {
  readonly forward: Channel["forward"];
  /** Subscribes to events with no version 1 equivalent and returns the unsubscribe. */
  readonly onNewEvent: (listener: (event: AppEventV2) => void) => () => void;
}

export interface HubClient extends Requester {
  /** Present when this client speaks version 2. The live store shows whether it is connected. */
  readonly v2?: Version2Channel;
  readonly live: LiveStore;
  readonly local: StoreApi<LocalState>;
  start(): void;
  /** Closes this tab's session for good, as the page closing does. */
  stop(): void;
  /** Links this browser with a code; the session follows by itself. */
  link(secret: LinkSecret, from: CodeSource, request: LinkRequest): Promise<void>;
  /** The new person's name the hub asked for: the waiting code links with it. */
  giveName(name: string): Promise<void>;
  /** Shows a code from the address that could not be read. */
  unreadable(): void;
  /** After a removal: this browser's record is cleared, so it can be linked again. */
  forget(): Promise<void>;
  /**
   * Every event as it comes, in whichever tab holds the session, for what the store does not
   * keep: a file's chunks (`backup.export`). Returns the unsubscribe.
   */
  onEvent(listener: (event: AppEvent) => void): () => void;
}

export function storeListener(
  store: LiveStore,
  timers: Timers,
  tap: (event: AppEvent) => void = () => undefined,
  newEvent?: ChannelListener["newEvent"],
): ChannelListener {
  return {
    status: (status) => {
      store.setState(applyStatus(store.getState(), status), true);
    },
    snapshot: (snapshot, hello) => {
      store.setState(applySnapshot(store.getState(), snapshot, hello, timers.now()), true);
    },
    event: (event) => {
      store.setState(applyEvent(store.getState(), event, timers.now()), true);
      tap(event);
    },
    ...(newEvent === undefined ? {} : { newEvent }),
  };
}

export interface HubClientDeps {
  readonly connect: Connect;
  readonly records: RecordStore;
  readonly timers: Timers;
  readonly app: string;
  readonly proto?: ProtoRange;
  /** The browser's tabs; without them, this one holds the session (tests, a browser without locks). */
  readonly tabs?: { readonly id: string; readonly locks: Locks; readonly bus: Bus };
}

export function createHubClient(deps: HubClientDeps): HubClient {
  const live = createLiveStore();
  let asked:
    | { readonly secret: LinkSecret; readonly from: CodeSource; readonly request: LinkRequest }
    | undefined;
  const taps = new Set<(event: AppEvent) => void>();
  const newEvents = new Set<(event: AppEventV2) => void>();
  const tap = (event: AppEvent) => {
    for (const listener of taps) listener(event);
  };
  const local = createStore<LocalState>()(() => ({ link: { kind: "idle" } }));
  /** Tells this tab's subscribers about an additional version 2 event. */
  const tapNew = (event: AppEventV2) => {
    for (const receive of newEvents) receive(event);
  };
  const makeChannel = (listener: ChannelListener) =>
    new Channel({
      connect: deps.connect,
      store: deps.records,
      timers: deps.timers,
      app: deps.app,
      ...(deps.proto === undefined ? {} : { proto: deps.proto }),
      listener,
    });
  let requester: Requester &
    Pick<Channel, "forward"> & {
      linked(): void;
      start(): void;
      stop(): void;
    };
  if (deps.tabs === undefined) {
    const channel = makeChannel(storeListener(live, deps.timers, tap, tapNew));
    requester = {
      request: (op, body) => channel.request(op, body),
      forward: (op, body) => channel.forward(op, body),
      linked: () => {
        channel.stop();
        void channel.start();
      },
      start: () => {
        void channel.start();
      },
      stop: () => {
        channel.stop();
      },
    };
  } else {
    const tabs = new Tabs({
      ...deps.tabs,
      store: live,
      makeChannel,
      listener: (store, forward) =>
        storeListener(store, deps.timers, (event) => {
          tap(event);
          forward(event);
        }),
      onEvent: tap,
      onNewEvent: tapNew,
    });
    requester = tabs;
  }

  const v2: Version2Channel = {
    forward: (op, body) => requester.forward(op, body),
    onNewEvent: (receive) => {
      newEvents.add(receive);
      return () => {
        newEvents.delete(receive);
      };
    },
  };
  const client: HubClient = {
    live,
    local,
    ...(deps.proto?.[1] === APP_PROTO_LATEST ? { v2 } : {}),
    start: () => {
      requester.start();
    },
    stop: () => {
      requester.stop();
    },
    request: (op, body) => requester.request(op, body),
    link: async (secret, from, request) => {
      await link(secret, from, request);
    },
    giveName: async (name) => {
      const waiting = asked;
      asked = undefined;
      if (waiting === undefined) return;
      await link(waiting.secret, waiting.from, { ...waiting.request, person: { name } });
    },
    unreadable: () => {
      local.setState({ link: { kind: "failed", from: "address", failure: "unreadable" } });
    },
    onEvent: (listener) => {
      taps.add(listener);
      return () => {
        taps.delete(listener);
      };
    },
    forget: async () => {
      await deps.records.clear();
      requester.linked();
    },
  };
  return client;

  async function link(secret: LinkSecret, from: CodeSource, request: LinkRequest): Promise<void> {
    local.setState({ link: { kind: "linking", from } });
    const linked = await linkBrowser(deps.connect, secret, request, deps.timers, deps.proto);
    if (!linked.ok && linked.fault === "needsName") {
      // Kept here, never in a store: only this tab's closure holds the code until the name comes.
      asked = { secret, from, request };
      local.setState({ link: { kind: "askingName", from } });
      return;
    }
    if (!linked.ok) {
      local.setState({ link: { kind: "failed", from, failure: linked.fault } });
      return;
    }
    const written = await deps.records.write(linked.value);
    if (!written.ok) {
      local.setState({ link: { kind: "failed", from, failure: "storage" } });
      return;
    }
    local.setState({ link: { kind: "linked", from } });
    requester.linked();
  }
}

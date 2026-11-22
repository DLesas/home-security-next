/**
 * Several homes on one phone (m3-design.md section 6, "Several hubs"; AP8, D28): the homes this
 * phone is linked to, each with the name the person gives it on this phone, one of them chosen.
 * Platform-neutral, over the phone client's records and session, so every rule runs under
 * `bun test` (`test/homes.test.ts`, `test/homes-real-hub.test.ts`).
 *
 * - **Names** live on this phone only (the record's `reach.homeName`): no hub change, no
 *   operation. A home not yet named is given the first free of "Home", "Home 2", "Home 3"… in the
 *   order the homes were linked, and the name is written, so removing one never renames another.
 * - **One session**, the chosen home's. Choosing another closes it and opens the other's
 *   (`PhoneClient.choose`).
 * - **Removing a home from this phone**, in order: `push.unregister`, only when this phone holds
 *   a push registration for that hub (`pushRegistrationOf`: none exists yet); `client.remove`
 *   for this phone's own client there, nothing it linked with it; then the record, key and backup
 *   keys are deleted. Each step needs the home's session: a home not chosen is chosen for the
 *   removal, and the chosen one comes back after. A step that fails stops the removal, and the
 *   home stays on this phone as it was. After it, the home chosen before stays chosen; if it was
 *   the one removed, the first home left is chosen, or none.
 */
import { type AppOpBody, displayName } from "@hsn/protocol/app";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AnyOutcome, RequestFailure, RequestOutcome } from "../hub/channel";
import type { Timers } from "../hub/wire";
import type { Stored } from "../platform/client-key";
import type { Outcome } from "../platform/split";
import type { PhoneRecords } from "../platform/vault";
import type { LiveState } from "../state/live";

/** One home on this phone. */
export interface Home {
  readonly identity: string;
  /** Its name on this phone. */
  readonly name: string;
}

export interface HomesState {
  /** In the order they were linked. */
  readonly homes: readonly Home[];
  /** The home whose session is open, or being opened; null when none is. */
  readonly chosen: string | null;
  /** The home being removed, while it is. */
  readonly removing: string | null;
  /** A choice is being written to the vault. */
  readonly switching: boolean;
}

/** Why a home was not removed. It stays on this phone, as it was. */
export type RemoveFault =
  /** The home's session did not open in time, so nothing was sent. */
  | { readonly step: "reach" }
  /** The hub did not take `push.unregister`. */
  | { readonly step: "push"; readonly failure: Extract<AnyOutcome, { readonly ok: false }> }
  /** The hub did not take `client.remove`. */
  | { readonly step: "client"; readonly failure: RequestFailure }
  /** The phone's own store could not be read or written. */
  | { readonly step: "storage" };

/** A rename's fault: a name the hub would not take either, or the store. */
export type RenameFault = "badName" | "storage";

/** How long a removal waits for the home's session to open ‡. */
export const REMOVAL_REACH_MS = 15_000;

export interface HomesDeps {
  readonly records: Pick<PhoneRecords, "list" | "chosen" | "hub" | "remove">;
  /** The phone client's switch: closes the open session and opens the chosen hub's. */
  readonly choose: (identity: string | null) => Promise<Stored<undefined>>;
  /** The open session's state. */
  readonly live: StoreApi<LiveState>;
  /** A request on the open session. */
  readonly request: (
    op: "client.remove",
    body: AppOpBody<"client.remove">,
  ) => Promise<RequestOutcome<"client.remove">>;
  /** Version 2's `push.unregister` on the open session. */
  readonly unregister: () => Promise<AnyOutcome>;
  /** Whether this phone holds a push registration for the hub (`pushRegistrationOf`). */
  readonly pushRegistered: (identity: string) => Promise<boolean>;
  readonly timers: Timers;
  /** The n-th default name: "Home" for 1, "Home 2" for 2… */
  readonly defaultName: (n: number) => string;
}

export interface Homes {
  readonly store: StoreApi<HomesState>;
  /** Reads the list again, naming any home not yet named. */
  refresh(): Promise<void>;
  /** Opens this home's session in place of the chosen one's. */
  choose(identity: string): Promise<Stored<undefined>>;
  rename(identity: string, name: string): Promise<Outcome<undefined, RenameFault>>;
  remove(identity: string): Promise<Outcome<undefined, RemoveFault>>;
}

/**
 * Whether this phone holds a push registration for the hub: never yet, since push registration
 * (`push.register`, m3-design.md section 6) is later work, which gives this its answer.
 */
export const pushRegistrationOf: (identity: string) => Promise<boolean> = () =>
  Promise.resolve(false);

/** The first default name not taken: "Home", then "Home 2", "Home 3"… */
export function nextHomeName(taken: readonly string[], nameFor: (n: number) => string): string {
  for (let n = 1; n <= taken.length; n += 1) {
    const name = nameFor(n);
    if (!taken.includes(name)) return name;
  }
  return nameFor(taken.length + 1);
}

/** Whether a session the phone can send on is open (its snapshot taken). */
function sessionOpen(state: LiveState): boolean {
  return state.connection.kind === "open" && state.session !== null;
}

const ok = { ok: true as const, value: undefined };

/** Manages the phone’s list and sends removal only on the selected home’s session. */
export function phoneHomes(deps: HomesDeps): Homes {
  const store = createStore<HomesState>()(() => ({
    homes: [],
    chosen: null,
    removing: null,
    switching: false,
  }));
  let reads = 0;

  /** Reads the list once and persists default names in link order. */
  async function refresh(): Promise<void> {
    const read = ++reads;
    const [listed, chosen] = await Promise.all([deps.records.list(), deps.records.chosen()]);
    if (!listed.ok || !chosen.ok || read !== reads) return;
    const records = await Promise.all(
      listed.value.map(async (identity) => ({
        identity,
        record: await deps.records.hub(identity).read(),
      })),
    );
    if (read !== reads || records.some(({ record }) => !record.ok)) return;
    const taken = records.flatMap(({ record }) => {
      const name = record.ok ? record.value?.reach?.homeName : undefined;
      return name ? [name] : [];
    });
    const homes: Home[] = [];
    for (const { identity, record } of records) {
      if (!record.ok || record.value === undefined) continue;
      let name = record.value.reach?.homeName || nextHomeName(taken, deps.defaultName);
      if (record.value.reach?.homeName === "") {
        const named = await deps.records
          .hub(identity)
          .update((r) =>
            r.reach?.homeName === "" ? { ...r, reach: { ...r.reach, homeName: name } } : r,
          );
        if (!named.ok || read !== reads) return;
        if (named.value === undefined) continue;
        name = named.value.reach?.homeName || name;
      }
      homes.push({ identity, name });
      taken.push(name);
    }
    if (read === reads) store.setState({ homes, chosen: chosen.value });
  }

  /** Switches the client, then publishes the committed choice. */
  async function switchTo(identity: string | null): Promise<Stored<undefined>> {
    const chose = await deps.choose(identity);
    if (chose.ok) {
      reads += 1;
      store.setState({ chosen: identity });
    }
    return chose;
  }

  /**
   * Once the open session's snapshot is in: `open`; `removed` when the hub says this phone was
   * removed; `none` after `reachMs`, or when no session can open.
   */
  function sessionReady(): Promise<"open" | "removed" | "none"> {
    return new Promise((resolve) => {
      let settled = false;
      let stopTimer: () => void = () => undefined;
      /** Settles once and releases both listeners. */
      const settle = (answer: "open" | "removed" | "none") => {
        if (settled) return;
        settled = true;
        unsubscribe();
        stopTimer();
        resolve(answer);
      };
      /** Accepts a connection once it has a snapshot, or a definitive local failure. */
      const look = (state: LiveState) => {
        if (sessionOpen(state)) settle("open");
        else if (state.connection.kind === "removed") settle("removed");
        else if (state.connection.kind === "notLinked" || state.connection.kind === "noStorage")
          settle("none");
      };
      const unsubscribe = deps.live.subscribe(look);
      stopTimer = deps.timers.after(REMOVAL_REACH_MS, () => {
        settle("none");
      });
      look(deps.live.getState());
    });
  }

  /** The three steps, on the open session of `identity`. */
  async function steps(
    identity: string,
    session: "open" | "removed",
  ): Promise<Outcome<undefined, RemoveFault>> {
    // Already removed by the hub (from another device): only this phone's record is left.
    if (session === "open") {
      if (await deps.pushRegistered(identity)) {
        const unregistered = await deps.unregister();
        if (!unregistered.ok) return { ok: false, fault: { step: "push", failure: unregistered } };
      }
      const record = await deps.records.hub(identity).read();
      if (!record.ok || record.value === undefined)
        return { ok: false, fault: { step: "storage" } };
      const removed = await deps.request("client.remove", {
        client: record.value.hub.client,
        also: [],
      });
      // The hub's `session` event may come before its reply: removed either way.
      if (!removed.ok && !("local" in removed && removed.local === "removed"))
        return { ok: false, fault: { step: "client", failure: removed } };
    }
    const deleted = await deps.records.remove(identity);
    return deleted.ok ? ok : { ok: false, fault: { step: "storage" } };
  }

  /** Runs the ordered steps and restores the usable home selection. */
  async function remove(identity: string): Promise<Outcome<undefined, RemoveFault>> {
    const before = store.getState();
    if (before.removing !== null || before.switching)
      return { ok: false, fault: { step: "reach" } };
    if (!before.homes.some((h) => h.identity === identity)) return ok;
    store.setState({ removing: identity });
    const elsewhere = before.chosen !== identity;
    const done = await (async (): Promise<Outcome<undefined, RemoveFault>> => {
      if (elsewhere && !(await switchTo(identity)).ok)
        return { ok: false, fault: { step: "storage" } };
      const session = await sessionReady();
      if (session === "none") return { ok: false, fault: { step: "reach" } };
      return steps(identity, session);
    })();
    // Back to the home chosen before; if it was this one and it went, the first left. A chosen
    // home that was not removed stays chosen, its session as it was.
    const left = before.homes.filter((h) => h.identity !== identity);
    const remaining = await deps.records.chosen();
    const target = elsewhere ? before.chosen : (left[0]?.identity ?? null);
    const restored =
      elsewhere || done.ok || (remaining.ok && remaining.value === null)
        ? await switchTo(target)
        : ok;
    await refresh();
    store.setState({ removing: null });
    return done.ok && !restored.ok ? { ok: false, fault: { step: "storage" } } : done;
  }

  return {
    store,
    refresh,
    choose: async (identity) => {
      const now = store.getState();
      if (now.chosen === identity) return ok;
      if (now.removing !== null || now.switching) return { ok: false, fault: "unavailable" };
      store.setState({ switching: true });
      const result = await switchTo(identity);
      await refresh();
      store.setState({ switching: false });
      return result;
    },
    rename: async (identity, text) => {
      // As every name the household types (`setup.tsx`'s `cleanName`): what the hub would take.
      const name = text.trim().normalize("NFC");
      if (!displayName.safeParse(name).success) return { ok: false, fault: "badName" };
      // A record without its reach (none the phone writes) cannot hold a name.
      const updated = await deps.records
        .hub(identity)
        .update((record) =>
          record.reach === undefined
            ? record
            : { ...record, reach: { ...record.reach, homeName: name } },
        );
      if (!updated.ok || updated.value?.reach?.homeName !== name)
        return { ok: false, fault: "storage" };
      await refresh();
      return ok;
    },
    remove,
  };
}

/**
 * Keeps the list as the phone client changes it: read at once, and again whenever the session's
 * connection changes kind (a link chose a new home, the hub removed this phone, a switch).
 * Returns the unsubscribe.
 */
export function followHomes(homes: Homes, live: StoreApi<LiveState>): () => void {
  void homes.refresh();
  return live.subscribe((state, before) => {
    if (
      state.connection.kind !== before.connection.kind &&
      (state.connection.kind === "loading" || state.connection.kind === "removed")
    )
      void homes.refresh();
  });
}

/** Homes where the phone gives none (a preview, the stand-ins): none, and nothing to do. */
export const NO_HOMES: Homes = {
  store: createStore<HomesState>()(() => ({
    homes: [],
    chosen: null,
    removing: null,
    switching: false,
  })),
  refresh: () => Promise.resolve(),
  choose: () => Promise.resolve(ok),
  rename: () => Promise.resolve({ ok: false, fault: "storage" }),
  remove: () => Promise.resolve({ ok: false, fault: { step: "storage" } }),
};

/** Phone-owned registration for one linked client on each hub (M4 §5). */
import type { SnapshotObjectV2 } from "@hsn/protocol/app";
import { PUSH_H } from "@hsn/protocol/relay";
import type { Timers } from "./wire";
import type { PhoneRecords, PhoneRecordHooks } from "../platform/vault";
import type { Outcome } from "../platform/split";
import type {
  DeviceToken,
  PushKeyRecord,
  StoredPush,
  PushStorage,
  Registration,
  TokenSource,
} from "../platform/push-types";
import { toHex } from "./digest";
import { toBase64url } from "./files";

export const KEY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
type Target = SnapshotObjectV2["push"];
type PushOutcome<T = void> = Outcome<T, "storage" | "token" | "hub">;
const done = { ok: true, value: undefined } as const;

/** The session owns the sender so a home switch cannot send one home's key to another. */
export interface PushSession {
  readonly hub: string;
  readonly client: number;
  register(body: Registration): Promise<{ readonly ok: boolean }>;
}

/** Makes a fresh independent key and routing id using the phone's secure random generator. */
function makeKey(token: DeviceToken, client: number, madeMs: number): PushKeyRecord {
  const key = crypto.getRandomValues(new Uint8Array(PUSH_H.keyBytes));
  const keyId = crypto.getRandomValues(new Uint8Array(PUSH_H.keyIdBytes));
  return { body: { ...token, key: toBase64url(key), keyId: toHex(keyId) }, madeMs, client };
}

/** Compares the device address and provider, leaving key age independent of token refreshes. */
function sameToken(a: DeviceToken, b: DeviceToken) {
  return a.token === b.token && a.platform === b.platform && a.environment === b.environment;
}

/** Owns the per-hub queue so late registration replies cannot resurrect a removed key. */
export function pushRegistration(store: PushStorage, tokens: TokenSource, now = Date.now) {
  const queues = new Map<string, Promise<unknown>>();
  const generations = new Map<string, symbol>();
  const saving = new Map<string, StoredPush<void>>();

  /** Tracks disk writes separately: vault deletion must never wait on a session reserving its seq. */
  function track(hub: string, write: StoredPush<void>) {
    saving.set(hub, write);
    void write.then(() => {
      if (saving.get(hub) === write) saving.delete(hub);
    });
    return write;
  }

  /** Orders key changes without making one unreachable hub block another. */
  function ordered<T>(hub: string, work: () => Promise<PushOutcome<T>>): Promise<PushOutcome<T>> {
    const task = (queues.get(hub) ?? Promise.resolve(done)).then(work);
    queues.set(hub, task);
    void task.then(() => {
      if (queues.get(hub) === task) queues.delete(hub);
    });
    return task;
  }

  /** Reconciles a snapshot, new link, token callback or rotation deadline with the saved registration. */
  function reconcile(
    session: PushSession,
    target?: Target,
    replacement?: DeviceToken,
    rotate = true,
  ): Promise<PushOutcome<number | null>> {
    const hub = session.hub;
    const generation = generations.get(hub) ?? Symbol();
    generations.set(hub, generation);
    const removed = () => generations.get(hub) !== generation;
    return ordered<number | null>(hub, async () => {
      const read =
        replacement === undefined ? await tokens.read() : { ok: true as const, value: replacement };
      if (!read.ok)
        return read.fault === "notAvailable"
          ? { ok: true, value: null }
          : { ok: false, fault: "token" };
      const keys = await store.keys(session.hub);
      if (!keys.ok) return keys;
      if (removed()) return { ok: true, value: null };
      const { active, pending } = keys.value;
      const token = read.value;
      // A previously staged rotation alone cannot open an unselected home's session.
      if (
        !rotate &&
        active?.client === session.client &&
        sameToken(active.body, token) &&
        (!pending || sameToken(pending.body, token))
      )
        return { ok: true, value: active.madeMs + KEY_LIFETIME_MS };
      const candidate = pending ?? active;
      const time = now();
      const sameLink = candidate?.client === session.client;
      const fresh = sameLink && (!rotate || time < candidate.madeMs + KEY_LIFETIME_MS);
      if (
        fresh &&
        !pending &&
        sameToken(candidate.body, token) &&
        (target === undefined || (target?.registered && target.valid))
      )
        return { ok: true, value: candidate.madeMs + KEY_LIFETIME_MS };
      const next = fresh
        ? { ...candidate, body: { ...candidate.body, ...token } }
        : makeKey(token, session.client, time);
      const saved = await track(hub, store.writeKeys(hub, { active, pending: next }));
      if (!saved.ok) return saved;
      if (removed()) return { ok: true, value: null };
      if (!(await session.register(next.body)).ok) return { ok: false, fault: "hub" };
      if (removed()) return { ok: true, value: null };
      const confirmed = await track(hub, store.writeKeys(hub, { active: next, pending: null }));
      return confirmed.ok ? { ok: true, value: next.madeMs + KEY_LIFETIME_MS } : confirmed;
    });
  }

  return {
    reconcile,
    /** Deletes key material after the home is removed, including an interrupted registration. */
    remove: (hub: string) => {
      generations.delete(hub);
      // A reply already in flight can no longer confirm a key. Future links wait for erasure.
      const erase = track(
        hub,
        (saving.get(hub) ?? Promise.resolve(done)).then(() => store.remove(hub)),
      );
      queues.set(hub, erase);
      void erase.then(() => {
        if (queues.get(hub) === erase) queues.delete(hub);
      });
      return erase;
    },
    /** Recomputes from the full set, since an arming event can change only some sensors. */
    armed: (hub: string, sensors: Iterable<Pick<SnapshotObjectV2["sensors"][number], "arm">>) =>
      store.arm(
        hub,
        Array.from(sensors).some((s) => s.arm !== "disarmed"),
      ),
  };
}

/** Mirrors home names from typed records and joins notification-key erasure to vault removal. */
export function pushRecordHooks(
  records: () => PhoneRecords,
  push: ReturnType<typeof pushLifecycle>,
): PhoneRecordHooks {
  let mirrored: Record<string, string> | undefined;
  let serial = Promise.resolve();
  return {
    changed() {
      serial = serial.then(async () => {
        const homes = records();
        const hubs = await homes.list();
        if (!hubs.ok) return;
        const names: Record<string, string> = {};
        for (const hub of hubs.value) {
          const read = await homes.hub(hub).read();
          if (!read.ok || !read.value) return;
          names[hub] = read.value.reach?.homeName ?? "";
        }
        if (
          mirrored &&
          Object.keys(mirrored).length === hubs.value.length &&
          hubs.value.every((hub) => mirrored?.[hub] === names[hub])
        )
          return;
        if ((await push.homes(names)).ok) mirrored = names;
      });
      return serial;
    },
    async removing(identity) {
      const removed = await push.registration.remove(identity);
      return removed.ok ? removed : { ok: false, fault: "failed" };
    },
  };
}

/** Follows a live phone session, including OS token changes and a rotation while it stays open. */
export function pushLifecycle(store: PushStorage, tokens: TokenSource, timers: Timers) {
  const registration = pushRegistration(store, tokens, () => timers.now());
  let current: PushSession | undefined;
  let cancel: (() => void) | undefined;
  let revision = 0;

  /** Only the current session may install a new timer or use its hub channel. */
  async function update(
    session: PushSession,
    target?: Target,
    token?: DeviceToken,
  ): Promise<PushOutcome> {
    const version = ++revision;
    cancel?.();
    const result = await registration.reconcile(
      {
        ...session,
        register: (body) =>
          current === session ? session.register(body) : Promise.resolve({ ok: false }),
      },
      target,
      token,
    );
    if (!result.ok) {
      if (version === revision && current === session)
        cancel = timers.after(60_000, () => {
          void update(session, target);
        });
      return result;
    }
    if (result.value === null || version !== revision || current !== session) return done;
    // JS timer delays above 2^31-1 overflow. Wake once before that limit, then at the deadline.
    const delay = Math.min(0x7fffffff, Math.max(1, result.value - timers.now()));
    cancel = timers.after(delay, () => {
      void update(session);
    });
    return done;
  }
  let unselected: (() => Promise<readonly PushSession[]>) | undefined;
  let sweeps = Promise.resolve();
  let tokenRevision = 0;
  /** Reconciles the other homes serially, preserving their keys even beyond the rotation deadline. */
  function refreshOthers(token: DeviceToken) {
    const version = ++tokenRevision;
    const list = unselected;
    if (!list) return Promise.resolve();
    sweeps = sweeps.then(async () => {
      for (const home of await list()) {
        if (version !== tokenRevision) break;
        if (current?.hub !== home.hub) await registration.reconcile(home, undefined, token, false);
      }
    });
    return sweeps;
  }
  const off = tokens.listen((token) => {
    if (current) void update(current, undefined, token);
    void refreshOthers(token);
  });

  /** Invalidates an old session before a home switch, removal or disconnect. */
  function closed() {
    current = undefined;
    revision++;
    cancel?.();
  }
  /** Suspends both the selected session and any queued work when the phone client stops. */
  function pause() {
    closed();
    unselected = undefined;
    tokenRevision++;
  }
  return {
    registration,
    pause,
    /** On foreground app startup, retry pending targets and catch token changes while JS was asleep. */
    start: async (list: () => Promise<readonly PushSession[]>) => {
      unselected = list;
      const version = tokenRevision;
      const read = await tokens.read();
      if (read.ok && version === tokenRevision) await refreshOthers(read.value);
    },
    homes: (names: Readonly<Record<string, string>>) => store.homes(names),
    closed,
    /** Writes the snapshot's armed state even when the build has no token. */
    snapshot: async (
      session: PushSession,
      target: Target,
      sensors: SnapshotObjectV2["sensors"],
    ) => {
      current = session;
      const armed = await registration.armed(session.hub, sensors);
      return armed.ok && current === session ? update(session, target) : armed;
    },
    /** Called after the live store applies the incoming arming delta. */
    arming: (sensors: Iterable<Pick<SnapshotObjectV2["sensors"][number], "arm">>) =>
      current ? registration.armed(current.hub, sensors) : Promise.resolve(done),
    /** Releases the token subscription and the outstanding rotation timer. */
    stop() {
      pause();
      off();
    },
  };
}

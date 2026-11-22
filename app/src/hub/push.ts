/** Phone-owned registration for one linked client on each hub (M4 §5). */
import type { SnapshotObjectV2 } from "@hsn/protocol/app";
import { PUSH_H } from "@hsn/protocol/relay";
import { createStore } from "zustand/vanilla";
import type { Timers } from "./wire";
import { alertPermission } from "../platform/alert-permission";
import type { AlertPermission, AlertPermissionAnswer } from "../platform/alert-permission-types";
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
const noDeadline = { ok: true, value: null } as const;
const emptyKeys = { active: null, pending: null };

/** The session owns the sender so a home switch cannot send one home's key to another. */
export interface PushSession {
  readonly hub: string;
  readonly client: number;
  register(body: Registration): Promise<{ readonly ok: boolean }>;
  /** Reads or writes the choice for this home; undefined means the home was removed. */
  alertChoice?(enabled?: boolean): Promise<PushOutcome<boolean | undefined>>;
  /** Removes the target over the open session. */
  unregister?(): Promise<{ readonly ok: boolean }>;
}

interface RegistrationStatus {
  readonly enabled: boolean;
  readonly permission: AlertPermissionAnswer;
  readonly available: boolean;
  readonly stored: boolean;
}

export interface PhoneAlertStatus extends RegistrationStatus {
  readonly hub: string;
  readonly client: number;
  readonly target: Target;
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
export function pushRegistration(
  store: PushStorage,
  tokens: TokenSource,
  now = Date.now,
  permission?: AlertPermission,
) {
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

  /** Erases both key generations while preserving the armed state and home name. */
  async function clearKeys(hub: string, removed: () => boolean): Promise<PushOutcome> {
    const read = await store.keys(hub);
    if (!read.ok) return read;
    return !removed() && (read.value.active || read.value.pending)
      ? track(hub, store.writeKeys(hub, emptyKeys))
      : done;
  }

  /** Orders opt-out after any registration already sent and before later reconciliation. */
  function setEnabled(session: PushSession, enabled: boolean): Promise<PushOutcome> {
    const generation = generations.get(session.hub);
    const removed = () => generations.get(session.hub) !== generation;
    return ordered(session.hub, async () => {
      if (removed() || !session.alertChoice) return { ok: false, fault: "storage" };
      if (!enabled && !(await session.unregister?.())?.ok) return { ok: false, fault: "hub" };
      if (removed()) return { ok: false, fault: "storage" };
      const saved = await session.alertChoice(enabled);
      if (!saved.ok || saved.value === undefined) return { ok: false, fault: "storage" };
      return enabled ? done : clearKeys(session.hub, removed);
    });
  }

  /** Reconciles a snapshot, new link, token callback or rotation deadline with the saved registration. */
  function reconcile(
    session: PushSession,
    target?: Target,
    replacement?: DeviceToken,
    rotate = true,
    observe?: (status: RegistrationStatus) => void,
  ): Promise<PushOutcome<number | null>> {
    const hub = session.hub;
    const generation = generations.get(hub) ?? Symbol();
    generations.set(hub, generation);
    const removed = () => generations.get(hub) !== generation;
    return ordered<number | null>(hub, async () => {
      if (removed()) return noDeadline;
      const choice = await session.alertChoice?.();
      if (choice && !choice.ok) return choice;
      if (choice && choice.value === undefined) return noDeadline;
      const enabled = choice?.value ?? true;
      const answer = await permission?.read();
      const allowed = answer === undefined ? "granted" : answer.ok ? answer.value : "notAsked";
      if (removed()) return noDeadline;
      if (!enabled || allowed !== "granted") {
        observe?.({ enabled, permission: allowed, available: true, stored: false });
        if (enabled && answer && !answer.ok) return { ok: false, fault: "token" };
        const cleared = enabled ? done : await clearKeys(hub, removed);
        return cleared.ok ? noDeadline : cleared;
      }
      const read =
        replacement === undefined ? await tokens.read() : { ok: true as const, value: replacement };
      const available = read.ok || read.fault !== "notAvailable";
      if (!available) {
        observe?.({ enabled, permission: allowed, available, stored: false });
        return noDeadline;
      }
      const keys = await store.keys(session.hub);
      const active = keys.ok ? keys.value.active : null;
      const status = {
        enabled,
        permission: allowed,
        available,
        stored:
          active?.client === session.client && (!read.ok || sameToken(active.body, read.value)),
      };
      observe?.(status);
      if (!keys.ok) return keys;
      if (!read.ok) return { ok: false, fault: "token" };
      if (removed()) return noDeadline;
      const { pending } = keys.value;
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
      if (removed()) return noDeadline;
      if (!(await session.register(next.body)).ok) return { ok: false, fault: "hub" };
      if (removed()) return noDeadline;
      const confirmed = await track(hub, store.writeKeys(hub, { active: next, pending: null }));
      if (confirmed.ok) observe?.({ ...status, stored: true });
      return confirmed.ok ? { ok: true, value: next.madeMs + KEY_LIFETIME_MS } : confirmed;
    });
  }

  return {
    reconcile,
    setEnabled,
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
export function pushLifecycle(
  store: PushStorage,
  tokens: TokenSource,
  timers: Timers,
  permission = alertPermission,
) {
  const registration = pushRegistration(store, tokens, () => timers.now(), permission);
  const status = createStore<PhoneAlertStatus | null>(() => null);
  let current: PushSession | undefined;
  let hubTarget: Target;
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
        register: async (body) => {
          if (current !== session) return { ok: false };
          const result = await session.register(body);
          if (result.ok && current === session) hubTarget = { registered: true, valid: true };
          return result;
        },
      },
      target,
      token,
      true,
      (read) => {
        if (version === revision && current === session)
          status.setState(
            { ...read, hub: session.hub, client: session.client, target: hubTarget },
            true,
          );
      },
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
  let unlistenForeground: (() => void) | undefined;
  let asking: ReturnType<AlertPermission["ask"]> | undefined;
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

  /** Reads a sweep's token only when this phone has allowed notifications. */
  async function sweep() {
    const version = tokenRevision;
    if (permission) {
      const answer = await permission.read();
      if (!answer.ok || answer.value !== "granted") return;
    }
    const read = await tokens.read();
    if (read.ok && version === tokenRevision) await refreshOthers(read.value);
  }

  /** Rechecks permission and reconciles after returning from the prompt or settings. */
  function refresh() {
    if (asking) return;
    if (current) void update(current, hubTarget);
    void sweep();
  }

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
    unlistenForeground?.();
    unlistenForeground = undefined;
  }
  return {
    registration,
    alerts: {
      status,
      permission,
      /** Shares one in-progress prompt across presses and home changes. */
      ask: () => {
        if (!permission || asking) return;
        asking = permission.ask();
        void asking.then(() => {
          asking = undefined;
          refresh();
        });
      },
      /** Changes only the home shown by this screen, and reconciles immediately on success. */
      setEnabled: async (hub: string, client: number, enabled: boolean): Promise<PushOutcome> => {
        const session = current;
        if (session?.hub !== hub || session.client !== client) return { ok: false, fault: "hub" };
        const result = await registration.setEnabled(
          {
            ...session,
            unregister: async () => {
              if (current !== session || !session.unregister) return { ok: false };
              const response = await session.unregister();
              if (response.ok && current === session)
                hubTarget = { registered: false, valid: false };
              return response;
            },
          },
          enabled,
        );
        if (
          current?.hub === hub &&
          current.client === client &&
          (result.ok || result.fault === "storage")
        )
          void update(current, hubTarget);
        return result;
      },
    },
    pause,
    /** On foreground app startup, retry pending targets and catch token changes while JS was asleep. */
    start: async (list: () => Promise<readonly PushSession[]>) => {
      unselected = list;
      unlistenForeground ??= permission?.onForeground(refresh);
      await sweep();
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
      hubTarget = target;
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

export type PhoneAlerts = ReturnType<typeof pushLifecycle>["alerts"];

/** Supplies permission and the local switch on a phone build without a push receiver. */
export function unavailablePush(timers: Timers) {
  return pushLifecycle(
    {
      keys: () => Promise.resolve({ ok: true, value: emptyKeys }),
      writeKeys: () => Promise.resolve(done),
      arm: () => Promise.resolve(done),
      homes: () => Promise.resolve(done),
      remove: () => Promise.resolve(done),
    },
    {
      read: () => Promise.resolve({ ok: false, fault: "notAvailable" }),
      listen: () => () => undefined,
    },
    timers,
  );
}

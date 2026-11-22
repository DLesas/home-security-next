/** Phone-owned registration for one linked client on each hub (M4 §5). */
import type { SnapshotObjectV2 } from "@hsn/protocol/app";
import { PUSH_H } from "@hsn/protocol/relay";
import type { Timers } from "./wire";
import { HUBS_ITEM, phoneRecords, type SecureItems } from "../platform/vault";
import { decodeJson } from "./codec";
import { err, ok, type Result as Outcome } from "neverthrow";
import type {
  DeviceToken,
  PushKeyRecord,
  PushStorage,
  Registration,
  TokenSource,
} from "../platform/push-types";
import { toHex } from "./digest";
import { toBase64url } from "./files";

export const KEY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
type Target = SnapshotObjectV2["push"];
type Result<T = void> = Outcome<T, "storage" | "token" | "hub">;
const done = ok(undefined);

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

/** Owns the per-hub queue so late registration replies cannot resurrect a removed key. */
export function pushRegistration(store: PushStorage, tokens: TokenSource, now = Date.now) {
  const queues = new Map<string, Promise<unknown>>();

  /** Orders key changes without making one unreachable hub block another. */
  function ordered<T>(hub: string, work: () => Promise<Result<T>>): Promise<Result<T>> {
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
  ): Promise<Result<number | null>> {
    return ordered<number | null>(session.hub, async () => {
      const read = replacement === undefined ? await tokens.read() : ok(replacement);
      if (read.isErr()) return read.error === "notAvailable" ? ok(null) : err("token" as const);
      const keys = await store.keys(session.hub);
      if (keys.isErr()) return err(keys.error);
      const { active, pending } = keys.value;
      const candidate = pending ?? active;
      const time = now();
      const sameLink = candidate?.client === session.client;
      const fresh = sameLink && time < candidate.madeMs + KEY_LIFETIME_MS;
      const token = read.value;
      if (
        fresh &&
        !pending &&
        candidate.body.token === token.token &&
        candidate.body.platform === token.platform &&
        candidate.body.environment === token.environment &&
        (target === undefined || (target?.registered && target.valid))
      )
        return ok(candidate.madeMs + KEY_LIFETIME_MS);
      const next = fresh
        ? { ...candidate, body: { ...candidate.body, ...token } }
        : makeKey(token, session.client, time);
      const saved = await store.writeKeys(session.hub, { active, pending: next });
      if (saved.isErr()) return err(saved.error);
      if (!(await session.register(next.body)).ok) return err("hub" as const);
      const confirmed = await store.writeKeys(session.hub, { active: next, pending: null });
      return confirmed.map(() => next.madeMs + KEY_LIFETIME_MS);
    });
  }

  return {
    reconcile,
    /** Deletes key material after the home is removed, including an interrupted registration. */
    remove: (hub: string) => ordered(hub, () => store.remove(hub)),
    /** Recomputes from the full set, since an arming event can change only some sensors. */
    armed: (hub: string, sensors: Iterable<Pick<SnapshotObjectV2["sensors"][number], "arm">>) =>
      store.arm(
        hub,
        Array.from(sensors).some((s) => s.arm !== "disarmed"),
      ),
  };
}

/** Mirrors local home names and joins push-key erasure to the vault's retryable deletion. */
export function pushVault(items: SecureItems, push: ReturnType<typeof pushLifecycle>): SecureItems {
  const records = phoneRecords(items);
  let names: Readonly<Record<string, string>> = {};
  let serial = Promise.resolve();
  /** Reads the authoritative linked list after a link, rename or removal, including older installs. */
  function refresh(): Promise<void> {
    serial = serial.then(async () => {
      const hubs = await records.list();
      if (!hubs.ok) return;
      const next: Record<string, string> = {};
      for (const hub of hubs.value) {
        const record = await records.hub(hub).read();
        if (!record.ok || !record.value) return;
        next[hub] = record.value.reach?.homeName ?? "";
      }
      if ((await push.homes(next)).isOk()) names = next;
    });
    return serial;
  }
  void refresh();
  return {
    ...items,
    set: async (name, value) => {
      const written = await items.set(name, value);
      if (!written.ok) return written;
      if (name === HUBS_ITEM) await refresh();
      else if (name.endsWith(".record")) {
        const hub = name.split(".")[1];
        const record = decodeJson(new TextEncoder().encode(value))?.value as
          { reach?: { homeName?: string } } | undefined;
        if (hub && names[hub] !== (record?.reach?.homeName ?? "")) await refresh();
      }
      return written;
    },
    delete: async (name) => {
      const match = /^hub\.([a-z2-7]{26})\.key$/u.exec(name);
      if (match?.[1] !== undefined && (await push.registration.remove(match[1])).isErr())
        return { ok: false, fault: "failed" };
      return items.delete(name);
    },
  };
}

/** Follows a live phone session, including OS token changes and a rotation while it stays open. */
export function pushLifecycle(store: PushStorage, tokens: TokenSource, timers: Timers) {
  const registration = pushRegistration(store, tokens, timers.now);
  let current: PushSession | undefined;
  let cancel: (() => void) | undefined;
  let revision = 0;

  /** Only the current session may install a new timer or use its hub channel. */
  async function update(
    session: PushSession,
    target?: Target,
    token?: DeviceToken,
  ): Promise<Result> {
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
    if (result.isErr()) return err(result.error);
    if (result.value === null || version !== revision || current !== session) return done;
    // JS timer delays above 2^31-1 overflow. Wake once before that limit, then at the deadline.
    const delay = Math.min(0x7fffffff, Math.max(1, result.value - timers.now()));
    cancel = timers.after(delay, () => {
      void update(session);
    });
    return done;
  }
  const off = tokens.listen((token) => {
    if (current) void update(current, undefined, token);
  });

  /** Invalidates an old session before a home switch, removal or disconnect. */
  function closed() {
    current = undefined;
    revision++;
    cancel?.();
  }
  return {
    registration,
    homes: store.homes,
    closed,
    /** Writes the snapshot's armed state even when the build has no token. */
    snapshot: async (
      session: PushSession,
      target: Target,
      sensors: SnapshotObjectV2["sensors"],
    ) => {
      current = session;
      const armed = await registration.armed(session.hub, sensors);
      return armed.isOk() && current === session ? update(session, target) : armed;
    },
    /** Called after the live store applies the incoming arming delta. */
    arming: (sensors: Iterable<Pick<SnapshotObjectV2["sensors"][number], "arm">>) =>
      current ? registration.armed(current.hub, sensors) : Promise.resolve(done),
    /** Releases the token subscription and the outstanding rotation timer. */
    stop() {
      closed();
      off();
    },
  };
}

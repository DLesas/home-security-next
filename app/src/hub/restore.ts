/**
 * The backup key on a phone and restore from a phone (m3-design.md section 4; m2-design.md
 * sections 5 and 9). Platform-neutral TypeScript on the protocol package's Noise.
 *
 * **Keeping the key** (`BackupKeyKeeper`): at linking, `LinkResult`'s key is written with the
 * hub's record (`PhoneRecords.add`). Then, on `backupKeyChanged`, and at the start of a session
 * whose snapshot names an epoch the phone does not hold (`backupKeyEpoch`, version 2), the phone
 * asks `backup.key`, writes the key (`BackupKeys.keep`, up to 16 epochs), and only then confirms
 * with `backup.keyHeld {epoch}` (version 2). A key written but not confirmed (a kill between) is
 * confirmed at the next session. On a version 1 session (today's hub), `backup.key` alone, as
 * version 1 has it: the hub records the epoch when it answers.
 *
 * **Restore** (`restoreHub`): restore's six messages on `/app/restore`, at the code's addresses.
 * Message 2's static key must hash to the code's identity (the new hub's), or the phone stops
 * before message 3. `RestoreOffer` (message 4, the first that proves the hub knows the code's
 * key) names the old hub's identity and epoch; the phone sends `RestoreKey` only for a key it holds
 * for exactly that identity and epoch, and otherwise closes. The handshake's own static key is
 * made for the try and dropped: the new hub learns nothing that links it to this phone's keys.
 *
 * Nothing here logs; the key is never in a store, an event or an error.
 */
import {
  backupKeyPayload,
  linkHubPayload,
  linkPrologue,
  matchesIdentity,
  NOISE_PATTERNS,
  parseIdentity,
  restoreHello,
  type RestoreOffer,
  restoreOffer,
  restoreResult,
  startHandshake,
  x25519StaticKey,
} from "@hsn/protocol/app";
import type { AnyOutcome } from "./channel";
import { decodeJson, encodeJson } from "./codec";
import { lookupOfSecret, pskOfSecret } from "./digest";
import type { RestoreCode } from "./finder";
import { HANDSHAKE_WAIT_MS, type ProtoRange } from "./handshake";
import { isRelayOwnClose } from "./relay";
import type { Stored } from "../platform/client-key";
import type { HeldBackupKey } from "../platform/records";
import type { PhoneBackupKeys } from "../platform/vault";
import { CLOSE, type Connect, Inbox, type Timers, type Wire } from "./wire";

// ----- base64url, for the key on the wire -----

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function keyBytes(text: string): Uint8Array | undefined {
  const binary = (() => {
    try {
      return atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=");
    } catch {
      return undefined;
    }
  })();
  if (binary === undefined) return undefined;
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return bytes.length === 32 ? bytes : undefined;
}

// ----- Keeping the key -----

/** One request on the session open now (the channel's `forward`). */
export type SessionRequest = (
  op: "backup.key" | "backup.keyHeld",
  body: object,
) => Promise<AnyOutcome>;

/** How often a stale `backup.keyHeld` (the key replaced meanwhile) starts one more round. */
export const KEEP_ROUNDS = 3;

/** What the keeper did last, for tests and the pages: never the key. */
export type KeeperStep =
  | { readonly kind: "kept"; readonly epoch: number; readonly confirmed: boolean }
  | { readonly kind: "refused" | "notWritten" | "offline" };

/**
 * Keeps a hub's backup keys up to date over its sessions. One fetch at a time per keeper; asked
 * again meanwhile, it runs once more after.
 */
export class BackupKeyKeeper {
  private running: Promise<void> | undefined;
  private again = false;
  last: KeeperStep | undefined;

  constructor(
    private readonly keys: PhoneBackupKeys,
    private readonly identity: string,
    private readonly proto: number,
    private readonly request: SessionRequest,
  ) {}

  /**
   * At a session's start: the snapshot's `backupKeyEpoch` (version 2; null or absent otherwise).
   * An epoch not held is fetched; one held but not confirmed (a kill before `backup.keyHeld`) is
   * confirmed.
   */
  async sessionStarted(snapshotEpoch: number | null): Promise<void> {
    if (this.proto < 2 || snapshotEpoch === null) return;
    const held = await this.keys.held(this.identity);
    if (!held.ok) return;
    if (!held.value.some((k) => k.epoch === snapshotEpoch)) {
      await this.fetch();
      return;
    }
    const confirmed = await this.keys.confirmed(this.identity);
    if (confirmed.ok && confirmed.value !== snapshotEpoch) await this.confirm(snapshotEpoch);
  }

  /** An event on the session: `backupKeyChanged` fetches the new key at once. */
  async event(ev: string): Promise<void> {
    if (ev === "backupKeyChanged") await this.fetch();
  }

  /** Asks `backup.key`, writes the key, then confirms it: one round at a time. */
  fetch(): Promise<void> {
    if (this.running !== undefined) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let rounds = 0;
      do {
        this.again = false;
        rounds += 1;
        const stale = await this.round();
        if (stale) this.again = true;
      } while (this.again && rounds < KEEP_ROUNDS);
      this.running = undefined;
    })();
    return this.running;
  }

  /** One round; true when the hub's key moved on before the confirmation. */
  private async round(): Promise<boolean> {
    const asked = await this.request("backup.key", {});
    if (!asked.ok) {
      this.last = { kind: "error" in asked ? "refused" : "offline" };
      return false;
    }
    const reply = backupKeyPayload.safeParse(asked.body);
    const key = reply.success ? keyBytes(reply.data.key) : undefined;
    if (!reply.success || key === undefined) {
      this.last = { kind: "refused" };
      return false;
    }
    const held: HeldBackupKey = { epoch: reply.data.epoch, key };
    const kept = await this.keys.keep(this.identity, held);
    key.fill(0);
    // Confirmed only once written (section 4): a phone that cannot write it says nothing.
    if (!kept.ok) {
      this.last = { kind: "notWritten" };
      return false;
    }
    if (this.proto < 2) {
      // Version 1: the hub recorded the epoch when it answered.
      this.last = { kind: "kept", epoch: held.epoch, confirmed: true };
      return false;
    }
    return this.confirm(held.epoch);
  }

  /** `backup.keyHeld {epoch}`; true when the hub refused it as no longer current. */
  private async confirm(epoch: number): Promise<boolean> {
    const said = await this.request("backup.keyHeld", { epoch });
    if (said.ok) {
      const noted = await this.keys.confirm(this.identity, epoch);
      this.last = { kind: "kept", epoch, confirmed: noted.ok };
      return false;
    }
    this.last = { kind: "kept", epoch, confirmed: false };
    return "error" in said && said.error.code === "invalid";
  }
}

/** The snapshot's `backupKeyEpoch` (version 2), or null when it has none. */
export function snapshotEpoch(snapshot: unknown): number | null {
  if (typeof snapshot !== "object" || snapshot === null || !("backupKeyEpoch" in snapshot))
    return null;
  const epoch = (snapshot as { readonly backupKeyEpoch: unknown }).backupKeyEpoch;
  return typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0 ? epoch : null;
}

// ----- Restore -----

/** Why a restore did not happen, each said in words by the restore page (M2 9's words). */
export type RestoreFailure =
  /** No socket at the code's addresses nor through the relay, or the relay's own close before message 2. */
  | "unreachable"
  /** Closed before message 2: the code is used, expired or unknown, or no version is shared. */
  | "refused"
  /** Message 2's key is not the code's hub: stopped before message 3. */
  | "wrongHub"
  /** No message 4: the hub did not take message 3. */
  | "notAccepted"
  /** The phone holds no key for the offer's hub and epoch: closed, nothing sent. */
  | "noKey"
  /** The phone's keys could not be read. */
  | "storage"
  /** `RestoreResult`'s reasons. */
  | "wrongKey"
  | "badFile"
  | "expired"
  | "busy"
  | "protocol"
  | "timeout";

export type RestoreOutcome =
  | { readonly ok: true; readonly offer: RestoreOffer }
  | { readonly ok: false; readonly fault: RestoreFailure; readonly offer?: RestoreOffer };

export interface RestoreDeps {
  /** A socket at the code's addresses (`targetsConnect`). */
  readonly connect: Connect;
  readonly timers: Timers;
  /** The app's version, as `RestoreHello.app`. */
  readonly app: string;
  /** The channel versions offered: the phone's (version 2 only) when not given. */
  readonly proto?: ProtoRange;
  /** The backup keys this phone holds for a hub. */
  readonly held: (identity: string) => Promise<Stored<readonly HeldBackupKey[]>>;
  /** Told the offer once it has proved itself, before the key is sent ("Restoring … from …"). */
  readonly offered?: (offer: RestoreOffer) => void;
  /** The handshake's own static key, 32 random bytes; the system's random source when not given. */
  readonly staticKey?: () => Uint8Array;
}

/** The phone's channel versions: version 2 only (m3-design.md section 3). */
export const PHONE_PROTO: ProtoRange = [2, 2];

function randomKey(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** Runs a restore from a scanned `hsn://restore/1` code. */
export async function restoreHub(code: RestoreCode, deps: RestoreDeps): Promise<RestoreOutcome> {
  const proto = deps.proto ?? PHONE_PROTO;
  const expected = parseIdentity(code.identity);
  const own = (deps.staticKey ?? randomKey)();
  const key = x25519StaticKey(own);
  own.fill(0);
  if (expected === undefined || !key.ok) return { ok: false, fault: "protocol" };
  const started = startHandshake({
    pattern: NOISE_PATTERNS.link,
    initiator: true,
    prologue: linkPrologue("restore"),
    staticKey: key.value,
    psk: await pskOfSecret(code.secret),
  });
  if (!started.ok) return { ok: false, fault: "protocol" };
  const handshake = started.value;
  const first = await handshake.writeMessage(
    encodeJson({ proto, find: await lookupOfSecret(code.secret) }),
  );
  if (!first.ok) return { ok: false, fault: "protocol" };

  const inbox = new Inbox(deps.timers);
  const wire = await deps.connect("restore", {
    message: (data) => {
      inbox.push(data);
    },
    closed: (closedCode) => {
      inbox.close(closedCode);
    },
  });
  if (wire === undefined) return { ok: false, fault: "unreachable" };
  const stop = (
    fault: RestoreFailure,
    offer?: RestoreOffer,
    close: number = CLOSE.protocol,
  ): RestoreOutcome => {
    wire.close(close);
    return offer === undefined ? { ok: false, fault } : { ok: false, fault, offer };
  };
  wire.send(first.value);

  const second = await inbox.next(HANDSHAKE_WAIT_MS);
  if (second.kind === "closed")
    return { ok: false, fault: isRelayOwnClose(second.code) ? "unreachable" : "refused" };
  if (second.kind === "timeout") return stop("timeout");
  const read = await handshake.readMessage(second.data);
  if (!read.ok) return stop("protocol");
  const payload = linkHubPayload.safeParse(decodeJson(read.value)?.value);
  if (!payload.success || payload.data.askName) return stop("protocol");
  if (payload.data.proto < proto[0] || payload.data.proto > proto[1]) return stop("protocol");
  const hubStatic = handshake.remoteStatic();
  // The new hub's key against the code's identity, before anything more is sent (section 5).
  if (hubStatic === undefined || !matchesIdentity(hubStatic, expected)) return stop("wrongHub");

  const third = await handshake.writeMessage(encodeJson(restoreHello.parse({ app: deps.app })));
  if (!third.ok) return stop("protocol");
  wire.send(third.value);
  const transport = handshake.split();
  if (!transport.ok) return stop("protocol");

  const fourth = await inbox.next(HANDSHAKE_WAIT_MS);
  if (fourth.kind === "closed") return { ok: false, fault: "notAccepted" };
  if (fourth.kind === "timeout") return stop("timeout");
  const offerBytes = transport.value.decrypt(fourth.data);
  if (!offerBytes.ok) return stop("protocol");
  const offer = restoreOffer.safeParse(decodeJson(offerBytes.value)?.value);
  if (!offer.success) return stop("protocol");

  const held = await deps.held(offer.data.identity);
  if (!held.ok) return stop("storage", offer.data, CLOSE.normal);
  const match = held.value.find((k) => k.epoch === offer.data.epoch);
  // Only for exactly the identity and epoch the offer names; without it, nothing is sent.
  if (match === undefined) return stop("noKey", offer.data, CLOSE.normal);
  deps.offered?.(offer.data);

  const message = encodeJson({ key: toBase64url(match.key), epoch: match.epoch });
  const fifth = transport.value.encrypt(message);
  message.fill(0);
  if (!fifth.ok) return stop("protocol", offer.data);
  wire.send(fifth.value);

  const sixth = await inbox.next(HANDSHAKE_WAIT_MS);
  if (sixth.kind === "closed") return { ok: false, fault: "notAccepted", offer: offer.data };
  if (sixth.kind === "timeout") return stop("timeout", offer.data);
  const resultBytes = transport.value.decrypt(sixth.data);
  const result = resultBytes.ok
    ? restoreResult.safeParse(decodeJson(resultBytes.value)?.value)
    : undefined;
  if (result?.success !== true) return stop("protocol", offer.data);
  closeQuietly(wire);
  return result.data.ok
    ? { ok: true, offer: offer.data }
    : { ok: false, fault: result.data.reason, offer: offer.data };
}

/** The hub closes after message 6; the phone's own close is then a formality. */
function closeQuietly(wire: Wire): void {
  wire.close(CLOSE.normal);
}

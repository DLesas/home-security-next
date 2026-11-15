/**
 * The app channel's session layer (m2-design.md section 5): every connection of the two app
 * listeners, from its upgrade to its close. It runs the handshakes, admits sessions, keeps them
 * alive inside Noise, encrypts and sends what the core gives it in one order per session, and
 * turns what clients send into the core's events. It never decides what a request may do: that
 * is the core's.
 *
 * **Which handshake** is said by the path (section 11, "Step 1, wave 2"): `/app` for a session
 * (IK), `/app/link` and `/app/restore` for the two XXpsk3 handshakes, each with its own prologue.
 * The first message is read as that path's handshake and nothing else, so one sent to the wrong
 * path fails as that handshake fails.
 *
 * **A session (IK).** Message 1 names the client's static key, looked up in `ClientKeys`: an
 * unknown or removed key, a console client on the home network's listener, a malformed
 * `ClientHello`, or no version both speak gets no message 2 and the socket closes. Message 2 is
 * `HubHello`. The connection is a *handshake* until the client's first transport message
 * decrypts, and only then a *session* (`clientConnected`): a replayed message 1 never takes one.
 * Then a client's fifth session closes its oldest (`replaced`), and past 64 sessions the new one
 * is closed. `first`, the request in message 1, is given to the core right after
 * `clientConnected`, before the companion message's request, and only once the session is proven
 * (settled in section 11): a replayed message 1 with a `first` causes nothing in the core.
 *
 * **A link or a restore (XXpsk3).** `LinkHello.find` names a token in `LinkSecrets`; none, or one
 * of the other purpose, closes before message 2 and counts as no try. The token's key is set after
 * message 1 (`setPsk`). Message 3 proves the client knows it: a failure is `linkFailed` (`badPsk`,
 * or `malformed` when it decrypted but is not the purpose's payload). A link becomes
 * `linkCompleted`, answered by the core's `LinkResult` (a `handshake` `appSend`) or `closeConn`; a
 * restore becomes `restoreOpened`, then the core's `RestoreOffer`, the phone's `RestoreKey`
 * (`restoreKey`, accepted only after the offer went, and once), and the core's `RestoreResult`.
 * After `LinkResult` or `RestoreResult` the shell closes the connection itself.
 *
 * **Limits** (section 5), each checked before memory or an X25519 is spent on an unproven peer:
 * 16 open handshakes ‡, each closed if its proof has not come within 5 s ‡; 10 handshakes a second
 * from one address and 100 in all ‡, refused at the upgrade; 4 sessions per client ‡ and 64 in all
 * ‡; at most 65,535 bytes a message (the listener's own limit) and a few messages queued while a
 * handshake step runs. Liveness is inside Noise: a session quiet for 20 s ‡ is sent an encrypted
 * `ping`, and one with nothing authenticated from the client for 60 s ‡ is closed (`liveness`);
 * WebSocket pings count for nothing. A session is closed 24 hours ‡ after its admission, on the
 * monotonic clock, with close code 4000 and `clientClosed {reason: "lifetime"}`, nothing sent first.
 *
 * **Order.** Each session's transport messages are encrypted and sent in one call, in the order
 * they are given (`#deliver`), so the client's nonces always follow; messages from a client are
 * handled in arrival order. Any message that fails to decrypt closes the socket at once.
 *
 * **Requests.** A session's message must be one UTF-8 JSON request that the version's schemas
 * accept, with `seq` on a change and none on a read; otherwise it is refused before the core sees
 * it (`inputRejected`, with the issues' paths and codes, never the content) and, when it names an
 * `id`, answered `invalid {field, reason: "format"}`. `fileChunk` is the shell's (`uploads.ts`), on
 * the console listener only.
 *
 * **Refusals** of a handshake (an unknown or removed key, a console key on the home network, no
 * shared version, a timeout, a malformed message, a peer past the limits) go to the core as
 * `clientRefused`, at most one per address per minute (`refusals.ts`).
 *
 * Nothing secret is logged, put in an error, or sent before the peer has proved itself: link
 * secrets live in `LinkSecrets` and inside the handshake, the hub's static key in `staticKey`.
 */
import {
  APP_OPS,
  APP_PATHS,
  APP_PROTO_VERSION,
  type AppMessage,
  type AppOpBody,
  type AppOpReply,
  type AppReply,
  clientHello,
  type EphemeralKeyPair,
  type Handshake,
  HUB_FEATURES,
  linkHello,
  linkPrologue,
  linkRequest,
  linkResult,
  NOISE_LIMITS,
  NOISE_PATTERNS,
  parseRequest,
  requestFrame,
  restoreHello,
  restoreKey,
  restoreOffer,
  restoreResult,
  SESSION_LIMITS,
  sessionPrologue,
  startHandshake,
  type StaticKey,
  type TransportSession,
} from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import type { HubError } from "../../core/model/errors.ts";
import type { Effect } from "../../core/model/effects.ts";
import type {
  AppListener,
  AppRejection,
  ConnCloseReason,
  HubEvent,
} from "../../core/model/events.ts";
import { type ClientId, type ConnId, connId, type TokenId } from "../../core/model/ids.ts";
import { ClientKind } from "../../core/model/rows.ts";
import type { ClientKeys } from "../../ports/client-keys.ts";
import type { LinkSecrets, TokenPurpose } from "../../ports/link-secrets.ts";
import { parseJson } from "../safe/json.ts";
import type { CoreView } from "./facts.ts";
import { HandshakeRate } from "./rate.ts";
import {
  type ClientRefused,
  REFUSAL_LIMITS,
  type RefusalReason,
  RefusalReporter,
} from "./refusals.ts";
import type { UploadStore } from "./uploads.ts";

const ORIGIN = "shell/app/channel";

/** WebSocket close codes the channel uses (RFC 6455, section 7.4; 4000 to 4999 private). */
export const CLOSE = {
  normal: 1000,
  stopping: 1001,
  /** A text message (section 5: "Text messages close the socket"). */
  unsupportedData: 1003,
  /** Refused: an unknown key, no shared version, a limit, a malformed handshake. */
  policy: 1008,
  /** The 24-hour lifetime (section 5) ‡. */
  lifetime: 4000,
  /** Nothing authenticated for 60 s ‡. */
  liveness: 4001,
  /** A client's fifth session closed its oldest ‡. */
  replaced: 4002,
  /** The client was removed (`closeClient`). */
  removed: 4003,
  /** A message failed to decrypt. */
  decryptFailed: 4004,
} as const;

/** Section 5's limits, and the two the channel adds. */
export interface ChannelLimits {
  readonly maxOpenHandshakes: number;
  readonly handshakeTimeoutMs: number;
  readonly maxSessionsPerClient: number;
  readonly maxSessions: number;
  readonly pingAfterQuietMs: number;
  readonly livenessMs: number;
  readonly lifetimeMs: number;
  readonly handshakesPerSecondPerAddress: number;
  readonly handshakesPerSecond: number;
  /** Messages a connection may queue while one of its handshake steps runs ‡. */
  readonly maxQueued: number;
  /** A link or restore connection waiting on the core is closed after this ‡. */
  readonly coreWaitMs: number;
  /** Refusals are sent at most once per address in this window: a minute (`refusals.ts`). */
  readonly refusalWindowMs: number;
  /** Addresses with a refusal input of their own per window ‡; the rest as `"many"`. */
  readonly refusalAddresses: number;
}

export const CHANNEL_LIMITS: ChannelLimits = {
  maxOpenHandshakes: SESSION_LIMITS.maxOpenHandshakes,
  handshakeTimeoutMs: SESSION_LIMITS.handshakeTimeoutMs,
  maxSessionsPerClient: SESSION_LIMITS.maxSessionsPerClient,
  maxSessions: SESSION_LIMITS.maxSessions,
  pingAfterQuietMs: SESSION_LIMITS.pingAfterQuietMs,
  livenessMs: SESSION_LIMITS.livenessMs,
  lifetimeMs: SESSION_LIMITS.lifetimeMs,
  handshakesPerSecondPerAddress: SESSION_LIMITS.handshakesPerSecondPerAddress,
  handshakesPerSecond: SESSION_LIMITS.handshakesPerSecond,
  maxQueued: 4,
  coreWaitMs: SESSION_LIMITS.livenessMs,
  refusalWindowMs: REFUSAL_LIMITS.windowMs,
  refusalAddresses: REFUSAL_LIMITS.maxAddresses,
};

/** The channel versions this hub speaks: version 1 only. */
export const HUB_PROTO: readonly [number, number] = [APP_PROTO_VERSION, APP_PROTO_VERSION];

/** One WebSocket as the channel sees it: binary messages out, and a close. */
export interface ChannelSocket {
  /** Sends one binary message; an error when it was dropped or the socket is closed. */
  send(bytes: Uint8Array): { readonly ok: boolean };
  close(code: number, reason: string): void;
}

/** Timers, which tests replace (the 24-hour lifetime). */
export interface Timers {
  /** Runs `run` after `ms`; the function returned cancels it. */
  after(ms: number, run: () => void): () => void;
}

export const REAL_TIMERS: Timers = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** The `ConnId` counter, shared with the control socket's connections (section 6). */
export class ConnIds {
  #next = 1;

  next(): ConnId {
    return connId(this.#next++);
  }
}

export interface ChannelOptions {
  /** The hub's static key for apps; its private half never leaves it. */
  readonly staticKey: StaticKey;
  /** The hub's app identity's 16 bytes, for the session prologue. */
  readonly identity: Uint8Array;
  readonly hubVersion: string;
  readonly clientKeys: ClientKeys;
  readonly linkSecrets: LinkSecrets;
  readonly core: CoreView;
  /** Every event for the core, in the order the channel makes them. */
  readonly emit: (event: HubEvent) => void;
  readonly connIds: ConnIds;
  /** `hub.status`'s reply, from the writer and the size guard (`hubStatusRead`). */
  readonly hubStatus: () => AppOpReply<"hub.status">;
  readonly uploads?: UploadStore;
  readonly limits?: Partial<ChannelLimits>;
  /** Milliseconds on the monotonic clock. */
  readonly now?: () => number;
  readonly timers?: Timers;
  /** What the channel could not do and the core need not know, for standard error. */
  readonly report?: (error: HubError) => void;
  /** The hub's ephemeral keys, for the vector tests only. */
  readonly ephemeral?: () => EphemeralKeyPair;
  /**
   * A session closed while one of its downloads (an export) was part way: its job ends here and
   * its file is freed (section 6). The step 0 owner's wiring passes the export's stop.
   */
  readonly downloadEnded?: (conn: ConnId, job: number) => void;
  /**
   * Refused handshakes, for the core (`clientRefused`, section 5), at most one per address per
   * minute. Until the input is in `HubEvent` the step 0 owner wires it to nothing or to the loop.
   */
  readonly refused?: (input: ClientRefused) => void;
  /** Whether a static key belonged to a removed client: `removedKey` rather than `unknownKey`. */
  readonly wasRemoved?: (staticKey: Uint8Array) => boolean;
}

/** The handshake a path carries (section 11, "Step 1, wave 2"). */
export type HandshakeKind = "session" | "link" | "restore";

/** The WebSocket path of each handshake: the protocol's own (`APP_PATHS`). */
export const HANDSHAKE_PATHS: Readonly<Record<HandshakeKind, string>> = APP_PATHS;

/** The handshake a request path names, or undefined: not the channel's. */
export function handshakeOfPath(path: string): HandshakeKind | undefined {
  for (const kind of ["session", "link", "restore"] as const)
    if (HANDSHAKE_PATHS[kind] === path) return kind;
  return undefined;
}

/** A refused upgrade: the HTTP status the listener answers with. */
export interface Refusal {
  readonly refused: true;
  readonly status: 503;
}

/** A slot taken for a connection about to open, before any memory is spent on it. */
export interface Ticket {
  readonly refused: false;
  readonly address: string;
  readonly handshake: HandshakeKind;
  used: boolean;
}

type Phase =
  | { readonly kind: "hello" }
  | {
      readonly kind: "proving";
      readonly transport: TransportSession;
      readonly client: ClientId;
      readonly remoteStatic: Uint8Array;
      readonly proto: number;
      readonly app: string;
      readonly first: AppRequestOf | undefined;
    }
  | {
      readonly kind: "session";
      readonly transport: TransportSession;
      readonly client: ClientId;
      readonly admittedAt: number;
    }
  | {
      readonly kind: "linkMessage3";
      readonly handshake: Handshake;
      readonly token: TokenId;
      readonly purpose: TokenPurpose;
    }
  | { readonly kind: "linked"; readonly transport: TransportSession; readonly token: TokenId }
  | {
      readonly kind: "restoring";
      readonly transport: TransportSession;
      readonly token: TokenId;
      offered: boolean;
      keyGiven: boolean;
    }
  | { readonly kind: "closed" };

type ClientRequestEvent = Extract<HubEvent, { readonly kind: "clientRequest" }>;
type AppRequestOf = ClientRequestEvent["request"];

interface Conn {
  readonly id: ConnId;
  readonly socket: ChannelSocket;
  readonly listener: AppListener;
  readonly address: string;
  readonly handshake: HandshakeKind;
  phase: Phase;
  /** The core was told of this connection, so it is told when it closes. */
  told: boolean;
  /** Messages in hand or waiting, in arrival order. */
  queue: Promise<void>;
  pending: number;
  /** The handshake's (or the wait for the core's) timer. */
  stopWaiting: (() => void) | undefined;
  stopPing: (() => void) | undefined;
  stopLiveness: (() => void) | undefined;
  stopLifetime: (() => void) | undefined;
  /** Downloads under way on this session: begun, not yet ended by their end mark or `fileFailed`. */
  readonly downloads: Set<number>;
  /** The last live revision this session was sent (`HubHello`'s, then each event's): `ping` carries it. */
  lastRev: number;
}

const encoder = new TextEncoder();

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

/** UTF-8 text, or undefined when the bytes are not UTF-8. */
function utf8(bytes: Uint8Array): string | undefined {
  const text = Buffer.from(bytes).toString("utf8");
  return Buffer.from(text, "utf8").equals(Buffer.from(bytes)) ? text : undefined;
}

/** A handshake payload checked against its schema: undefined when it is not one. */
function payload<T extends z.ZodType>(schema: T, bytes: Uint8Array): z.infer<T> | undefined {
  const text = utf8(bytes);
  if (text === undefined) return undefined;
  const parsed = parseJson(text, "codec", ORIGIN);
  if (parsed.isErr()) return undefined;
  const checked = schema.safeParse(parsed.value);
  return checked.success ? checked.data : undefined;
}

/** The highest version both speak, or undefined (section 5, "Versions"). */
export function agreedVersion(range: readonly [number, number]): number | undefined {
  const high = Math.min(range[1], HUB_PROTO[1]);
  return high >= Math.max(range[0], HUB_PROTO[0]) ? high : undefined;
}

const KIND_NAMES = {
  [ClientKind.Console]: "console",
  [ClientKind.Web]: "web",
  [ClientKind.Phone]: "phone",
} as const;

/** An event the session is sent: it carries a live revision. */
function isEvent(value: unknown): value is { readonly t: "evt"; readonly rev: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly t?: unknown }).t === "evt" &&
    typeof (value as { readonly rev?: unknown }).rev === "number"
  );
}

/** What the shell refuses of a request, and how it answers (section 2). */
interface Refused {
  readonly reason: AppRejection;
  readonly id: number | undefined;
  readonly field: string;
  readonly issues: readonly string[];
}

function issuePaths(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[],
  prefix: string,
): readonly string[] {
  return issues.map(
    (i) => `${[prefix, ...i.path.map(String)].filter((p) => p !== "").join(".")}: ${i.code}`,
  );
}

/** Checks a request the way `parseRequest` does, saying which rule failed and where, without values. */
function refusalOf(value: unknown): Refused | undefined {
  const frame = requestFrame.safeParse(value);
  if (!frame.success) {
    const id =
      typeof value === "object" && value !== null && "id" in value
        ? (value as { readonly id: unknown }).id
        : undefined;
    const goodId =
      typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= 2 ** 32 - 1
        ? id
        : undefined;
    return {
      reason: "badShape",
      id: goodId,
      field: "",
      issues: issuePaths(frame.error.issues, ""),
    };
  }
  const { id, seq, op, body } = frame.data;
  if (!Object.hasOwn(APP_OPS, op))
    return { reason: "badShape", id, field: "op", issues: ["op: unknown"] };
  const rule = APP_OPS[op as keyof typeof APP_OPS];
  const checked = rule.body.safeParse(body);
  if (!checked.success) {
    const issues = issuePaths(checked.error.issues, "body");
    const first = checked.error.issues[0]?.path.map(String).join(".") ?? "";
    return { reason: "badShape", id, field: first, issues };
  }
  if (rule.change !== (seq !== undefined))
    return { reason: "seqRule", id, field: "seq", issues: ["seq: rule"] };
  return undefined;
}

export class AppChannel {
  readonly #options: ChannelOptions;
  readonly #limits: ChannelLimits;
  readonly #now: () => number;
  readonly #timers: Timers;
  readonly #rate: HandshakeRate;
  readonly #refusals: RefusalReporter;
  readonly #conns = new Map<ConnId, Conn>();
  #reserved = 0;
  #stopped = false;

  constructor(options: ChannelOptions) {
    this.#options = options;
    this.#limits = { ...CHANNEL_LIMITS, ...options.limits };
    this.#now = options.now ?? (() => performance.now());
    this.#timers = options.timers ?? REAL_TIMERS;
    this.#rate = new HandshakeRate({
      perAddress: this.#limits.handshakesPerSecondPerAddress,
      overall: this.#limits.handshakesPerSecond,
      windowMs: 1000,
    });
    const refused = options.refused;
    this.#refusals = new RefusalReporter(
      (input) => {
        refused?.(input);
      },
      (ms, run) => this.#timers.after(ms, run),
      { windowMs: this.#limits.refusalWindowMs, maxAddresses: this.#limits.refusalAddresses },
    );
  }

  // ----- Counts -----

  /** Connections that are not sessions, and slots taken for ones about to open. */
  get handshakes(): number {
    let n = this.#reserved;
    for (const conn of this.#conns.values()) if (conn.phase.kind !== "session") n++;
    return n;
  }

  get sessions(): number {
    let n = 0;
    for (const conn of this.#conns.values()) if (conn.phase.kind === "session") n++;
    return n;
  }

  /** The open sessions of a client, oldest first. */
  sessionsOf(client: ClientId): readonly ConnId[] {
    return [...this.#conns.values()]
      .flatMap((c) =>
        c.phase.kind === "session" && c.phase.client === client
          ? [{ id: c.id, at: c.phase.admittedAt }]
          : [],
      )
      .toSorted((a, b) => a.at - b.at)
      .map((s) => s.id);
  }

  // ----- Opening -----

  /**
   * Whether a WebSocket upgrade from `address` may go ahead (section 5, "Limits on work"):
   * refused when 16 handshakes are open, when 64 sessions are, or past the rates. Checked before
   * the upgrade, so a refused peer costs no socket, no Noise state and no X25519.
   */
  admit(address: string, handshake: HandshakeKind = "session"): Ticket | Refusal {
    const refused = { refused: true, status: 503 } as const;
    if (this.#stopped) return refused;
    if (
      this.handshakes >= this.#limits.maxOpenHandshakes ||
      this.sessions >= this.#limits.maxSessions ||
      !this.#rate.admit(address, this.#now())
    ) {
      this.#refusals.refused(address, "rateLimited");
      return refused;
    }
    this.#reserved++;
    return { refused: false, address, handshake, used: false };
  }

  /** A ticket whose upgrade did not happen gives its slot back. */
  cancel(ticket: Ticket): void {
    if (ticket.used) return;
    ticket.used = true;
    this.#reserved--;
  }

  /** The upgraded socket: a handshake, closed if it is not proven within 5 s ‡. */
  open(ticket: Ticket, socket: ChannelSocket, listener: AppListener): ConnId {
    if (!ticket.used) {
      ticket.used = true;
      this.#reserved--;
    }
    const conn: Conn = {
      id: this.#options.connIds.next(),
      socket,
      listener,
      address: ticket.address,
      handshake: ticket.handshake,
      phase: { kind: "hello" },
      told: false,
      queue: Promise.resolve(),
      pending: 0,
      stopWaiting: undefined,
      stopPing: undefined,
      stopLiveness: undefined,
      stopLifetime: undefined,
      downloads: new Set(),
      lastRev: 0,
    };
    this.#conns.set(conn.id, conn);
    if (this.#stopped) {
      this.#close(conn, CLOSE.stopping, undefined);
      return conn.id;
    }
    conn.stopWaiting = this.#timers.after(this.#limits.handshakeTimeoutMs, () => {
      this.#refuse(conn, "timeout");
    });
    return conn.id;
  }

  // ----- From the socket -----

  /** A binary message: one Noise message, handled in arrival order. */
  receive(id: ConnId, bytes: Uint8Array): void {
    const conn = this.#conns.get(id);
    if (conn === undefined || conn.phase.kind === "closed") return;
    if (bytes.length > NOISE_LIMITS.maxMessageBytes) {
      this.#close(conn, CLOSE.policy, "badFrame");
      return;
    }
    if (conn.pending === 0 && this.#synchronous(conn.phase)) {
      this.#handleNow(conn, bytes);
      return;
    }
    if (conn.pending >= this.#limits.maxQueued) {
      this.#close(conn, CLOSE.policy, "badFrame");
      return;
    }
    conn.pending++;
    conn.queue = conn.queue
      .then(() => this.#handle(conn, bytes))
      .then(() => {
        conn.pending--;
      });
  }

  /** A text message closes the socket (section 5, "Framing"). */
  text(id: ConnId): void {
    const conn = this.#conns.get(id);
    if (conn !== undefined) this.#close(conn, CLOSE.unsupportedData, "badFrame");
  }

  /** The socket closed: the client went, or the network dropped it. */
  closed(id: ConnId): void {
    const conn = this.#conns.get(id);
    if (conn !== undefined) this.#gone(conn, "remote");
  }

  // ----- The core's effects -----

  /** `appSend`, `closeClient`, `closeConn`, `linkSecret` and `hubStatusRead`; others are not the channel's. */
  perform(effect: Effect): void {
    switch (effect.kind) {
      case "appSend":
        this.#appSend(effect.conn, effect.message);
        return;
      case "closeClient":
        for (const conn of [...this.#conns.values()]) {
          const client =
            conn.phase.kind === "session" || conn.phase.kind === "proving"
              ? conn.phase.client
              : undefined;
          if (client === effect.client) this.#close(conn, CLOSE.removed, "removed");
        }
        return;
      case "closeConn": {
        const conn = this.#conns.get(effect.conn);
        if (
          conn !== undefined &&
          (conn.phase.kind === "linked" || conn.phase.kind === "restoring")
        ) {
          this.#close(conn, CLOSE.policy, undefined);
        }
        return;
      }
      case "linkSecret":
        this.#options.linkSecrets.apply(
          effect.token,
          effect.purpose,
          effect.askName,
          effect.lookup ?? "",
          effect.psk,
        );
        return;
      case "hubStatusRead": {
        const conn = this.#conns.get(effect.conn);
        if (conn?.phase.kind === "session") {
          this.#deliver(conn, {
            t: "res",
            id: effect.id,
            ok: true,
            body: this.#options.hubStatus(),
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /** The hub is stopping: every connection closes, and the core is told of its sessions. */
  stop(): void {
    this.#stopped = true;
    // A download under way ends with `fileFailed {stopping}` before its session closes, and its
    // job ends (section 6).
    for (const conn of this.#conns.values()) {
      for (const job of [...conn.downloads]) {
        this.download(conn.id, { fileFailed: { job, reason: "stopping" } }).match(
          () => undefined,
          () => undefined,
        );
        this.#options.downloadEnded?.(conn.id, job);
      }
    }
    for (const conn of [...this.#conns.values()]) this.#close(conn, CLOSE.stopping, "stopping");
    this.#refusals.flush();
  }

  /**
   * One line of a download on a session (section 6, the wave 2 ruling): after the reply `{job}`,
   * which went before it as an `appSend` through this same queue, the chunks in order of `n`, then
   * the end mark (the chunk with `end`) or `fileFailed`. Each leaves through `#deliver`, the one
   * queue that encrypts and sends, so nothing is reordered. Other events may come between two
   * chunks; the client tells them apart by `ev` (only `fileChunk` and `fileFailed` belong to a
   * download), by `job`, and by `n`, which must follow on from the last. An error when the session
   * is gone: the job stops there, and its file is freed by `downloadEnded`.
   */
  download(
    id: ConnId,
    line:
      | { readonly fileChunk: AppOpBody<"fileChunk"> }
      | { readonly fileFailed: { readonly job: number; readonly reason: "io" | "stopping" } },
  ): Result<void, string> {
    const conn = this.#conns.get(id);
    if (conn?.phase.kind !== "session") return err("the session is gone");
    const rev = this.#options.core.rev();
    const job = "fileChunk" in line ? line.fileChunk.job : line.fileFailed.job;
    const ends = "fileFailed" in line || line.fileChunk.end !== undefined;
    if (ends) conn.downloads.delete(job);
    else conn.downloads.add(job);
    const sent =
      "fileChunk" in line
        ? this.#deliver(conn, { t: "evt", rev, ev: "fileChunk", body: line.fileChunk })
        : this.#deliver(conn, { t: "evt", rev, ev: "fileFailed", body: line.fileFailed });
    return sent ? ok(undefined) : err("the session is gone");
  }

  // ----- Handling, in arrival order -----

  #synchronous(phase: Phase): boolean {
    return phase.kind !== "hello" && phase.kind !== "linkMessage3";
  }

  async #handle(conn: Conn, bytes: Uint8Array): Promise<void> {
    const phase = conn.phase;
    if (phase.kind === "hello") await this.#hello(conn, bytes);
    else if (phase.kind === "linkMessage3") await this.#message3(conn, phase, bytes);
    else this.#handleNow(conn, bytes);
  }

  #handleNow(conn: Conn, bytes: Uint8Array): void {
    const phase = conn.phase;
    switch (phase.kind) {
      case "proving":
        this.#prove(conn, phase, bytes);
        return;
      case "session":
        this.#sessionMessage(conn, phase, bytes);
        return;
      case "restoring":
        this.#restoreMessage(conn, phase, bytes);
        return;
      case "linked":
        // A linking client sends nothing after message 3.
        this.#close(conn, CLOSE.policy, "badFrame");
        return;
      case "hello":
      case "linkMessage3":
      case "closed":
        return;
    }
  }

  #start(pattern: "session" | "link", prologue: Uint8Array): Handshake | undefined {
    const ephemeral = this.#options.ephemeral?.();
    const started = startHandshake({
      pattern: pattern === "session" ? NOISE_PATTERNS.session : NOISE_PATTERNS.link,
      initiator: false,
      prologue,
      staticKey: this.#options.staticKey,
      ...(ephemeral === undefined ? {} : { ephemeral }),
    });
    return started.ok ? started.value : undefined;
  }

  /** Message 1, read as the handshake its path names and nothing else. */
  async #hello(conn: Conn, message: Uint8Array): Promise<void> {
    const kind = conn.handshake;
    const handshake =
      kind === "session"
        ? this.#start("session", sessionPrologue(this.#options.identity))
        : this.#start("link", linkPrologue(kind));
    if (handshake === undefined) {
      this.#refuse(conn, "malformed");
      return;
    }
    const read = await handshake.readMessage(message);
    if (conn.phase.kind !== "hello") return;
    if (!read.ok) {
      this.#refuse(conn, "malformed");
      return;
    }
    if (kind === "session") await this.#sessionHello(conn, handshake, read.value);
    else await this.#linkHello(conn, handshake, kind, read.value);
  }

  async #sessionHello(conn: Conn, handshake: Handshake, body: Uint8Array): Promise<void> {
    const refuse = (reason: RefusalReason = "malformed"): void => {
      this.#refuse(conn, reason);
    };
    const remoteStatic = handshake.remoteStatic();
    const known =
      remoteStatic === undefined ? undefined : this.#options.clientKeys.lookup(remoteStatic);
    if (remoteStatic === undefined || known === undefined) {
      refuse(
        remoteStatic !== undefined && this.#options.wasRemoved?.(remoteStatic) === true
          ? "removedKey"
          : "unknownKey",
      );
      return;
    }
    if (known.kind === ClientKind.Console && conn.listener !== "console") {
      refuse("consoleOnLan");
      return;
    }
    const hello = payload(clientHello, body);
    if (hello === undefined) {
      refuse();
      return;
    }
    const proto = agreedVersion(hello.proto);
    if (proto === undefined) {
      refuse("noVersion");
      return;
    }
    let first: AppRequestOf | undefined;
    if (hello.first !== undefined) {
      // `first` may be replayed, so it must carry `seq` (section 5): a change, never a chunk.
      const parsed = parseRequest(hello.first);
      if (!parsed.ok || parsed.value.seq === undefined || parsed.value.op.op === "fileChunk") {
        refuse();
        return;
      }
      first = parsed.value;
    }
    const facts = this.#options.core.hello(known.client);
    if (facts === undefined) {
      refuse("unknownKey");
      return;
    }
    const written = await handshake.writeMessage(
      json({
        proto,
        hub: this.#options.hubVersion,
        boot: facts.boot,
        rev: facts.rev,
        client: { id: known.client, person: facts.person, kind: KIND_NAMES[known.kind] },
        features: HUB_FEATURES,
      }),
    );
    if (conn.phase.kind !== "hello") return;
    if (!written.ok) {
      refuse();
      return;
    }
    const split = handshake.split();
    if (!split.ok) {
      refuse();
      return;
    }
    if (!this.#raw(conn, written.value)) return;
    conn.lastRev = facts.rev;
    conn.phase = {
      kind: "proving",
      transport: split.value,
      client: known.client,
      remoteStatic,
      proto,
      app: hello.app,
      first,
    };
  }

  async #linkHello(
    conn: Conn,
    handshake: Handshake,
    purpose: TokenPurpose,
    body: Uint8Array,
  ): Promise<void> {
    const refuse = (reason: RefusalReason = "malformed"): void => {
      this.#refuse(conn, reason);
    };
    const hello = payload(linkHello, body);
    if (hello === undefined) {
      refuse();
      return;
    }
    // No live token of this purpose: closed before message 2, which is no token's try (section
    // 5), counted per address as `unknownToken`.
    const token = this.#options.linkSecrets.find(hello.find);
    if (token?.purpose !== purpose) {
      refuse("unknownToken");
      return;
    }
    const proto = agreedVersion(hello.proto);
    if (proto === undefined) {
      refuse("noVersion");
      return;
    }
    if (!handshake.setPsk(token.psk).ok) {
      refuse();
      return;
    }
    // Message 2 says whether the client asks for the new person's name (step 1, wave 2).
    const written = await handshake.writeMessage(
      json({ hub: this.#options.hubVersion, proto, askName: token.askName }),
    );
    if (conn.phase.kind !== "hello") return;
    if (!written.ok) {
      refuse();
      return;
    }
    if (!this.#raw(conn, written.value)) return;
    conn.phase = { kind: "linkMessage3", handshake, token: token.token, purpose };
  }

  /** Link or restore message 3: the proof that the client holds the token's key. */
  async #message3(
    conn: Conn,
    phase: Extract<Phase, { readonly kind: "linkMessage3" }>,
    message: Uint8Array,
  ): Promise<void> {
    const read = await phase.handshake.readMessage(message);
    if (conn.phase !== phase) return;
    const failed = (reason: "badPsk" | "malformed"): void => {
      this.#options.emit({ kind: "linkFailed", token: phase.token, reason, address: conn.address });
      this.#close(conn, CLOSE.policy, undefined);
    };
    if (!read.ok) {
      failed(read.error === "decryptFailed" ? "badPsk" : "malformed");
      return;
    }
    const split = phase.handshake.split();
    const staticKey = phase.handshake.remoteStatic();
    if (!split.ok || staticKey === undefined) {
      failed("malformed");
      return;
    }
    this.#stopWaiting(conn);
    if (phase.purpose === "link") {
      const link = payload(linkRequest, read.value);
      if (link === undefined) {
        failed("malformed");
        return;
      }
      conn.phase = { kind: "linked", transport: split.value, token: phase.token };
      conn.told = true;
      this.#waitForCore(conn);
      this.#options.emit({
        kind: "linkCompleted",
        conn: conn.id,
        token: phase.token,
        staticKey,
        listener: conn.listener,
        link,
      });
      return;
    }
    if (payload(restoreHello, read.value) === undefined) {
      failed("malformed");
      return;
    }
    conn.phase = {
      kind: "restoring",
      transport: split.value,
      token: phase.token,
      offered: false,
      keyGiven: false,
    };
    conn.told = true;
    this.#waitForCore(conn);
    this.#options.emit({ kind: "restoreOpened", conn: conn.id, token: phase.token });
  }

  /** The client's first transport message: the proof, then admission (section 5). */
  #prove(
    conn: Conn,
    phase: Extract<Phase, { readonly kind: "proving" }>,
    message: Uint8Array,
  ): void {
    const plain = phase.transport.decrypt(message);
    if (!plain.ok) {
      this.#refuse(conn, "malformed", CLOSE.decryptFailed);
      return;
    }
    this.#stopWaiting(conn);
    // A client removed between message 1 and now has no session.
    if (this.#options.clientKeys.lookup(phase.remoteStatic)?.client !== phase.client) {
      this.#refuse(conn, "removedKey", CLOSE.removed);
      return;
    }
    const mine = this.sessionsOf(phase.client);
    for (let i = 0; i <= mine.length - this.#limits.maxSessionsPerClient; i++) {
      const oldest = this.#conns.get(mine[i] ?? connId(0));
      if (oldest !== undefined) this.#close(oldest, CLOSE.replaced, "replaced");
    }
    if (this.sessions >= this.#limits.maxSessions) {
      this.#refuse(conn, "rateLimited");
      return;
    }
    conn.phase = {
      kind: "session",
      transport: phase.transport,
      client: phase.client,
      admittedAt: this.#now(),
    };
    conn.told = true;
    this.#options.emit({
      kind: "clientConnected",
      conn: conn.id,
      client: phase.client,
      listener: conn.listener,
      proto: phase.proto,
      app: phase.app,
    });
    if (phase.first !== undefined) {
      this.#options.emit({
        kind: "clientRequest",
        conn: conn.id,
        client: phase.client,
        request: phase.first,
      });
    }
    conn.stopLifetime = this.#timers.after(this.#limits.lifetimeMs, () => {
      this.#close(conn, CLOSE.lifetime, "lifetime");
    });
    this.#heard(conn);
    this.#request(conn, phase.client, plain.value);
  }

  #sessionMessage(
    conn: Conn,
    phase: Extract<Phase, { readonly kind: "session" }>,
    message: Uint8Array,
  ): void {
    const plain = phase.transport.decrypt(message);
    if (!plain.ok) {
      this.#close(conn, CLOSE.decryptFailed, "decryptFailed");
      return;
    }
    this.#heard(conn);
    this.#request(conn, phase.client, plain.value);
  }

  /** Restore message 5, `RestoreKey`: only after the offer went, and once (section 5). */
  #restoreMessage(
    conn: Conn,
    phase: Extract<Phase, { readonly kind: "restoring" }>,
    message: Uint8Array,
  ): void {
    const plain = phase.transport.decrypt(message);
    if (!plain.ok) {
      this.#close(conn, CLOSE.decryptFailed, "decryptFailed");
      return;
    }
    const key = payload(restoreKey, plain.value);
    const bytes = key === undefined ? undefined : new Uint8Array(Buffer.from(key.key, "base64url"));
    plain.value.fill(0);
    if (!phase.offered || phase.keyGiven || key === undefined || bytes?.length !== 32) {
      bytes?.fill(0);
      this.#close(conn, CLOSE.policy, "badFrame");
      return;
    }
    phase.keyGiven = true;
    this.#waitForCore(conn);
    this.#options.emit({
      kind: "restoreKey",
      conn: conn.id,
      token: phase.token,
      key: bytes,
      epoch: key.epoch,
    });
  }

  /** A session's plaintext: one request, checked before the core sees it (section 2). */
  #request(conn: Conn, client: ClientId, plain: Uint8Array): void {
    const text = utf8(plain);
    const value = text === undefined ? undefined : parseJson(text, "codec", ORIGIN);
    if (value === undefined || value.isErr()) {
      this.#reject(conn, { reason: "notJson", id: undefined, field: "", issues: [] }, plain.length);
      return;
    }
    const refused = refusalOf(value.value);
    const parsed = refused === undefined ? parseRequest(value.value) : undefined;
    if (refused !== undefined || !parsed?.ok) {
      this.#reject(
        conn,
        refused ?? { reason: "badShape", id: undefined, field: "", issues: [] },
        plain.length,
      );
      return;
    }
    const request = parsed.value;
    if (request.op.op === "fileChunk") {
      this.#chunk(conn, request.id, request.op.body);
      return;
    }
    // The keepalive is the shell's (section 5): a `pong` has already counted as something
    // authenticated (`#heard`), and is nothing more. It never reaches the core and is never
    // answered; one that answers no `ping`, or comes again, is the same.
    if (request.op.op === "pong") return;
    this.#options.emit({ kind: "clientRequest", conn: conn.id, client, request });
  }

  #reject(conn: Conn, refused: Refused, bytes: number): void {
    this.#options.emit({
      kind: "inputRejected",
      rejection: {
        source: "app",
        conn: conn.id,
        reason: refused.reason,
        bytes,
        issues: refused.issues,
      },
    });
    if (refused.id !== undefined) {
      this.#deliver(conn, {
        t: "res",
        id: refused.id,
        ok: false,
        error: { code: "invalid", detail: { field: refused.field, reason: "format" } },
      });
    }
  }

  /** `fileChunk`: the shell's, on the console listener only ‡ (section 6). */
  #chunk(conn: Conn, id: number, body: Parameters<UploadStore["chunk"]>[1]): void {
    const reply = (outcome: AppReply): void => {
      this.#deliver(conn, outcome);
    };
    if (conn.listener !== "console") {
      reply({ t: "res", id, ok: false, error: { code: "consoleOnly", detail: {} } });
      return;
    }
    const uploads = this.#options.uploads;
    if (uploads === undefined) {
      reply({ t: "res", id, ok: false, error: { code: "unavailable", detail: {} } });
      return;
    }
    const outcome = uploads.chunk(conn.id, body);
    reply(
      outcome.ok
        ? { t: "res", id, ok: true, body: {} }
        : { t: "res", id, ok: false, error: outcome.error },
    );
  }

  // ----- Sending -----

  #appSend(id: ConnId, message: AppMessage): void {
    const conn = this.#conns.get(id);
    if (conn === undefined) return;
    if (!("kind" in message)) {
      if (conn.phase.kind === "session") this.#deliver(conn, message);
      return;
    }
    const phase = conn.phase;
    const body = message.body;
    if (phase.kind === "linked" && linkResult.safeParse(body).success) {
      if (this.#deliver(conn, body)) this.#close(conn, CLOSE.normal, undefined);
      return;
    }
    if (phase.kind === "restoring" && !phase.offered && restoreOffer.safeParse(body).success) {
      if (this.#deliver(conn, body)) phase.offered = true;
      return;
    }
    if (phase.kind === "restoring" && restoreResult.safeParse(body).success) {
      if (this.#deliver(conn, body)) this.#close(conn, CLOSE.normal, undefined);
      return;
    }
    this.#report(`a handshake message the ${phase.kind} connection cannot carry`);
  }

  /**
   * Encrypts and sends one transport message, in one call, so a session's messages leave in the
   * order they are given and the client's nonces follow (section 5, "Order"). A message that
   * cannot go (too long for one Noise message, a dropped send) closes the session: its stream
   * must never lose a message.
   */
  #deliver(conn: Conn, value: unknown): boolean {
    const phase = conn.phase;
    if (phase.kind !== "session" && phase.kind !== "linked" && phase.kind !== "restoring")
      return false;
    const plain = json(value);
    if (plain.length > NOISE_LIMITS.maxPlaintextBytes) {
      this.#report(`a message of ${plain.length} bytes is too long for one Noise message`);
      this.#close(conn, CLOSE.policy, "remote");
      return false;
    }
    const sealed = phase.transport.encrypt(plain);
    if (!sealed.ok) {
      this.#close(conn, CLOSE.policy, "remote");
      return false;
    }
    const sent = this.#raw(conn, sealed.value);
    if (sent && isEvent(value)) conn.lastRev = value.rev;
    return sent;
  }

  /** Sends bytes as they are; a send that fails (dropped, or a closed socket) closes it. */
  #raw(conn: Conn, bytes: Uint8Array): boolean {
    if (conn.socket.send(bytes).ok) return true;
    this.#close(conn, CLOSE.policy, "remote");
    return false;
  }

  // ----- Timers -----

  #stopWaiting(conn: Conn): void {
    conn.stopWaiting?.();
    conn.stopWaiting = undefined;
  }

  #waitForCore(conn: Conn): void {
    this.#stopWaiting(conn);
    conn.stopWaiting = this.#timers.after(this.#limits.coreWaitMs, () => {
      this.#close(conn, CLOSE.policy, "liveness");
    });
  }

  /** Something authenticated came: the ping and liveness timers start again (section 5). */
  #heard(conn: Conn): void {
    conn.stopPing?.();
    conn.stopLiveness?.();
    const ping = (): void => {
      // Its `rev` is the last one sent on this session, unchanged (section 6).
      if (this.#deliver(conn, { t: "evt", rev: conn.lastRev, ev: "ping", body: {} })) {
        conn.stopPing = this.#timers.after(this.#limits.pingAfterQuietMs, ping);
      }
    };
    conn.stopPing = this.#timers.after(this.#limits.pingAfterQuietMs, ping);
    conn.stopLiveness = this.#timers.after(this.#limits.livenessMs, () => {
      this.#close(conn, CLOSE.liveness, "liveness");
    });
  }

  // ----- Closing -----

  /** A handshake refused: closed, and counted for the core's `client_refused`. */
  #refuse(conn: Conn, reason: RefusalReason, code: number = CLOSE.policy): void {
    if (conn.phase.kind === "closed") return;
    this.#refusals.refused(conn.address, reason);
    this.#close(conn, code, undefined);
  }

  /** Closes the socket; the core is told why, if it knew the connection. */
  #close(conn: Conn, code: number, reason: ConnCloseReason | undefined): void {
    if (conn.phase.kind === "closed") return;
    this.#end(conn, reason);
    conn.socket.close(code, reason ?? "refused");
  }

  /** The socket is gone already. */
  #gone(conn: Conn, reason: ConnCloseReason): void {
    if (conn.phase.kind === "closed") return;
    this.#end(conn, reason);
  }

  #end(conn: Conn, reason: ConnCloseReason | undefined): void {
    conn.phase = { kind: "closed" };
    this.#stopWaiting(conn);
    conn.stopPing?.();
    conn.stopLiveness?.();
    conn.stopLifetime?.();
    this.#conns.delete(conn.id);
    this.#options.uploads?.closed(conn.id);
    // A download part way when the session went: its job ends, and its file is freed.
    for (const job of [...conn.downloads]) this.#options.downloadEnded?.(conn.id, job);
    conn.downloads.clear();
    if (conn.told && reason !== undefined) {
      this.#options.emit({ kind: "clientClosed", conn: conn.id, reason });
    }
  }

  #report(message: string): void {
    this.#options.report?.({ kind: "internal", origin: ORIGIN, message });
  }
}

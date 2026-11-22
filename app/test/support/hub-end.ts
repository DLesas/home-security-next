/**
 * A hub end for the app's tests, until owner A2's listeners exist (the brief's rule: small and
 * honest, answering what m2-design.md says a hub answers, nothing more). Built from the protocol
 * package's own Noise responder and the frozen schemas:
 *
 * - **Sessions** (IK): a static key it does not know, or a removed one, gets no message 2; the
 *   channel version is picked from the client's range or the socket closed; `HubHello` names the
 *   client. A connection counts once its first transport message decrypts.
 * - **Links** (XXpsk3): `LinkHello.find` names a live token or the socket closes before message 2;
 *   the psk is set after message 1; a wrong psk fails message 3 (a typed code counts the try, void
 *   after 5); a used token never works again; a new person needs a name; `LinkResult` is message 4,
 *   then the hub closes.
 * - **Requests**: the shell's checks (`parseRequest`), then the `seq` rule with the last 16 replies
 *   kept, a retried `seq` answered `repeat`, any other old one `seqTooLow {last}`.
 * - **Operations**: those the tests give it (`ops`), answered as section 6 says; any other is
 *   `notBuilt`, step 0's code for an operation not built yet.
 * - **Events**: `emit` raises `rev` by one and sends to every proven session.
 *
 * Each socket's path says its handshake: `/app` a session, `/app/link` a link (`/app/restore`,
 * a phone's, is not served here).
 *
 * **Version 2** (a phone's tests, P2): with `speaks` reaching 2, a session agreed at 2 has its
 * requests checked by version 2's tables (`parseRequestIn`), its snapshot carries version 2's
 * fields (`v2`), and a phone's `LinkResult` carries the backup key (`backupKey`). At version 1
 * everything is as before.
 */
import {
  type AppError,
  type AppEventBody,
  type AppEventName,
  type AppOpBody,
  type AppOpName,
  type AppOpNameV2,
  type AppOpReply,
  type ClientKindValue,
  clientHello,
  formatIdentity,
  appIdentityBytes,
  type Handshake,
  type HubHello,
  linkHello,
  linkPrologue,
  linkRequest,
  type LinkRequest,
  NOISE_PATTERNS,
  parseRequest,
  parseRequestIn,
  REQUEST_LIMITS,
  secretLookup,
  secretPsk,
  sessionPrologue,
  type SnapshotObject,
  startHandshake,
  type StaticKey,
  type TransportSession,
  typedLookup,
  typedPsk,
  formatTypedCode,
  x25519StaticKey,
} from "@hsn/protocol/app";
import { nodeSha256 } from "@hsn/protocol";
import type { ChannelPath, Connect, Wire, WireHandlers } from "../../src/hub/wire";
import { snapshotOf } from "./snapshots";

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (value: unknown) => enc.encode(JSON.stringify(value));
const parse = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(dec.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** One end of an in-memory socket; messages arrive in order, a turn later, as a socket's do. */
interface End {
  send(data: Uint8Array): void;
  close(code?: number): void;
}

function socketPair(clientSide: WireHandlers, hubSide: WireHandlers): { client: End; hub: End } {
  let open = true;
  const later = (run: () => void) => {
    setTimeout(run, 0);
  };
  const close = (code = 1000) => {
    if (!open) return;
    open = false;
    later(() => {
      clientSide.closed(code);
      hubSide.closed(code);
    });
  };
  return {
    client: {
      send: (data) => {
        const copy = data.slice();
        if (open)
          later(() => {
            hubSide.message(copy);
          });
      },
      close,
    },
    hub: {
      send: (data) => {
        const copy = data.slice();
        if (open)
          later(() => {
            clientSide.message(copy);
          });
      },
      close,
    },
  };
}

export interface HubClient {
  readonly id: number;
  readonly person: number | null;
  readonly kind: ClientKindValue;
  readonly name: string;
  readonly staticKey: Uint8Array;
  removed: boolean;
  lastSeq: number;
  readonly replies: Map<number, unknown>;
}

type TokenKind = "console" | "newPerson" | "ownDevice";
interface Token {
  readonly id: number;
  readonly lookup: string;
  readonly psk: Uint8Array;
  readonly kind: TokenKind;
  readonly typed: boolean;
  readonly person: number | null;
  readonly personName: string | undefined;
  used: boolean;
  failures: number;
}

export type OpAnswer<N extends AppOpName> =
  | { readonly ok: true; readonly body: AppOpReply<N> }
  | { readonly ok: false; readonly error: AppError };
export type OpHandler<N extends AppOpName> = (
  body: AppOpBody<N>,
  client: HubClient,
) => OpAnswer<N> | Promise<OpAnswer<N>>;

export interface SeenRequest {
  readonly client: number;
  readonly id: number;
  readonly seq: number | undefined;
  readonly op: string;
  readonly body: unknown;
}

interface Conn {
  readonly end: End;
  readonly path: ChannelPath;
  /** The channel version the session agreed. */
  proto: number;
  transport: TransportSession | undefined;
  client: HubClient | undefined;
  proven: boolean;
  link: { readonly hs: Handshake; readonly token: Token } | undefined;
}

export class HubEnd {
  readonly staticKey: StaticKey;
  readonly identity: string;
  readonly identityBytes: Uint8Array;
  boot = 1;
  rev = 10;
  version = "0.0.0-test";
  /** The versions this hub speaks. */
  speaks: readonly [number, number] = [1, 1];
  /** A fault: `HubHello` names this client number in place of the client's own. */
  helloClientOverride: number | undefined = undefined;
  /** A fault: `HubHello` names this channel version, whatever the client speaks. */
  helloProtoOverride: number | undefined = undefined;
  /** A fault: message 4 carries this in place of `LinkResult`. */
  linkResultOverride: unknown = undefined;
  /** The backup key a phone's `LinkResult` carries (m2-design.md section 5), when set. */
  backupKey: { readonly key: string; readonly epoch: number } | undefined = undefined;
  /** What a version 2 snapshot adds (m3-design.md sections 2 and 4). */
  v2: {
    addresses: readonly string[];
    appsPort: number;
    backupKeyEpoch: number | null;
    /** `hub.info`'s `relay` (RD 3): the hub's relay URL; none when not given. */
    relay?: string;
  } = { addresses: [], appsPort: 8444, backupKeyEpoch: null };
  reachable = true;
  /** While true, changes are made and committed, but their replies are not sent (a lost reply). */
  dropReplies = false;
  readonly clients = new Map<number, HubClient>();
  readonly tokens: Token[] = [];
  readonly seen: SeenRequest[] = [];
  readonly people = new Map<number, string>();
  private readonly conns = new Set<Conn>();
  private readonly ops = new Map<string, (body: unknown, client: HubClient) => unknown>();
  private nextClient = 1;
  private nextPerson = 1;
  private nextToken = 1;
  snapshot: SnapshotObject;
  /** Each socket's path, in order. */
  readonly paths: ChannelPath[] = [];
  /** Connections opened, of either kind. */
  connections = 0;

  constructor(privateKey: Uint8Array = new Uint8Array(32).fill(7)) {
    const key = x25519StaticKey(privateKey);
    if (!key.ok) throw new Error("hub key");
    this.staticKey = key.value;
    this.identityBytes = appIdentityBytes(nodeSha256, key.value.publicKey);
    this.identity = formatIdentity(this.identityBytes);
    this.snapshot = emptySnapshot(this);
    // A version 2 session's snapshot is version 1's with fields added (`snapshotFor`).
    this.handleV2("snapshot", (_body, client) => ({ ok: true, body: this.snapshotFor(client) }));
    this.handle("subscribe", (body) => ({ ok: true, body: { topics: body.topics } }));
    this.handle("pong", () => ({ ok: true, body: {} }));
  }

  /** The client side's `Connect`. */
  readonly connect: Connect = (path, handlers) => {
    if (!this.reachable) return Promise.resolve(undefined);
    this.connections += 1;
    const holder: { conn?: Conn } = {};
    this.paths.push(path);
    const pair = socketPair(handlers, {
      message: (data) => {
        if (holder.conn !== undefined) void this.receive(holder.conn, data);
      },
      closed: () => {
        if (holder.conn !== undefined) this.conns.delete(holder.conn);
      },
    });
    holder.conn = {
      end: pair.hub,
      path,
      proto: 1,
      transport: undefined,
      client: undefined,
      proven: false,
      link: undefined,
    };
    this.conns.add(holder.conn);
    const wire: Wire = {
      send: (d) => {
        pair.client.send(d);
      },
      close: (c) => {
        pair.client.close(c);
      },
    };
    return Promise.resolve(wire);
  };

  /** Answers `op` as the test says. */
  handle<N extends AppOpName>(op: N, handler: OpHandler<N>): void {
    // Bodies reach handlers only after `parseRequest` checked them against `op`'s schema.
    this.ops.set(op, (body, client) => handler(body as AppOpBody<N>, client));
  }

  /** Answers an operation of version 2 as the test says (`parseRequestIn` checked its body). */
  handleV2(
    op: AppOpNameV2,
    handler: (
      body: unknown,
      client: HubClient,
    ) => { ok: true; body: unknown } | { ok: false; error: unknown },
  ): void {
    this.ops.set(op, handler);
  }

  /** The version each client's newest session agreed, for the snapshot. */
  private readonly agreed = new Map<number, number>();

  /** The snapshot as `client`'s session sees it: version 2's fields on a version 2 session. */
  private snapshotFor(client: HubClient): unknown {
    const base = { ...this.snapshot, rev: this.rev };
    if ((this.agreed.get(client.id) ?? 1) < 2) return base;
    return {
      ...base,
      hub: {
        ...base.hub,
        proto: 2,
        addresses: this.v2.addresses,
        appsPort: this.v2.appsPort,
        relay: this.v2.relay === undefined ? null : { url: this.v2.relay },
      },
      push: client.kind === "phone" ? { registered: false, valid: false } : null,
      backupKeyEpoch: client.kind === "phone" ? this.v2.backupKeyEpoch : null,
    };
  }

  /** A link token; its secret, as a QR code, a link address or the console's token carry it. */
  tokenWithSecret(kind: TokenKind, person: number | null = null, personName?: string): Uint8Array {
    const secret = new Uint8Array(16);
    crypto.getRandomValues(secret);
    this.tokens.push({
      id: this.nextToken++,
      lookup: secretLookup(nodeSha256, secret),
      psk: secretPsk(nodeSha256, secret),
      kind,
      typed: false,
      person,
      personName,
      used: false,
      failures: 0,
    });
    return secret;
  }

  /** A typed code, `XXXX-XXXX-XXXX`. */
  typedCode(kind: TokenKind, person: number | null = null, personName?: string): string {
    const tokenId = 1000 + this.nextToken;
    const secret = 0x123456789n + BigInt(this.nextToken);
    this.tokens.push({
      id: this.nextToken++,
      lookup: typedLookup(tokenId),
      psk: typedPsk(nodeSha256, secret),
      kind,
      typed: true,
      person,
      personName,
      used: false,
      failures: 0,
    });
    return formatTypedCode({ tokenId, secret }) ?? "";
  }

  /** A client linked some other way (as the hub computer would). */
  addClient(
    staticKey: Uint8Array,
    kind: ClientKindValue = "web",
    person: number | null = null,
  ): HubClient {
    const client: HubClient = {
      id: this.nextClient++,
      person,
      kind,
      name: "test",
      staticKey,
      removed: false,
      lastSeq: 0,
      replies: new Map(),
    };
    this.clients.set(client.id, client);
    return client;
  }

  /** Raises `rev` by one and sends an event to every proven session. */
  emit<N extends AppEventName>(ev: N, body: AppEventBody<N>): void {
    this.rev += 1;
    for (const conn of this.conns)
      if (conn.proven) this.sendFrame(conn, { t: "evt", rev: this.rev, ev, body });
  }

  /** The `session` event, then the close (section 6), for every session of the client. */
  remove(clientId: number): void {
    const client = this.clients.get(clientId);
    if (client === undefined) return;
    client.removed = true;
    for (const conn of this.conns) {
      if (conn.client?.id !== clientId) continue;
      this.rev += 1;
      this.sendFrame(conn, { t: "evt", rev: this.rev, ev: "session", body: {} });
      conn.end.close(1000);
    }
  }

  /** Closes every connection, as a hub restart or a dropped network does. */
  dropAll(): void {
    for (const conn of this.conns) conn.end.close(1001);
    this.conns.clear();
  }

  /** Sends a frame as it is, encrypted, on every session: events of any version, or wrong ones. */
  emitFrame(frame: unknown): void {
    for (const conn of this.conns) if (conn.proven) this.sendFrame(conn, frame);
  }

  /** Sends raw bytes on every session, for tests of what the client refuses. */
  sendRaw(data: Uint8Array): void {
    for (const conn of this.conns) if (conn.proven) conn.end.send(data);
  }

  get openSessions(): number {
    return [...this.conns].filter((c) => c.proven).length;
  }

  private sendFrame(conn: Conn, frame: unknown): void {
    const sealed = conn.transport?.encrypt(json(frame));
    if (sealed?.ok === true) conn.end.send(sealed.value);
  }

  private async receive(conn: Conn, data: Uint8Array): Promise<void> {
    if (conn.link !== undefined) {
      await this.third(conn, conn.link.hs, conn.link.token, data);
      return;
    }
    if (conn.transport === undefined) {
      await this.firstMessage(conn, data);
      return;
    }
    const opened = conn.transport.decrypt(data);
    if (!opened.ok) {
      conn.end.close(1002);
      return;
    }
    conn.proven = true;
    await this.request(conn, parse(opened.value));
  }

  private async firstMessage(conn: Conn, data: Uint8Array): Promise<void> {
    // The path says which handshake it is (wave 2's ruling); nothing is read on trial.
    const answered =
      conn.path === "session"
        ? await this.trySession(conn, data)
        : conn.path === "link" && (await this.tryLink(conn, data));
    if (!answered) conn.end.close(1002);
  }

  private async trySession(conn: Conn, data: Uint8Array): Promise<boolean> {
    const started = startHandshake({
      pattern: NOISE_PATTERNS.session,
      initiator: false,
      prologue: sessionPrologue(this.identityBytes),
      staticKey: this.staticKey,
    });
    if (!started.ok) return false;
    const hs = started.value;
    const payload = await hs.readMessage(data);
    if (!payload.ok) return false;
    const remote = hs.remoteStatic();
    const client = [...this.clients.values()].find(
      (c) => remote !== undefined && hex(c.staticKey) === hex(remote),
    );
    const hello = clientHello.safeParse(parse(payload.value));
    // An unknown or removed key, or no version both speak: no message 2 (section 5).
    if (client === undefined || client.removed || !hello.success) {
      conn.end.close(1000);
      return true;
    }
    const proto = Math.min(hello.data.proto[1], this.speaks[1]);
    if (proto < Math.max(hello.data.proto[0], this.speaks[0])) {
      conn.end.close(1000);
      return true;
    }
    const hubHello: HubHello = {
      proto: this.helloProtoOverride ?? proto,
      hub: this.version,
      boot: this.boot,
      rev: this.rev,
      client: {
        id: this.helloClientOverride ?? client.id,
        person: client.person,
        kind: client.kind,
      },
      features: [],
    };
    const second = await hs.writeMessage(json(hubHello));
    const transport = hs.split();
    if (!second.ok || !transport.ok) {
      conn.end.close(1002);
      return true;
    }
    conn.client = client;
    conn.proto = hubHello.proto;
    this.agreed.set(client.id, hubHello.proto);
    conn.transport = transport.value;
    conn.end.send(second.value);
    return true;
  }

  private async tryLink(conn: Conn, data: Uint8Array): Promise<boolean> {
    const started = startHandshake({
      pattern: NOISE_PATTERNS.link,
      initiator: false,
      prologue: linkPrologue("link"),
      staticKey: this.staticKey,
    });
    if (!started.ok) return false;
    const hs = started.value;
    const payload = await hs.readMessage(data);
    if (!payload.ok) return false;
    const hello = linkHello.safeParse(parse(payload.value));
    const token = hello.success
      ? this.tokens.find((t) => t.lookup === hello.data.find && !t.used)
      : undefined;
    // A lookup that names no live token, or no version both speak, closes before message 2 and
    // counts as no try.
    if (
      token === undefined ||
      !hello.success ||
      hello.data.proto[0] > this.speaks[1] ||
      hello.data.proto[1] < this.speaks[0]
    ) {
      conn.end.close(1000);
      return true;
    }
    if (!hs.setPsk(token.psk).ok) return true;
    const second = await hs.writeMessage(
      // Message 2 asks for the name when the token makes a person its maker did not name.
      json({
        hub: this.version,
        proto: Math.min(hello.data.proto[1], this.speaks[1]),
        askName: token.kind === "newPerson" && token.personName === undefined,
      }),
    );
    if (!second.ok) return true;
    conn.end.send(second.value);
    conn.link = { hs, token };
    return true;
  }

  /** Message 3 of a link: the psk proves itself here, or the try fails. */
  private async third(conn: Conn, hs: Handshake, token: Token, data: Uint8Array): Promise<void> {
    conn.link = undefined;
    const third = await hs.readMessage(data);
    if (!third.ok) {
      if (token.typed) {
        token.failures += 1;
        if (token.failures >= 5) token.used = true;
      }
      conn.end.close(1000);
      return;
    }
    const request = linkRequest.safeParse(parse(third.value));
    const remote = hs.remoteStatic();
    const transport = hs.split();
    if (!request.success || remote === undefined || !transport.ok || token.used) {
      conn.end.close(1000);
      return;
    }
    this.completeLink(conn, token, request.data, remote, transport.value);
  }

  private completeLink(
    conn: Conn,
    token: Token,
    request: LinkRequest,
    remote: Uint8Array,
    transport: TransportSession,
  ): void {
    if ([...this.clients.values()].some((c) => hex(c.staticKey) === hex(remote))) {
      conn.end.close(1000);
      return;
    }
    let person: number | null = token.person;
    if (token.kind === "newPerson") {
      const name = token.personName ?? request.person?.name;
      if (name === undefined) {
        conn.end.close(1000);
        return;
      }
      person = this.nextPerson++;
      this.people.set(person, name);
    }
    const kind: ClientKindValue = token.kind === "console" ? "console" : request.kind;
    const client: HubClient = {
      id: this.nextClient++,
      person: token.kind === "console" ? null : person,
      kind,
      name: request.name,
      staticKey: remote.slice(),
      removed: false,
      lastSeq: 0,
      replies: new Map(),
    };
    this.clients.set(client.id, client);
    token.used = true;
    const result = {
      client: client.id,
      person: client.person,
      ...(kind === "phone" && this.backupKey !== undefined ? { backupKey: this.backupKey } : {}),
    };
    const sealed = transport.encrypt(json(this.linkResultOverride ?? result));
    if (sealed.ok) conn.end.send(sealed.value);
    conn.end.close(1000);
  }

  private async request(conn: Conn, frame: unknown): Promise<void> {
    const client = conn.client;
    if (client === undefined) return;
    const parsed = conn.proto >= 2 ? parseRequestIn(2, frame) : parseRequest(frame);
    if (!parsed.ok) {
      if (parsed.id !== undefined)
        this.sendFrame(conn, {
          t: "res",
          id: parsed.id,
          ok: false,
          error: { code: "invalid", detail: { field: "", reason: "format" } },
        });
      return;
    }
    const { id, seq, op } = parsed.value;
    this.seen.push({ client: client.id, id, seq, op: op.op, body: op.body });
    if (client.removed) {
      this.sendFrame(conn, {
        t: "res",
        id,
        ok: false,
        error: { code: "unauthorized", detail: {} },
      });
      return;
    }
    if (seq !== undefined && seq <= client.lastSeq) {
      const kept = client.replies.get(seq);
      const reply =
        kept === undefined
          ? { ok: false, error: { code: "seqTooLow", detail: { last: client.lastSeq } } }
          : { ...(kept as object), repeat: true };
      this.sendFrame(conn, { t: "res", id, ...reply });
      return;
    }
    const handler = this.ops.get(op.op);
    const answer =
      handler === undefined
        ? { ok: false, error: { code: "notBuilt", detail: { op: op.op } } }
        : await handler(op.body, client);
    const reply = answerFrame(answer);
    if (seq !== undefined) {
      // The change, the new last `seq` and the reply, together (section 3), then the reply.
      client.lastSeq = seq;
      client.replies.set(seq, reply);
      for (const old of [...client.replies.keys()]
        .sort((a, b) => a - b)
        .slice(0, -REQUEST_LIMITS.storedReplies))
        client.replies.delete(old);
      if (this.dropReplies) return;
    }
    this.sendFrame(conn, { t: "res", id, ...reply });
  }
}

function answerFrame(answer: unknown): object {
  const a = answer as { ok: boolean; body?: unknown; error?: unknown };
  return a.ok ? { ok: true, body: a.body } : { ok: false, error: a.error };
}

export function emptySnapshot(hub: HubEnd): SnapshotObject {
  return snapshotOf({ rev: hub.rev, version: hub.version, identity: hub.identity, boot: hub.boot });
}

/**
 * The client's two handshakes (m2-design.md section 5): a session (`Noise_IK`, every connection)
 * and a link (`Noise_XXpsk3`, once). Both run on the page's own origin, the only address the
 * content security policy allows.
 *
 * A session: message 1 carries `ClientHello`, message 2 `HubHello`; the hub's static key is the one
 * pinned at linking, in the prologue's identity too. A hub that closes before message 2 refused
 * the key (unknown, removed), the version, or a handshake slot; the client cannot tell which.
 *
 * A link: message 1 carries `LinkHello` with the token's lookup, never the secret; message 2's
 * static key is checked against the identity the code carried, when it carried one (a QR code, a
 * link address), and the client stops before message 3 if it does not match; message 3 carries
 * only a name and a kind; nothing the client must keep secret is sent before message 4, the hub's
 * first transport message, has decrypted, proving it knows the pre-shared key. The key is made
 * for each try and kept only once linked.
 */
import {
  APP_PROTO_VERSION,
  clientHello,
  type ClientHello,
  type HubHello,
  hubHello,
  linkHubPayload,
  linkPrologue,
  type LinkRequest,
  type LinkResult,
  linkResult,
  matchesIdentity,
  NOISE_PATTERNS,
  parseIdentity,
  sessionPrologue,
  startHandshake,
  type TransportSession,
  type TypedCode,
  typedLookup,
} from "@hsn/protocol/app";
import { identityOf, lookupOfSecret, pskOfSecret, pskOfTypedSecret } from "./digest";
import { decodeJson, encodeJson } from "./codec";
import { isRelayOwnClose } from "./relay";
import type { ClientKeys, KeyFault, StoredClient } from "../platform/client-key";
import { makeClientKey, type PlatformSecret, staticKeyOf } from "../platform/keys";
import { type ChannelPath, CLOSE, type Connect, Inbox, type Timers, type Wire } from "./wire";

/** The original channel's range, used when a caller does not supply its build's range. */
export const PROTO_RANGE: readonly [number, number] = [APP_PROTO_VERSION, APP_PROTO_VERSION];

/**
 * A range of channel versions a client offers, lowest first. The web and phone builds give
 * their range explicitly (m3-design.md section 3).
 */
export type ProtoRange = readonly [number, number];

/**
 * The platform's key functions (`platform/keys.ts`): what the handshakes use when not given
 * others. Tests of the phone's client, which Bun runs with the web's binding, give the phone's.
 */
export const PLATFORM_KEYS: ClientKeys<PlatformSecret> = { makeClientKey, staticKeyOf };

/** How long a handshake waits for the hub's next message ‡ (the hub's own limit is 5 s). */
export const HANDSHAKE_WAIT_MS = 10_000;

export type SessionFailure =
  /** No socket, or the relay closed it before message 2 (`isRelayOwnClose`): the hub is not reachable. */
  | "unreachable"
  /** Closed before message 2: the key is unknown or removed, no version is shared, or the hub is full. */
  | "refused"
  /** Message 2 did not decrypt: not the hub this browser linked to. */
  | "notOurHub"
  /** A message the client cannot read, or a version outside its range. */
  | "protocol"
  | "timeout"
  /** Web Crypto refused the key's Diffie-Hellman. */
  | "keyFailed";

export interface OpenedSession {
  readonly hello: HubHello;
  readonly transport: TransportSession;
  readonly wire: Wire;
  /** Messages after message 2 go here; the session takes them over. */
  readonly inbox: Inbox;
}

type Outcome<T, F> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: F };

function fail<F>(fault: F, wire?: Wire): { readonly ok: false; readonly fault: F } {
  wire?.close(CLOSE.protocol);
  return { ok: false, fault };
}

async function connected(
  connect: Connect,
  path: ChannelPath,
  inbox: Inbox,
): Promise<Wire | undefined> {
  return connect(path, {
    message: (data) => {
      inbox.push(data);
    },
    closed: (code) => {
      inbox.close(code);
    },
  });
}

/** Opens a session (IK) with the stored key and hub. */
export async function openSession(
  connect: Connect,
  stored: StoredClient,
  app: string,
  timers: Timers,
  proto: ProtoRange = PROTO_RANGE,
  keys: ClientKeys<PlatformSecret> = PLATFORM_KEYS,
  firstRequest?: ClientHello["first"],
): Promise<Outcome<OpenedSession, SessionFailure>> {
  const identity = parseIdentity(stored.hub.identity);
  if (identity === undefined) return fail("protocol");
  const started = startHandshake({
    pattern: NOISE_PATTERNS.session,
    initiator: true,
    prologue: sessionPrologue(identity),
    staticKey: keys.staticKeyOf(stored.key),
    remoteStatic: stored.hub.staticKey,
  });
  if (!started.ok) return fail("protocol");
  const handshake = started.value;
  const hello = clientHello.parse({ proto, app, first: firstRequest });
  const first = await handshake.writeMessage(encodeJson(hello));
  if (!first.ok) return fail(first.error === "allZeroDh" ? "keyFailed" : "protocol");

  const inbox = new Inbox(timers);
  const wire = await connected(connect, "session", inbox);
  if (wire === undefined) return fail("unreachable");
  wire.send(first.value);

  const next = await inbox.next(HANDSHAKE_WAIT_MS);
  if (next.kind === "closed") return fail(isRelayOwnClose(next.code) ? "unreachable" : "refused");
  if (next.kind === "timeout") return fail("timeout", wire);
  const second = await handshake.readMessage(next.data);
  if (!second.ok) return fail("notOurHub", wire);
  const json = decodeJson(second.value);
  const parsed = hubHello.safeParse(json?.value);
  if (!parsed.success) return fail("protocol", wire);
  if (parsed.data.proto < proto[0] || parsed.data.proto > proto[1]) return fail("protocol", wire);
  if (parsed.data.client.id !== stored.hub.client) return fail("protocol", wire);
  const transport = handshake.split();
  if (!transport.ok) return fail("protocol", wire);
  return { ok: true, value: { hello: parsed.data, transport: transport.value, wire, inbox } };
}

/** What a code carries, read from where it came (section 5, "Linking"). */
export type LinkSecret =
  /** A QR code or a link address (with the hub's identity), or the console's token (without). */
  | { readonly kind: "secret"; readonly secret: Uint8Array; readonly identity: string | undefined }
  | { readonly kind: "typed"; readonly code: TypedCode };

export type LinkFailure =
  | "unreachable"
  /** Closed before message 2: no live token has that lookup (used, expired, never made), or no shared version. */
  | "refused"
  /** Message 2's static key is not the identity the code named: stopped before message 3. */
  | "wrongHub"
  /** No message 4: a wrong code, a token used or expired meanwhile, or a link the hub refused. */
  | "notAccepted"
  /** Message 2 asks for the new person's name, which was not given: closed before message 3. */
  | "needsName"
  | "protocol"
  | "timeout"
  | KeyFault;

/** Links this browser; the record to keep, which the caller writes. */
export async function linkBrowser(
  connect: Connect,
  secret: LinkSecret,
  request: LinkRequest,
  timers: Timers,
  proto: ProtoRange = PROTO_RANGE,
): Promise<Outcome<StoredClient, LinkFailure>> {
  const linked = await linkClient(connect, secret, request, timers, proto);
  return linked.ok ? { ok: true, value: linked.value.record } : linked;
}

/** A link made: the record to keep, and message 4 as the hub sent it (a phone's backup key). */
export interface LinkedClient {
  readonly record: StoredClient;
  readonly result: LinkResult;
}

/**
 * Links a client, browser or phone, offering `proto`: the record to keep and the hub's
 * `LinkResult`, whose backup key a phone keeps with the record (m3-design.md section 4).
 */
export async function linkClient(
  connect: Connect,
  secret: LinkSecret,
  request: LinkRequest,
  timers: Timers,
  proto: ProtoRange = PROTO_RANGE,
  keys: ClientKeys<PlatformSecret> = PLATFORM_KEYS,
): Promise<Outcome<LinkedClient, LinkFailure>> {
  const key = await keys.makeClientKey();
  if (!key.ok) return fail(key.fault);
  const psk =
    secret.kind === "secret"
      ? await pskOfSecret(secret.secret)
      : await pskOfTypedSecret(secret.code.secret);
  const find =
    secret.kind === "secret"
      ? await lookupOfSecret(secret.secret)
      : typedLookup(secret.code.tokenId);
  const expected =
    secret.kind === "secret" && secret.identity !== undefined
      ? parseIdentity(secret.identity)
      : undefined;
  if (secret.kind === "secret" && secret.identity !== undefined && expected === undefined)
    return fail("protocol");

  const started = startHandshake({
    pattern: NOISE_PATTERNS.link,
    initiator: true,
    prologue: linkPrologue("link"),
    staticKey: keys.staticKeyOf(key.value),
    psk,
  });
  if (!started.ok) return fail("protocol");
  const handshake = started.value;
  const first = await handshake.writeMessage(encodeJson({ proto, find }));
  if (!first.ok) return fail("protocol");

  const inbox = new Inbox(timers);
  const wire = await connected(connect, "link", inbox);
  if (wire === undefined) return fail("unreachable");
  wire.send(first.value);

  const second = await inbox.next(HANDSHAKE_WAIT_MS);
  if (second.kind === "closed")
    return fail(isRelayOwnClose(second.code) ? "unreachable" : "refused");
  if (second.kind === "timeout") return fail("timeout", wire);
  const read = await handshake.readMessage(second.data);
  if (!read.ok) return fail("protocol", wire);
  const payload = linkHubPayload.safeParse(decodeJson(read.value)?.value);
  if (!payload.success || payload.data.proto < proto[0] || payload.data.proto > proto[1])
    return fail("protocol", wire);
  const hubStatic = handshake.remoteStatic();
  if (hubStatic === undefined) return fail("protocol", wire);
  // The check against the identity the code carried, before anything more is sent (section 5).
  if (expected !== undefined && !matchesIdentity(hubStatic, expected))
    return fail("wrongHub", wire);
  // The token makes a new person whose name its maker did not give (wave 2's ruling): the person
  // is asked, and the link made again with it. Closing before message 3 costs the code no try.
  if (payload.data.askName && request.person === undefined) return fail("needsName", wire);

  const third = await handshake.writeMessage(encodeJson(request));
  if (!third.ok) return fail(third.error === "allZeroDh" ? "failed" : "protocol", wire);
  wire.send(third.value);
  const transport = handshake.split();
  if (!transport.ok) return fail("protocol", wire);

  const fourth = await inbox.next(HANDSHAKE_WAIT_MS);
  if (fourth.kind === "closed") return fail("notAccepted");
  if (fourth.kind === "timeout") return fail("timeout", wire);
  const opened = transport.value.decrypt(fourth.data);
  if (!opened.ok) return fail("protocol", wire);
  const result = linkResult.safeParse(decodeJson(opened.value)?.value);
  if (!result.success) return fail("protocol", wire);
  wire.close(CLOSE.normal);
  return {
    ok: true,
    value: {
      record: {
        key: key.value,
        hub: {
          identity: await identityOf(hubStatic),
          staticKey: hubStatic.slice(),
          client: result.data.client,
          person: result.data.person,
        },
        lastSeq: 0,
      },
      result: result.data,
    },
  };
}

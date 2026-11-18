/**
 * A stand-in for Apple's push service (APNs) on loopback: HTTP/2 over TLS with a certificate made
 * for the test, token authentication checked against a test key, the request headers and body
 * checked as Apple documents them ‡, and answers scripted per request. Everything it received is
 * recorded, so a test can assert on headers, the JWT and the body. What it imitates and what it
 * does not is in this workspace's README; every fact about the real service here is from memory ‡.
 */
import { randomUUID } from "node:crypto";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { decodeJwt, type DecodedJwt, signatureVerifies } from "./jwt.ts";
import { fail, ok, type Result } from "./result.ts";
import { parseJson } from "./safe/attempt.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The facts the stand-in checks, as Apple documents them ‡. */
export const APNS_FACTS = {
  /** A provider token older than this is refused `ExpiredProviderToken` ‡. */
  tokenLifetimeMs: 60 * MINUTE,
  /** A new provider token sooner than this after the last is refused `TooManyProviderTokenUpdates` ‡. */
  minTokenUpdateMs: 20 * MINUTE,
  /** A JWT's `iat` this far in the future is refused (the stand-in's own tolerance ‡). */
  futureSkewMs: MINUTE,
  /** An alert push's body, at most ‡. */
  maxBodyBytes: 4096,
  /** `apns-push-type` values ‡. */
  pushTypes: [
    "alert",
    "background",
    "location",
    "voip",
    "complication",
    "fileprovider",
    "mdm",
    "liveactivity",
    "pushtotalk",
  ],
  /** `apns-priority` values ‡. */
  priorities: ["10", "5", "1"],
  /** `apns-collapse-id`, at most ‡. */
  maxCollapseIdBytes: 64,
} as const;

/** What the stand-in did with a request. */
export type ApnsAnswered =
  | { readonly kind: "status"; readonly status: number; readonly reason?: string }
  | { readonly kind: "stalled" }
  | { readonly kind: "reset" }
  | { readonly kind: "dropped" };

/** One request as received. */
export interface ApnsReceived {
  readonly atMs: number;
  /** Which connection carried it, numbered from 1 in order of arrival. */
  readonly connection: number;
  /** Its stream's id on that connection. */
  readonly stream: number;
  readonly method: string;
  readonly path: string;
  /** The device token from the path, when the path has the form `/3/device/<token>`. */
  readonly deviceToken: string | undefined;
  /** Every header but the pseudo-headers and `authorization`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The `authorization` header as sent. */
  readonly authorization: string | undefined;
  /** The bearer JWT, decoded, when it could be. */
  readonly jwt: DecodedJwt | undefined;
  readonly body: string;
  /** Set once the stand-in has answered. */
  answered: ApnsAnswered | undefined;
}

/** A scripted answer for a request that passed every check. */
export type ApnsScript =
  | {
      readonly kind: "status";
      readonly status: number;
      readonly reason?: string;
      /** Answer this long after the request ended, not at once. */
      readonly delayMs?: number;
      /** A GOAWAY after the answer naming this stream as the last processed, as Apple does when it closes a connection ‡. */
      readonly goawayAfter?: boolean;
    }
  /** Never answer: the stream stays open until the client gives up or the stand-in closes. */
  | { readonly kind: "stall" }
  /** Reset the stream (RST_STREAM, INTERNAL_ERROR) without answering. */
  | { readonly kind: "reset" }
  /** Destroy the whole connection without answering: a connection lost mid-request. */
  | { readonly kind: "drop" };

export interface ApnsStandInOptions {
  readonly tls: { readonly key: string; readonly cert: string };
  readonly keyId: string;
  readonly teamId: string;
  /** The APNs key's public half, SPKI PEM. */
  readonly publicKeyPem: string;
  /** The app's bundle id: the only `apns-topic` accepted. */
  readonly topic: string;
  /** SETTINGS_MAX_CONCURRENT_STREAMS the stand-in announces; 1,000 when not given ‡. */
  readonly maxConcurrentStreams?: number;
  /** The stand-in's clock; `Date.now` when not given. */
  readonly now?: () => number;
  /** Called for each request that passed every check; `undefined` answers 200. */
  readonly script?: (request: ApnsReceived) => ApnsScript | undefined;
}

export interface ApnsStandIn {
  /** `https://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly received: readonly ApnsReceived[];
  /** Connections accepted so far. */
  readonly connections: number;
  /** Connections open now. */
  readonly openConnections: number;
  /** From now on, `token` answers 410 `Unregistered` with the time it was unregistered. */
  unregister(token: string): void;
  /**
   * Sends GOAWAY (NO_ERROR, `{"reason":"Shutdown"}`) on every open connection, naming `lastStream`
   * as the last one processed (by default the highest received): streams above it were not.
   */
  goaway(lastStream?: number): void;
  /** Destroys every open connection at once. */
  dropConnections(): void;
  close(): Promise<void>;
}

const HEX_TOKEN = /^[0-9a-fA-F]{64,200}$/u;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}

/** Apple's answer for a request, or undefined when every check passes ‡. */
function check(
  options: ApnsStandInOptions,
  request: ApnsReceived,
  nowMs: number,
  tokens: { current: string | undefined; changedMs: number },
  unregistered: ReadonlyMap<string, number>,
): { readonly status: number; readonly reason: string; readonly timestamp?: number } | undefined {
  if (request.method !== "POST") return { status: 405, reason: "MethodNotAllowed" };
  if (request.deviceToken === undefined) return { status: 404, reason: "BadPath" };
  const authorization = request.authorization;
  if (authorization === undefined) return { status: 403, reason: "MissingProviderToken" };
  const bearer = /^bearer (.+)$/u.exec(authorization)?.[1];
  const jwt = request.jwt;
  if (
    bearer === undefined ||
    jwt?.header.kid !== options.keyId ||
    jwt.claims.iss !== options.teamId ||
    typeof jwt.claims.iat !== "number" ||
    !signatureVerifies(jwt, "ES256", options.publicKeyPem)
  ) {
    return { status: 403, reason: "InvalidProviderToken" };
  }
  const iatMs = jwt.claims.iat * SECOND;
  if (iatMs > nowMs + APNS_FACTS.futureSkewMs)
    return { status: 403, reason: "InvalidProviderToken" };
  if (nowMs - iatMs > APNS_FACTS.tokenLifetimeMs)
    return { status: 403, reason: "ExpiredProviderToken" };
  if (tokens.current !== bearer) {
    if (tokens.current !== undefined && nowMs - tokens.changedMs < APNS_FACTS.minTokenUpdateMs) {
      return { status: 429, reason: "TooManyProviderTokenUpdates" };
    }
    tokens.current = bearer;
    tokens.changedMs = nowMs;
  }
  const h = request.headers;
  const topic = h["apns-topic"];
  if (topic === undefined) return { status: 400, reason: "MissingTopic" };
  if (topic !== options.topic) return { status: 400, reason: "BadTopic" };
  const pushType = h["apns-push-type"];
  if (pushType === undefined || !APNS_FACTS.pushTypes.some((t) => t === pushType)) {
    return { status: 400, reason: "InvalidPushType" };
  }
  const priority = h["apns-priority"];
  if (priority !== undefined && !APNS_FACTS.priorities.some((p) => p === priority)) {
    return { status: 400, reason: "BadPriority" };
  }
  const expiration = h["apns-expiration"];
  if (expiration !== undefined && !/^\d+$/u.test(expiration)) {
    return { status: 400, reason: "BadExpirationDate" };
  }
  const id = h["apns-id"];
  if (id !== undefined && !UUID.test(id)) return { status: 400, reason: "BadMessageId" };
  const collapse = h["apns-collapse-id"];
  if (collapse !== undefined && Buffer.byteLength(collapse) > APNS_FACTS.maxCollapseIdBytes) {
    return { status: 400, reason: "BadCollapseId" };
  }
  if (!HEX_TOKEN.test(request.deviceToken)) return { status: 400, reason: "BadDeviceToken" };
  if (request.body.length === 0) return { status: 400, reason: "PayloadEmpty" };
  if (Buffer.byteLength(request.body) > APNS_FACTS.maxBodyBytes) {
    return { status: 413, reason: "PayloadTooLarge" };
  }
  const payload = parseJson(request.body);
  const aps =
    payload.ok && typeof payload.value === "object" && payload.value !== null
      ? (payload.value as Readonly<Record<string, unknown>>).aps
      : undefined;
  // Not one of Apple's reasons: the stand-in's own, so a client's malformed body is caught here.
  if (typeof aps !== "object" || aps === null) return { status: 400, reason: "StandInBadPayload" };
  const gone = unregistered.get(request.deviceToken);
  if (gone !== undefined) return { status: 410, reason: "Unregistered", timestamp: gone };
  return undefined;
}

/** Starts the stand-in on 127.0.0.1 and a free port. */
export function startApnsStandIn(
  options: ApnsStandInOptions,
): Promise<Result<ApnsStandIn, string>> {
  const now = options.now ?? Date.now;
  const received: ApnsReceived[] = [];
  const unregistered = new Map<string, number>();
  const sessions = new Set<http2.ServerHttp2Session>();
  const stalled = new Set<http2.ServerHttp2Stream>();
  const tokens = { current: undefined as string | undefined, changedMs: 0 };
  let connections = 0;
  const numbers = new WeakMap<http2.ServerHttp2Session, number>();
  /** The highest stream each connection has received: GOAWAY's last stream. */
  const lastStream = new WeakMap<http2.ServerHttp2Session, number>();
  /** GOAWAY, NO_ERROR, naming `last` (or the highest stream received) as the last one processed. */
  const shutdown = (session: http2.ServerHttp2Session, last?: number) => {
    session.goaway(
      http2.constants.NGHTTP2_NO_ERROR,
      last ?? lastStream.get(session) ?? 0,
      Buffer.from('{"reason":"Shutdown"}'),
    );
  };

  const server = http2.createSecureServer({
    key: options.tls.key,
    cert: options.tls.cert,
    settings: { maxConcurrentStreams: options.maxConcurrentStreams ?? 1000 },
  });
  server.on("session", (session) => {
    connections += 1;
    numbers.set(session, connections);
    sessions.add(session);
    session.on("error", () => undefined);
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    stream.on("error", () => undefined);
    lastStream.set(stream.session as http2.ServerHttp2Session, stream.id ?? 0);
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const path = headerText(headers[":path"]) ?? "";
      const authorization = headerText(headers.authorization);
      const bearer =
        authorization === undefined ? undefined : /^bearer (.+)$/u.exec(authorization)?.[1];
      const decoded = bearer === undefined ? undefined : decodeJwt(bearer);
      const plain: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        const text = headerText(value);
        if (!name.startsWith(":") && name !== "authorization" && text !== undefined)
          plain[name] = text;
      }
      const request: ApnsReceived = {
        atMs: now(),
        connection: numbers.get(stream.session as http2.ServerHttp2Session) ?? 0,
        stream: stream.id ?? 0,
        method: headerText(headers[":method"]) ?? "",
        path,
        deviceToken: /^\/3\/device\/([^/]+)$/u.exec(path)?.[1],
        headers: plain,
        authorization,
        jwt: decoded?.ok === true ? decoded.value : undefined,
        body: Buffer.concat(chunks).toString("utf8"),
        answered: undefined,
      };
      received.push(request);
      const apnsId = request.headers["apns-id"] ?? randomUUID();
      const refusal = check(options, request, request.atMs, tokens, unregistered);
      const script: ApnsScript =
        refusal === undefined
          ? (options.script?.(request) ?? { kind: "status", status: 200 })
          : { kind: "status", status: refusal.status, reason: refusal.reason };
      switch (script.kind) {
        case "stall":
          request.answered = { kind: "stalled" };
          stalled.add(stream);
          stream.on("close", () => stalled.delete(stream));
          return;
        case "reset":
          request.answered = { kind: "reset" };
          stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
          return;
        case "drop":
          request.answered = { kind: "dropped" };
          stream.session?.destroy();
          return;
        case "status": {
          if (script.delayMs !== undefined && script.delayMs > 0) {
            const { delayMs, ...later } = script;
            setTimeout(() => {
              answer(stream, request, later, refusal, apnsId);
            }, delayMs);
            return;
          }
          answer(stream, request, script, refusal, apnsId);
          return;
        }
      }
    });
  });

  function answer(
    stream: http2.ServerHttp2Stream,
    request: ApnsReceived,
    script: Extract<ApnsScript, { kind: "status" }>,
    refusal: ReturnType<typeof check>,
    apnsId: string,
  ): void {
    if (stream.closed || stream.destroyed) return;
    const reason = script.reason;
    request.answered =
      reason === undefined
        ? { kind: "status", status: script.status }
        : { kind: "status", status: script.status, reason };
    const body =
      script.status === 200
        ? ""
        : JSON.stringify(
            refusal?.timestamp === undefined
              ? { reason: reason ?? "InternalServerError" }
              : { reason, timestamp: refusal.timestamp },
          );
    stream.respond({
      ":status": script.status,
      "apns-id": apnsId,
      ...(body === "" ? {} : { "content-type": "application/json" }),
    });
    stream.end(body);
    // As Apple does when it closes a connection ‡: streams after this one were not processed.
    if (script.goawayAfter === true)
      shutdown(stream.session as http2.ServerHttp2Session, stream.id);
  }

  return new Promise((resolve) => {
    server.once("error", (error) => {
      resolve(fail(`listen: ${error.message}`));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(
        ok({
          origin: `https://127.0.0.1:${address.port}`,
          received,
          get connections() {
            return connections;
          },
          get openConnections() {
            return sessions.size;
          },
          unregister(token: string) {
            unregistered.set(token, now());
          },
          goaway(last?: number) {
            for (const session of sessions) shutdown(session, last);
          },
          dropConnections() {
            for (const session of sessions) session.destroy();
          },
          close() {
            for (const stream of stalled) stream.close(http2.constants.NGHTTP2_CANCEL);
            for (const session of sessions) session.destroy();
            return new Promise<void>((done) => {
              server.close(() => {
                done();
              });
            });
          },
        }),
      );
    });
  });
}

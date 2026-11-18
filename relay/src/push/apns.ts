/**
 * The APNs sender (docs/m4-design.md section 5, "To Apple and Google"): HTTP/2 to Apple's
 * service with token authentication, one connection per environment, kept open and reused for
 * every push, with requests multiplexed up to the number of streams Apple allows. How `node:http2`
 * behaves under Bun 1.4.2, and so why this is written as it is, is docs/spikes/B3-http2-under-bun.md.
 *
 * - **The request** ‡: `POST /3/device/<token>`, `authorization: bearer <provider token>`,
 *   `apns-topic: <bundle id>`, `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration`
 *   now + 24 hours, and the body `{"aps": {"alert": {"loc-key": "push.placeholder"},
 *   "mutable-content": 1, "sound": "default"}, "h": "…"}`: no title, no app name, no collapse id.
 * - **Connections.** Opened on the first push of an environment and used once Apple's SETTINGS
 *   have arrived, replaced after a GOAWAY, a failure or a close, with the hub's back-off between failed attempts (`RELAY_BACKOFF`). A
 *   stream Apple did not process (`refused`) is sent again, at most twice; one that may have been
 *   processed (a reset, a connection lost mid-request, a timeout) is not: it is `retryLater`, and
 *   the hub's outbox sends it again, at least once as the design has it.
 * - **The provider token** is `jwt.ts`'s; after `ExpiredProviderToken` it is renewed once and the
 *   push sent again.
 * - Every failure is an outcome (`outcomes.ts`); nothing here throws or rejects.
 */
import type { PushEnvironment } from "@hsn/protocol/relay";
import { RELAY_BACKOFF } from "@hsn/protocol/relay";
import type { ApnsProviderToken } from "./jwt.ts";
import type { PushLog } from "./log.ts";
import { apnsOutcome, retryLater, type ServiceOutcome } from "./outcomes.ts";
import { Http2Connection, type Http2Failure } from "./safe/http2.ts";
import { parseJson } from "./safe/json.ts";

const SECOND = 1000;

/** Apple's two services ‡. */
export const APNS_ORIGINS: Readonly<Record<PushEnvironment, string>> = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com",
};

/** The sender's own values ‡. */
export const APNS_RULES = {
  /** An answer from Apple within this long, or the push is `retryLater` (timeout). */
  requestTimeoutMs: 10 * SECOND,
  /** A connection and Apple's SETTINGS within this long. */
  connectTimeoutMs: 10 * SECOND,
  /** `apns-expiration`: Apple keeps trying an absent phone for this long (the design's 24 h ‡). */
  expirationMs: 24 * 3600 * SECOND,
  /** An answer's body, at most: Apple's are a short JSON reason. */
  maxAnswerBytes: 4096,
  /** A push Apple refused unprocessed is sent this many times more, at most. */
  refusedRetries: 2,
} as const;

/** The body every push carries: the placeholder Apple shows only if the extension fails, and `h`. */
export function apnsBody(h: string): string {
  return JSON.stringify({
    aps: { alert: { "loc-key": "push.placeholder" }, "mutable-content": 1, sound: "default" },
    h,
  });
}

export interface ApnsSettings {
  readonly tokens: ApnsProviderToken;
  /** The app's bundle id (`DEPLOYMENT.ios.bundleId`). */
  readonly topic: string;
  readonly origins: Readonly<Record<PushEnvironment, string>>;
  /** A certificate authority to trust instead of the system's: the stand-in's (tests only). */
  readonly ca?: string;
  readonly now: () => number;
  readonly log: PushLog;
  /** `APNS_RULES.requestTimeoutMs` unless given (tests). */
  readonly requestTimeoutMs?: number;
}

export interface ApnsTarget {
  readonly env: PushEnvironment;
  /** The device token, hex. */
  readonly token: string;
  readonly h: string;
}

function backoffMs(failures: number): number {
  return RELAY_BACKOFF.stepsMs[failures - 1] ?? RELAY_BACKOFF.thenEveryMs;
}

/**
 * One environment's connection and its back-off. Streams beyond Apple's limit are not counted
 * here: once SETTINGS has arrived, `node:http2` holds them until a stream is free (the check found
 * none refused with 200 pushes at once against a limit of 10), so the connection is used only
 * after `ready`.
 */
class Lane {
  private connection: Http2Connection | undefined;
  private connecting: Promise<Http2Connection | undefined> | undefined;
  private failures = 0;
  private retryAtMs = 0;

  constructor(
    private readonly env: PushEnvironment,
    private readonly settings: ApnsSettings,
  ) {}

  /** A connection whose SETTINGS have arrived, or undefined while Apple cannot be reached. */
  acquire(): Promise<Http2Connection | undefined> {
    if (this.connection?.usable === true) return Promise.resolve(this.connection);
    if (this.connecting !== undefined) return this.connecting;
    if (this.settings.now() < this.retryAtMs) return Promise.resolve(undefined);
    const connection = Http2Connection.open(this.settings.origins[this.env], {
      connectTimeoutMs: APNS_RULES.connectTimeoutMs,
      ...(this.settings.ca === undefined ? {} : { ca: this.settings.ca }),
    });
    this.connecting = connection.ready().then((ready) => {
      this.connecting = undefined;
      if (ready.isOk()) {
        this.failures = 0;
        this.connection = connection;
        return connection;
      }
      connection.close();
      this.failures += 1;
      this.retryAtMs = this.settings.now() + backoffMs(this.failures);
      this.settings.log.write("warning", "serviceUnreachable", {
        service: "apns",
        env: this.env,
        failures: this.failures,
        why: ready.error.kind === "timeout" ? "timeout" : "connection",
      });
      return undefined;
    });
    return this.connecting;
  }

  /**
   * Stops using a connection, so the next push opens another. One that is broken is closed; one
   * that is only going away (a GOAWAY) is left to finish the streams Apple is still answering.
   */
  discard(connection: Http2Connection, broken: boolean): void {
    if (this.connection === connection) this.connection = undefined;
    if (broken) connection.close();
  }

  close(): void {
    this.connection?.close();
    this.connection = undefined;
  }
}

function failureOutcome(failure: Http2Failure): ServiceOutcome {
  return failure.kind === "timeout" ? retryLater("timeout") : retryLater("connection");
}

function reasonOf(body: string): string | undefined {
  if (body === "") return undefined;
  const parsed = parseJson(body, "service", "push/apns", "APNs's answer");
  if (parsed.isErr()) return undefined;
  const value = parsed.value;
  if (typeof value !== "object" || value === null || !("reason" in value)) return undefined;
  return typeof value.reason === "string" ? value.reason : undefined;
}

export class ApnsClient {
  private readonly lanes: Readonly<Record<PushEnvironment, Lane>>;
  private refused = 0;

  constructor(private readonly settings: ApnsSettings) {
    this.lanes = {
      production: new Lane("production", settings),
      development: new Lane("development", settings),
    };
  }

  /** Sends one push and resolves with what Apple's answer means. Never rejects. */
  async send(target: ApnsTarget): Promise<ServiceOutcome> {
    const { now, log } = this.settings;
    let token = this.settings.tokens.current(now());
    let renewed = false;
    const lane = this.lanes[target.env];
    for (let refused = 0; ;) {
      if (token.isErr()) {
        log.write("error", "credentialsFailed", { service: "apns" }, token.error);
        return retryLater("credentials");
      }
      const connection = await lane.acquire();
      if (connection === undefined) return retryLater("connection");
      const answer = await connection.request(
        {
          ":method": "POST",
          ":path": `/3/device/${target.token}`,
          authorization: `bearer ${token.value}`,
          "apns-topic": this.settings.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor((now() + APNS_RULES.expirationMs) / SECOND)),
          "content-type": "application/json",
        },
        apnsBody(target.h),
        this.settings.requestTimeoutMs ?? APNS_RULES.requestTimeoutMs,
        APNS_RULES.maxAnswerBytes,
      );
      if (answer.isErr()) {
        if (answer.error.kind === "refused" && refused < APNS_RULES.refusedRetries) {
          refused += 1;
          this.refused += 1;
          if (!connection.usable) lane.discard(connection, false);
          continue;
        }
        if (answer.error.kind !== "timeout") lane.discard(connection, true);
        return failureOutcome(answer.error);
      }
      const reason = reasonOf(answer.value.body);
      if (answer.value.status === 403 && reason === "ExpiredProviderToken" && !renewed) {
        renewed = true;
        token = this.settings.tokens.renewAfterExpired(now());
        if (token.isOk()) log.write("info", "credentialsRenewed", { service: "apns" });
        continue;
      }
      if (answer.value.status === 403) {
        log.write("error", "credentialsFailed", { service: "apns", status: 403 });
      }
      return apnsOutcome(answer.value.status, reason);
    }
  }

  /** Streams Apple refused unprocessed so far, each sent again: none while the stream limit is kept. */
  get refusedStreams(): number {
    return this.refused;
  }

  close(): void {
    this.lanes.production.close();
    this.lanes.development.close();
  }
}

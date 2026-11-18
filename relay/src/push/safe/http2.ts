/**
 * One HTTP/2 connection to APNs, behind results (docs/m4-design.md section 5; the check of
 * docs/spikes/B3-http2-under-bun.md). `node:http2` throws from `request` on a closed session under
 * Node and reports the same asynchronously under Bun, and reports a stream's end through several
 * events; this file turns all of it into one answer or one `Http2Failure` per request.
 *
 * What the check found and this file therefore does:
 * - It waits for the server's SETTINGS before the first request (`ready`): a client that opens
 *   streams before them has those over the server's limit refused (REFUSED_STREAM), under Bun as
 *   under Node; after them, `node:http2` holds streams over the limit until one is free.
 * - A GOAWAY makes the connection unusable for new requests; streams the server never processed
 *   (above its last stream id, reported as `ERR_HTTP2_GOAWAY_SESSION` with REFUSED_STREAM) are
 *   `refused`, which the caller may send again on a new connection.
 * - A stream reset after it was sent, or a connection lost while a request was in flight, may have
 *   been processed: `reset` and `connection`, which the caller does not repeat by itself.
 * - Every request has its own timeout; a stalled stream is cancelled and the connection kept.
 *
 * Errors keep only codes: an `http2` error's message can quote a header's value, and the path
 * holds a device token, the `authorization` header a JWT.
 */
import http2 from "node:http2";
import { err, ok, type Result } from "neverthrow";
import { thrownCode } from "./thrown.ts";

const { NGHTTP2_CANCEL, NGHTTP2_REFUSED_STREAM } = http2.constants;

/** Why a request got no answer. */
export type Http2Failure =
  /** The server did not process it (REFUSED_STREAM, or above a GOAWAY's last stream): send again. */
  | { readonly kind: "refused" }
  /** The stream was reset after it was sent: it may have been processed. */
  | { readonly kind: "reset"; readonly code: number }
  /** No answer within the request's time; the stream was cancelled. */
  | { readonly kind: "timeout" }
  /** The connection failed, or was lost while the request was in flight. */
  | { readonly kind: "connection"; readonly code?: string };

export interface Http2Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface Http2Options {
  /** A certificate authority to trust instead of the system's: the stand-ins' only (tests). */
  readonly ca?: string;
  readonly connectTimeoutMs: number;
}

function text(value: string | string[] | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(",") : String(value);
}

export class Http2Connection {
  private session: http2.ClientHttp2Session | undefined;
  private isGone = false;
  private readonly settled: Promise<Result<void, Http2Failure>>;

  private constructor(origin: string, options: Http2Options) {
    let settle: (result: Result<void, Http2Failure>) => void = () => undefined;
    this.settled = new Promise((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      settle(err({ kind: "timeout" }));
      this.close();
    }, options.connectTimeoutMs);
    const done = (result: Result<void, Http2Failure>) => {
      clearTimeout(timer);
      settle(result);
    };
    try {
      const session = http2.connect(origin, options.ca === undefined ? {} : { ca: options.ca });
      this.session = session;
      session.on("error", (thrown: unknown) => {
        this.isGone = true;
        const code = thrownCode(thrown);
        done(err(code === undefined ? { kind: "connection" } : { kind: "connection", code }));
      });
      session.on("goaway", () => {
        this.isGone = true;
        done(err({ kind: "refused" }));
      });
      session.on("close", () => {
        this.isGone = true;
        done(err({ kind: "connection" }));
      });
      session.once("remoteSettings", () => {
        done(ok(undefined));
      });
    } catch (thrown) {
      this.isGone = true;
      const code = thrownCode(thrown);
      done(err(code === undefined ? { kind: "connection" } : { kind: "connection", code }));
    }
  }

  /** Opens a connection to `origin` (`https://host:port`). Never throws; see `ready`. */
  static open(origin: string, options: Http2Options): Http2Connection {
    return new Http2Connection(origin, options);
  }

  /** Resolves once the server's SETTINGS arrived, or with why the connection failed first. */
  ready(): Promise<Result<void, Http2Failure>> {
    return this.settled;
  }

  /** False once the connection failed, closed, or the server sent GOAWAY. */
  get usable(): boolean {
    const session = this.session;
    return !this.isGone && session !== undefined && !session.closed && !session.destroyed;
  }

  /** How many streams the server allows at once (its SETTINGS), 1 until it said. */
  get streamLimit(): number {
    const announced = this.session?.remoteSettings.maxConcurrentStreams;
    return announced === undefined || announced < 1 ? 1 : Math.min(announced, 1000);
  }

  /** Sends one request and resolves with its answer or why there is none. Never rejects. */
  request(
    headers: http2.OutgoingHttpHeaders,
    body: string,
    timeoutMs: number,
    maxBodyBytes: number,
  ): Promise<Result<Http2Answer, Http2Failure>> {
    const session = this.session;
    if (session === undefined || !this.usable) return Promise.resolve(err({ kind: "refused" }));
    return new Promise((resolve) => {
      let stream: http2.ClientHttp2Stream;
      try {
        stream = session.request(headers);
      } catch {
        // A session already closed or going away: nothing was sent.
        resolve(err({ kind: "refused" }));
        return;
      }
      let status: number | undefined;
      const answerHeaders: Record<string, string> = {};
      const chunks: Buffer[] = [];
      let size = 0;
      let ended = false;
      let finished = false;
      const finish = (result: Result<Http2Answer, Http2Failure>) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };
      const cancel = () => {
        try {
          stream.close(NGHTTP2_CANCEL);
        } catch {
          // Already closed: nothing to cancel.
        }
      };
      const failure = (thrown?: unknown): Http2Failure => {
        const code = thrown === undefined ? undefined : thrownCode(thrown);
        if (stream.rstCode === NGHTTP2_REFUSED_STREAM) return { kind: "refused" };
        if (code === "ERR_HTTP2_GOAWAY_SESSION" || code === "ERR_HTTP2_INVALID_SESSION") {
          return { kind: "refused" };
        }
        if (session.destroyed || code === "ERR_HTTP2_STREAM_CANCEL") {
          return code === undefined ? { kind: "connection" } : { kind: "connection", code };
        }
        return { kind: "reset", code: stream.rstCode };
      };
      const timer = setTimeout(() => {
        finish(err({ kind: "timeout" }));
        cancel();
      }, timeoutMs);
      stream.on("response", (received) => {
        status = Number(received[":status"]);
        for (const [name, value] of Object.entries(received)) {
          const v = text(value);
          if (!name.startsWith(":") && v !== undefined) answerHeaders[name] = v;
        }
      });
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBodyBytes) {
          finish(err({ kind: "reset", code: NGHTTP2_CANCEL }));
          cancel();
        } else {
          chunks.push(chunk);
        }
      });
      stream.on("end", () => {
        ended = true;
        if (status !== undefined) {
          finish(
            ok({ status, headers: answerHeaders, body: Buffer.concat(chunks).toString("utf8") }),
          );
        }
      });
      stream.on("error", (thrown: unknown) => {
        finish(err(failure(thrown)));
      });
      stream.on("close", () => {
        if (ended && status !== undefined) {
          finish(
            ok({ status, headers: answerHeaders, body: Buffer.concat(chunks).toString("utf8") }),
          );
        }
        finish(err(failure()));
      });
      stream.end(body);
    });
  }

  /** Closes the connection: requests in flight end as `connection`. */
  close(): void {
    this.isGone = true;
    try {
      this.session?.destroy();
    } catch {
      // Already destroyed.
    }
  }
}

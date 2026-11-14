/**
 * `hsn`'s side of the control socket (hub-design.md section 9): one JSON request line, then one
 * reply line, checked with the frozen schemas; with `--follow`, the stream lines after it until
 * the hub closes the connection. It reaches the hub only through the socket and never opens the
 * database.
 */
import { connect, type Socket } from "node:net";
import { err, ok, Result } from "neverthrow";
import {
  type ChunkLine,
  chunkLine,
  type RecordJson,
  replyLine,
  type ReplyLine,
  type RequestLine,
  streamLine,
} from "../src/control-protocol/index.ts";

export type ClientError =
  /** No socket file, or nothing listening on it. */
  | { readonly kind: "notRunning"; readonly message: string }
  /** The socket's permissions keep this account out. */
  | { readonly kind: "permission"; readonly message: string }
  /** No reply in time. */
  | { readonly kind: "timeout"; readonly message: string }
  /** The hub closed the connection before it answered. */
  | { readonly kind: "closed"; readonly message: string }
  /** A line that is not a reply. */
  | { readonly kind: "badReply"; readonly message: string };

export interface Exchange {
  readonly reply: ReplyLine;
}

const NEWLINE = "\n";
const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  () => undefined,
);

const NOT_RUNNING_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ENOTSOCK",
  "ENOTDIR",
]);
const PERMISSION_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

function codeOf(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "";
}

/**
 * Sends `request` and waits for its reply. With `onRecord`, keeps the connection open after the
 * reply and passes on every streamed record until the hub closes it; `stop` ends it early.
 */
export function exchange(
  path: string,
  request: RequestLine,
  timeoutMs: number,
  onRecord?: (record: RecordJson) => void,
  stop?: (end: () => void) => void,
): Promise<Result<Exchange, ClientError>> {
  return new Promise((resolve) => {
    let settled = false;
    let reply: ReplyLine | undefined;
    let held = "";
    const socket: Socket = connect(path);
    const finish = (result: Result<Exchange, ClientError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const fail = (error: ClientError): void => {
      finish(err(error));
    };
    const timer = setTimeout(() => {
      fail({
        kind: "timeout",
        message: `the hub gave no answer in ${Math.round(timeoutMs / 1000)} s`,
      });
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}${NEWLINE}`);
    });
    socket.on("error", (error) => {
      const code = codeOf(error);
      if (NOT_RUNNING_CODES.has(code))
        fail({ kind: "notRunning", message: `no hub is listening on ${path}` });
      else if (PERMISSION_CODES.has(code))
        fail({ kind: "permission", message: `this account may not open ${path}` });
      else
        fail({
          kind: "closed",
          message: `the connection failed (${code === "" ? error.message : code})`,
        });
    });
    socket.on("close", () => {
      if (reply === undefined)
        fail({ kind: "closed", message: "the hub closed the connection without an answer" });
      else finish(ok({ reply }));
    });
    socket.on("data", (chunk: string) => {
      held += chunk;
      for (let at = held.indexOf(NEWLINE); at !== -1; at = held.indexOf(NEWLINE)) {
        const text = held.slice(0, at);
        held = held.slice(at + 1);
        const json = parseJson(text);
        const value = json.isOk() ? json.value : undefined;
        if (reply === undefined) {
          const parsed = replyLine.safeParse(value);
          if (!parsed.success || parsed.data.id !== request.id) {
            fail({ kind: "badReply", message: "the hub's answer is not a reply to this request" });
            return;
          }
          reply = parsed.data;
          if (onRecord === undefined || !parsed.data.reply.ok) {
            finish(ok({ reply }));
            return;
          }
          clearTimeout(timer);
          stop?.(() => {
            finish(ok({ reply: parsed.data }));
          });
        } else if (onRecord !== undefined) {
          const streamed = streamLine.safeParse(value);
          if (!streamed.success || streamed.data.id !== request.id) {
            fail({ kind: "badReply", message: "the hub streamed a line that is not a record" });
            return;
          }
          onRecord(streamed.data.record);
        }
      }
    });
  });
}

/**
 * One connection that carries several requests in turn (m2-design.md section 6, "Commands that
 * carry a file"): an upload's `fileChunk` requests and then the operation that names its `job`
 * must share a connection, since the shell keeps an upload per connection (`UploadRef`). A
 * download's `fileChunk` lines come before its request's reply.
 */
export class Session {
  readonly #socket: Socket;
  readonly #path: string;
  #held = "";
  #nextId = 1;
  #waiting:
    | {
        readonly id: number;
        readonly onChunk: ((chunk: ChunkLine["fileChunk"]) => void) | undefined;
        readonly done: (result: Result<ReplyLine, ClientError>) => void;
      }
    | undefined;
  #closed: ClientError | undefined;
  #onClose: (() => void) | undefined;

  private constructor(socket: Socket, path: string) {
    this.#socket = socket;
    this.#path = path;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#data(chunk);
    });
    socket.on("close", () => {
      this.#end({ kind: "closed", message: "the hub closed the connection" });
      this.#onClose?.();
    });
    socket.on("error", (error) => {
      this.#end({ kind: "closed", message: `the connection failed (${codeOf(error)})` });
    });
  }

  /** Opens a connection to the hub's socket. */
  static open(path: string): Promise<Result<Session, ClientError>> {
    return new Promise((resolve) => {
      const socket = connect(path);
      const failed = (error: Error): void => {
        const code = codeOf(error);
        resolve(
          err(
            NOT_RUNNING_CODES.has(code)
              ? { kind: "notRunning", message: `no hub is listening on ${path}` }
              : PERMISSION_CODES.has(code)
                ? { kind: "permission", message: `this account may not open ${path}` }
                : { kind: "closed", message: `the connection failed (${code})` },
          ),
        );
      };
      socket.once("error", failed);
      socket.once("connect", () => {
        socket.off("error", failed);
        resolve(ok(new Session(socket, path)));
      });
    });
  }

  /**
   * Sends one request and waits for its reply, passing on each `fileChunk` line before it.
   * `timeoutMs` undefined waits as long as it takes.
   */
  request(
    actor: string,
    command: RequestLine["command"],
    timeoutMs: number | undefined,
    onChunk?: (chunk: ChunkLine["fileChunk"]) => void,
  ): Promise<Result<ReplyLine, ClientError>> {
    if (this.#closed !== undefined) return Promise.resolve(err(this.#closed));
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#settle(
                err({
                  kind: "timeout",
                  message: `the hub gave no answer in ${Math.round(timeoutMs / 1000)} s`,
                }),
              );
            }, timeoutMs);
      this.#waiting = {
        id,
        onChunk,
        done: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      };
      this.#socket.write(`${JSON.stringify({ id, actor, command })}${NEWLINE}`);
    });
  }

  /** Resolves when the hub closes the connection (a restore ends with the hub's restart). */
  closedByHub(): Promise<void> {
    return this.#closed === undefined
      ? new Promise((resolve) => {
          this.#onClose = resolve;
        })
      : Promise.resolve();
  }

  close(): void {
    this.#socket.destroy();
  }

  get path(): string {
    return this.#path;
  }

  #data(text: string): void {
    this.#held += text;
    for (let at = this.#held.indexOf(NEWLINE); at !== -1; at = this.#held.indexOf(NEWLINE)) {
      const line = this.#held.slice(0, at);
      this.#held = this.#held.slice(at + 1);
      const json = parseJson(line);
      const value = json.isOk() ? json.value : undefined;
      const waiting = this.#waiting;
      if (waiting === undefined) continue;
      const chunk = chunkLine.safeParse(value);
      if (chunk.success && chunk.data.id === waiting.id && waiting.onChunk !== undefined) {
        waiting.onChunk(chunk.data.fileChunk);
        continue;
      }
      const reply = replyLine.safeParse(value);
      this.#settle(
        reply.success && reply.data.id === waiting.id
          ? ok(reply.data)
          : err({ kind: "badReply", message: "the hub's answer is not a reply to this request" }),
      );
    }
  }

  #settle(result: Result<ReplyLine, ClientError>): void {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.done(result);
  }

  #end(error: ClientError): void {
    this.#closed ??= error;
    this.#settle(err(error));
  }
}

/**
 * The control socket's server (hub-design.md sections 3 and 9; the `Control` port): a Unix domain
 * socket in the hub's data folder that only the hub's account can open (`socket-file.ts`), one
 * JSON request and one JSON reply per line, each checked with the frozen Zod schemas of
 * `control-protocol/`.
 *
 * - A request becomes a `command` input for the core, under a `RequestId` of this run; its reply
 *   is the core's `respond` effect, which the loop performs after the commit (section 4). One
 *   request at a time per connection: later lines wait their turn.
 * - `hsn log` goes to the core too, which records it, and is answered here: the log source
 *   flushes and reads (section 3). With `--follow` the connection then streams every record the
 *   loop hands to `publish`, filtered, in the order the core made them; it never polls the
 *   database.
 * - A malformed, oversized or partial line is answered where it can be (`badRequest`, request id
 *   0 when none could be read), never executed, and given to the core as an `inputRejected`
 *   input to be recorded: its length and the shape errors only, never its content, which may
 *   hold a password.
 * - The `status` reply gets the writer's part, last commit and staged items, which only the
 *   shell knows (control-protocol replies.ts).
 */
import type { AppOpBody } from "@hsn/protocol/app";
import { createServer, type Server, type Socket } from "node:net";
import type { Result } from "neverthrow";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import type { AuditRecord } from "../../core/model/audit.ts";
import type { ControlReply } from "../../core/model/control.ts";
import type { HubError } from "../../core/model/errors.ts";
import type { ControlLineRejection } from "../../core/model/events.ts";
import { type ConnId, type RequestId, requestId } from "../../core/model/ids.ts";
import { ConnIds } from "../app/channel.ts";
import { controlChunkReply, type UploadStore } from "../app/uploads.ts";
import {
  chunkLine,
  fileFailedLine,
  replyLine,
  requestLine,
  type RequestLine,
  streamLine,
  typedCommand,
} from "../../control-protocol/index.ts";
import type { Control, SubscriberId } from "../../ports/control.ts";
import type { EventSink } from "../../ports/links.ts";
import type { LogQuery } from "../../ports/reader.ts";
import { parseJson } from "../safe/json.ts";
import { FILE_CHUNK_NOT_BUILT } from "./file-chunks.ts";
import { LineReader, MAX_REQUEST_LINE_BYTES } from "./lines.ts";
import { type FollowFilter, matches, recordJson } from "./records.ts";
import { type SocketSteps, socketStepsFor } from "./socket-steps.ts";
import type { WarningSink } from "./windows.ts";

/** A download's chunk, as the app's `fileChunk` body carries it. */
type FileChunkCommandBody = AppOpBody<"fileChunk">;

const ORIGIN = "shell/control/server";

/** The id answered when a request's own could not be read (control-protocol `requestNumber`). */
export const UNREAD_REQUEST_ID = 0;

/** Requests one connection may have waiting behind the one in hand: 16 ‡ (this design). */
export const MAX_WAITING_REQUESTS = 16;

/**
 * Bytes a `--follow` connection may leave unread before the hub drops it, 1 MiB ‡ (this design):
 * a follower that does not read must not make the hub hold every record for it.
 */
export const MAX_FOLLOW_BACKLOG_BYTES = 1024 * 1024;

/** Why a line was not taken as a request (the core's `ControlLineRejection`). */
export type RejectionReason = ControlLineRejection;

/** What is recorded of a rejected line: never its content. */
export interface Rejection {
  readonly reason: RejectionReason;
  readonly bytes: number;
  /** Zod's paths and codes for a `badShape`, without the values. */
  readonly issues: readonly string[];
}

/** What only the writer knows, for `hsn status` (section 9). */
export interface WriterStatus {
  readonly lastCommitMs: number | null;
  readonly stagedItems: number;
  readonly databaseBytes: number | null;
  readonly historyShortened: boolean;
}

export interface ControlServerOptions {
  /** `control.sock` in the data folder (cli/paths.ts). */
  readonly socketPath: string;
  /** `hsn log`: flush, then read through the writer's connection (sections 3 and 5). */
  readonly logQuery: (query: LogQuery) => Result<readonly AuditRecord[], HubError>;
  /** A device's id by its name, from the core's registry, for `--follow --device`. */
  readonly deviceIdOf: (name: string) => number | undefined;
  readonly writerStatus: () => WriterStatus;
  /** The loop's longest turn since the last read (`HubLoop.takeLongestTurnMs`); 0 without it. */
  readonly longestTurnMs?: () => number;
  /** Also told of each rejected line, after it reached the core (tests watch it). */
  readonly onRejected?: (rejection: Rejection) => void;
  /**
   * How the socket's place is checked: the system's own by default (`socket-steps.ts`); tests
   * give Windows' steps with access lists as data.
   */
  readonly steps?: SocketSteps;
  /**
   * Told `data_folder_open` or `data_folder_was_open` when the Windows steps find a top folder
   * open (m2-design.md section 9); standard error when not given.
   */
  readonly onWarning?: WarningSink;
  /**
   * Windows: the hub's other top folders, checked as the data folder is (the program folder,
   * m2-design.md section 9, "The privilege boundary"); none elsewhere.
   */
  readonly otherTopFolders?: readonly string[];
  /**
   * The shell's one counter of connections, shared with the app listeners (m2-design.md section
   * 6): each control connection is a `ConnId`, so an upload on it is `UploadRef {conn, job}`.
   */
  readonly connIds?: ConnIds;
  /** The uploads `fileChunk` requests go to; without it each chunk is answered not built. */
  readonly uploads?: UploadStore;
}

interface Follower {
  readonly id: SubscriberId;
  readonly clientId: number;
  readonly filter: FollowFilter;
}

interface Connection {
  readonly conn: ConnId;
  readonly socket: Socket;
  readonly reader: LineReader;
  readonly waiting: string[];
  /** The request in hand, until its reply is written. */
  inHand: RequestId | undefined;
  /** The client's id of the last reply written: a download's lines follow its reply. */
  lastReplied: number | undefined;
  follower: Follower | undefined;
}

/** The client's id in a line that is not a valid request, if it has one. */
function idIn(value: unknown): number {
  if (typeof value !== "object" || value === null || !("id" in value)) return UNREAD_REQUEST_ID;
  const id = value.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : UNREAD_REQUEST_ID;
}

function refusal(message: string): ControlReply {
  return { ok: false, error: { code: "badRequest", message } };
}

export class UnixControlServer implements Control {
  readonly #options: ControlServerOptions;
  readonly #steps: SocketSteps;
  readonly #connIds: ConnIds;
  readonly #server: Server;
  readonly #connections = new Set<Connection>();
  readonly #requests = new Map<
    RequestId,
    { readonly connection: Connection; readonly clientId: number }
  >();
  readonly #followers = new Map<SubscriberId, Connection>();
  #sink: EventSink | undefined;
  #nextRequest = 1;
  #nextSubscriber = 1;

  private constructor(options: ControlServerOptions, steps: SocketSteps, server: Server) {
    this.#options = options;
    this.#steps = steps;
    this.#connIds = options.connIds ?? new ConnIds();
    this.#server = server;
    server.on("connection", (socket) => {
      this.#accept(socket);
    });
  }

  /**
   * Opens the socket: the folder secured, an old socket removed, listening, then the socket file
   * checked (0600 on macOS and Linux, its access list on Windows). When that last check fails,
   * the listener is closed again, so a socket that failed its check never serves.
   */
  static open(options: ControlServerOptions): ResultAsync<UnixControlServer, HubError> {
    const steps =
      options.steps ??
      socketStepsFor(process.platform, options.onWarning, options.otherTopFolders ?? []);
    return steps.prepare(options.socketPath).andThen(() => {
      const server = createServer();
      const instance = new UnixControlServer(options, steps, server);
      const listening = new Promise<Result<void, HubError>>((resolve) => {
        server.once("error", (error) => {
          resolve(
            err({ kind: "control", origin: ORIGIN, message: `cannot listen: ${error.message}` }),
          );
        });
        server.listen(options.socketPath, () => {
          resolve(ok(undefined));
        });
      });
      return ResultAsync.fromSafePromise(listening)
        .andThen((listened) => listened)
        .andThen(() =>
          steps
            .secure(options.socketPath)
            .asyncAndThen(() => okAsync(instance))
            .orElse((error) => instance.#stopListening().andThen(() => errAsync(error))),
        );
    });
  }

  /** A line refused before the core saw it: an `inputRejected` input, so the core records it. */
  #rejected(rejection: Rejection): void {
    this.#sink?.({
      kind: "inputRejected",
      rejection: { source: "control", ...rejection, issues: [...rejection.issues] },
    });
    this.#options.onRejected?.(rejection);
  }

  listen(sink: EventSink): void {
    this.#sink = sink;
  }

  respond(request: RequestId, reply: ControlReply): void {
    const waiting = this.#requests.get(request);
    if (waiting === undefined) return;
    this.#requests.delete(request);
    const { connection, clientId } = waiting;
    connection.inHand = undefined;
    this.#reply(connection, clientId, this.#withWriterStatus(reply));
    this.#next(connection);
  }

  /** Whether `conn` is one of this server's connections (the shell's one counter, section 6). */
  has(conn: ConnId): boolean {
    return this.#find(conn) !== undefined;
  }

  /**
   * A download's chunk, or its failure, on the connection that asked: after the reply `{job}`,
   * with that reply's id (m2-design.md section 6). False when the connection is gone.
   */
  download(
    conn: ConnId,
    line:
      | { readonly fileChunk: FileChunkCommandBody }
      | { readonly fileFailed: { readonly job: number; readonly reason: "io" | "stopping" } },
  ): boolean {
    const connection = this.#find(conn);
    const id = connection?.lastReplied;
    if (connection === undefined || id === undefined) return false;
    const checked =
      "fileChunk" in line
        ? chunkLine.safeParse({ id, fileChunk: line.fileChunk })
        : fileFailedLine.safeParse({ id, kind: "fileFailed", ...line.fileFailed });
    if (!checked.success) return false;
    this.#write(connection, checked.data);
    return true;
  }

  #find(conn: ConnId): Connection | undefined {
    for (const connection of this.#connections) if (connection.conn === conn) return connection;
    return undefined;
  }

  stream(subscriber: SubscriberId, record: AuditRecord): void {
    const connection = this.#followers.get(subscriber);
    const follower = connection?.follower;
    if (connection === undefined || follower === undefined || !matches(follower.filter, record))
      return;
    if (connection.socket.writableLength > MAX_FOLLOW_BACKLOG_BYTES) {
      connection.socket.destroy();
      return;
    }
    const line = streamLine.safeParse({ id: follower.clientId, record: recordJson(record) });
    if (line.success) this.#write(connection, line.data);
  }

  /** Every streamed record goes to every follower whose filter it matches. */
  publish(record: AuditRecord): void {
    for (const subscriber of this.#followers.keys()) this.stream(subscriber, record);
  }

  /** The `--follow` streams open now. */
  followers(): readonly SubscriberId[] {
    return [...this.#followers.keys()];
  }

  /** Closes every connection and the socket, and removes the socket file. */
  close(): ResultAsync<void, HubError> {
    return this.#stopListening().andThen(() => this.#steps.remove(this.#options.socketPath));
  }

  #stopListening(): ResultAsync<void, HubError> {
    for (const connection of this.#connections) connection.socket.destroy();
    const closed = new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
    return ResultAsync.fromSafePromise(closed);
  }

  #accept(socket: Socket): void {
    const connection: Connection = {
      conn: this.#connIds.next(),
      socket,
      reader: new LineReader(MAX_REQUEST_LINE_BYTES),
      waiting: [],
      inHand: undefined,
      lastReplied: undefined,
      follower: undefined,
    };
    this.#connections.add(connection);
    socket.on("data", (chunk: Buffer) => {
      this.#received(connection, chunk);
    });
    socket.on("end", () => {
      const partial = connection.reader.end();
      if (partial > 0) this.#rejected({ reason: "partial", bytes: partial, issues: [] });
      socket.end();
    });
    socket.on("close", () => {
      this.#forget(connection);
    });
    socket.on("error", () => {
      socket.destroy();
    });
  }

  #forget(connection: Connection): void {
    this.#connections.delete(connection);
    this.#options.uploads?.closed(connection.conn);
    if (connection.follower !== undefined) this.#followers.delete(connection.follower.id);
    for (const [request, waiting] of this.#requests) {
      if (waiting.connection === connection) this.#requests.delete(request);
    }
  }

  #received(connection: Connection, chunk: Uint8Array): void {
    for (const event of connection.reader.push(chunk)) {
      if (event.kind === "tooLong") {
        this.#rejected({ reason: "tooLong", bytes: event.bytes, issues: [] });
        this.#reply(
          connection,
          UNREAD_REQUEST_ID,
          refusal(`a request line has at most ${MAX_REQUEST_LINE_BYTES} bytes`),
        );
        connection.socket.end();
        return;
      }
      if (connection.follower !== undefined) {
        this.#rejected({ reason: "following", bytes: event.text.length, issues: [] });
        continue;
      }
      if (connection.waiting.length >= MAX_WAITING_REQUESTS) {
        this.#rejected({ reason: "tooMany", bytes: event.text.length, issues: [] });
        this.#reply(
          connection,
          UNREAD_REQUEST_ID,
          refusal("too many requests waiting on one connection"),
        );
        connection.socket.end();
        return;
      }
      connection.waiting.push(event.text);
    }
    this.#next(connection);
  }

  /** Takes the next waiting line, unless a request is in hand or the connection follows. */
  #next(connection: Connection): void {
    while (connection.inHand === undefined && connection.follower === undefined) {
      const text = connection.waiting.shift();
      if (text === undefined) return;
      const request = this.#parse(connection, text);
      if (request !== undefined) this.#take(connection, request);
    }
  }

  #parse(connection: Connection, text: string): RequestLine | undefined {
    const bytes = Buffer.byteLength(text);
    const json = parseJson(text, "control", ORIGIN);
    if (json.isErr()) {
      this.#rejected({ reason: "notJson", bytes, issues: [] });
      this.#reply(connection, UNREAD_REQUEST_ID, refusal("a request is one line of JSON"));
      return undefined;
    }
    const parsed = requestLine.safeParse(json.value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`);
      this.#rejected({ reason: "badShape", bytes, issues });
      this.#reply(
        connection,
        idIn(json.value),
        refusal(`not a request this hub knows (${issues.join("; ")})`),
      );
      return undefined;
    }
    return parsed.data;
  }

  #take(connection: Connection, line: RequestLine): void {
    const sink = this.#sink;
    if (sink === undefined) {
      this.#reply(connection, line.id, {
        ok: false,
        error: { code: "failed", message: "the hub is starting: try again" },
      });
      return;
    }
    if (line.command.kind === "fileChunk") {
      // The shell's own (m2-design.md section 6), never the core's: kept per connection.
      const { job, n, data, end } = line.command;
      const chunk = end === undefined ? { job, n, data } : { job, n, data, end };
      const uploads = this.#options.uploads;
      if (uploads === undefined) {
        this.#reply(connection, line.id, FILE_CHUNK_NOT_BUILT);
        return;
      }
      // In hand until its file call has settled, off the loop (`uploads.ts`), so the connection's
      // next line waits for this answer as for any request's: one chunk in flight, in order.
      const request = requestId(this.#nextRequest++);
      connection.inHand = request;
      void uploads.chunk(connection.conn, chunk).then((outcome) => {
        if (connection.inHand !== request || this.#find(connection.conn) === undefined) return;
        connection.inHand = undefined;
        this.#reply(connection, line.id, controlChunkReply(outcome));
        this.#next(connection);
      });
      return;
    }
    const command = typedCommand(line.command);
    if (command === undefined) return;
    const request = requestId(this.#nextRequest++);
    if (command.kind !== "log") {
      // Waiting before the core sees it, so an answer made at once still finds its client.
      connection.inHand = request;
      this.#requests.set(request, { connection, clientId: line.id });
      sink({ kind: "command", request, conn: connection.conn, actor: line.actor, command });
      return;
    }
    sink({ kind: "command", request, conn: connection.conn, actor: line.actor, command });
    const query: LogQuery = {
      ...(command.device === undefined ? {} : { device: command.device }),
      ...(command.since === undefined ? {} : { since: command.since }),
      ...(command.logKind === undefined ? {} : { logKind: command.logKind }),
    };
    const device =
      command.device === undefined ? undefined : this.#options.deviceIdOf(command.device);
    if (command.device !== undefined && device === undefined) {
      this.#reply(connection, line.id, {
        ok: false,
        error: {
          code: "unknownDevice",
          message: `no device is called ${command.device}`,
          names: [command.device],
        },
      });
      return;
    }
    const read = this.#options.logQuery(query);
    if (read.isErr()) {
      this.#reply(connection, line.id, {
        ok: false,
        error: { code: "failed", message: `the log could not be read: ${read.error.message}` },
      });
      return;
    }
    this.#reply(connection, line.id, {
      ok: true,
      result: { kind: "log", records: read.value.map(recordJson) },
    });
    if (command.follow) {
      const id = this.#nextSubscriber++ as SubscriberId;
      connection.follower = {
        id,
        clientId: line.id,
        filter: { device, since: command.since, logKind: command.logKind },
      };
      this.#followers.set(id, connection);
    }
  }

  #withWriterStatus(reply: ControlReply): ControlReply {
    if (!reply.ok || reply.result.kind !== "status") return reply;
    const status = this.#options.writerStatus();
    return {
      ok: true,
      result: {
        ...reply.result,
        lastCommitMs: status.lastCommitMs,
        stagedItems: status.stagedItems,
        databaseBytes: status.databaseBytes,
        historyShortened: status.historyShortened,
        longestTurnMs: this.#options.longestTurnMs?.() ?? 0,
      },
    };
  }

  #reply(connection: Connection, clientId: number, reply: ControlReply): void {
    connection.lastReplied = clientId;
    const line = replyLine.safeParse({ id: clientId, reply });
    if (line.success) {
      this.#write(connection, line.data);
      return;
    }
    this.#rejected({
      reason: "badReply",
      bytes: 0,
      issues: line.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`),
    });
    this.#write(connection, {
      id: clientId,
      reply: {
        ok: false,
        error: { code: "failed", message: "the hub made a reply it could not send" },
      },
    });
  }

  #write(connection: Connection, value: unknown): void {
    if (!connection.socket.writable) return;
    connection.socket.write(`${JSON.stringify(value)}\n`);
  }
}

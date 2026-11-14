/**
 * `--bench-lockstep <socket>` (hub-design.md section 11, "Lockstep: the wire"): the hub connects
 * to the controller's Unix socket and takes one JSON message a line. The first must be `start`;
 * every later one is handled in order, and each `advance` or `stop` is answered at once. A line
 * that is not a message, or that the hub cannot take, is answered `error` and the hub exits 65
 * with nothing more committed. The controller closing the socket ends the hub the same way
 * (exit 0), as a kill would: only `stop` is a clean stop.
 *
 * Bun's socket writes what the kernel takes and returns the count; the rest is the caller's to
 * keep. So every answer goes through one queue, written on as the socket drains, and the hub
 * exits only once the queue is empty: an `idle` larger than the socket's buffer (8 KB on macOS)
 * once lost its tail, and the controller waited for a line end that never came.
 */
import type { Socket } from "bun";
import { lockstepToHub, type LockstepFromHub } from "../../control-protocol/index.ts";
import { parseJson } from "../safe/json.ts";
import { LockstepHub } from "./hub.ts";

const ORIGIN = "shell/lockstep/wire";
/** Exit codes: done (a stop, or the socket closed), and a line the hub could not take. */
const EXIT_DONE = 0;
const EXIT_BAD_LINE = 65;
/** The longest line the hub takes: a frame is at most 1,024 bytes, so 2,048 hex digits ‡. */
const MAX_LINE_BYTES = 1_048_576;

export interface LockstepWireOptions {
  readonly socketPath: string;
  readonly dataDir: string;
  /** Where a word about a refusal goes, besides the `error` line. */
  readonly say: (message: string) => void;
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** Runs the hub on the controller's socket until `stop`, a bad line or the socket's close. */
export function runLockstep(options: LockstepWireOptions): Promise<number> {
  return new Promise<number>((resolve) => {
    let hub: LockstepHub | undefined;
    let buffer = "";
    let done = false;
    let chain: Promise<void> = Promise.resolve();
    const encoder = new TextEncoder();
    /** What is still to go, in order; written on as the socket drains. */
    let queued: Uint8Array[] = [];
    let ending: { readonly socket: Socket; readonly code: number } | undefined;
    const end = (socket: Socket | undefined, code: number): void => {
      socket?.end();
      resolve(code);
    };
    const flush = (socket: Socket): void => {
      while (queued.length > 0) {
        const head = queued[0] ?? new Uint8Array();
        const wrote = socket.write(head);
        // A closed socket takes nothing more, ever: what is left cannot be delivered.
        if (wrote < 0) queued = [];
        else if (wrote < head.length) {
          queued[0] = head.subarray(wrote);
          return;
        } else queued.shift();
      }
      if (ending !== undefined) end(ending.socket, ending.code);
    };
    const finish = (socket: Socket | undefined, code: number): void => {
      if (done) return;
      done = true;
      hub?.close();
      hub = undefined;
      if (socket === undefined || queued.length === 0) {
        end(socket, code);
        return;
      }
      ending = { socket, code };
      flush(socket);
    };
    const write = (socket: Socket, message: LockstepFromHub): void => {
      queued.push(encoder.encode(`${JSON.stringify(message)}\n`));
      flush(socket);
    };
    const refuse = (socket: Socket, message: string, line: string): void => {
      options.say(`lockstep: ${message}`);
      write(socket, { type: "error", message, line });
      finish(socket, EXIT_BAD_LINE);
    };
    const take = async (socket: Socket, line: string): Promise<void> => {
      if (done) return;
      const json = parseJson(line, "config", ORIGIN);
      if (json.isErr()) {
        refuse(socket, "not one line of JSON", line);
        return;
      }
      const parsed = lockstepToHub.safeParse(json.value);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        refuse(socket, `not a lockstep message (${issues.join("; ")})`, line);
        return;
      }
      const message = parsed.data;
      if (hub === undefined) {
        if (message.type !== "start") {
          refuse(socket, "the first message must be start", line);
          return;
        }
        const started = await LockstepHub.start(message, { dataDir: options.dataDir });
        if (started.isErr()) {
          refuse(socket, `the hub could not start: ${started.error.message}`, line);
          return;
        }
        hub = started.value.hub;
        write(socket, started.value.idle);
        return;
      }
      const answered = hub.handle(message);
      if (answered.isErr()) {
        refuse(socket, answered.error.message, line);
        return;
      }
      for (const answer of answered.value) write(socket, answer);
      if (message.type === "stop") finish(socket, EXIT_DONE);
    };
    void Bun.connect({
      unix: options.socketPath,
      socket: {
        data: (socket, data) => {
          buffer += data.toString();
          if (buffer.length > MAX_LINE_BYTES && !buffer.includes("\n")) {
            refuse(socket, `a line has at most ${MAX_LINE_BYTES} bytes`, "");
            return;
          }
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim() === "") continue;
            // One message after another, in order, however the handling waits. A throw inside
            // is answered `error` like a line the hub cannot take: never silence.
            chain = chain.then(() =>
              take(socket, line).then(undefined, (thrown: unknown) => {
                refuse(socket, `the hub failed: ${describe(thrown)}`, line);
              }),
            );
          }
        },
        drain: (socket) => {
          flush(socket);
        },
        close: () => {
          void chain.then(() => {
            finish(undefined, EXIT_DONE);
          });
        },
        error: () => {
          finish(undefined, EXIT_DONE);
        },
      },
    }).catch(() => {
      options.say(`lockstep: cannot connect to ${options.socketPath}`);
      finish(undefined, EXIT_BAD_LINE);
    });
  });
}

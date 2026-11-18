/** Windows USB ports behind the same event stream and results as the Unix adapter. */
import { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import type { LinkError } from "../../ports/links.ts";
import {
  configuredPort,
  releaseSerial,
  serialCalls,
  serialWake,
  signalSerial,
  type WindowsSerialCalls,
} from "./ffi-windows-serial.ts";
import { linkError } from "./link-error.ts";
import { devicePath, type SerialLines } from "./serial-windows-layout.ts";
import type { SerialWorkerData } from "./worker-windows-serial.ts";
import type { WorkerReply } from "./worker-serial-transfer.ts";

const ORIGIN = "shell/safe/serial-windows";
export const WINDOWS_SERIAL = process.platform === "win32";

/** Uses one label for both explicit and automatically listed names of a Windows port. */
export function serialPath(path: string): string {
  return WINDOWS_SERIAL ? (devicePath(path)?.slice(4) ?? path) : path;
}

type WorkerJob = Omit<Extract<SerialWorkerData, { kind: "port" }>, "stopping"> | { kind: "watch" };

/** Starts the source worker or the explicitly embedded entry in the installed executable. */
function start(job: WorkerJob, stopping: Int32Array): Worker {
  const workerData: SerialWorkerData = { ...job, stopping };
  // Bun 1.4.2 resolves embedded Worker entries by source path relative to the compile root.
  const entry = /(?:^|[\\/])~BUN[\\/]/u.test(Bun.main)
    ? "./src/shell/safe/worker-windows-serial.ts"
    : new URL("./worker-windows-serial.ts", import.meta.url);
  return new Worker(entry, {
    workerData,
    transferList: job.kind === "port" ? [job.incoming] : [],
  });
}

/** A configured handle with all reads and writes owned by its worker. */
export class WindowsSerialPort {
  readonly stream = new EventEmitter();
  readonly #stopping = new Int32Array(new SharedArrayBuffer(4));
  readonly #done = Promise.withResolvers<undefined>();
  readonly closed = this.#done.promise;
  readonly #worker: Worker;
  #pending: ReturnType<typeof Promise.withResolvers<Result<void, LinkError>>> | undefined;
  #failure: LinkError | undefined;

  constructor(
    readonly path: string,
    job: Extract<WorkerJob, { kind: "port" }>,
    private readonly outgoing: MessagePort,
    private readonly signal: (event: "stop" | "write") => void,
    release: () => void,
    startWorker: typeof start,
  ) {
    this.#worker = startWorker(job, this.#stopping);
    this.stream.on("error", () => undefined);
    this.#worker.on("message", (reply: WorkerReply) => {
      switch (reply.kind) {
        case "data":
          if (Atomics.load(this.#stopping, 0) === 0)
            this.stream.emit("data", Buffer.from(reply.bytes));
          break;
        case "written":
          this.#pending?.resolve(ok(undefined));
          this.#pending = undefined;
          break;
        case "failed":
          this.#failure = linkError("writeFailed", ORIGIN, `${path}: ${reply.message}`);
          break;
        case "ready":
          this.stream.emit("ready");
          break;
      }
    });
    this.#worker.on("error", (error) => {
      this.#failure = linkError("writeFailed", ORIGIN, `serial worker for ${path}`, error);
    });
    this.#worker.once("exit", () => {
      this.outgoing.close();
      const released = Result.fromThrowable(release, (error) =>
        linkError("closed", ORIGIN, `close serial port ${path}`, error),
      )();
      if (released.isErr()) this.#failure ??= released.error;
      const failure = this.#failure;
      Atomics.store(this.#stopping, 0, 1);
      this.#pending?.resolve(err(failure ?? linkError("closed", ORIGIN, `${path} closed`)));
      this.#pending = undefined;
      this.#done.resolve(undefined);
      // Let the send queue report failures with their references before closing the link.
      queueMicrotask(() => {
        if (failure !== undefined) this.stream.emit("error", failure);
        this.stream.emit("close");
      });
    });
  }

  /** Queues the adapter's one in-flight write without blocking the hub. */
  write(bytes: Uint8Array): ResultAsync<void, LinkError> {
    if (Atomics.load(this.#stopping, 0) !== 0)
      return errAsync(linkError("closed", ORIGIN, `${this.path} closed`));
    if (this.#pending !== undefined)
      return errAsync(linkError("queueFull", ORIGIN, `${this.path} has a pending write`));
    const pending = Promise.withResolvers<Result<void, LinkError>>();
    this.#pending = pending;
    const posted = Result.fromThrowable(
      () => {
        this.outgoing.postMessage(bytes);
      },
      (error) => linkError("writeFailed", ORIGIN, `write to serial port ${this.path}`, error),
    )();
    if (posted.isErr()) {
      this.#pending = undefined;
      pending.resolve(err(posted.error));
    } else {
      this.#wake("write");
      if (this.#failure !== undefined) this.close();
    }
    return new ResultAsync(pending.promise);
  }

  /** Wakes the worker to cancel and drain its requests before the exit handler frees handles. */
  close(): void {
    if (Atomics.exchange(this.#stopping, 0, 1) === 0) this.#wake("stop");
  }

  #wake(event: "stop" | "write"): void {
    const sent = Result.fromThrowable(
      () => {
        this.signal(event);
      },
      (error) => linkError("writeFailed", ORIGIN, `wake serial port ${this.path}`, error),
    )();
    if (sent.isErr()) this.#failure ??= sent.error;
  }
}

interface WindowsSerialOptions {
  readonly system?: WindowsSerialCalls;
  readonly startWorker?: typeof start;
  readonly lines?: SerialLines;
}

/** Opens and configures the port before it can emit a byte. */
export function openWindowsSerial(
  path: string,
  options: WindowsSerialOptions = {},
): Result<WindowsSerialPort, LinkError> {
  return Result.fromThrowable(
    () => {
      const calls = options.system ?? serialCalls();
      const handle = configuredPort(path, calls, options.lines);
      const handles = [handle];
      let attached = false;
      try {
        const wake = serialWake(calls);
        handles.push(wake.stop, wake.write);
        const { port1, port2 } = new MessageChannel();
        try {
          const port = new WindowsSerialPort(
            path,
            { kind: "port", handle, wake, incoming: port2 },
            port1,
            (event) => {
              signalSerial(calls, wake[event]);
            },
            () => {
              releaseSerial(calls, ...handles);
            },
            options.startWorker ?? start,
          );
          attached = true;
          return port;
        } finally {
          if (!attached) {
            port1.close();
            port2.close();
          }
        }
      } finally {
        if (!attached) releaseSerial(calls, ...handles);
      }
    },
    (error) => linkError("writeFailed", ORIGIN, `open serial port ${path}`, error),
  )();
}

/** Sample once, on successful registration, then only on notified changes. */
export function watchWindowsSerial(
  ready: () => void,
  changed: () => void,
  failed: (error: LinkError) => void,
): Result<{ close(): Promise<void> }, LinkError> {
  const stopping = new Int32Array(new SharedArrayBuffer(4));
  return Result.fromThrowable(
    () => {
      const worker = start({ kind: "watch" }, stopping);
      const exited = Promise.withResolvers<undefined>();
      worker.on("message", (message: { kind: "ready" | "changed" }) => {
        if (Atomics.load(stopping, 0) !== 0) return;
        if (message.kind === "ready") ready();
        else changed();
      });
      worker.on("error", (error) => {
        failed(linkError("closed", ORIGIN, "watch Windows serial ports", error));
      });
      worker.once("exit", () => {
        exited.resolve(undefined);
      });
      return {
        close: () => {
          Atomics.store(stopping, 0, 1);
          return exited.promise;
        },
      };
    },
    (error) => linkError("closed", ORIGIN, "start Windows serial watcher", error),
  )();
}

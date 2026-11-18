/** Windows USB ports behind the same event stream and results as the Unix adapter. */
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import type { LinkError } from "../../ports/links.ts";
import {
  configuredPort,
  releasePort,
  serialCalls,
  type WindowsSerialCalls,
} from "./ffi-windows-serial.ts";
import { linkError } from "./link-error.ts";
import { devicePath } from "./serial-windows-layout.ts";
import type { SerialWorkerData } from "./worker-windows-serial.ts";
import type { WorkerReply } from "./worker-serial-transfer.ts";

const ORIGIN = "shell/safe/serial-windows";
export const WINDOWS_SERIAL = process.platform === "win32";

/** Uses one label for both explicit and automatically listed names of a Windows port. */
export function serialPath(path: string): string {
  return WINDOWS_SERIAL ? (devicePath(path)?.slice(4) ?? path) : path;
}

type WorkerJob = { readonly kind: "port"; readonly handle: bigint } | { readonly kind: "watch" };

/** Starts the source worker or the explicitly embedded entry in the installed executable. */
function start(job: WorkerJob, stopping: Int32Array): Worker {
  const workerData: SerialWorkerData = { ...job, stopping };
  // Bun 1.4.2 resolves embedded Worker entries by source path relative to the compile root.
  const entry = /(?:^|[\\/])~BUN[\\/]/u.test(Bun.main)
    ? "./src/shell/safe/worker-windows-serial.ts"
    : new URL("./worker-windows-serial.ts", import.meta.url);
  return new Worker(entry, { workerData });
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
    handle: bigint,
    release: () => void,
    startWorker: typeof start,
  ) {
    this.#worker = startWorker({ kind: "port", handle }, this.#stopping);
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
        this.#worker.postMessage(bytes);
      },
      (error) => linkError("writeFailed", ORIGIN, `write to serial port ${this.path}`, error),
    )();
    if (posted.isErr()) {
      this.#pending = undefined;
      pending.resolve(err(posted.error));
    }
    return new ResultAsync(pending.promise);
  }

  /** Stops after the pending Win32 call returns; the exit handler releases the handle. */
  close(): void {
    Atomics.store(this.#stopping, 0, 1);
  }
}

/** Opens and configures the port before it can emit a byte. */
export function openWindowsSerial(
  path: string,
  system?: WindowsSerialCalls,
  startWorker = start,
): Result<WindowsSerialPort, LinkError> {
  return Result.fromThrowable(
    () => {
      const calls = system ?? serialCalls();
      const handle = configuredPort(path, calls);
      /** The caller owns the handle until the worker can take I/O. */
      const release = (): void => {
        releasePort(calls, handle);
      };
      try {
        return new WindowsSerialPort(path, handle, release, startWorker);
      } catch (error) {
        release();
        throw error;
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

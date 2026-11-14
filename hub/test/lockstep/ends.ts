/**
 * The hub's end of the lockstep wire, for the controller (`controller.ts`): the `LockstepHub` in
 * this process, or a real hub process (`src/shell/main.ts --bench-lockstep <socket>`) on a Unix
 * socket the controller listens on, one JSON message per line both ways (section 11).
 */
import { join } from "node:path";
import {
  type LockstepFromHub,
  lockstepFromHub,
  type LockstepToHub,
} from "../../src/control-protocol/index.ts";
import { LockstepHub, type LockstepOptions } from "../../src/shell/lockstep/hub.ts";
import { spawnTracked } from "../world/processes.ts";
import type { HubEnd } from "./controller.ts";

/** The hub in this process: what a real one does, with no socket in between. */
export class InProcessEnd implements HubEnd {
  readonly dataDir: string;
  readonly options: Omit<LockstepOptions, "dataDir">;
  hub: LockstepHub | undefined;

  constructor(dataDir: string, options: Omit<LockstepOptions, "dataDir"> = {}) {
    this.dataDir = dataDir;
    this.options = options;
  }

  async send(message: LockstepToHub): Promise<readonly LockstepFromHub[]> {
    if (message.type === "start") {
      this.hub?.close();
      const started = await LockstepHub.start(message, { ...this.options, dataDir: this.dataDir });
      if (started.isErr())
        return [{ type: "error", message: started.error.message, line: JSON.stringify(message) }];
      this.hub = started.value.hub;
      return [started.value.idle];
    }
    const hub = this.hub;
    if (hub === undefined)
      return [{ type: "error", message: "no hub: start first", line: JSON.stringify(message) }];
    const answered = hub.handle(message);
    if (answered.isErr())
      return [{ type: "error", message: answered.error.message, line: JSON.stringify(message) }];
    if (message.type === "stop") {
      hub.close();
      this.hub = undefined;
    }
    return answered.value;
  }

  /** The hub killed: its database closed as it is, nothing more committed. */
  kill(): void {
    this.hub?.close();
    this.hub = undefined;
  }
}

const MAIN = join(import.meta.dir, "..", "..", "src", "shell", "main.ts");

/** A real hub process, started on the controller's socket; started again after a stop or kill. */
export class ProcessEnd implements HubEnd {
  readonly dataDir: string;
  readonly socketPath: string;
  #server: ReturnType<typeof Bun.listen<undefined>> | undefined;
  #socket: Bun.Socket | undefined;
  #process: Bun.Subprocess | undefined;
  #buffer = "";
  #lines: string[] = [];
  #waiting: (() => void) | undefined;
  #connected: (() => void) | undefined;

  constructor(dataDir: string, socketPath: string) {
    this.dataDir = dataDir;
    this.socketPath = socketPath;
  }

  #listen(): void {
    if (this.#server !== undefined) return;
    this.#server = Bun.listen({
      unix: this.socketPath,
      socket: {
        open: (socket) => {
          this.#socket = socket;
          this.#connected?.();
        },
        data: (_socket, data) => {
          this.#buffer += data.toString();
          const parts = this.#buffer.split("\n");
          this.#buffer = parts.pop() ?? "";
          this.#lines.push(...parts.filter((p) => p !== ""));
          this.#waiting?.();
        },
        close: () => {
          this.#socket = undefined;
          this.#waiting?.();
        },
      },
    });
  }

  async #line(): Promise<string | undefined> {
    for (let rounds = 0; rounds < 1000; rounds++) {
      const line = this.#lines.shift();
      if (line !== undefined) return line;
      if (this.#socket === undefined && this.#process === undefined) return undefined;
      await Promise.race([
        new Promise<void>((resolve) => {
          this.#waiting = resolve;
        }),
        Bun.sleep(10_000),
      ]);
    }
    return undefined;
  }

  async send(message: LockstepToHub): Promise<readonly LockstepFromHub[]> {
    if (message.type === "start") {
      this.#listen();
      const connected = new Promise<void>((resolve) => {
        this.#connected = resolve;
      });
      this.#process = spawnTracked(
        ["bun", MAIN, "--data", this.dataDir, "--bench-lockstep", this.socketPath],
        {
          stdout: "ignore",
          stderr: "inherit",
        },
      );
      await Promise.race([connected, Bun.sleep(15_000)]);
    }
    const socket = this.#socket;
    if (socket === undefined)
      return [{ type: "error", message: "the hub did not connect", line: "" }];
    socket.write(`${JSON.stringify(message)}\n`);
    const answers =
      message.type === "start" || message.type === "advance" ? 1 : message.type === "stop" ? 2 : 0;
    const out: LockstepFromHub[] = [];
    for (let n = 0; n < answers; n++) {
      const line = await this.#line();
      if (line === undefined)
        return [...out, { type: "error", message: "the hub closed the socket", line: "" }];
      const parsed = lockstepFromHub.safeParse(JSON.parse(line));
      if (!parsed.success)
        return [...out, { type: "error", message: `not a hub message: ${line}`, line }];
      out.push(parsed.data);
      if (parsed.data.type === "error") return out;
    }
    if (message.type === "stop") await this.#exited();
    return out;
  }

  async #exited(): Promise<number | undefined> {
    const code = await this.#process?.exited;
    this.#process = undefined;
    this.#socket = undefined;
    return code;
  }

  /** `kill -9`: nothing more is committed. */
  async kill(): Promise<void> {
    this.#process?.kill(9);
    await this.#exited();
  }

  async close(): Promise<void> {
    await this.kill();
    this.#server?.stop(true);
    this.#server = undefined;
  }
}

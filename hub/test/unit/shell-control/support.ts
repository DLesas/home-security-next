/**
 * A real control socket for tests: a short temporary data folder (a socket path must stay under
 * 104 bytes), a server with recording callbacks, and a raw client that writes bytes and reads
 * lines.
 */
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "neverthrow";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import type { HubEvent } from "../../../src/core/model/events.ts";
import type { LogQuery } from "../../../src/ports/reader.ts";
import {
  type ControlServerOptions,
  type Rejection,
  UnixControlServer,
} from "../../../src/shell/control/server.ts";
import { noteOutput } from "../setup/support/leak-guard.ts";

export interface TestFolder {
  readonly folder: string;
  readonly socket: string;
  remove(): void;
}

export function testFolder(): TestFolder {
  const base = mkdtempSync(join(tmpdir(), "hsn-"));
  const folder = join(base, "data");
  return {
    folder,
    socket: join(folder, "control.sock"),
    remove: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export interface Recorded {
  /** The `command` inputs the server gave the core. */
  readonly events: HubEvent[];
  /** The `inputRejected` inputs it gave the core, one per refused line. */
  readonly refused: HubEvent[];
  readonly rejections: Rejection[];
  readonly queries: LogQuery[];
}

export async function openServer(
  socket: string,
  options: Partial<Omit<ControlServerOptions, "socketPath">> & {
    readonly records?: readonly AuditRecord[];
  } = {},
): Promise<{ readonly server: UnixControlServer; readonly recorded: Recorded }> {
  const recorded: Recorded = { events: [], refused: [], rejections: [], queries: [] };
  const opened = await UnixControlServer.open({
    socketPath: socket,
    logQuery:
      options.logQuery ??
      ((query) => {
        recorded.queries.push(query);
        return ok(options.records ?? []);
      }),
    deviceIdOf: options.deviceIdOf ?? ((name) => (name === "front" ? 3 : undefined)),
    writerStatus:
      options.writerStatus ??
      (() => ({
        lastCommitMs: 1_700_000_000_000,
        stagedItems: 4,
        databaseBytes: 12_000_000,
        historyShortened: false,
      })),
    onRejected:
      options.onRejected ??
      ((rejection) => {
        recorded.rejections.push(rejection);
        noteOutput(JSON.stringify(rejection));
      }),
  });
  expect(opened.isOk() ? "opened" : opened.error.message).toBe("opened");
  const server = opened._unsafeUnwrap();
  server.listen((event) => {
    if (event.kind === "inputRejected") recorded.refused.push(event);
    else recorded.events.push(event);
  });
  return { server, recorded };
}

/** A raw client: writes what it is given, collects every line, and knows when it was closed. */
export class RawClient {
  readonly lines: string[] = [];
  closed = false;
  readonly #socket: Socket;
  #held = "";
  readonly #waiters: (() => void)[] = [];

  constructor(path: string) {
    this.#socket = connect(path);
    this.#socket.setEncoding("utf8");
    this.#socket.on("data", (chunk: string) => {
      this.#held += chunk;
      for (let at = this.#held.indexOf("\n"); at !== -1; at = this.#held.indexOf("\n")) {
        const line = this.#held.slice(0, at);
        noteOutput(line);
        this.lines.push(line);
        this.#held = this.#held.slice(at + 1);
      }
      this.#wake();
    });
    this.#socket.on("close", () => {
      this.closed = true;
      this.#wake();
    });
    this.#socket.on("error", () => undefined);
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  connected(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.#socket.connecting) resolve();
      else
        this.#socket.once("connect", () => {
          resolve();
        });
    });
  }

  write(text: string | Uint8Array): void {
    this.#socket.write(text);
  }

  end(): void {
    this.#socket.end();
  }

  /** Waits until `check` holds or 2 s pass. */
  async until(check: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 2000;
    while (!check() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    return check();
  }

  /** The lines as JSON. */
  json(): unknown[] {
    return this.lines.map((line) => JSON.parse(line) as unknown);
  }
}

/** Lets the event loop run, for things that should not happen. */
export function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

#!/usr/bin/env bun
/**
 * Spike W2's server: the smallest stand-in for the hub's control socket. One line protocol for
 * every transport: when a secret is set, the first line must be exactly the secret, otherwise the
 * server answers "refused" and closes; then "ping" is answered "pong". Every line received is kept
 * (`seen`), so a test can show what a browser's request looked like when it was refused.
 *
 * Imported by w2.ts; also run on its own by W3 as a Windows service:
 *
 *   bun server.ts <kind> <address> <readyFile> [secretFile]
 *
 * kind: unix-node | unix-bun | pipe-node | tcp-secret. For tcp-secret the address is ignored and
 * the port chosen is written to readyFile with the rest.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import net from "node:net";

export type ServerKind = "unix-node" | "unix-bun" | "pipe-node" | "tcp-secret";

export interface Running {
  readonly kind: ServerKind;
  /** The path or pipe listened on, or "127.0.0.1:<port>". */
  readonly address: string;
  readonly port: number | undefined;
  /** Every line received, in order, across connections. */
  readonly seen: string[];
  close(): Promise<void>;
}

/** Answers one connection's lines. Returns what to write back for `line`, and whether to close. */
function answerer(secret: string | undefined, seen: string[]) {
  let authenticated = secret === undefined;
  return (line: string): { reply: string | undefined; close: boolean } => {
    seen.push(line.length > 200 ? `${line.slice(0, 200)}…` : line);
    if (!authenticated) {
      if (line === secret) {
        authenticated = true;
        return { reply: undefined, close: false };
      }
      return { reply: "refused\n", close: true };
    }
    if (line === "ping") return { reply: "pong\n", close: false };
    return { reply: "refused\n", close: true };
  };
}

function splitter(onLine: (line: string) => boolean) {
  let buffer = "";
  return (chunk: string): void => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).replace(/\r$/u, "");
      buffer = buffer.slice(at + 1);
      if (!onLine(line)) {
        buffer = "";
        return;
      }
    }
  };
}

export function listen(
  kind: ServerKind,
  address: string,
  secret?: string,
): Promise<Running> {
  const seen: string[] = [];
  if (kind === "unix-bun") {
    return new Promise((resolve, reject) => {
      try {
        const server = Bun.listen<{ feed: (chunk: string) => void }>({
          unix: address,
          socket: {
            open(socket) {
              const answer = answerer(secret, seen);
              socket.data = {
                feed: splitter((line) => {
                  const { reply, close } = answer(line);
                  if (reply !== undefined) socket.write(reply);
                  if (close) socket.end();
                  return !close;
                }),
              };
            },
            data(socket, data) {
              socket.data.feed(data.toString());
            },
          },
        });
        resolve({
          kind,
          address,
          port: undefined,
          seen,
          close: async () => {
            server.stop(true);
          },
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const answer = answerer(secret, seen);
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      socket.on(
        "data",
        splitter((line) => {
          const { reply, close } = answer(line);
          if (reply !== undefined) socket.write(reply);
          if (close) socket.end();
          return !close;
        }),
      );
    });
    server.once("error", reject);
    const ready = (): void => {
      const bound = server.address();
      const port = typeof bound === "object" && bound !== null ? bound.port : undefined;
      resolve({
        kind,
        address: kind === "tcp-secret" ? `127.0.0.1:${port}` : address,
        port,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      });
    };
    if (kind === "tcp-secret") server.listen(0, "127.0.0.1", ready);
    else server.listen(address, ready);
  });
}

/** A new secret: 32 random bytes as hex, as option (c) would keep in its file. */
export function newSecret(): string {
  return randomBytes(32).toString("hex");
}

if (import.meta.main) {
  const [kind = "", address = "", readyFile = "", secretFile = ""] = process.argv.slice(2);
  const secret = secretFile === "" ? undefined : newSecret();
  if (secret !== undefined) writeFileSync(secretFile, `${secret}\n`);
  const running = await listen(kind as ServerKind, address, secret).catch((e: unknown) => {
    writeFileSync(readyFile, `${JSON.stringify({ ok: false, error: String(e) })}\n`);
    process.exit(1);
  });
  writeFileSync(
    readyFile,
    `${JSON.stringify({ ok: true, kind, address: running.address, port: running.port, pid: process.pid })}\n`,
  );
  const stop = async (): Promise<void> => {
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

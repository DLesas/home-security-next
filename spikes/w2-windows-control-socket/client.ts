#!/usr/bin/env bun
/**
 * Spike W2's client, run as the interactive user or as the second local account. It depends on
 * nothing but Bun and Node's built-in modules, so it can be copied next to a copy of bun.exe into
 * a folder the second account can read.
 *
 *   bun client.ts <mode> <target> [secretFile] <resultFile>
 *
 * Modes:
 *   whoami                  the account this process runs as (target unused)
 *   unix-node <path>        net.connect(path), "ping" -> "pong"
 *   unix-bun <path>         Bun.connect({ unix: path }), "ping" -> "pong"
 *   pipe-node <pipe>        net.connect("\\.\pipe\..."), "ping" -> "pong"
 *   tcp-secret <port>       reads secretFile, sends it, then "ping" -> "pong"
 *   tcp-wrong <port>        sends a wrong secret, then "ping"
 *   read-file <path>        reads a file (the secret, or a file in the data folder)
 *   list-dir <path>         lists a folder
 *
 * It writes one JSON object to resultFile (and stdout) and always exits 0: what happened is the
 * result, not the exit code.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { userInfo } from "node:os";

const argv = process.argv.slice(2);
const [mode = "", target = ""] = argv;
const resultFile = argv.length >= 3 ? (argv.at(-1) ?? "") : "";
const secretFile = argv.length >= 4 ? (argv[2] ?? "") : "";
const TIMEOUT_MS = 5000;

interface Outcome {
  readonly mode: string;
  readonly target: string;
  readonly user: string;
  readonly connected?: boolean;
  readonly reply?: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly detail?: unknown;
}

function who(): string {
  try {
    return userInfo().username;
  } catch (e) {
    return `unknown (${String(e)})`;
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === undefined ? e.message : `${code}: ${e.message}`;
  }
  return String(e);
}

/** Connects with node:net, sends `lines`, and collects what comes back until close or timeout. */
function nodeExchange(
  options: net.NetConnectOpts,
  lines: readonly string[],
): Promise<{ connected: boolean; reply: string; error?: string }> {
  return new Promise((resolve) => {
    let connected = false;
    let reply = "";
    let settled = false;
    const done = (error?: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(error === undefined ? { connected, reply } : { connected, reply, error });
    };
    const socket = net.connect(options, () => {
      connected = true;
      socket.write(lines.map((l) => `${l}\n`).join(""));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      reply += chunk;
      if (reply.includes("pong") || reply.includes("refused")) done();
    });
    socket.on("error", (e) => done(errorText(e)));
    socket.on("close", () => done());
    setTimeout(() => done("timeout"), TIMEOUT_MS);
  });
}

async function bunExchange(path: string): Promise<{ connected: boolean; reply: string; error?: string }> {
  let reply = "";
  try {
    let resolveReply: () => void = () => undefined;
    const got = new Promise<void>((r) => {
      resolveReply = r;
    });
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_s, data) {
          reply += data.toString();
          if (reply.includes("pong")) resolveReply();
        },
        close() {
          resolveReply();
        },
        error() {
          resolveReply();
        },
      },
    });
    socket.write("ping\n");
    await Promise.race([got, Bun.sleep(TIMEOUT_MS)]);
    socket.end();
    return { connected: true, reply };
  } catch (e) {
    return { connected: false, reply, error: errorText(e) };
  }
}

async function main(): Promise<Outcome> {
  const user = who();
  const base = { mode, target, user };
  switch (mode) {
    case "whoami":
      return { ...base, ok: true };
    case "unix-node":
    case "pipe-node": {
      const r = await nodeExchange({ path: target }, ["ping"]);
      return { ...base, ...r, ok: r.reply.includes("pong") };
    }
    case "unix-bun": {
      const r = await bunExchange(target);
      return { ...base, ...r, ok: r.reply.includes("pong") };
    }
    case "tcp-secret": {
      let secret: string;
      try {
        secret = readFileSync(secretFile, "utf8").trim();
      } catch (e) {
        return { ...base, ok: false, error: `cannot read the secret: ${errorText(e)}` };
      }
      const r = await nodeExchange({ host: "127.0.0.1", port: Number(target) }, [secret, "ping"]);
      return { ...base, ...r, ok: r.reply.includes("pong") };
    }
    case "tcp-wrong": {
      const r = await nodeExchange({ host: "127.0.0.1", port: Number(target) }, [
        "0".repeat(64),
        "ping",
      ]);
      return { ...base, ...r, ok: r.reply.includes("pong") };
    }
    case "read-file": {
      try {
        const bytes = readFileSync(target);
        return { ...base, ok: true, detail: { bytes: bytes.length } };
      } catch (e) {
        return { ...base, ok: false, error: errorText(e) };
      }
    }
    case "list-dir": {
      try {
        return { ...base, ok: true, detail: { entries: readdirSync(target).length } };
      } catch (e) {
        return { ...base, ok: false, error: errorText(e) };
      }
    }
    default:
      return { ...base, ok: false, error: `unknown mode ${mode}` };
  }
}

const outcome = await main().catch(
  (e: unknown): Outcome => ({ mode, target, user: who(), ok: false, error: errorText(e) }),
);
const line = JSON.stringify(outcome);
console.log(line);
if (resultFile !== "") {
  try {
    writeFileSync(resultFile, `${line}\n`);
  } catch (e) {
    console.error(`client: cannot write ${resultFile}: ${errorText(e)}`);
  }
}
process.exit(0);

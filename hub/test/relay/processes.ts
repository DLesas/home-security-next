/**
 * The pieces of the relay work as the processes they run as on a host (docs/m4-design.md section
 * 11): the push role (`relay/src/push/main.ts`) against B3's stand-ins for Apple and Google, the
 * relay program (`relay/src/shell/main.ts`) from a configuration file written here in the form of
 * `relay/test/local.json`, the real hub (`hub/src/shell/main.ts`, through the tests' entry that
 * trusts `TEST_PUBLISHER_KEY`) on a temporary data folder, and a TCP pass-through between a hub
 * and its relay that can cut the link without stopping either and records when the hub last sent a
 * byte (the relay's "last contact").
 *
 * Every process is started with `spawnTracked`, so a failed test never leaves one running; each
 * one's whole standard error is kept (`Output`) and searched for secrets at the end (`leaks.ts`).
 * Every wait has a deadline and fails with what it waited for.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import type { Subprocess } from "bun";
import { exchange } from "../../cli/client.ts";
import { HUB_VERSION } from "../../src/shell/hub-facts.ts";
import { installPaths } from "../../launcher/src/layout.ts";
import { spawnTracked } from "../world/processes.ts";
import type { StandIns } from "../../../relay/test/push/helpers.ts";

export const REPO = join(import.meta.dir, "..", "..", "..");
export const HUB_DIR = join(REPO, "hub");
/** The hub's own `runHub`, trusting the tests' publisher key, the clock taken as synchronised. */
export const HUB_TEST_ENTRY = join(HUB_DIR, "test", "unit", "shell-main", "hub-with-test-key.ts");
export const HSN = join(HUB_DIR, "cli", "hsn.ts");
const RELAY_MAIN = join(REPO, "relay", "src", "shell", "main.ts");
const PUSH_MAIN = join(REPO, "relay", "src", "push", "main.ts");

/** A short folder under /tmp: Unix sockets' paths are limited to about 100 bytes. */
export function shortFolder(prefix: string): string {
  return mkdtempSync(`/tmp/${prefix}`);
}

/** Waits until `ready()` holds; false after `ms`. */
export async function waitFor(
  ready: () => boolean | Promise<boolean>,
  ms: number,
  everyMs = 20,
): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await ready()) return true;
    if (Date.now() > end) return false;
    await Bun.sleep(everyMs);
  }
}

/** Fails the test, naming what was not met, unless `ok`. */
export function check(ok: boolean, what: string): void {
  if (!ok) expect(what).toBe("met");
}

/** A free TCP port on loopback, at this moment. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port ?? 0;
  await server.stop(true);
  return port;
}

/** A process's standard error as it comes, kept whole. */
export class Output {
  #text = "";
  readonly done: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    this.done = (async () => {
      for await (const chunk of stream) this.#text += decoder.decode(chunk, { stream: true });
    })();
  }

  get text(): string {
    return this.#text;
  }

  /** The JSON lines (the relay's and the push role's logs). */
  lines(): Record<string, unknown>[] {
    // Whole lines only: the last may still be coming.
    return this.#text
      .split("\n")
      .slice(0, -1)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  count(needle: string): number {
    return this.#text.split(needle).length - 1;
  }
}

/** Every output any process here wrote, for the leak search at the end of a run. */
export const ALL_OUTPUT: Output[] = [];

function spawnWithOutput(
  cmd: string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): { readonly proc: Subprocess<"ignore", "ignore", "pipe">; readonly out: Output } {
  const proc = spawnTracked(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    cwd: options.cwd ?? REPO,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const out = new Output(proc.stderr);
  ALL_OUTPUT.push(out);
  return { proc, out };
}

// ----- The push role -----

export interface PushRoleOptions {
  /** The releases role's forwarding socket, for relay links' release frames (operated service). */
  readonly releasesSocket?: string;
  /** A TLS listener for self-hosted relays: `--listen 127.0.0.1:<port>` with this key pair. */
  readonly tls?: { readonly certPath: string; readonly keyPath: string; readonly port: number };
  readonly refusedRelays?: string;
}

/** The push role as its own process, on its local socket, pointed at the stand-ins. */
export class PushRole {
  readonly socket: string;
  #proc: Subprocess<"ignore", "ignore", "pipe"> | undefined;
  out: Output | undefined;

  constructor(
    readonly folder: string,
    readonly standIns: StandIns,
    readonly options: PushRoleOptions = {},
  ) {
    this.socket = join(folder, "push.sock");
  }

  /** `ws+unix://…:/v1/relay`, as the operated relay's configuration names it. */
  get url(): string {
    return `ws+unix://${this.socket}:/v1/relay`;
  }

  async start(): Promise<void> {
    const s = this.standIns;
    const ca = join(this.folder, "standin-ca.pem");
    writeFileSync(ca, s.tls.cert);
    const o = this.options;
    // No `--apns-topic`: the topic is the deployment's bundle identifier (the one configuration).
    const { proc, out } = spawnWithOutput([
      process.execPath,
      PUSH_MAIN,
      "--socket",
      this.socket,
      "--apns-key",
      s.apnsKeyPath,
      "--apns-key-id",
      s.apnsKey.keyId,
      "--apns-team",
      s.apnsKey.teamId,
      "--fcm-account",
      s.fcmAccountPath,
      "--apns-production",
      s.apns.origin,
      "--apns-development",
      s.apns.origin,
      "--fcm-origin",
      s.fcm.origin,
      "--test-ca",
      ca,
      ...(o.releasesSocket === undefined ? [] : ["--releases-socket", o.releasesSocket]),
      ...(o.refusedRelays === undefined ? [] : ["--refused-relays", o.refusedRelays]),
      ...(o.tls === undefined
        ? []
        : [
            "--listen",
            `127.0.0.1:${String(o.tls.port)}`,
            "--tls-cert",
            o.tls.certPath,
            "--tls-key",
            o.tls.keyPath,
          ]),
    ]);
    this.#proc = proc;
    this.out = out;
    check(
      await waitFor(() => out.text.includes('"started"'), 15_000),
      `the push role started:\n${out.text}`,
    );
  }

  async stop(): Promise<number> {
    const proc = this.#proc;
    if (proc === undefined) return -1;
    proc.kill("SIGTERM");
    this.#proc = undefined;
    return await proc.exited;
  }
}

// ----- The relay program -----

export interface RelayProgramOptions {
  /** The push service's relay-link URL (the push role's socket, or a TLS listener). */
  readonly pushUrl: string;
  readonly pushCa?: string;
  /** The releases role: its folder; the forwarding socket the push role passes release frames to. */
  readonly releases?: {
    readonly folder: string;
    readonly socket?: string;
    readonly upstreamSocket?: string;
  };
  /** A file of refused hub identities, read at start and again on SIGHUP. */
  readonly refusedHubs?: string;
  /** Listen on this port; a free one at the first start, kept after. */
  readonly port?: number;
  /** Proxies whose `X-Forwarded-For` names the peer (`listen.trustedProxies`). */
  readonly trustedProxies?: readonly string[];
}

/** The relay program started from a configuration file, stopped and started again on one port. */
export class RelayProgram {
  readonly configPath: string;
  readonly dataFolder: string;
  port: number;
  #proc: Subprocess<"ignore", "ignore", "pipe"> | undefined;
  /** Every start's output, in order. */
  readonly outs: Output[] = [];

  constructor(
    readonly folder: string,
    readonly options: RelayProgramOptions,
  ) {
    this.configPath = join(folder, "relay.json");
    this.dataFolder = join(folder, "relay-data");
    this.port = options.port ?? 0;
  }

  get url(): string {
    return `ws://127.0.0.1:${String(this.port)}`;
  }

  get out(): Output | undefined {
    return this.outs.at(-1);
  }

  /** The configuration, in `relay/test/local.json`'s form with this run's folders. */
  config(): Record<string, unknown> {
    const o = this.options;
    return {
      listen: {
        hostname: "127.0.0.1",
        port: this.port,
        ...(o.trustedProxies === undefined ? {} : { trustedProxies: o.trustedProxies }),
      },
      dataFolder: this.dataFolder,
      roles: o.releases === undefined ? ["relay"] : ["relay", "releases"],
      push: { url: o.pushUrl, ...(o.pushCa === undefined ? {} : { ca: o.pushCa }) },
      ...(o.releases === undefined
        ? {}
        : {
            releases: {
              folder: o.releases.folder,
              ...(o.releases.socket === undefined ? {} : { socket: o.releases.socket }),
              ...(o.releases.upstreamSocket === undefined
                ? {}
                : { upstream: { socket: o.releases.upstreamSocket } }),
            },
          }),
      ...(o.refusedHubs === undefined ? {} : { refusedHubs: o.refusedHubs }),
    };
  }

  async start(): Promise<void> {
    if (this.port === 0) this.port = await freePort();
    writeFileSync(this.configPath, JSON.stringify(this.config(), null, 2));
    const { proc, out } = spawnWithOutput([
      process.execPath,
      RELAY_MAIN,
      "--config",
      this.configPath,
    ]);
    this.#proc = proc;
    this.outs.push(out);
    check(
      await waitFor(() => out.text.includes('"event":"started"'), 15_000),
      `the relay started:\n${out.text}`,
    );
  }

  /** A clean stop (SIGTERM): every hub link closes 1001. */
  async stop(): Promise<number> {
    const proc = this.#proc;
    if (proc === undefined) return -1;
    this.#proc = undefined;
    proc.kill("SIGTERM");
    return await proc.exited;
  }

  /** The operator reads the refused hubs again. */
  hangUp(): void {
    this.#proc?.kill("SIGHUP");
  }

  get pid(): number | undefined {
    return this.#proc?.pid;
  }

  /** Every log line of every start with `event`. */
  events(event: string): Record<string, unknown>[] {
    return this.outs.flatMap((out) => out.lines().filter((line) => line.event === event));
  }
}

// ----- The hub -----

export interface HubOptions {
  /** Started with this environment's `HSN_PROGRAM`, a program tree as the launcher makes it. */
  readonly programTree?: boolean;
  /** Seeds the data folder before the first start (`home.ts`). */
  readonly seed?: (dataDir: string) => void;
  /**
   * Starts the hub with this command in place of the tests' entry, given the hub's arguments
   * (`--data …`), and these variables added to the environment.
   */
  readonly command?: (args: readonly string[]) => string[];
  readonly env?: Record<string, string>;
}

/** A control command's result: the operation's body, or its error. */
export type OpResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly error: unknown };

/** The real hub as a process, on a data folder of its own, stopped and started again on it. */
export class HubProcess {
  readonly dataDir: string;
  readonly sock: string;
  readonly prefix: string | undefined;
  devicePort = 0;
  #proc: Subprocess<"ignore", "ignore", "pipe"> | undefined;
  readonly outs: Output[] = [];
  #seeded = false;

  constructor(
    readonly root: string,
    readonly options: HubOptions = {},
  ) {
    this.dataDir = mkdtempSync(join(root, "hub-"));
    this.sock = join(this.dataDir, "control.sock");
    this.prefix = options.programTree === true ? programTree(root) : undefined;
  }

  get out(): Output | undefined {
    return this.outs.at(-1);
  }

  get running(): boolean {
    return this.#proc !== undefined;
  }

  get exited(): Promise<number> | undefined {
    return this.#proc?.exited;
  }

  async start(): Promise<void> {
    if (!this.#seeded) {
      this.#seeded = true;
      this.options.seed?.(this.dataDir);
    }
    if (this.devicePort === 0) this.devicePort = await freePort();
    const args = [
      "--data",
      this.dataDir,
      "--port",
      String(this.devicePort),
      "--no-usb-watch",
      "--app-ports",
      "0,0",
    ];
    const { proc, out } = spawnWithOutput(
      this.options.command?.(args) ?? ["bun", HUB_TEST_ENTRY, ...args],
      {
        cwd: HUB_DIR,
        env: {
          ...process.env,
          ...(this.prefix === undefined ? {} : { HSN_PROGRAM: this.prefix }),
          ...this.options.env,
        },
      },
    );
    this.#proc = proc;
    this.outs.push(out);
    // The control socket answers once the hub has booted.
    const up = await waitFor(
      async () => {
        if (this.#proc !== proc) return false;
        const status = await this.control({ kind: "status" }, 1000);
        return status !== undefined;
      },
      30_000,
      200,
    );
    check(up, `the hub started:\n${out.text}`);
  }

  /** A clean stop, as a service stop is. */
  async stop(): Promise<number> {
    const proc = this.#proc;
    if (proc === undefined) return -1;
    this.#proc = undefined;
    proc.kill("SIGTERM");
    const code = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => -2)]);
    if (code === -2) {
      proc.kill(9);
      return await proc.exited;
    }
    return code;
  }

  /** `kill -9`: no clean stop, nothing announced, nothing staged committed. */
  async kill(): Promise<void> {
    const proc = this.#proc;
    if (proc === undefined) return;
    this.#proc = undefined;
    proc.kill(9);
    await proc.exited;
  }

  /** The hub exited by itself (a switch's exit 70): forget the process. */
  async ended(): Promise<number> {
    const proc = this.#proc;
    if (proc === undefined) return -1;
    const code = await proc.exited;
    this.#proc = undefined;
    return code;
  }

  /** One control request (HD 9); its reply's result, or undefined when there was no reply. */
  async control(command: object, timeoutMs = 10_000): Promise<unknown> {
    const answer = await exchange(
      this.sock,
      { id: 1, actor: "relay test", command: command as never },
      timeoutMs,
    );
    if (answer.isErr()) return undefined;
    const reply = answer.value.reply.reply;
    return reply.ok ? { ok: true, result: reply.result } : { ok: false, error: reply.error };
  }

  /** `hsn op <name> <body>` on the control socket, as the hub computer's own console. */
  async op(name: string, body: unknown, timeoutMs = 10_000): Promise<OpResult> {
    const answer = await exchange(
      this.sock,
      { id: 1, actor: "relay test", command: { kind: "op", op: name, body } },
      timeoutMs,
    );
    if (answer.isErr()) return { ok: false, error: answer.error };
    const reply = answer.value.reply.reply;
    return reply.ok && reply.result.kind === "op"
      ? { ok: true, body: reply.result.body as Record<string, unknown> }
      : { ok: false, error: reply.ok ? reply.result : reply.error };
  }

  /** `hsn …` against this hub's data folder: exit code and output. */
  async hsn(...args: string[]): Promise<{ readonly code: number; readonly out: string }> {
    const proc = spawnTracked(["bun", HSN, "--data", this.dataDir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, error] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out: out + error };
  }

  /** The hub's identity, from `hub.info`. */
  async identity(): Promise<string> {
    const info = await this.op("hub.info", {});
    const identity = info.ok ? info.body.identity : undefined;
    check(typeof identity === "string", `hub.info names the identity: ${JSON.stringify(info)}`);
    return typeof identity === "string" ? identity : "";
  }

  /** `relay.status`'s body. */
  async relayStatus(): Promise<Record<string, unknown>> {
    const status = await this.op("relay.status", {});
    return status.ok ? status.body : {};
  }

  /** Waits until `relay.status` says `state`. */
  async relayState(state: "up" | "down" | "off", ms: number): Promise<boolean> {
    return waitFor(async () => (await this.relayStatus()).state === state, ms, 100);
  }
}

/** The program tree the launcher would have made, running this version (`HSN_PROGRAM`). */
export function programTree(root: string): string {
  const prefix = mkdtempSync(join(root, "p"));
  mkdirSync(join(prefix, "staged", HUB_VERSION, "bin"), { recursive: true });
  mkdirSync(join(prefix, "state"), { recursive: true });
  writeFileSync(
    installPaths(prefix).launcherFile,
    JSON.stringify({ current: HUB_VERSION, previous: null, trial: null, rolledBack: null }),
  );
  return prefix;
}

// ----- A pass-through between a hub and its relay -----

/** One direction's bytes not yet taken by the socket (Bun's `write` may take only some). */
class Outbound {
  readonly #waiting: Uint8Array[] = [];
  socket: Bun.Socket<Pair> | undefined;

  write(bytes: Uint8Array): void {
    if (this.socket === undefined || this.#waiting.length > 0) {
      this.#waiting.push(new Uint8Array(bytes));
      return;
    }
    const n = this.socket.write(bytes);
    if (n < bytes.length) this.#waiting.push(new Uint8Array(bytes.subarray(Math.max(0, n))));
  }

  /** The socket can take more (`drain`), or has just opened. */
  drain(): void {
    const socket = this.socket;
    if (socket === undefined) return;
    while (this.#waiting.length > 0) {
      const next = this.#waiting[0] ?? new Uint8Array();
      const n = socket.write(next);
      if (n < next.length) {
        this.#waiting[0] = next.subarray(Math.max(0, n));
        return;
      }
      this.#waiting.shift();
    }
  }
}

interface Pair {
  /** Towards the hub, and towards the relay. */
  readonly toHub: Outbound;
  readonly toRelay: Outbound;
  /** Whether the request's first line has gone (the header is added after it). */
  started: boolean;
}

/** The request with `X-Forwarded-For: <address>` after its first line. */
function withForwardedFor(bytes: Uint8Array, address: string): Uint8Array {
  const text = new TextDecoder("latin1").decode(bytes);
  const end = text.indexOf("\r\n");
  if (end === -1) return bytes;
  const header = new TextEncoder().encode(`X-Forwarded-For: ${address}\r\n`);
  const out = new Uint8Array(bytes.length + header.length);
  out.set(bytes.subarray(0, end + 2), 0);
  out.set(header, end + 2);
  out.set(bytes.subarray(end + 2), end + 2 + header.length);
  return out;
}

/**
 * A TCP pass-through on loopback: the hub's relay URL names it, and it carries every byte to the
 * relay unchanged. `lastFromHubMs` is when a byte last came from the hub's side: the relay's last
 * contact, to the frame. `cut()` ends every connection and refuses new ones until `mend()`: the
 * home's internet gone, with the hub and the relay both running.
 */
export class Passthrough {
  readonly #listener: Bun.TCPSocketListener<Pair>;
  readonly #pairs = new Set<Pair>();
  #cut = false;
  lastFromHubMs = 0;
  bytesFromHub = 0;
  bytesToHub = 0;
  connections = 0;

  constructor(
    readonly targetPort: number,
    /** Before the relay, a proxy it trusts: each request says the peer is this address. */
    readonly forwardedFor?: string,
  ) {
    this.#listener = Bun.listen<Pair>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (client) => {
          this.#open(client);
        },
        data: (client, bytes) => {
          const pair = client.data as Pair | undefined;
          if (pair === undefined) return;
          this.lastFromHubMs = Date.now();
          this.bytesFromHub += bytes.length;
          const forwardedFor = this.forwardedFor;
          const first = !pair.started;
          pair.started = true;
          pair.toRelay.write(
            first && forwardedFor !== undefined ? withForwardedFor(bytes, forwardedFor) : bytes,
          );
        },
        drain: (client) => {
          (client.data as Pair | undefined)?.toHub.drain();
        },
        close: (client) => {
          const pair = client.data as Pair | undefined;
          if (pair === undefined) return;
          pair.toRelay.socket?.end();
          this.#pairs.delete(pair);
        },
        error: (client) => {
          (client.data as Pair | undefined)?.toRelay.socket?.end();
        },
      },
    });
  }

  #open(client: Bun.Socket<Pair>): void {
    if (this.#cut) {
      client.end();
      return;
    }
    this.connections += 1;
    const pair: Pair = { toHub: new Outbound(), toRelay: new Outbound(), started: false };
    pair.toHub.socket = client;
    client.data = pair;
    this.#pairs.add(pair);
    void Bun.connect<Pair>({
      hostname: "127.0.0.1",
      port: this.targetPort,
      socket: {
        open: (upstream) => {
          upstream.data = pair;
          pair.toRelay.socket = upstream;
          pair.toRelay.drain();
        },
        data: (_upstream, bytes) => {
          this.bytesToHub += bytes.length;
          pair.toHub.write(bytes);
        },
        drain: () => {
          pair.toRelay.drain();
        },
        close: () => {
          pair.toHub.socket?.end();
          this.#pairs.delete(pair);
        },
        error: () => {
          pair.toHub.socket?.end();
        },
      },
    }).catch(() => {
      client.end();
    });
  }

  get port(): number {
    return this.#listener.port;
  }

  get url(): string {
    return `ws://127.0.0.1:${String(this.port)}`;
  }

  /** The home's internet gone: every connection dropped at once, none taken until `mend`. */
  cut(): void {
    this.#cut = true;
    for (const pair of [...this.#pairs]) {
      pair.toHub.socket?.terminate();
      pair.toRelay.socket?.terminate();
    }
    this.#pairs.clear();
  }

  mend(): void {
    this.#cut = false;
  }

  close(): void {
    this.cut();
    this.#listener.stop(true);
  }
}

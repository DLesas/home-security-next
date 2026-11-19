/** Starts test subprocesses on temporary TCP ports and retries collisions before first use. */
import { expect } from "bun:test";
import type { Subprocess } from "bun";

/** A loopback port available at the time it was checked. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port ?? 0;
  await server.stop(true);
  expect(port).toBeGreaterThan(0);
  return port;
}

/** Collects a process's output as it arrives, without waiting for it to exit. */
export class Output {
  #text = "";
  readonly done: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>, mirror = false) {
    const decoder = new TextDecoder();
    this.done = (async () => {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        this.#text += text;
        if (mirror) process.stderr.write(text);
      }
    })();
  }

  get text(): string {
    return this.#text;
  }

  /** The complete JSON log lines. */
  lines(): Record<string, unknown>[] {
    return this.#text
      .split("\n")
      .slice(0, -1)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** Counts occurrences of text in the log. */
  count(needle: string): number {
    return this.#text.split(needle).length - 1;
  }
}

interface PortAttempt {
  readonly proc: Subprocess;
  readonly out: Output;
  readonly ports: readonly number[];
  readonly ready: () => boolean | Promise<boolean>;
}

/** Reads the current exit state, including an exit by signal. */
function running(proc: Subprocess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

/** Recognises Bun's bind error for an attempted TCP port, including the relay's structured log. */
function busyPort(output: string, ports: readonly number[]): number | undefined {
  const lines = output.split("\n");
  return ports.find(
    (port) =>
      port > 0 &&
      lines.some(
        (line) =>
          (line.includes('"code":"EADDRINUSE"') &&
            (line.includes(`:${port}"`) || line.includes(`:${port}: `))) ||
          (line.includes(`Failed to start server. Is port ${port} in use?`) &&
            (line.includes("the app listeners could not open:") ||
              output.includes('code: "EADDRINUSE"'))),
      ),
  );
}

/** Retries up to five bind collisions for picked ports and leaves established ports fixed. */
export async function startWithPortRetry<T extends PortAttempt>(
  launch: () => T | Promise<T>,
  options: {
    readonly label: string;
    readonly pickAgain: boolean;
    readonly timeoutMs: number;
    readonly pollMs?: number;
  },
): Promise<T> {
  for (let retries = 0; ; retries++) {
    const attempt = await launch();
    const { proc, out, ports, ready } = attempt;
    const end = Date.now() + options.timeoutMs;
    while (running(proc) && busyPort(out.text, ports) === undefined) {
      const up = await ready();
      if (!running(proc) || busyPort(out.text, ports) !== undefined) break;
      if (up) return attempt;
      if (Date.now() >= end) break;
      await Bun.sleep(options.pollMs ?? 20);
    }
    const occupied = busyPort(out.text, ports);
    if (running(proc)) proc.kill(9);
    await proc.exited;
    await out.done;
    const port = occupied ?? busyPort(out.text, ports);
    if (port === undefined || !options.pickAgain || retries === 5)
      expect.unreachable(`${options.label}:\n${out.text}`);
    console.log(
      `${options.label}: port ${port} was in use, retrying with a free port (${retries + 1}/5)`,
    );
  }
}

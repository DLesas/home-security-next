/** Exchanges one control line with the hub. Bun also runs this for Node's Windows test runner. */
import { connect } from "node:net";
import { existsSync } from "node:fs";

/** The same startup deadline on both systems. */
export const HUB_START_MS = 15_000;

/** Sends a control request and takes its first response line. */
export function controlLine(path: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end >= 0) {
        socket.end();
        resolve(text.slice(0, end));
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      reject(new Error("the control socket closed before replying"));
    });
    socket.write(`${request}\n`);
  });
}

// Use pipes for both lines so a token never appears in a command line or a test log.
if (import.meta.main) {
  const path = process.argv[2];
  if (!path) process.exit(2);
  if (process.argv[3] === "--ready") {
    // Check the Windows AF_UNIX endpoint with the runtime that created it.
    const deadline = Date.now() + HUB_START_MS;
    while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(50);
    process.exit(existsSync(path) ? 0 : 1);
  }
  const request = await Bun.stdin.text();
  const reply = await controlLine(path, request);
  process.stdout.write(`${reply}\n`);
}

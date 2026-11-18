/**
 * The relay's memory under slow readers and oversized messages (docs/m4-design.md section 11,
 * "memory flat under slow readers and oversized messages"; D142 "Memory per connection"),
 * measured in the program's own process, started as an operator would start it: the same burst
 * three times, and the program's resident memory after the third is no more than after the
 * first, give or take, so nothing a slow or oversized peer sends is kept.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { PHONE_CLOSE, RELAY_LIMITS } from "@hsn/protocol/relay";
import { cleanup, Client, StandInHub, tempFolder, until } from "../helpers.ts";

let folder: string;
let program: ReturnType<typeof Bun.spawn>;
let port = 0;

/** The program's resident memory, in bytes. */
function rss(): number {
  const pid = program.pid;
  return (
    Number(
      Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)])
        .stdout.toString()
        .trim(),
    ) * 1024
  );
}

function rawPhone(path: string, address: string): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  return new Promise((resolve) => {
    socket.once("data", () => {
      socket.pause();
      resolve(socket);
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
        `X-Forwarded-For: ${address}\r\n\r\n`,
    );
  });
}

beforeAll(async () => {
  folder = tempFolder();
  const config = join(folder, "relay.json");
  writeFileSync(
    config,
    JSON.stringify({
      listen: { hostname: "127.0.0.1", port: 0, trustedProxies: ["127.0.0.1"] },
      dataFolder: folder,
      roles: ["relay"],
      push: { url: `ws+unix://${join(folder, "none.sock")}:/v1/relay` },
    }),
  );
  program = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../../src/shell/main.ts"), "--config", config],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const reader = (program.stderr as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!text.includes('"event":"started"')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  port = Number(/"port":(\d+)/u.exec(text)?.[1] ?? 0);
  void (async () => {
    for (;;) if ((await reader.read()).done) return;
  })();
});

afterAll(async () => {
  program.kill("SIGTERM");
  await program.exited;
  cleanup(folder);
});

test("resident memory stays flat over repeated bursts of slow readers and oversized messages", async () => {
  const url = `ws://127.0.0.1:${port}`;
  const hub = await StandInHub.connect(url, { address: "192.0.2.1" });
  await hub.next("joined");
  const big = new Uint8Array(RELAY_LIMITS.maxPhoneMessageBytes);
  const after: number[] = [];
  for (let round = 0; round < 3; round++) {
    // Oversized: phones each send one message of 200 KiB, closed 1009.
    const phones = Array.from(
      { length: 8 },
      (_, i) => new Client(`${url}/v1/phone/${hub.identity}/session`, `198.51.${round}.${i}`),
    );
    await Promise.all(phones.map((p) => p.open()));
    for (let left = phones.length; left > 0; left -= 1) await hub.next("open");
    for (const p of phones) p.send(new Uint8Array(200 * 1024));
    await until(() => phones.every((p) => p.closeCode === PHONE_CLOSE.tooLarge), "the 1009s");
    for (let left = phones.length; left > 0; left -= 1) await hub.next("close");
    // Slow readers: phones that never read, sent about 20 MB each; each closed 4429.
    const slow = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        rawPhone(`/v1/phone/${hub.identity}/session`, `203.0.${round}.${i}`),
      ),
    );
    const streams: number[] = [];
    for (let left = slow.length; left > 0; left -= 1) streams.push((await hub.next("open")).stream);
    for (const stream of streams) for (let k = 0; k < 300; k++) hub.sendStream(stream, big);
    const closes: number[] = [];
    while (closes.length < streams.length) closes.push((await hub.next("close")).code);
    expect(closes).toEqual(streams.map(() => PHONE_CLOSE.overLimit));
    for (const s of slow) s.destroy();
    hub.send({ t: "ping", n: round });
    await hub.next("pong");
    after.push(rss());
  }
  const [first = 0, , third = 0] = after;
  expect(first).toBeGreaterThan(0);
  // About 140 MB went past the relay in these bursts; it kept none of it.
  expect(third - first).toBeLessThan(24 * 1024 * 1024);
}, 60_000);

/**
 * Layer 1 under load (docs/m4-design.md section 11, "Protection, layer 1"), sized to run in
 * seconds on this Mac: connections from many IPv4 addresses and IPv6 /64s (through a trusted
 * loopback proxy's `X-Forwarded-For`, since this Mac has one loopback address), each per-address
 * and global cap reached and answered with its code, nothing kept for a refused upgrade, memory
 * flat under slow readers and oversized messages (`memory.test.ts`, in the program's own process),
 * established hub links kept through a flood of new ones, new identities refused past their rate, and release egress stopping at its budget.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { PHONE_CLOSE, RELAY_CLOSE, RELAY_LIMITS } from "@hsn/protocol/relay";
import { ReleaseBudget } from "../../src/core/release-budget.ts";
import { PROTECTION_LIMITS as L } from "../../src/core/rules.ts";
import { FolderReleaseIndex } from "../../src/releases/folder-index.ts";
import { ReleaseService } from "../../src/releases/service.ts";
import {
  Client,
  cleanup,
  ManualClock,
  memoryLog,
  must,
  settle,
  StandInHub,
  startRelay,
  tempFolder,
  type TestRelay,
  until,
} from "../helpers.ts";

let folder: string;
let t: TestRelay;
const clock = new ManualClock(Date.UTC(2026, 10, 18, 12));
const PIECE = RELAY_LIMITS.maxReleasePieceBytes;
/** The test's egress budget: ten pieces, so the budget is reached in seconds. */
const EGRESS = 10 * PIECE;

/** An IPv4 address, or an IPv6 address in its own /64, by number. */
const v4 = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
const v6 = (i: number) => `2001:db8:${(i >> 16) & 0xffff}:${i & 0xffff}::${(i % 7) + 1}`;
const addressOf = (i: number) => (i % 2 === 0 ? v4(i) : v6(i));

/** A raw upgrade from `address`; its status, and the socket held open when asked. */
function rawUpgrade(
  path: string,
  address: string,
  keep: boolean,
): Promise<{ status: number; socket: Socket }> {
  const socket = connect(t.listener.port, "127.0.0.1");
  return new Promise((resolve) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (!text.includes("\r\n")) return;
      const status = Number(text.split("\r\n")[0]?.split(" ")[1]);
      if (!keep) socket.destroy();
      resolve({ status, socket });
    });
    socket.on("error", () => {
      resolve({ status: 0, socket });
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
        `X-Forwarded-For: ${address}\r\n\r\n`,
    );
  });
}

/** Runs `jobs` 50 at a time, so the system's listen queue does not refuse connections. */
async function batched<T>(jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; at < jobs.length; at += 50) {
    out.push(...(await Promise.all(jobs.slice(at, at + 50).map((job) => job()))));
  }
  return out;
}

function tally(statuses: readonly number[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of statuses) out[s] = (out[s] ?? 0) + 1;
  return out;
}

const established: { hub: StandInHub; phone: Client; stream: number }[] = [];

/** Every established hub still answers, and its stream still carries both ways. */
async function establishedStillWork(round: number): Promise<void> {
  expect(established).toHaveLength(20);
  for (const { hub, phone, stream } of established) {
    hub.send({ t: "ping", n: round });
    await hub.next("pong");
    const before = hub.streamMessages(stream).length;
    phone.send(new Uint8Array([round]));
    await until(() => hub.streamMessages(stream).length === before + 1, "a phone's message");
    expect(hub.client.closeCode).toBeUndefined();
    expect(phone.closeCode).toBeUndefined();
  }
}

beforeAll(async () => {
  folder = tempFolder();
  const releases = join(folder, "releases");
  mkdirSync(releases);
  const payload = new Uint8Array(3 * PIECE);
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      kind: "firmware",
      version: "1.0.0",
      target: "esp32s3",
      roles: [1],
      payloadBytes: payload.length,
      payloadSha256: "0".repeat(64),
      madeMs: 0,
    }),
  );
  const file = new Uint8Array(12 + manifest.length + 64 + payload.length);
  file.set(new TextEncoder().encode("HSNF"), 0);
  file[4] = 1;
  new DataView(file.buffer).setUint32(8, manifest.length, true);
  file.set(manifest, 12);
  writeFileSync(join(releases, "hsn-firmware-1.0.0.hsnf"), file);
  const index = new FolderReleaseIndex(releases, memoryLog());
  must(await index.refresh());
  t = startRelay(folder, {
    clock,
    trustedProxies: ["127.0.0.1"],
    releases: new ReleaseService(index, new ReleaseBudget(undefined, EGRESS), clock, memoryLog()),
  });
  for (let i = 0; i < 20; i++) {
    const hub = await StandInHub.connect(t.url, { address: `192.0.2.${i}` });
    await hub.next("joined");
    const phone = new Client(`${t.url}/v1/phone/${hub.identity}/session`, `198.51.100.${i}`);
    await phone.open();
    const stream = (await hub.next("open")).stream;
    established.push({ hub, phone, stream });
  }
});

afterAll(async () => {
  await t.stop();
  cleanup(folder);
});

describe("under load", () => {
  test(`unfinished handshakes: ${L.unauthenticated.perAddress} per address and ${L.unauthenticated.inAll} in all, the rest closed 4429`, async () => {
    // The established hubs' handshakes were this second's: a new second.
    clock.advance(1000);
    const addresses = 600;
    const jobs: (() => Promise<{ status: number; socket: Socket }>)[] = [];
    for (let i = 0; i < addresses; i++) {
      for (let k = 0; k < L.unauthenticated.perAddress + 1; k++) {
        jobs.push(() => rawUpgrade("/v1/hub", addressOf(i), true));
      }
    }
    const answers: { status: number; socket: Socket }[] = [];
    // At most `handshakesPerSecondInAll` a second: the clock moves on between batches.
    for (let at = 0; at < jobs.length; at += L.beforeState.handshakesPerSecondInAll) {
      answers.push(...(await batched(jobs.slice(at, at + L.beforeState.handshakesPerSecondInAll))));
      clock.advance(1000);
    }
    expect(tally(answers.map((a) => a.status))).toEqual({ 101: jobs.length });
    await until(() => t.relay.counts.unauthenticated === L.unauthenticated.inAll, "the cap");
    await settle(50);
    expect(t.relay.counts.unauthenticated).toBe(L.unauthenticated.inAll);
    // Every one past the caps was closed at once (its socket ended); the held ones are open.
    const ended = answers.filter((a) => a.socket.readableEnded || a.socket.destroyed).length;
    await until(
      () =>
        answers.filter((a) => a.socket.readableEnded || a.socket.destroyed).length ===
        jobs.length - L.unauthenticated.inAll,
      "the refused to close",
    );
    expect(ended).toBeLessThanOrEqual(jobs.length - L.unauthenticated.inAll);
    await establishedStillWork(1);
    for (const a of answers) a.socket.destroy();
    await until(() => t.relay.counts.unauthenticated === 0, "nothing kept");
    // The handshake timer of each is gone with it.
    expect(t.relay.counts.joined).toBe(established.length);
  }, 60_000);

  test("a refused upgrade keeps nothing: a whole /64 flooding is one address", async () => {
    clock.advance(60_000);
    const jobs = Array.from(
      { length: 1000 },
      (_, i) => () => rawUpgrade("/v1/hub", `2001:db8:ffff:1::${(i + 1).toString(16)}`, false),
    );
    const statuses = (await batched(jobs)).map((a) => a.status);
    expect(tally(statuses)).toEqual({
      101: L.beforeState.hubAndRelayUpgradesPerMinutePerAddress,
      429: 1000 - L.beforeState.hubAndRelayUpgradesPerMinutePerAddress,
    });
    await until(() => t.relay.counts.unauthenticated === 0, "nothing kept");
    await establishedStillWork(2);
  }, 30_000);

  test("phone streams past their caps are 4429, oversized messages 1009, slow readers 4429", async () => {
    clock.advance(60_000);
    const { hub } = established[0] ?? { hub: undefined };
    expect(hub).toBeDefined();
    if (hub === undefined) return;
    const phones: Client[] = [];
    // 15 more streams fill the hub's 16; then 10 more are refused.
    for (let i = 0; i < L.phoneStreams.perHub - 1 + 10; i++) {
      phones.push(new Client(`${t.url}/v1/phone/${hub.identity}/session`, v6(5000 + i)));
    }
    await Promise.all(phones.map((p) => p.open()));
    await until(
      () => phones.filter((p) => p.closeCode === PHONE_CLOSE.overLimit).length === 10,
      "the refusals",
    );
    // Each open stream sends a message over 65,535 bytes: each is closed 1009, nothing carried.
    const open = phones.filter((p) => p.closeCode === undefined);
    expect(open).toHaveLength(L.phoneStreams.perHub - 1);
    for (let left = open.length; left > 0; left -= 1) await hub.next("open");
    for (const p of open) p.send(new Uint8Array(200 * 1024));
    await until(() => open.every((p) => p.closeCode === PHONE_CLOSE.tooLarge), "the 1009s");
    // Slow readers: phones that never read, each sent about 20 MB by its hub (more than this
    // system's socket buffers take); each closed 4429.
    const slow = await batched(
      Array.from(
        { length: 3 },
        (_, i) => () => rawUpgrade(`/v1/phone/${hub.identity}/session`, v4(9000 + i), true),
      ),
    );
    for (const s of slow) s.socket.pause();
    const streams: number[] = [];
    for (let left = slow.length; left > 0; left -= 1) streams.push((await hub.next("open")).stream);
    expect(streams).toHaveLength(3);
    const big = new Uint8Array(RELAY_LIMITS.maxPhoneMessageBytes);
    for (const stream of streams) for (let k = 0; k < 300; k++) hub.sendStream(stream, big);
    let slowClosed = 0;
    while (slowClosed < streams.length) {
      if ((await hub.next("close")).code === PHONE_CLOSE.overLimit) slowClosed += 1;
    }
    for (const s of slow) s.socket.destroy();
    await settle(50);
    // The relay's own memory under these, measured in its own process: `memory.test.ts`.
    await establishedStillWork(3);
    expect(t.relay.counts.streams).toBe(established.length);
  }, 60_000);

  test("new identities past their rate get `limit`; established hubs are untouched", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < L.newIdentities.perDayPerAddress + 2; i++) {
      const hub = await StandInHub.connect(t.url, { address: "2001:db8:eeee:1::1" });
      await until(() => hub.joined || hub.client.closeCode !== undefined, "an answer");
      results.push(hub.joined);
      if (!hub.joined) expect(hub.client.closeCode).toBe(RELAY_CLOSE.overLimit);
      hub.client.close();
    }
    expect(results).toEqual([true, true, true, false, false]);
    await establishedStillWork(4);
  }, 30_000);

  test("release egress stops at its budget, for every hub, until midnight UTC", async () => {
    let served = 0;
    let refused = 0;
    for (const [i, { hub }] of established.entries()) {
      hub.send({
        t: "release.get",
        id: i,
        file: "hsn-firmware-1.0.0.hsnf",
        offset: 0,
        length: PIECE,
      });
      const answered = await Promise.race([
        until(() => hub.pieces().has(i), "a piece").then(() => "piece"),
        hub.next("release.error").then((e) => e.reason),
      ]);
      if (answered === "piece") served += 1;
      else {
        expect(answered).toBe("limit");
        refused += 1;
      }
    }
    expect(served).toBe(EGRESS / PIECE);
    expect(refused).toBe(established.length - EGRESS / PIECE);
  }, 30_000);
});

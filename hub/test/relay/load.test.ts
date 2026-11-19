/**
 * Layer 1 under load, end to end (docs/m4-design.md section 11, "Protection, layer 1"; section 3,
 * D142's table), sized to run in well under a minute: the relay program as a process on the system
 * clock, behind a loopback proxy it trusts (`trustedProxies`, as an operator's filter in front
 * would be), so each connection names its own address in `X-Forwarded-For`; the real hub joined
 * through it under one address and a phone's session to it under another, both on the real code.
 * B2's own load tests (`relay/test/load/`) take every cap to its edge in the relay's process with
 * its test clock; this one floods the running program and watches what a household would.
 *
 * - From one address: hub upgrades past 10 a minute are 429, nothing kept; phone opens past 30 a
 *   minute are 429.
 * - From many addresses: a thousand unfinished hub handshakes, held open, and a burst of phone
 *   opens to the real hub's identity; each answered within its caps (101, 429, 503, or a close
 *   with 4429, 4408 or 1013), never more held than the caps allow.
 * - Throughout: the hub's link is never closed or replaced, and the phone's session answers every
 *   request.
 * - The relay process's resident memory stays bounded, and comes back near where it was.
 * - Afterwards the relay still answers: a hub from a new address joins, a new session opens.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { PROTECTION_LIMITS as L } from "../../../relay/src/core/rules.ts";
import { StandInHub } from "../../../relay/test/helpers.ts";
import { endProcesses } from "../world/processes.ts";
import { AwayPhone, relayConnect } from "./phone.ts";
import { Seen } from "./leaks.ts";
import {
  ALL_OUTPUT,
  check,
  HubProcess,
  Passthrough,
  RelayProgram,
  shortFolder,
  waitFor,
} from "./processes.ts";

const SECOND = 1000;
const MB = 1024 * 1024;
/** The relay's resident memory may grow by this much under the flood, at most ‡ (a measure, here). */
const PEAK_GROWTH_BOUND = 192 * MB;
/** And keep this much of it once the flood is gone, at most. */
const AFTER_GROWTH_BOUND = 64 * MB;
const roots: string[] = [];
const stops: (() => unknown)[] = [];
const seen = new Seen();
afterAll(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await endProcesses();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The process's resident memory, in bytes. */
function rss(pid: number | undefined): number {
  if (pid === undefined) return Number.NaN;
  return (
    Number(
      Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)])
        .stdout.toString()
        .trim(),
    ) * 1024
  );
}

/** A raw WebSocket upgrade naming `address`: its status, the socket kept open when asked. */
function rawUpgrade(
  port: number,
  path: string,
  address: string,
  keep: boolean,
): Promise<{ readonly status: number; readonly socket: Socket }> {
  const socket = connect(port, "127.0.0.1");
  return new Promise((resolve) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      if (text.includes("\r\n")) return;
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
async function batched<T>(jobs: readonly (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; at < jobs.length; at += 50)
    out.push(...(await Promise.all(jobs.slice(at, at + 50).map((job) => job()))));
  return out;
}

function tally(statuses: readonly number[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of statuses) out[s] = (out[s] ?? 0) + 1;
  return out;
}

const many = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

describe("layer 1 under load, with the real hub on the relay program", () => {
  test("caps hold from one address and from many; the household's link and session undisturbed; memory bounded; the relay answers after", async () => {
    const root = shortFolder("hsn-ld-");
    roots.push(root);
    const relay = new RelayProgram(root, {
      pushUrl: `ws+unix://${join(root, "no-push.sock")}:/v1/relay`,
      trustedProxies: ["127.0.0.1"],
    });
    await relay.start();
    seen.relayDirs.push(relay.dataFolder);
    stops.push(() => relay.stop());
    const hubLine = new Passthrough(relay.port, "192.0.2.10");
    const phoneLine = new Passthrough(relay.port, "192.0.2.20");
    stops.push(() => {
      hubLine.close();
      phoneLine.close();
    });
    const hub = new HubProcess(root);
    seen.hubDirs.push(hub.dataDir);
    await hub.start();
    stops.push(() => hub.kill());
    check((await hub.op("relay.set", { url: hubLine.url })).ok, "relay.set");
    check(await hub.relayState("up", 15 * SECOND), "the hub joined");
    const identity = await hub.identity();
    const invite = await hub.op("link.create", {
      kind: { newPerson: { name: "Uma" } },
      form: "qr",
    });
    const linked = await AwayPhone.link(
      invite.ok ? String(invite.body.qr) : "",
      "Uma",
      phoneLine.url,
      true,
    );
    check(linked instanceof AwayPhone, `linked: ${JSON.stringify(linked)}`);
    const phone = linked as AwayPhone;
    seen.phones.push(phone);
    stops.push(() => {
      phone.stop();
    });
    check(await phone.open(), "the phone's session");
    const joinedBefore = relay.events("hubJoined").length;
    const hubConnections = hubLine.connections;
    const before = rss(relay.pid);
    let peak = before;
    const asked = { n: 0, failed: [] as unknown[], up: true };
    const household = { running: true };
    const watching = (async () => {
      while (household.running) {
        peak = Math.max(peak, rss(relay.pid));
        const info = await phone.request("hub.info", {});
        asked.n += 1;
        if (!info.ok) asked.failed.push(info);
        if ((await hub.relayStatus()).state !== "up") asked.up = false;
        await Bun.sleep(250);
      }
    })();

    // From one address: upgrades past their minute's rate refused before anything is kept.
    const one = "198.51.100.7";
    const hubUpgrades = await batched(
      Array.from({ length: 40 }, () => () => rawUpgrade(relay.port, "/v1/hub", one, false)),
    );
    expect(tally(hubUpgrades.map((u) => u.status))).toEqual({
      101: L.beforeState.hubAndRelayUpgradesPerMinutePerAddress,
      429: 40 - L.beforeState.hubAndRelayUpgradesPerMinutePerAddress,
    });
    const phoneOpens = await batched(
      Array.from(
        { length: 60 },
        () => () => rawUpgrade(relay.port, `/v1/phone/${identity}/session`, one, false),
      ),
    );
    expect(tally(phoneOpens.map((u) => u.status))).toEqual({
      101: L.beforeState.phoneOpensPerMinutePerAddress,
      429: 60 - L.beforeState.phoneOpensPerMinutePerAddress,
    });

    // From many addresses: unfinished handshakes held open, and phone opens to the hub.
    const held = await batched(
      Array.from(
        { length: 1000 },
        (_, i) => () => rawUpgrade(relay.port, "/v1/hub", many(i), true),
      ),
    );
    const heldStatuses = tally(held.map((u) => u.status));
    expect(Object.keys(heldStatuses).every((s) => ["101", "429", "503"].includes(s))).toBe(true);
    expect(heldStatuses[101] ?? 0).toBeLessThanOrEqual(L.unauthenticated.inAll);
    const streams = await batched(
      Array.from(
        { length: 200 },
        (_, i) => () =>
          rawUpgrade(relay.port, `/v1/phone/${identity}/session`, many(5000 + i), true),
      ),
    );
    expect(
      Object.keys(tally(streams.map((u) => u.status))).every((s) =>
        ["101", "429", "503"].includes(s),
      ),
    ).toBe(true);
    peak = Math.max(peak, rss(relay.pid));
    // The unfinished handshakes are closed by the relay at 10 s (4408): nothing left of them.
    check(
      await waitFor(
        () => held.every((u) => u.status !== 101 || u.socket.readableEnded || u.socket.destroyed),
        L.unauthenticated.message3WithinMs + 5 * SECOND,
        100,
      ),
      "every unfinished handshake closed by the relay",
    );
    for (const u of [...held, ...streams]) u.socket.destroy();
    await Bun.sleep(2 * SECOND);
    household.running = false;
    await watching;

    // The household's link and session, undisturbed.
    expect(asked.failed).toEqual([]);
    expect(asked.n).toBeGreaterThan(10);
    expect(asked.up).toBe(true);
    expect(relay.events("hubJoined").length).toBe(joinedBefore);
    expect(hubLine.connections).toBe(hubConnections);
    expect(phone.status).toBe("open");

    // Memory: bounded under the flood, and back near where it was.
    await Bun.sleep(1 * SECOND);
    const after = rss(relay.pid);
    console.log(
      `relay resident memory: ${(before / MB).toFixed(1)} MB before, ${(peak / MB).toFixed(1)} MB at the peak, ${(after / MB).toFixed(1)} MB after`,
    );
    expect(peak - before).toBeLessThan(PEAK_GROWTH_BOUND);
    expect(after - before).toBeLessThan(AFTER_GROWTH_BOUND);

    // Still answering: a hub from a new address joins; a new session opens to the real hub.
    const newcomer = await StandInHub.connect(relay.url.replace("ws://", "ws://"), {
      address: "203.0.113.5",
    });
    expect((await newcomer.next("joined")).identity).toBe(newcomer.identity);
    const fresh = new Passthrough(relay.port, "192.0.2.30");
    stops.push(() => {
      fresh.close();
    });
    const disarm = await phone.disarmFirst([relayConnect(fresh.url, identity)]);
    expect(disarm.reply).toMatchObject({ ok: true });
    await hub.stop();
  }, 60_000);
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});

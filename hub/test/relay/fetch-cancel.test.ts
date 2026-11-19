/**
 * A release fetch cancelled mid-way (docs/m4-design.md section 6, "Fetching, only when asked";
 * D142, layer 1: "release pieces only as the hub asks for them (it pulls, so nothing piles up)";
 * "Releases (bandwidth costs money)"), with the relay program as a process and a pass-through that
 * counts the bytes the relay sends the hub. A 48 MB signed release is offered; the hub is asked to
 * fetch it, and `update.cancel` comes once a few megabytes are in.
 *
 * - The cancel holds: nothing is staged, and a later fetch starts afresh.
 * - FOUND-3: only pieces already in flight can arrive after the cancel.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { endProcesses } from "../world/processes.ts";
import { Seen } from "./leaks.ts";
import {
  ALL_OUTPUT,
  check,
  HubProcess,
  Passthrough,
  PushRole,
  RelayProgram,
  shortFolder,
  waitFor,
} from "./processes.ts";
import { RELEASE_VERSION, standIns, writeTestRelease } from "./pushes.ts";

const SECOND = 1000;
const MB = 1024 * 1024;
const roots: string[] = [];
const stops: (() => unknown)[] = [];
afterAll(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await endProcesses();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Cancelled {
  readonly hub: HubProcess;
  readonly size: number;
  /** Bytes the relay sent the hub when the cancel was answered, and a while after. */
  readonly atCancel: number;
  readonly after: number;
}

let once: Promise<Cancelled> | undefined;
const seen = new Seen();

/** One fetch, cancelled after 4 MB, shared by the tests below. */
function cancelledFetch(): Promise<Cancelled> {
  once ??= (async () => {
    const root = shortFolder("hsn-fc-");
    roots.push(root);
    const s = await standIns();
    seen.standIns = s;
    stops.push(() => s.close());
    const push = new PushRole(root, s);
    await push.start();
    stops.push(() => push.stop());
    const releases = join(root, "releases");
    mkdirSync(releases);
    const release = writeTestRelease(releases, 48 * MB);
    const relay = new RelayProgram(root, { pushUrl: push.url, releases: { folder: releases } });
    await relay.start();
    seen.relayDirs.push(relay.dataFolder);
    stops.push(() => relay.stop());
    const line = new Passthrough(relay.port);
    stops.push(() => {
      line.close();
    });
    const hub = new HubProcess(root, { programTree: true });
    seen.hubDirs.push(hub.dataDir);
    await hub.start();
    stops.push(() => hub.kill());
    check((await hub.op("relay.set", { url: line.url })).ok, "relay.set");
    check(await hub.relayState("up", 15 * SECOND), "joined");
    check(
      await waitFor(
        async () => {
          const offers = await hub.op("update.offers", {});
          return offers.ok && offers.body.offer !== null;
        },
        10 * SECOND,
        100,
      ),
      "offered",
    );
    const base = line.bytesToHub;
    check((await hub.op("update.fetch", { version: RELEASE_VERSION })).ok, "update.fetch");
    check(await waitFor(() => line.bytesToHub - base > 4 * MB, 30 * SECOND, 1), "4 MB in");
    const cancel = await hub.op("update.cancel", {});
    const atCancel = line.bytesToHub - base;
    check(cancel.ok, `update.cancel: ${JSON.stringify(cancel)}`);
    check(atCancel < release.size / 2, `cancelled mid-way (${String(atCancel)} bytes in)`);
    // Long enough for the whole file at the rate it came.
    await Bun.sleep(8 * SECOND);
    return { hub, size: release.size, atCancel, after: line.bytesToHub - base };
  })();
  return once;
}

describe("a release fetch cancelled mid-way", () => {
  test("the cancel holds: nothing staged; asked again, the release is fetched and staged", async () => {
    const { hub } = await cancelledFetch();
    const status = await hub.op("update.status", {});
    expect(status).toMatchObject({ ok: true, body: { staged: null } });
    check((await hub.op("update.fetch", { version: RELEASE_VERSION })).ok, "fetched again");
    check(
      await waitFor(
        async () => {
          const again = await hub.op("update.status", {});
          return again.ok && again.body.staged === RELEASE_VERSION;
        },
        60 * SECOND,
        250,
      ),
      "staged on the second fetch",
    );
  }, 120_000);

  test("FOUND-3: after the cancel the hub asks for no more than the pieces already in flight", async () => {
    const { atCancel, after, size } = await cancelledFetch();
    console.log(
      `fetch cancelled at ${String(atCancel)} bytes; ${String(after)} of ${String(size)} came in all`,
    );
    // At most the 4 pieces of 256 KiB in flight, and the frames' few bytes of overhead.
    expect(after - atCancel).toBeLessThan(4 * 256 * 1024 + 64 * 1024);
  }, 120_000);
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});

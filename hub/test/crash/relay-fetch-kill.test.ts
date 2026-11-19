/**
 * A release fetch cut off by a power cut (docs/m4-design.md section 6, "Fetching, only when
 * asked"; HD 4's table): the real hub killed with `kill -9` while a 32 MB signed release comes in
 * pieces through the relay program, then started again on its folder. Nothing half-fetched is
 * kept or taken for staged; the relay offers the release again when the link opens, and asked
 * again, the hub fetches it from the start and stages it.
 *
 * The crash points of each turn (`relay-crash.test.ts`) cannot cut the fetch, which is the relay
 * client's, so it is cut here, in the process, at the moment the bytes are coming.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { UPLOADS_FOLDER } from "../../src/shell/app/uploads.ts";
import { endProcesses } from "../world/processes.ts";
import { Seen } from "../relay/leaks.ts";
import {
  ALL_OUTPUT,
  check,
  HubProcess,
  Passthrough,
  PushRole,
  RelayProgram,
  shortFolder,
  waitFor,
} from "../relay/processes.ts";
import { RELEASE_VERSION, standIns, writeTestRelease } from "../relay/pushes.ts";

const SECOND = 1000;
const MB = 1024 * 1024;
const roots: string[] = [];
const stops: (() => unknown)[] = [];
const seen = new Seen();
afterAll(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await endProcesses();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const offered = async (hub: HubProcess): Promise<boolean> =>
  waitFor(
    async () => {
      const offers = await hub.op("update.offers", {});
      return (
        offers.ok && (offers.body.offer as { version?: string } | null)?.version === RELEASE_VERSION
      );
    },
    15 * SECOND,
    100,
  );

const staged = async (hub: HubProcess): Promise<string | null | undefined> => {
  const status = await hub.op("update.status", {});
  return status.ok ? (status.body.staged as string | null) : undefined;
};

describe("a release fetch cut off by kill -9", () => {
  test("nothing half-fetched kept or staged; offered again, fetched again from the start, staged", async () => {
    const root = shortFolder("hsn-fk-");
    roots.push(root);
    const s = await standIns();
    seen.standIns = s;
    stops.push(() => s.close());
    const push = new PushRole(root, s);
    await push.start();
    stops.push(() => push.stop());
    const releases = join(root, "releases");
    mkdirSync(releases);
    const release = writeTestRelease(releases, 32 * MB);
    const relay = new RelayProgram(root, { pushUrl: push.url, releases: { folder: releases } });
    await relay.start();
    stops.push(() => relay.stop());
    const line = new Passthrough(relay.port);
    stops.push(() => {
      line.close();
    });
    const hub = new HubProcess(root, { programTree: true });
    seen.hubDirs.push(hub.dataDir);
    seen.relayDirs.push(relay.dataFolder);
    await hub.start();
    stops.push(() => hub.kill());
    check((await hub.op("relay.set", { url: line.url })).ok, "relay.set");
    check(await hub.relayState("up", 15 * SECOND), "joined");
    check(await offered(hub), "offered");

    const base = line.bytesToHub;
    check((await hub.op("update.fetch", { version: RELEASE_VERSION })).ok, "update.fetch");
    check(await waitFor(() => line.bytesToHub - base > 6 * MB, 30 * SECOND, 1), "6 MB in");
    await hub.kill();
    const cutAt = line.bytesToHub - base;
    expect(cutAt).toBeLessThan(release.size);

    await hub.start();
    expect(await staged(hub)).toBeNull();
    // No upload left behind, and no version folder in the program tree.
    const uploads = join(hub.dataDir, UPLOADS_FOLDER);
    expect(existsSync(uploads) ? readdirSync(uploads) : []).toEqual([]);
    expect(existsSync(join(hub.prefix ?? "", "staged", RELEASE_VERSION))).toBe(false);
    check(await hub.relayState("up", 15 * SECOND), "joined again");
    check(await offered(hub), "offered again when the link opened");

    const again = line.bytesToHub;
    check((await hub.op("update.fetch", { version: RELEASE_VERSION })).ok, "fetched again");
    check(
      await waitFor(async () => (await staged(hub)) === RELEASE_VERSION, 60 * SECOND, 250),
      "staged",
    );
    // From the start: the whole file came again.
    expect(line.bytesToHub - again).toBeGreaterThanOrEqual(release.size);
    await hub.stop();
  }, 120_000);
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});

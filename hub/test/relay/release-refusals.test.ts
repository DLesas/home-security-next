/**
 * Releases through the relay that the hub must refuse (docs/m4-design.md section 6; section 11,
 * "Releases": "one with a changed byte refused `badFile`, one with a wrong key `badSignature`, and
 * the loop's 20 ms limit held throughout"): the relay program as a process serving its folder, the
 * real hub fetching through it. The relay checks no signature, as it is not trusted to; the hub
 * does.
 *
 * - A release signed with a key the hub does not trust: offered, fetched, refused `badSignature`,
 *   nothing staged.
 * - A release whose file changed after the relay indexed it (a byte flipped on the relay's disk):
 *   offered with the old SHA-256, fetched, refused `badFile` before staging.
 * - The hub's longest turn while each fetch ran (`hsn status`'s `longestTurnMs`), against the bound
 *   `loop-limit.test.ts` holds a loaded machine to (250 ms); M2's 20 ms ‡ printed beside it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, openSync, rmSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { HUB_VERSION } from "../../src/shell/hub-facts.ts";
import { makeRelease, platformOf } from "../../src/shell/update/release.ts";
import { programName } from "../../src/shell/update/program-name.ts";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { endProcesses } from "../world/processes.ts";
import { Seen } from "./leaks.ts";
import {
  ALL_OUTPUT,
  check,
  HubProcess,
  PushRole,
  RelayProgram,
  shortFolder,
  waitFor,
} from "./processes.ts";
import { RELEASE_VERSION, standIns, writeTestRelease } from "./pushes.ts";

const SECOND = 1000;
const MB = 1024 * 1024;
/** `loop-limit.test.ts`'s bound for a turn on a loaded machine. */
const LONGEST_TURN_BOUND_MS = 250;
const roots: string[] = [];
const stops: (() => unknown)[] = [];
const seen = new Seen();
afterAll(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await endProcesses();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A release of `bytes` for this computer signed with a key no hub trusts. */
function wronglySigned(folder: string, bytes: number): void {
  const data = new Uint8Array(bytes).map((_, i) => (i * 7) & 0xff);
  const hash = createHash("sha256").update(data).digest("hex");
  const platform = platformOf(process.platform, process.arch) ?? "darwin-arm64";
  const file = makeRelease(
    {
      version: RELEASE_VERSION,
      platform,
      madeMs: 0,
      payloadBytes: data.length,
      payloadSha256: hash,
      files: [
        {
          path: `bin/${programName(platform)}`,
          bytes: data.length,
          sha256: hash,
          executable: true,
        },
      ],
    },
    data,
    new Uint8Array(32).fill(9),
  )._unsafeUnwrap();
  writeFileSync(join(folder, `hsn-hub-${RELEASE_VERSION}-${platform}.hsnr`), file);
}

/** A hub fetching from a relay whose folder `fill` made; what it recorded, and its longest turn. */
async function fetchFrom(
  fill: (folder: string) => void,
  afterIndexed?: (folder: string) => void,
): Promise<{ readonly refused: string; readonly staged: unknown; readonly longestTurnMs: number }> {
  const root = shortFolder("hsn-rr-");
  roots.push(root);
  const s = await standIns();
  seen.standIns = s;
  stops.push(() => s.close());
  const push = new PushRole(root, s);
  await push.start();
  stops.push(() => push.stop());
  const releases = join(root, "releases");
  mkdirSync(releases);
  fill(releases);
  const relay = new RelayProgram(root, { pushUrl: push.url, releases: { folder: releases } });
  await relay.start();
  seen.relayDirs.push(relay.dataFolder);
  stops.push(() => relay.stop());
  afterIndexed?.(releases);
  const hub = new HubProcess(root, { programTree: true });
  seen.hubDirs.push(hub.dataDir);
  await hub.start();
  stops.push(() => hub.kill());
  check((await hub.op("relay.set", { url: relay.url })).ok, "relay.set");
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
  await hub.control({ kind: "status" });
  check((await hub.op("update.fetch", { version: RELEASE_VERSION })).ok, "update.fetch");
  const refused = await waitFor(
    async () => (await hub.hsn("log", "--kind", "event")).out.includes("update_refused"),
    60 * SECOND,
    500,
  );
  check(refused, "the fetched release refused");
  const status = (await hub.control({ kind: "status" })) as {
    readonly result?: { readonly longestTurnMs?: number };
  };
  const staged = await hub.op("update.status", {});
  await hub.stop();
  // The record's detail names the reason (`{reason, message}`); the log line shows the message.
  const db = new Database(join(hub.dataDir, "hub.db"), { readonly: true });
  const detail = db
    .query<{ detail: string | null }, []>(
      "SELECT detail FROM hub_events WHERE code = 'update_refused'",
    )
    .all()
    .map((row) => row.detail ?? "")
    .join("\n");
  db.close();
  return {
    refused: detail,
    staged: staged.ok ? staged.body.staged : "?",
    longestTurnMs: status.result?.longestTurnMs ?? Number.NaN,
  };
}

describe("releases through the relay the hub refuses", () => {
  test("signed with a key the hub does not trust: badSignature, nothing staged", async () => {
    const result = await fetchFrom((folder) => {
      wronglySigned(folder, 4 * MB);
    });
    console.log(
      `wrong key: ${result.refused}; longest turn ${String(result.longestTurnMs)} ms (M2's 20 ms ‡)`,
    );
    expect(result.refused).toContain("badSignature");
    expect(result.staged).toBeNull();
    expect(result.longestTurnMs).toBeLessThan(LONGEST_TURN_BOUND_MS);
  }, 120_000);

  test("changed on the relay's disk after it was indexed: badFile, nothing staged", async () => {
    const result = await fetchFrom(
      (folder) => {
        writeTestRelease(folder, 4 * MB);
      },
      (folder) => {
        const platform = platformOf(process.platform, process.arch) ?? "darwin-arm64";
        const fd = openSync(join(folder, `hsn-hub-${RELEASE_VERSION}-${platform}.hsnr`), "r+");
        writeSync(fd, Uint8Array.of(0x5a), 0, 1, 2 * MB);
        closeSync(fd);
      },
    );
    console.log(
      `changed byte: ${result.refused}; longest turn ${String(result.longestTurnMs)} ms (M2's 20 ms ‡)`,
    );
    expect(result.refused).toContain("badFile");
    expect(result.staged).toBeNull();
    expect(result.longestTurnMs).toBeLessThan(LONGEST_TURN_BOUND_MS);
    expect(HUB_VERSION).not.toBe(RELEASE_VERSION);
  }, 120_000);

  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});

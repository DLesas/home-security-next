/**
 * The update's switch announced to the relay by the real hub (docs/m4-design.md section 4, D96):
 * the hub process started as `main.ts` starts it (with the tests' publisher key), joined to B2's
 * relay on loopback (`hsn op relay.set`), a release staged and approved: it sends `restarting`
 * before it stops, the relay holds the hub's grace (no unreachable alert), and the hub exits 70 for
 * the launcher within the announcement's bound. With the relay gone, the switch is not held up.
 * The restore's switch runs the same port; the phone's end-to-end restore covers it with no relay
 * (`app/test/phone-real-hub.test.ts`), and `announce.test.ts` every case of the port.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELAY_LIMITS } from "@hsn/protocol/relay";
import { exchange } from "../../../cli/client.ts";
import { HUB_VERSION } from "../../../src/shell/hub-facts.ts";
import { makeRelease, platformOf } from "../../../src/shell/update/release.ts";
import { installPaths } from "../../../launcher/src/layout.ts";
import { endProcesses, spawnTracked } from "../../world/processes.ts";
import { type RelayRun, startRelayRun, stopAll, until } from "../shell-relay/support.ts";

const HUB = join(import.meta.dir, "..", "..", "..");
const TEST_ENTRY = join(HUB, "test", "unit", "shell-main", "hub-with-test-key.ts");
const HSN = join(HUB, "cli", "hsn.ts");
const root = mkdtempSync("/tmp/hsn-announce-");
const TEST_SEED = new Uint8Array(32).fill(7);

afterAll(async () => {
  await endProcesses();
  await stopAll();
  rmSync(root, { recursive: true, force: true });
});

/** A release of one file for this computer, newer than the running hub, signed with the test key. */
function testRelease(): string {
  const data = new TextEncoder().encode("#!/bin/sh\necho test release\n");
  const hash = createHash("sha256").update(data).digest("hex");
  const platform = platformOf(process.platform, process.arch) ?? "darwin-arm64";
  const file = makeRelease(
    {
      version: "99.0.0",
      platform,
      madeMs: 0,
      payloadBytes: data.length,
      payloadSha256: hash,
      files: [{ path: "bin/hsn-hub", bytes: data.length, sha256: hash, executable: true }],
    },
    data,
    TEST_SEED,
  )._unsafeUnwrap();
  const path = join(root, "release.hsnr");
  writeFileSync(path, file);
  return path;
}

/** The program tree the launcher would have made, running this version. */
function programTree(): string {
  const prefix = mkdtempSync(join(root, "p"));
  mkdirSync(join(prefix, "staged", HUB_VERSION, "bin"), { recursive: true });
  mkdirSync(join(prefix, "state"), { recursive: true });
  writeFileSync(
    installPaths(prefix).launcherFile,
    JSON.stringify({ current: HUB_VERSION, previous: null, trial: null, rolledBack: null }),
  );
  return prefix;
}

async function op(sock: string, name: string, body: unknown): Promise<Record<string, unknown>> {
  const answer = await exchange(
    sock,
    { id: 1, actor: "announce test", command: { kind: "op", op: name, body } },
    10_000,
  );
  const reply = answer._unsafeUnwrap().reply.reply;
  return reply.ok && reply.result.kind === "op"
    ? { ok: true, body: reply.result.body }
    : { ok: false, error: reply.ok ? undefined : reply.error };
}

/** A hub with a staged release, joined to `url`'s relay when it is up; then the approval. */
async function switchWith(
  run: RelayRun,
  joined: boolean,
): Promise<{ readonly code: number; readonly afterApproveMs: number; readonly identity: string }> {
  const data = mkdtempSync(join(root, "d"));
  const prefix = programTree();
  const hub = spawnTracked(
    ["bun", TEST_ENTRY, "--data", data, "--port", "0", "--no-usb-watch", "--app-ports", "0,0"],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, HSN_PROGRAM: prefix } },
  );
  const sock = join(data, "control.sock");
  await until(() => existsSync(sock), "the hub's control socket", 20_000);
  await Bun.sleep(300);
  const info = await op(sock, "hub.info", {});
  const identity = (info.body as { identity?: string } | undefined)?.identity ?? "";
  expect(await op(sock, "relay.set", { url: run.url })).toMatchObject({ ok: true });
  if (joined) await until(() => run.joined === 1, "the hub's link to the relay", 10_000);
  const install = spawnTracked(["bun", HSN, "--data", data, "update", "install", testRelease()], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(install.stdout).text();
  expect(await install.exited).toBe(0);
  expect(out).toContain("staged: version 99.0.0");
  const approved = await op(sock, "update.approve", {});
  const at = performance.now();
  expect(approved).toMatchObject({ ok: true, body: { switchWhen: "now" } });
  const code = await hub.exited;
  const afterApproveMs = performance.now() - at;
  // The launcher's note: the switch went ahead.
  expect(JSON.parse(readFileSync(installPaths(prefix).switchFile, "utf8"))).toEqual({
    to: "99.0.0",
  });
  return { code, afterApproveMs, identity };
}

describe("the update's switch, announced (main.ts)", () => {
  test("joined to B2's relay: restarting before the stop, the relay holds the grace, exit 70 within the bound", async () => {
    const run = startRelayRun();
    const { code, afterApproveMs, identity } = await switchWith(run, true);
    expect(code).toBe(70);
    expect(afterApproveMs).toBeLessThan(RELAY_LIMITS.restartAckWaitMs + 1500);
    const presence = run.relay?.presenceOf(identity);
    expect(presence?.graceEndMs).toBe(run.clock.now() + RELAY_LIMITS.maxRestartWithinMs);
  }, 60_000);

  test("the relay gone: nothing to wait for, exit 70 at once", async () => {
    const run = startRelayRun();
    await run.stop();
    const { code, afterApproveMs } = await switchWith(run, false);
    expect(code).toBe(70);
    expect(afterApproveMs).toBeLessThan(RELAY_LIMITS.restartAckWaitMs);
  }, 60_000);
});

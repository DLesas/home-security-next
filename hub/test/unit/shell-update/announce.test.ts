/**
 * A switch the hub makes itself is announced to the relay first (docs/m4-design.md section 4,
 * "Announcing a restart"; D96), in both switches: `switchUpdate` and `switchRestore` say which
 * (`JobDone.reason`), the loop hands it to its `restart` port only once it has stopped taking
 * inputs, and `switchAfterAnnouncing` (what `main.ts`'s port runs) sends `restarting` through the
 * relay client and switches once: on the acknowledgement, after 2 s ‡ when the relay is silent, at
 * once when the link is down or there is no relay client, never later than the 2 s whatever the
 * relay client does, and never twice.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSha256 } from "@hsn/protocol";
import { RELAY_LIMITS } from "@hsn/protocol/relay";
import { sha256 } from "@noble/hashes/sha2.js";
import { ok, type Result } from "neverthrow";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { HubEvent, Input } from "../../../src/core/model/events.ts";
import { jobId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import type { Core } from "../../../src/core/step.ts";
import type { CommitInfo, StorageError } from "../../../src/ports/writer.ts";
import { type JobDeps, runToEnd } from "../../../src/shell/backup/jobs.ts";
import { HubLoop, type LoopPorts, type LoopWriter } from "../../../src/shell/loop.ts";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { switchAfterAnnouncing } from "../../../src/shell/update/announce.ts";
import { installPaths } from "../../../launcher/src/layout.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import {
  identityOf,
  makeClient,
  ManualTimers,
  NOWHERE,
  ScriptedRelay,
  settle,
  startRelayRun,
  staticKeyOf,
  stopAll,
  until,
} from "../shell-relay/support.ts";

const roots: string[] = [];
afterEach(async () => {
  await stopAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** What a switch did: how often it ran, and when on the test's clock. */
function switcher(timers: ManualTimers): { readonly at: number[]; readonly run: () => void } {
  const at: number[] = [];
  return { at, run: () => at.push(timers.now) };
}

describe("switchAfterAnnouncing (main.ts's restart port)", () => {
  test("B2's relay answers: restarting {update}, acknowledged, then the switch, once, before 2 s; the relay holds the grace", async () => {
    const run = startRelayRun();
    const key = staticKeyOf(120);
    const side = makeClient({ key });
    side.client.perform({ kind: "relayConnect", url: run.url });
    await until(() => side.client.state.kind === "up", "the link up");
    const mine = new ManualTimers();
    const did = switcher(mine);
    const done = switchAfterAnnouncing(side.client, "update", mine, did.run);
    expect(did.at).toEqual([]);
    await done;
    expect(did.at).toEqual([0]);
    const presence = run.relay?.presenceOf(identityOf(key, sha256));
    expect(presence?.graceEndMs).toBe(run.clock.now() + RELAY_LIMITS.maxRestartWithinMs);
    // The bound's own timer is cancelled: nothing runs it again.
    mine.advance(RELAY_LIMITS.restartAckWaitMs * 2);
    side.timers.advance(RELAY_LIMITS.restartAckWaitMs * 2);
    await settle(5);
    expect(did.at).toEqual([0]);
    expect(mine.pending).toBe(0);
  });

  test.each(["update", "restore"] as const)(
    "the %s switch says so in its frame",
    async (reason) => {
      const relay = new ScriptedRelay();
      const side = makeClient({ key: staticKeyOf(121), connect: relay.connect });
      side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
      await until(() => side.client.state.kind === "up", "up");
      const mine = new ManualTimers();
      const did = switcher(mine);
      const done = switchAfterAnnouncing(side.client, reason, mine, did.run);
      await settle(5);
      expect(relay.last?.sent("restarting")).toEqual([
        { t: "restarting", reason, withinMs: 600_000 },
      ]);
      expect(did.at).toEqual([]);
      relay.last?.send({ t: "restartingAck" });
      await done;
      expect(did.at).toEqual([0]);
    },
  );

  test("a silent relay: the switch after 2 s ‡, not a millisecond before, and once", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: staticKeyOf(122), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    const mine = new ManualTimers();
    const did = switcher(mine);
    void switchAfterAnnouncing(side.client, "restore", mine, did.run);
    // Both clocks move together, as the one real clock does.
    side.timers.advance(RELAY_LIMITS.restartAckWaitMs - 1);
    mine.advance(RELAY_LIMITS.restartAckWaitMs - 1);
    await settle(5);
    expect(did.at).toEqual([]);
    side.timers.advance(1);
    mine.advance(1);
    await settle(5);
    expect(did.at).toEqual([RELAY_LIMITS.restartAckWaitMs]);
    // A late acknowledgement changes nothing.
    relay.last?.send({ t: "restartingAck" });
    await settle(5);
    expect(did.at).toHaveLength(1);
  });

  test("the link down: nothing sent, the switch at once", async () => {
    const side = makeClient({ key: staticKeyOf(123), connect: NOWHERE });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "waiting", "down");
    const mine = new ManualTimers();
    const did = switcher(mine);
    await switchAfterAnnouncing(side.client, "update", mine, did.run);
    expect(did.at).toEqual([0]);
  });

  test("no relay client at all: the switch at once, in the same call", () => {
    const mine = new ManualTimers();
    const did = switcher(mine);
    void switchAfterAnnouncing(undefined, "restore", mine, did.run);
    expect(did.at).toEqual([0]);
  });

  test("a relay client that never answers: the switch at 2 s ‡ by the bound's own timer; a late answer changes nothing", async () => {
    let answer: (() => void) | undefined;
    const never = {
      announceRestart: () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    };
    const mine = new ManualTimers();
    const did = switcher(mine);
    void switchAfterAnnouncing(never, "update", mine, did.run);
    mine.advance(RELAY_LIMITS.restartAckWaitMs - 1);
    await settle(1);
    expect(did.at).toEqual([]);
    mine.advance(1);
    expect(did.at).toEqual([RELAY_LIMITS.restartAckWaitMs]);
    answer?.();
    await settle(1);
    expect(did.at).toHaveLength(1);
  });

  test("an announcement that rejects (it never should): the switch still goes, at once, once", async () => {
    const failing = { announceRestart: () => Promise.reject(new Error("broken")) };
    const mine = new ManualTimers();
    const did = switcher(mine);
    await switchAfterAnnouncing(failing, "update", mine, did.run);
    expect(did.at).toEqual([0]);
    mine.advance(RELAY_LIMITS.restartAckWaitMs);
    expect(did.at).toHaveLength(1);
  });
});

// ----- Both switches name their reason, and the loop passes it on after it has stopped -----

function jobDeps(dataDir: string, prefix: string | undefined): JobDeps {
  return {
    db: undefined as never,
    dataDir,
    migrationsFolder: "",
    rules: DEFAULT_RULES,
    uploads: { pathOf: () => undefined },
    exports: { send: () => ok(undefined) },
    prefix,
    switchBlockedBy: () => undefined,
    nowMs: () => 0,
    salt: () => ok(new Uint8Array(8)),
    room: () => ({ freeBytes: 10 ** 12, databaseBytes: 1 }),
  };
}

describe("the switches' reasons", () => {
  test("switchRestore: stop and restart, for a restore; switchUpdate of an installed version: for an update", () => {
    const root = mkdtempSync(join(tmpdir(), "hsn-announce-"));
    roots.push(root);
    expect(runToEnd(jobId(1), { kind: "switchRestore" }, jobDeps(root, undefined))).toMatchObject({
      kind: "stopAndRestart",
      reason: "restore",
    });
    const prefix = join(root, "prefix");
    mkdirSync(join(prefix, "staged", "1.1.0"), { recursive: true });
    mkdirSync(join(prefix, "state"), { recursive: true });
    writeFileSync(
      installPaths(prefix).launcherFile,
      JSON.stringify({ current: "1.0.0", previous: null, trial: null, rolledBack: null }),
    );
    expect(
      runToEnd(jobId(2), { kind: "switchUpdate", version: "1.1.0" }, jobDeps(root, prefix)),
    ).toMatchObject({ kind: "stopAndRestart", reason: "update" });
  });

  class Writer implements LoopWriter {
    stage(): void {
      return;
    }
    setCadence(): void {
      return;
    }
    durable(): number | undefined {
      return undefined;
    }
    due(): undefined {
      return undefined;
    }
    flushIfDue(): Result<(CommitInfo & { readonly committed: boolean }) | undefined, StorageError> {
      return ok(undefined);
    }
    flush(): Result<CommitInfo & { readonly committed: boolean }, StorageError> {
      return ok({ items: 0, durationMs: 0, committed: true });
    }
    takeOutcome(): undefined {
      return undefined;
    }
    maintain(): Result<void, StorageError> {
      return ok(undefined);
    }
  }

  test.each(["update", "restore"] as const)(
    "the loop: a %s switch's job gives the port its reason, after the loop has stopped taking inputs",
    (reason) => {
      const restarts: { reason: string; takesInputs: boolean }[] = [];
      const work =
        reason === "update"
          ? ({ kind: "switchUpdate", version: "1.1.0" } as const)
          : ({ kind: "switchRestore" } as const);
      const core: Core = {
        emptyState: () => ({}) as HubState,
        nextDeadline: () => undefined,
        step: (state: HubState, input: Input) =>
          ok({
            state,
            effects:
              input.event.kind === "tick"
                ? ([{ kind: "fileJob", job: jobId(1), work }] as readonly Effect[])
                : [],
            wake: undefined,
          }),
      };
      const ports: LoopPorts = {
        clock: { now: (): Now => ({ mono: mono(0), wall: 1_800_000_000_000, wallTrusted: true }) },
        random: { bytes: (length) => ok(new Uint8Array(length)) },
        links: { listen: () => undefined, send: () => ok(undefined), close: () => ok(undefined) },
        control: { respond: () => undefined, publish: () => undefined },
        writer: new Writer(),
        advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
        wakeAt: () => undefined,
        soon: () => undefined,
        report: () => undefined,
        fatal: () => undefined,
        files: {
          perform: () => ({ kind: "stopAndRestart", reason, afterStop: () => ok(undefined) }),
        },
        restart: (_afterStop, given) => {
          loop.enqueue({ kind: "tick" } satisfies HubEvent);
          restarts.push({ reason: given, takesInputs: loop.waiting > 0 });
        },
      };
      const loop = new HubLoop(
        core,
        {
          cipher: VectorCipher.fromVectors(),
          rules: DEFAULT_RULES,
          calendar: UNBUILT_CALENDAR,
          sha256: nodeSha256,
        },
        ports,
      );
      loop.enqueue({ kind: "tick" });
      loop.turn();
      expect(restarts).toEqual([{ reason, takesInputs: false }]);
    },
  );
});

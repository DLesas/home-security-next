/**
 * A hub release offered and fetched through B2's real relay, end to end on the hub's side
 * (docs/m4-design.md section 6): the relay's releases role serves a release signed with
 * `TEST_PUBLISHER_KEY` from its folder; the hub's relay client (B6) offers it to upkeep, which
 * records `update_offered` once and answers `update.offers`; `update.fetch` makes the
 * `fetchRelease` the client downloads in pieces and stages with M2's own staging under the fetch's
 * job, which upkeep's `stagingJob` accepts; the outcome makes `update_staged`, the version is in the
 * program tree, and the fetched file is gone. A fetch cancelled half-way stages nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppOp, type AppOpV2, isVersion1Op } from "@hsn/protocol/app";
import { hubReleaseFileName, type ReleasePlatform } from "@hsn/protocol/release";
import { ok } from "neverthrow";
import type { Effect, FileWork } from "../../../src/core/model/effects.ts";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { clientId, connId, type JobId, seq } from "../../../src/core/model/ids.ts";
import type { AnswerTo, Internal } from "../../../src/core/model/messages.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { stagingJob } from "../../../src/core/upkeep/view.ts";
import { UploadStore } from "../../../src/shell/app/uploads.ts";
import { startJob } from "../../../src/shell/backup/jobs.ts";
import type { JobPieces, JobStarted } from "../../../src/shell/loop.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import { platformOf } from "../../../src/shell/update/release.ts";
import { programName } from "../../../src/shell/update/program-name.ts";
import { installPaths } from "../../../launcher/src/layout.ts";
import { releaseOfFiles } from "../../../packaging/shared/make-release.ts";
import { ReleaseBudget } from "../../../../relay/src/core/release-budget.ts";
import { FolderReleaseIndex } from "../../../../relay/src/releases/folder-index.ts";
import { ReleaseService } from "../../../../relay/src/releases/service.ts";
import { ManualClock, memoryLog } from "../../../../relay/test/helpers.ts";
import {
  type ClientSide,
  makeClient,
  settle,
  startRelayRun,
  staticKeyOf,
  stopAll,
  until,
} from "../shell-relay/support.ts";
import { type Ran, Runner, snapshot } from "../upkeep/support.ts";

const SEED = new Uint8Array(32).fill(7);
const RUNNING = "0.1.0";
const VERSION = "9.0.0";
const PLATFORM: ReleasePlatform = platformOf(process.platform, process.arch) ?? "darwin-arm64";
let root: string;
let releases: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hsn-fetch-relay-"));
  releases = join(root, "releases");
  mkdirSync(releases);
  const made = releaseOfFiles(
    [
      {
        path: `bin/${programName(PLATFORM)}`,
        data: new Uint8Array(randomBytes(1_200_000)),
        executable: true,
      },
      { path: "drizzle/0000.sql", data: new TextEncoder().encode("SELECT 1;"), executable: false },
    ],
    VERSION,
    PLATFORM,
    SEED,
    0,
  );
  if (made.isErr()) expect(made.error).toBe("a release");
  writeFileSync(
    join(releases, hubReleaseFileName(VERSION, PLATFORM)),
    made.unwrapOr(new Uint8Array()),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  await stopAll();
});

const CONSOLE: AnswerTo = { kind: "app", conn: connId(3), client: clientId(1), id: 7, seq: 9 };

/** The program tree the launcher made, running `RUNNING`. */
function programTree(): string {
  const prefix = mkdtempSync(join(root, "prefix-"));
  mkdirSync(join(prefix, "staged", RUNNING, "bin"), { recursive: true });
  mkdirSync(join(prefix, "state"), { recursive: true });
  writeFileSync(
    installPaths(prefix).launcherFile,
    JSON.stringify({ current: RUNNING, previous: null, trial: null, rolledBack: null }),
  );
  return prefix;
}

/** upkeep running `RUNNING`, its operations sent as `app` sends them. */
function upkeep(): Runner {
  const runner = new Runner();
  runner.boot(snapshot({ backupKey: { key: new Uint8Array(32), epoch: 1 } }));
  runner.send({
    kind: "hubFacts",
    version: RUNNING,
    addresses: [],
    appsPort: 8444,
    consolePort: 8445,
    certificateSha256: new Uint8Array(32),
  });
  return runner;
}

/** `update.offers` and `update.fetch` as `app` routes them (`v2OpRequest`); `update.cancel`, a version 1 row. */
function op(runner: Runner, o: AppOpV2): Ran {
  const actor = { kind: "computer", name: "root" } as const;
  return runner.send(
    isVersion1Op(o.op)
      ? {
          kind: "opRequest",
          owner: "upkeep",
          op: o as AppOp,
          actor,
          answerTo: CONSOLE,
          record: seq(0),
        }
      : { kind: "v2OpRequest", owner: "upkeep", op: o, actor, answerTo: CONSOLE, record: seq(0) },
  );
}

function answer(ran: Ran): unknown {
  const found = ran.messages.find((m) => m.kind === "opAnswer");
  return found?.kind === "opAnswer" ? found.outcome : undefined;
}

function decisions(ran: Ran): string[] {
  return ran.messages.flatMap((m) =>
    m.kind === "auditRecord" && m.record.kind === "decision" ? [m.record.row.kind] : [],
  );
}

/** The hub's relay client, joined to B2's relay serving the folder, staging as `main.ts` wires it. */
async function joined(
  runner: Runner,
  prefix: string,
): Promise<{ side: ClientSide; uploads: UploadStore }> {
  const clock = new ManualClock(Date.UTC(2026, 10, 18, 12));
  const index = new FolderReleaseIndex(releases, memoryLog());
  expect((await index.refresh()).isOk()).toBe(true);
  const service = new ReleaseService(index, new ReleaseBudget(), clock, memoryLog());
  const run = startRelayRun({
    releases: {
      check: (peer, check) => service.check(peer, check),
      get: (peer, r) => service.get(peer, r),
    },
  });
  const uploadFolder = mkdtempSync(join(root, "uploads-"));
  const uploads = new UploadStore(uploadFolder);
  expect(uploads.clearAll().isOk()).toBe(true);
  // `main.ts`: the relay client stages through the app side's jobs, whose staging asks upkeep
  // whether it still wants this job (`stagingJob`).
  const stage = (job: JobId, work: FileWork): JobStarted => {
    const started = startJob(job, work, {
      db: undefined as never,
      dataDir: root,
      migrationsFolder: "",
      rules: DEFAULT_RULES,
      uploads: { pathOf: (ref) => uploads.finished(ref)?.path },
      exports: { send: () => ok(undefined) },
      prefix,
      switchBlockedBy: () => undefined,
      stagingWanted: (staging) => stagingJob(runner.view) === staging,
      publisherKeys: [TEST_PUBLISHER_KEY],
      version: RUNNING,
      nowMs: () => 0,
      salt: () => ok(new Uint8Array(8)),
    });
    if (started.kind !== "pieces") return started;
    const pieces = started.pieces;
    return {
      kind: "pieces",
      pieces: {
        next: () => {
          const outcome = pieces.next();
          return outcome === undefined ? { done: false } : { done: true, outcome };
        },
        abort: () => {
          pieces.abort("stopped");
        },
      },
    };
  };
  const side = makeClient({ key: staticKeyOf(140), platform: PLATFORM, stage, uploads });
  side.client.perform({ kind: "relayConnect", url: run.url });
  await until(() => side.client.state.kind === "up", "the link up");
  return { side, uploads };
}

/** Runs pieces as the loop does: one `next` a turn, none while the job waits; `each` after each. */
async function drive(pieces: JobPieces, each: () => void = () => undefined): Promise<FileOutcome> {
  for (;;) {
    if (pieces.waiting?.() === true) {
      await settle(2);
      continue;
    }
    const step = pieces.next();
    if (step.done) return step.outcome;
    each();
  }
}

function fetchJob(ran: Ran): Extract<Effect, { readonly kind: "fileJob" }> | undefined {
  return ran.effects.find(
    (e): e is Extract<Effect, { readonly kind: "fileJob" }> => e.kind === "fileJob",
  );
}

describe("a hub release through the relay", () => {
  test("offered when the link opens, recorded once; fetched on update.fetch and staged as update_staged", async () => {
    const runner = upkeep();
    const prefix = programTree();
    const { side, uploads } = await joined(runner, prefix);
    await until(() => side.of("releaseOffered").length === 1, "the offer");
    const offeredRan = runner.send(side.of("releaseOffered")[0] as Internal);
    expect(decisions(offeredRan)).toEqual(["update_offered"]);
    const offers = answer(op(runner, { op: "update.offers", body: {} }));
    expect(offers).toMatchObject({
      ok: true,
      body: { offer: { version: VERSION, platform: PLATFORM } },
    });

    const asked = op(runner, { op: "update.fetch", body: { version: VERSION } });
    const job = fetchJob(asked);
    expect(answer(asked)).toEqual({ ok: true, body: { job: job?.job } });
    expect(job?.work.kind).toBe("fetchRelease");
    if (job?.work.kind !== "fetchRelease") return;
    expect(job.work.sha256).toHaveLength(32);
    const started = side.client.fetch(job.job, job.work);
    expect(started.kind).toBe("pieces");
    if (started.kind !== "pieces") return;
    const outcome = await drive(started.pieces);
    expect(outcome).toEqual({ kind: "updateStaged", version: VERSION });
    const ended = runner.send({ kind: "fileReady", job: job.job, outcome });
    expect(decisions(ended)).toEqual(["update_staged"]);
    expect(runner.slice.update.stagedVersion).toBe(VERSION);
    expect(existsSync(join(prefix, "staged", VERSION, "drizzle", "0000.sql"))).toBe(true);
    // The fetched file is freed; the relay client holds no fetch.
    expect(uploads.held).toBe(0);
    expect(side.client.releases.fetching).toBe(0);
  }, 60_000);

  test("cancelled while it fetches: the staging finds it unwanted, nothing is staged, the outcome is ignored", async () => {
    const runner = upkeep();
    const prefix = programTree();
    const { side, uploads } = await joined(runner, prefix);
    await until(() => side.of("releaseOffered").length === 1, "the offer");
    runner.send(side.of("releaseOffered")[0] as Internal);
    const job = fetchJob(op(runner, { op: "update.fetch", body: { version: VERSION } }));
    expect(job?.work.kind).toBe("fetchRelease");
    if (job?.work.kind !== "fetchRelease") return;
    const started = side.client.fetch(job.job, job.work);
    expect(started.kind).toBe("pieces");
    if (started.kind !== "pieces") return;
    let cancelled = false;
    const outcome = await drive(started.pieces, () => {
      if (!cancelled) {
        cancelled = true;
        expect(answer(op(runner, { op: "update.cancel", body: {} }))).toEqual({
          ok: true,
          body: {},
        });
      }
    });
    expect(outcome.kind).toBe("failed");
    expect(decisions(runner.send({ kind: "fileReady", job: job.job, outcome }))).toEqual([]);
    expect(runner.slice.update.stagedVersion).toBeNull();
    expect(readdirSync(join(prefix, "staged"))).toEqual([RUNNING]);
    expect(uploads.held).toBe(0);
  }, 60_000);
});

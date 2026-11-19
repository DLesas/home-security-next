/**
 * A8's new steps cut off by a power cut at each point of hub-design.md section 4's table, on the
 * whole hub of `test/world/home.ts` with M2's household and a phone, then the restart from what was
 * on the disk (m3-design section 4; m4-design section 6):
 *
 * - `backup.keyHeld` (the epoch written now): answered only after its commit; whether or not it
 *   was, the phone fetches the key again after the restart and confirms it, and the hub then holds
 *   the epoch;
 * - a release fetched through the relay and staged (`update_staged` written now): recorded staged
 *   only with its version folder in place; when the record was lost, offered again (the relay
 *   offers when the link opens) and fetched again, it stages, the old folder replaced.
 *
 * The fetch's download is the relay client's (B6's tests); here the shell's file work gives the
 * fetched file straight to M2's staging, as the relay client does once every byte is in.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppOpV2 } from "@hsn/protocol/app";
import { ok } from "neverthrow";
import type { FileWork } from "../../src/core/model/effects.ts";
import {
  type ClientId,
  clientId,
  type ConnId,
  connId,
  type JobId,
} from "../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";
import { startJob } from "../../src/shell/backup/jobs.ts";
import type { JobStarted } from "../../src/shell/loop.ts";
import { TEST_PUBLISHER_KEY } from "../../src/shell/update/publisher-keys.ts";
import { platformOf } from "../../src/shell/update/release.ts";
import { programName } from "../../src/shell/update/program-name.ts";
import { installPaths } from "../../launcher/src/layout.ts";
import { releaseOf } from "../../packaging/shared/make-release.ts";
import { tempDir } from "../unit/storage/fixtures.ts";
import { CONSOLE, Household, homePorts, seedHousehold } from "../budget/household.ts";
import { CRASH_POINTS, type CrashPoint, Home, HOUR, MINUTE } from "../world/home.ts";
import { DAY_TEST_TIMEOUT_MS } from "../world/timeouts.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");
/** Anna's phone, added to the household (kind 2). */
const PHONE = clientId(30);
const RUNNING = "0.1.0";
const VERSION = "9.0.0";
const PLATFORM = platformOf(process.platform, process.arch) ?? "darwin-arm64";
const PROGRAM = programName(PLATFORM);

let home: Home | undefined;
const folders: { remove(): void }[] = [];
afterEach(() => {
  home?.close();
  home = undefined;
});
afterAll(() => {
  for (const f of folders) f.remove();
});

function must(result: { isErr(): boolean; error?: { message: string } }): void {
  expect(result.isErr() ? (result.error?.message ?? "stalled") : "ok").toBe("ok");
}

/** A signed release of this computer's platform, its program tree, and the file work as main.ts wires it. */
function releaseSetup(): {
  readonly path: string;
  readonly prefix: string;
  readonly sha256: string;
  readonly bytes: number;
} {
  const root = tempDir("a8-release");
  folders.push(root);
  const source = join(root.path, "source");
  mkdirSync(join(source, "bin"), { recursive: true });
  writeFileSync(join(source, "bin", PROGRAM), new Uint8Array(600_000).fill(7), { mode: 0o755 });
  const path = join(root.path, "fetched.hsnr");
  const file = releaseOf(source, VERSION, PLATFORM, new Uint8Array(32).fill(7), 0)._unsafeUnwrap();
  writeFileSync(path, file);
  const prefix = join(root.path, "program");
  mkdirSync(join(installPaths(prefix).staged, RUNNING), { recursive: true });
  mkdirSync(installPaths(prefix).state, { recursive: true });
  writeFileSync(
    installPaths(prefix).launcherFile,
    JSON.stringify({ current: RUNNING, previous: null, trial: null, rolledBack: null }),
  );
  return {
    path,
    prefix,
    sha256: createHash("sha256").update(file).digest("hex"),
    bytes: file.length,
  };
}

/** The household and Anna's phone; M2's file jobs, a fetched release staged as the relay client stages it. */
/**
 * The crash point for the turn that ends the next fetch's staging: armed when the shell starts the
 * fetch's file work, after the commit and the answer of the turn that asked for it, so the power
 * goes in the turn whose commit holds `update_staged` (or an earlier one written now meanwhile).
 */
let crashOnFetch: CrashPoint | undefined;

async function household(
  seed: number,
  release?: ReturnType<typeof releaseSetup>,
): Promise<Household> {
  const ports = homePorts();
  const base = ports.files;
  const files = {
    perform: (job: JobId, work: FileWork): JobStarted => {
      const store = home?.store;
      if (work.kind !== "fetchRelease" || release === undefined || store === undefined)
        return (
          base?.perform(job, work) ?? {
            kind: "ready",
            outcome: { kind: "failed", reason: "io", message: "no file jobs" },
          }
        );
      if (crashOnFetch !== undefined) home?.crashAt(crashOnFetch, true);
      crashOnFetch = undefined;
      const started = startJob(
        job,
        { kind: "stageUpdate", upload: { conn: connId(999), job } },
        {
          db: store.db,
          dataDir: dirname(store.path),
          migrationsFolder: MIGRATIONS,
          rules: DEFAULT_RULES,
          uploads: { pathOf: () => release.path },
          exports: { send: () => ok(undefined) },
          prefix: release.prefix,
          switchBlockedBy: () => undefined,
          publisherKeys: [TEST_PUBLISHER_KEY],
          version: RUNNING,
          nowMs: () => 0,
          salt: () => ok(new Uint8Array(8)),
        },
      );
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
            pieces.abort("the hub is stopping");
          },
        },
      };
    },
  };
  home = await Home.create(
    { name: "a8", sensors: 2, sirens: 1, gateways: 1, seed, calendar: ports.calendar, files },
    (store) => {
      seedHousehold(store);
      store.db.run(
        `INSERT INTO clients (id, person_id, static_key, kind, name, created_ms, last_seq, backup_key_epoch) VALUES (?, 1, ?, 2, 'Anna''s phone', 0, 0, NULL)`,
        [PHONE, new Uint8Array(32).fill(PHONE)],
      );
    },
  );
  ports.attach(home);
  const h = new Household(home);
  h.facts();
  must(home.advanceTo(HOUR));
  return h;
}

let conns = 7000;
let ids = 0;

/** A version 2 session, as the channel gives it once the handshake agreed version 2. */
function sessionV2(hub: Home, client: ClientId, listener: "lan" | "console" = "lan"): ConnId {
  const conn = connId(conns++);
  hub.input({ kind: "clientConnected", conn, client, listener, proto: 2, app: "2.0.0" });
  return conn;
}

function ask(hub: Home, conn: ConnId, client: ClientId, op: AppOpV2, seq?: number): number {
  const id = ++ids;
  hub.input({ kind: "clientRequest", conn, client, request: { id, seq, op } });
  return id;
}

/** The reply to request `id` on `conn`, if it left the hub. */
function reply(hub: Home, conn: ConnId, id: number): { readonly ok?: unknown } | undefined {
  for (const e of hub.app)
    if (e.kind === "appSend" && e.conn === conn && "t" in e.message && e.message.t === "res")
      if (e.message.id === id) return e.message;
  return undefined;
}

function heldEpoch(hub: Home): number | null | undefined {
  return hub.query<{ e: number | null }>(
    `SELECT backup_key_epoch AS e FROM clients WHERE id = ?`,
    PHONE,
  )[0]?.e;
}

describe.each(CRASH_POINTS.map((p) => [p]))("power lost at %s", (point: CrashPoint) => {
  test(
    "backup.keyHeld: answered only after its commit; the key fetched again after the restart and confirmed",
    async () => {
      const h = await household(21);
      const hub = h.home;
      const epoch = hub.query<{ e: number }>(`SELECT epoch AS e FROM backup_key`)[0]?.e ?? -1;
      expect(epoch).toBeGreaterThan(0);
      let conn = sessionV2(hub, PHONE);
      const key = reply(hub, conn, ask(hub, conn, PHONE, { op: "backup.key", body: {} }));
      expect(key).toMatchObject({ ok: true, body: { epoch } });
      expect(heldEpoch(hub)).toBeNull();
      hub.crashAt(point, true);
      const id = ask(hub, conn, PHONE, { op: "backup.keyHeld", body: { epoch } }, 1);
      expect(hub.restarts).toBe(1);
      const answered = reply(hub, conn, id);
      // "Now": nothing answered before its commit.
      if (answered?.ok === true) expect(heldEpoch(hub)).toBe(epoch);
      // After the restart, the phone asks again (it never saw the answer, or did) and confirms.
      conn = sessionV2(hub, PHONE);
      const again = reply(hub, conn, ask(hub, conn, PHONE, { op: "backup.key", body: {} }));
      expect(again).toMatchObject({ ok: true, body: { epoch } });
      const confirmed = reply(
        hub,
        conn,
        ask(hub, conn, PHONE, { op: "backup.keyHeld", body: { epoch } }, 1),
      );
      expect(confirmed?.ok).toBe(true);
      expect(heldEpoch(hub)).toBe(epoch);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test(
    "a fetched release's update_staged: recorded only with its folder; lost, offered and fetched again, it stages",
    async () => {
      const release = releaseSetup();
      const h = await household(22, release);
      const hub = h.home;
      const offer = {
        kind: "hub" as const,
        version: VERSION,
        platform: PLATFORM,
        file: `hsn-hub-${VERSION}-${PLATFORM}.hsnr`,
        bytes: release.bytes,
        sha256: release.sha256,
      };
      const staged = join(installPaths(release.prefix).staged, VERSION);
      const recorded = (): string | null | undefined =>
        hub.query<{ v: string | null }>(`SELECT staged_version AS v FROM update_state`)[0]?.v;
      const fetch = (seq: number): { readonly ok?: unknown } | undefined => {
        hub.input({ kind: "releaseOffered", releases: [offer] });
        const conn = sessionV2(hub, CONSOLE, "console");
        return reply(
          hub,
          conn,
          ask(hub, conn, CONSOLE, { op: "update.fetch", body: { version: VERSION } }, seq),
        );
      };
      // The staging runs in pieces after the answer; its end is written now, where the power goes.
      crashOnFetch = point;
      expect(fetch(1)).toMatchObject({ ok: true });
      // A turn a piece, as the loop runs jobs (the home turns only for inputs).
      for (let i = 0; i < 200 && hub.restarts === 0; i++) hub.input({ kind: "tick" });
      expect(hub.restarts).toBe(1);
      if (recorded() === VERSION) expect(existsSync(join(staged, "bin", PROGRAM))).toBe(true);
      else {
        // Lost with the turn: the relay offers again when the link opens, and a person fetches again.
        expect(fetch(2)).toMatchObject({ ok: true });
        for (let i = 0; i < 200 && recorded() !== VERSION; i++) hub.input({ kind: "tick" });
      }
      expect(recorded()).toBe(VERSION);
      expect(readFileSync(join(staged, "bin", PROGRAM)).length).toBe(600_000);
      must(hub.advanceBy(MINUTE));
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

/**
 * Firmware staging on its worker thread (`shell/firmware/stage-job.ts`, `stage-serve.ts`), as the
 * loop drives it: the same outcomes and the same store as `FirmwareStaging` on the thread, the
 * hub's key read on the loop and nothing on the worker able to open `hub.db`; stagings beside each
 * other (no gate); a stop, with the worker answering and not; a worker that does not start, throws
 * or exits first; nothing left behind.
 *
 * A worker stuck in two ways, each let go by the test: in a real file call, the upload made a FIFO
 * with no writer, which `FirmwareStaging` opens in its first piece, so the worker blocks in
 * `open()`, nothing written yet (FIFOs are Linux's and macOS's); and on every system, Windows
 * too, a stand-in worker that stages as the real one but holds its thread in the temporary file's
 * sync, the payload copied (`firmware-workers/held.ts`).
 *
 * The loop's time (the job's constructor, which reads the key from a real database, and each
 * `next()` within section 3's 20 ms, a 10 ms timer never 50 ms late) is asserted in a child process
 * holding nothing but the job (`firmware-timing-child.ts`), for the reason `shell-update`'s
 * `stage-job.test.ts` gives: this process's heap has its own collections.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyImageHeader } from "@hsn/protocol/update";
import { err, ok, type Result } from "neverthrow";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { type SigningKeys, signerOfKeys } from "../../../src/shell/firmware/sign.ts";
import {
  type FirmwareJobInputs,
  FirmwareStagingJob,
} from "../../../src/shell/firmware/stage-job.ts";
import { FirmwareStaging, stagingFile } from "../../../src/shell/firmware/stage.ts";
import { checkStore, storeFolder } from "../../../src/shell/firmware/store.ts";
import { type JobThreadEvents, startJobThread } from "../../../src/shell/safe/job-thread.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import { jobControl } from "../../../src/shell/worker/control.ts";
import {
  STOP_WAIT_MS,
  type StartWorker,
  type WorkerJobOptions,
} from "../../../src/shell/worker/job.ts";
import type { KindData, WorkerData } from "../../../src/shell/worker/kinds.ts";
import type { FirmwareChildArgs, FirmwareChildNumbers } from "./firmware-timing-child.ts";
import {
  espImage,
  hex,
  release,
  RULES,
  sha256,
  STRANGER_SEED,
  type TempFolder,
  tempFolder,
  testHubKeys,
  toEnd,
} from "./support.ts";

/** A firmware staging's worker data. */
type Staged = KindData<"stageFirmware">;

const POSIX = process.platform !== "win32";
const HUB = join(import.meta.dir, "..", "..", "..");
const CHILD = join(import.meta.dir, "firmware-timing-child.ts");
const folders: TempFolder[] = [];
const writers: ReturnType<typeof Bun.spawn>[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
/** The jobs this test made: each aborted after it, so that a failed test leaves no worker held. */
const opened: FirmwareStagingJob[] = [];
/** The stuck stagings this test made: each let go after it. */
const stuck: { readonly at: Rig; readonly way: StuckWay }[] = [];
let signingKeys: SigningKeys;
let publicKey: Uint8Array;
let jobs = 0;

/** The longest a drive waits for the job's wake, and the most turns it may ask for one staging. */
const WAKE_WAIT_MS = 6000;
const MOST_TURNS = 20;
/** A payload as large as a real image: 1.5 MB. */
const PAYLOAD = espImage({ size: 1_500_000, seed: 5 });
const OWN = espImage({ size: 900_000, seed: 6 });

setDefaultTimeout(60_000);

beforeAll(async () => {
  const keys = await testHubKeys();
  signingKeys = {
    signingPrivate: keys.pkcs8,
    signingPublic: keys.publicKey,
    identity: keys.identity,
  };
  publicKey = keys.publicKey;
});

afterEach(async () => {
  for (const { at, way } of stuck.splice(0)) way.letGo(at);
  for (const job of opened.splice(0)) job.abort("the test is over");
  // Every held worker let go ends; give their threads the time to.
  await Bun.sleep(50);
});

afterAll(() => {
  for (const spawned of [...writers, ...children]) spawned.kill(9);
  for (const folder of folders.splice(0)) folder.remove();
});

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!done()) {
    expect(performance.now()).toBeLessThan(end);
    await Bun.sleep(5);
  }
}

/** A hub's data folder with an upload in it, and the job number its staging is given. */
interface Rig {
  readonly dataDir: string;
  readonly upload: string;
  readonly job: number;
}

function rig(file: Uint8Array | "fifo"): Rig {
  const folder = tempFolder("stage-job");
  folders.push(folder);
  const dataDir = join(folder.path, "data");
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const upload = join(dataDir, "uploads", "1");
  if (file === "fifo") expect(Bun.spawnSync(["mkfifo", upload]).exitCode).toBe(0);
  else writeFileSync(upload, file);
  return { dataDir, upload, job: 2 ** 31 + (jobs += 1) };
}

function inputs(
  at: Rig,
  own: string | null = null,
  key: () => Result<SigningKeys, string> = () => ok(signingKeys),
): FirmwareJobInputs {
  return {
    job: at.job,
    path: at.upload,
    own: own === null ? null : { version: own },
    dataDir: at.dataDir,
    keys: [TEST_PUBLISHER_KEY],
    rules: RULES,
    signingKeys: key,
  };
}

/**
 * `FirmwareStaging` on this thread, a piece after another: what the loop did before the worker,
 * its signer read from the database and made when the header is.
 */
function onThread(jobInputs: FirmwareJobInputs): FileOutcome {
  const { signingKeys: read, ...rest } = jobInputs;
  return toEnd(new FirmwareStaging({ ...rest, signer: () => read().andThen(signerOfKeys) }))
    .outcome;
}

/** The store's files, by name, with their bytes; none when there is no store folder. */
function store(at: Rig): Map<string, string> {
  const folder = storeFolder(at.dataDir);
  const files = new Map<string, string>();
  if (!existsSync(folder)) return files;
  for (const name of readdirSync(folder))
    files.set(name, readFileSync(join(folder, name)).toString("base64"));
  return files;
}

interface Drive {
  readonly job: FirmwareStagingJob;
  wakes: number;
  /**
   * Runs turns as the loop does until the job ends: none while it waits, a wake asking for one.
   * A wake not come within `WAKE_WAIT_MS`, or more than `MOST_TURNS` turns, fails.
   */
  readonly end: () => Promise<FileOutcome>;
}

/** A job with a wake, driven as the loop drives it. */
function driven(
  stageInputs: FirmwareJobInputs,
  options: Omit<WorkerJobOptions<Staged>, "wake"> = {},
): Drive {
  let woken = Promise.withResolvers<undefined>();
  const drive: Drive = {
    job: new FirmwareStagingJob(stageInputs, {
      ...options,
      wake: () => {
        drive.wakes += 1;
        woken.resolve(undefined);
      },
    }),
    wakes: 0,
    end: async () => {
      for (let turns = 1; ; turns++) {
        expect(turns, "turns asked for one staging").toBeLessThanOrEqual(MOST_TURNS);
        const outcome = drive.job.next();
        if (outcome !== undefined) return outcome;
        if (drive.job.waiting()) {
          const woke = await Promise.race([
            woken.promise.then(() => true),
            Bun.sleep(WAKE_WAIT_MS).then(() => false),
          ]);
          expect(woke, `a wake within ${WAKE_WAIT_MS} ms`).toBe(true);
          woken = Promise.withResolvers<undefined>();
        } else await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
  opened.push(drive.job);
  return drive;
}

const startWith =
  (entry: string): StartWorker<Staged> =>
  (data, events) =>
    startJobThread(data, events, new URL(`./firmware-workers/${entry}`, import.meta.url));

/** Fills the store with `files` images of `bytes` each, none of them the one staged. */
function fill(at: Rig, files: number, bytes: number): void {
  const folder = storeFolder(at.dataDir);
  mkdirSync(folder, { recursive: true });
  for (let i = 0; i < files; i++)
    writeFileSync(join(folder, `${hex(sha256(Uint8Array.of(i)))}.bin`), new Uint8Array(bytes));
}

describe("firmware staging on its worker", () => {
  test.each([
    ["a publisher's release", () => release({ payload: PAYLOAD }), null],
    ["an owner's own build", () => OWN, "1.4.0"],
  ] as const)(
    "%s: the same outcome and store as on the thread, signed by the hub; one wake",
    async (_name, file, own) => {
      const before = rig(file());
      const expected = onThread(inputs(before, own));
      expect(expected.kind).toBe("firmwareStaged");
      const after = rig(file());
      const drive = driven(inputs(after, own));
      expect(drive.job.waiting()).toBe(true);
      const outcome = await drive.end();
      expect(outcome).toEqual(expected);
      expect(drive.wakes).toBe(1);
      expect(drive.job.waiting()).toBe(false);
      if (outcome.kind === "firmwareStaged")
        expect(verifyImageHeader(outcome.image.header, publicKey)).toBe(true);
      expect(store(after)).toEqual(store(before));
      expect(store(after).size).toBe(1);
    },
  );

  /** Each refusal, the file and the version given (null: a release), and the store beforehand. */
  const refusals: readonly {
    readonly name: string;
    readonly file: () => Uint8Array;
    readonly own: string | null;
    readonly reason: string;
    readonly prepare?: (at: Rig) => void;
  }[] = [
    {
      name: "a release no publisher key signed",
      file: () => release({ payload: PAYLOAD, seed: STRANGER_SEED }),
      own: null,
      reason: "badSignature",
    },
    {
      name: "a release for another target",
      file: () => release({ payload: PAYLOAD, manifest: { target: "esp32c3" } }),
      own: null,
      reason: "wrongTarget",
    },
    {
      name: "a payload whose hash is not the manifest's",
      file: () => {
        const file = release({ payload: PAYLOAD });
        file[file.length - 100] = (file[file.length - 100] ?? 0) ^ 1;
        return file;
      },
      own: null,
      reason: "badFile",
    },
    {
      name: "an own build over the slot",
      file: () => espImage({ size: RULES.slotBytes + 64 }),
      own: "1.4.0",
      reason: "tooLarge",
    },
    {
      name: "an own build naming another version",
      file: () => OWN,
      own: "1.4.1",
      reason: "badFile",
    },
    {
      name: "a store of four images",
      file: () => OWN,
      own: "1.4.0",
      reason: "storeFull",
      prepare: (at) => {
        fill(at, 4, 10);
      },
    },
  ];
  // Rows as objects: Bun's `test.each` takes a callback parameter beyond a row's length as `done`.
  test.each(refusals)(
    "refused as on the thread: $name, nothing left behind",
    async ({ file, own, reason, prepare }) => {
      const before = rig(file());
      prepare?.(before);
      const expected = onThread(inputs(before, own));
      expect(expected).toMatchObject({ kind: "failed", reason });
      const after = rig(file());
      prepare?.(after);
      const kept = store(after);
      expect(await driven(inputs(after, own)).end()).toEqual(expected);
      expect(store(after)).toEqual(kept);
    },
  );

  test("a hub without its key: refused where the thread refused it, after pass 1, nothing left", async () => {
    const none = () => err("the hub has no signing key yet");
    // A bad file is still refused as bad: the key is asked for only once the payload checked.
    const spoilt = release({ payload: PAYLOAD });
    spoilt[spoilt.length - 1] = (spoilt[spoilt.length - 1] ?? 0) ^ 1;
    for (const file of [OWN, spoilt]) {
      const own = file === OWN ? "1.4.0" : null;
      const expected = onThread(inputs(rig(file), own, none));
      const at = rig(file);
      expect(await driven(inputs(at, own, none)).end()).toEqual(expected);
      expect(store(at).size).toBe(0);
    }
    expect(onThread(inputs(rig(OWN), "1.4.0", none))).toMatchObject({
      reason: "io",
      message: "the hub has no signing key yet",
    });
  });

  test("a stored key that is not its public half's: refused on the worker as on the thread", async () => {
    const wrong = () => ok({ ...signingKeys, signingPublic: new Uint8Array(64).fill(1) });
    const expected = onThread(inputs(rig(OWN), "1.4.0", wrong));
    expect(expected).toMatchObject({
      reason: "io",
      message: "the hub's stored signing key is not its public key's",
    });
    const at = rig(OWN);
    expect(await driven(inputs(at, "1.4.0", wrong)).end()).toEqual(expected);
    expect(store(at).size).toBe(0);
  });

  test("an upload that is not there: as on the thread", async () => {
    const at = rig(OWN);
    const gone: Rig = { ...at, upload: join(at.dataDir, "uploads", "2") };
    const expected = onThread(inputs(gone));
    expect(expected).toMatchObject({ kind: "failed", reason: "unreachable" });
    expect(await driven(inputs(gone)).end()).toEqual(expected);
  });

  test("the key's columns read once, on the loop, as the job starts; the worker given them as data", async () => {
    const at = rig(OWN);
    let reads = 0;
    const given: WorkerData<Staged>[] = [];
    const drive = driven(
      inputs(at, "1.4.0", () => {
        reads += 1;
        return ok(signingKeys);
      }),
      {
        start: (data, events) => {
          given.push(data);
          return startJobThread(data, events);
        },
      },
    );
    expect(reads).toBe(1);
    expect(given).toHaveLength(1);
    expect(given[0]?.signingKeys).toEqual({ keys: signingKeys });
    expect(Object.keys(given[0]?.inputs ?? {}).toSorted()).toEqual(
      ["dataDir", "job", "keys", "own", "path", "rules"].toSorted(),
    );
    expect(await drive.end()).toMatchObject({ kind: "firmwareStaged" });
    expect(reads).toBe(1);
  });

  test("nothing a worker loads can open hub.db: the one entry's whole graph has no bun:sqlite", async () => {
    const built = await Bun.build({
      entrypoints: [join(HUB, "src", "shell", "worker", "entry.ts")],
      target: "bun",
      metafile: true,
    });
    expect(built.success).toBe(true);
    const inputs = Object.keys(built.metafile?.inputs ?? {});
    expect(inputs.some((path) => path.endsWith("firmware/stage-serve.ts"))).toBe(true);
    expect(inputs.some((path) => path.includes("shell/storage/"))).toBe(false);
    expect(await built.outputs[0]?.text()).not.toContain("bun:sqlite");
  });

  test("stagings beside each other (no gate): each in its own temporary file, both staged", async () => {
    const a = rig(release({ payload: PAYLOAD }));
    // Its upload in a folder of its own, its staging into the same store.
    const b: Rig = { ...rig(OWN), dataDir: a.dataDir };
    const first = driven(inputs(a), { start: startWith("holds.ts") });
    const second = driven(inputs(b, "1.4.0"));
    // The second does not wait for the first, held 1.5 s.
    expect(await second.end()).toMatchObject({ kind: "firmwareStaged" });
    expect(first.job.waiting()).toBe(true);
    expect(await first.end()).toMatchObject({ kind: "firmwareStaged" });
    expect([...store(a).keys()].filter((name) => name.startsWith("."))).toEqual([]);
    expect(store(a).size).toBe(2);
  });

  test("without a wake the job never says it waits (the loop then turns for it)", async () => {
    const job = new FirmwareStagingJob(inputs(rig(OWN), "1.4.0"));
    opened.push(job);
    expect(job.waiting()).toBe(false);
    for (;;) {
      if (job.next() !== undefined) break;
      await Bun.sleep(1);
    }
  });
});

const STOPPED = { kind: "failed", reason: "io", message: "the hub is stopping" } as const;

/** A way to have the worker stuck in a file call, and to let it go on. */
interface StuckWay {
  /** A data folder and upload whose staging will be stuck. */
  readonly rig: () => Rig;
  readonly start: StartWorker<Staged>;
  /** Until the worker is at its stuck point. */
  readonly reached: (at: Rig) => Promise<void>;
  /** Lets it go on, after `afterMs`. */
  readonly letGo: (at: Rig, afterMs?: number) => void;
}

/** Writes `data` to `path` after `afterMs`, from another process: this thread may be in a stop's wait. */
function writeLater(path: string, data: string, afterMs: number): void {
  writers.push(
    Bun.spawn([
      process.execPath,
      "-e",
      `await Bun.sleep(${afterMs}); require("node:fs").writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(data)});`,
    ]),
  );
}

const FIFO: StuckWay = {
  rig: () => rig("fifo"),
  start: (data, events) => startJobThread(data, events),
  // Nothing marks a blocked open(): the worker has started and reached it well within this.
  reached: () => Bun.sleep(300),
  letGo: (at, afterMs = 0) => {
    writeLater(at.upload, "not an image", afterMs);
  },
};

const HELD: StuckWay = {
  rig: () => rig(release({ payload: PAYLOAD })),
  start: startWith("held.ts"),
  reached: async (at) => {
    const temporary = stagingFile(at.dataDir, at.job);
    await until(() => existsSync(temporary) && statSync(temporary).size === PAYLOAD.length);
  },
  letGo: (at, afterMs = 0) => {
    writeLater(join(at.dataDir, "go"), "", afterMs);
  },
};

const STUCK: readonly (readonly [string, StuckWay])[] = [
  ...(POSIX ? [["in a real file call (the upload a FIFO, nothing written)", FIFO] as const] : []),
  ["in its temporary file's sync, the payload copied (a stand-in, on every system)", HELD],
];

/** A rig whose staging `way` will be stuck in, let go after the test at the latest. */
function stuckRig(way: StuckWay): Rig {
  const at = way.rig();
  stuck.push({ at, way });
  return at;
}

/** No temporary file left, and no image: the store as a staging that never began left it. */
function nothingLeft(at: Rig): void {
  expect([...store(at).keys()]).toEqual([]);
}

describe.each(STUCK)("a worker stuck %s", (_name, way) => {
  test("a stop shorter than the worker's wait ends at its bound; let go, the worker removes what it wrote", async () => {
    const at = stuckRig(way);
    const drive = driven(inputs(at), { start: way.start, stopWaitMs: 300 });
    await way.reached(at);
    expect(drive.job.next()).toBeUndefined();
    expect(drive.job.waiting()).toBe(true);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    const took = performance.now() - start;
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(1000);
    expect(drive.wakes).toBe(0);
    way.letGo(at);
    await until(() => !existsSync(stagingFile(at.dataDir, at.job)));
    await Bun.sleep(100);
    nothingLeft(at);
  });

  test("a stop waits for the worker, which removes what it wrote: nothing left, no outcome for the core", async () => {
    const at = stuckRig(way);
    const drive = driven(inputs(at), { start: way.start });
    await way.reached(at);
    way.letGo(at, 200);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    expect(performance.now() - start).toBeLessThan(1500);
    nothingLeft(at);
    expect(drive.wakes).toBe(0);
    expect(drive.job.next()).toEqual(STOPPED);
  });
});

describe("a worker held before it stages", () => {
  test("a stand-in held 1.5 s: waiting all the while, then the outcome", async () => {
    const drive = driven(inputs(rig(OWN), "1.4.0"), { start: startWith("holds.ts") });
    await Bun.sleep(1000);
    expect(drive.job.waiting()).toBe(true);
    expect(drive.job.next()).toBeUndefined();
    expect(await drive.end()).toMatchObject({ kind: "firmwareStaged" });
  });

  test("a stop told during the hold: answered when it ends, within the bound, nothing written", async () => {
    const at = rig(OWN);
    const drive = driven(inputs(at, "1.4.0"), { start: startWith("holds.ts") });
    await Bun.sleep(300);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    const took = performance.now() - start;
    expect(took).toBeGreaterThan(500);
    expect(took).toBeLessThan(STOP_WAIT_MS);
    nothingLeft(at);
  });
});

describe("a stop after the worker's outcome came, before the loop took it", () => {
  test("no outcome for the core; the image's file stays, unindexed, and the next start's check deletes it", async () => {
    const at = rig(OWN);
    const drive = driven(inputs(at, "1.4.0"));
    await until(() => !drive.job.waiting());
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    expect(drive.job.next()).toEqual(STOPPED);
    const file = `${hex(sha256(OWN))}.bin`;
    expect([...store(at).keys()]).toEqual([file]);
    expect(checkStore(at.dataDir, [])._unsafeUnwrap()).toEqual({ damaged: [], removed: [file] });
    nothingLeft(at);
  });
});

describe("a worker that fails", () => {
  test("does not start: failed, saying so, nothing written", async () => {
    const at = rig(OWN);
    const drive = driven(inputs(at, "1.4.0"), { start: () => err("no thread for it") });
    expect(await drive.end()).toEqual({
      kind: "failed",
      reason: "io",
      message: "the firmware staging worker did not start: no thread for it",
    });
    nothingLeft(at);
  });

  test("whose entry Bun refuses at once (a bare name): failed, saying so, nothing written", async () => {
    const at = rig(OWN);
    const refused = (data: WorkerData<Staged>, events: JobThreadEvents) =>
      startJobThread(data, events, "entry.ts");
    const said = refused(
      {
        kind: "stageFirmware",
        inputs: {
          job: at.job,
          path: at.upload,
          own: null,
          dataDir: at.dataDir,
          keys: [TEST_PUBLISHER_KEY],
          rules: RULES,
        },
        signingKeys: { error: "none" },
        control: jobControl(),
      },
      { ended: () => undefined, failed: () => undefined, exited: () => undefined },
    );
    expect(said._unsafeUnwrapErr()).toContain("absolute path or a relative path");
    const outcome = await driven(inputs(at, "1.4.0"), { start: refused }).end();
    expect(outcome.kind === "failed" ? outcome.message : "").toStartWith(
      "the firmware staging worker did not start: ",
    );
    nothingLeft(at);
  });

  test("whose entry is not there: failed, saying so", async () => {
    const outcome = await driven(inputs(rig(OWN), "1.4.0"), {
      start: startWith("missing.ts"),
    }).end();
    expect(outcome).toMatchObject({ kind: "failed", reason: "io" });
    expect(outcome.kind === "failed" ? outcome.message : "").toStartWith(
      "the firmware staging worker ended without an outcome: ",
    );
  });

  test("throws with the signing key in its message: the outcome says it threw, the key spelled nowhere", async () => {
    const at = rig(OWN);
    const outcome = await driven(inputs(at, "1.4.0"), { start: startWith("leaks.ts") }).end();
    const message = outcome.kind === "failed" ? outcome.message : "";
    expect(message).toStartWith("the firmware staging worker ended without an outcome: bad key ");
    expect(message).toContain("[bytes]");
    const key = Buffer.from(signingKeys.signingPrivate);
    for (const form of [
      key.toString("hex"),
      key.toString("base64"),
      key.toString("base64url"),
      [...key].join(","),
      [...key].join(", "),
    ])
      expect(message).not.toContain(form);
    nothingLeft(at);
  });

  test.each([
    ["throws", "throws.ts", "JSON Parse error"],
    ["exits first", "exits.ts", "exit code 3"],
  ])(
    "%s, having written its temporary file: failed, saying so, the file removed",
    async (_name, entry, why) => {
      const at = rig(OWN);
      const outcome = await driven(inputs(at, "1.4.0"), { start: startWith(entry) }).end();
      expect(outcome).toMatchObject({ kind: "failed", reason: "io" });
      const message = outcome.kind === "failed" ? outcome.message : "";
      expect(message).toStartWith("the firmware staging worker ended without an outcome: ");
      expect(message).toContain(why);
      nothingLeft(at);
    },
  );
});

/** Runs `firmware-timing-child.ts` with `args`: its numbers, once it ended on its own within 30 s. */
async function inChild(args: Omit<FirmwareChildArgs, "keys">): Promise<FirmwareChildNumbers> {
  const keys = {
    signingPrivate: Buffer.from(signingKeys.signingPrivate).toString("hex"),
    signingPublic: Buffer.from(signingKeys.signingPublic).toString("hex"),
    identity: Buffer.from(signingKeys.identity).toString("hex"),
  };
  const full: FirmwareChildArgs = { ...args, keys };
  const child = Bun.spawn([process.execPath, CHILD, JSON.stringify(full)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const ended = await Promise.race([child.exited, Bun.sleep(30_000).then(() => "running")]);
  const [out, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ ended, stderr }).toEqual({ ended: 0, stderr: "" });
  const line = out.split("\n").find((l) => l.startsWith("TIMING "));
  expect(line).toBeDefined();
  const numbers = JSON.parse((line ?? "").slice("TIMING ".length)) as FirmwareChildNumbers;
  console.log(
    `the loop's thread in the child: ${JSON.stringify({ ...numbers, outcome: numbers.outcome?.kind })}`,
  );
  return numbers;
}

/** Section 3's limit for one of the loop's calls ‡: the job's constructor, and each `next()`. */
const CALL_MS = 20;
/** How late the loop's 10 ms timer may come while the job is open. */
const LATE_MS = 50;

function loopKeptFree(numbers: FirmwareChildNumbers): void {
  expect(numbers.constructMs).toBeLessThan(CALL_MS);
  expect(numbers.longestCallMs).toBeLessThan(CALL_MS);
  expect(numbers.worstLateMs).toBeLessThan(LATE_MS);
}

describe("the loop's thread, in a process holding nothing but the job", () => {
  test("a real staging of a 1.5 MB release, start to outcome: the constructor and every call short, the timer on time", async () => {
    const at = rig(release({ payload: PAYLOAD }));
    const numbers = await inChild({
      upload: at.upload,
      dataDir: at.dataDir,
      job: at.job,
      entry: "real",
      windowMs: 10_000,
      untilOutcome: true,
    });
    expect(numbers.outcome?.kind).toBe("firmwareStaged");
    expect(numbers.wakes).toBe(1);
    loopKeptFree(numbers);
  });

  test.each(STUCK)("a worker stuck %s: the loop free all the while", async (_name, way) => {
    const at = way.rig();
    const numbers = await inChild({
      upload: at.upload,
      dataDir: at.dataDir,
      job: at.job,
      entry: way === HELD ? "held.ts" : "real",
      windowMs: 1500,
      ...(way === HELD ? { stuckFile: stagingFile(at.dataDir, at.job) } : {}),
    });
    if (way === HELD) expect(numbers.stuckReached).toBe(true);
    expect(numbers.outcome).toBeNull();
    loopKeptFree(numbers);
  });

  test("a stand-in held 1.5 s before it stages: the loop free all the while", async () => {
    const at = rig(release({ payload: PAYLOAD }));
    const numbers = await inChild({
      upload: at.upload,
      dataDir: at.dataDir,
      job: at.job,
      entry: "holds.ts",
      windowMs: 1000,
    });
    expect(numbers.outcome).toBeNull();
    loopKeptFree(numbers);
  });
});

/**
 * `hsn firmware …` and `hsn rollout …` against a real hub's control socket: the hub as a process
 * (the tests' own entry, trusting the tests' publisher key, `shell-main/hub-with-test-key.ts`), so
 * each command runs the whole way: the socket, the core's `firmware` module, the staging job in
 * pieces, the store's folder, the answer. Then a restart over a damaged store.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Session } from "../../../cli/client.ts";
import { ExitCode } from "../../../cli/exit-codes.ts";
import { type CliIo, runCli } from "../../../cli/main.ts";
import { imageFileName, storeFolder } from "../../../src/shell/firmware/store.ts";
import { endProcesses, spawnTracked } from "../../world/processes.ts";
import { espImage, release, sha256, STRANGER_SEED } from "../shell-firmware/support.ts";

const ENTRY = join(import.meta.dir, "..", "shell-main", "hub-with-test-key.ts");
let base: string;
let dataDir: string;
let hub: ReturnType<typeof spawnTracked> | undefined;
let answer = "y";

/** The hub, started on the data folder, once its control socket answers. */
async function start(): Promise<void> {
  hub = spawnTracked(
    ["bun", ENTRY, "--data", dataDir, "--port", "0", "--no-usb-watch", "--app-ports", "0,0"],
    { stdout: "ignore", stderr: "pipe" },
  );
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(dataDir, "control.sock")) && (await hsn("rollout status")).code === 0)
      return;
    await Bun.sleep(50);
  }
  expect("the hub did not start").toBe("");
}

async function stop(): Promise<void> {
  hub?.kill("SIGTERM");
  await hub?.exited;
  hub = undefined;
}

interface Run {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

async function hsn(args: string): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { HSN_DATA_DIR: dataDir, USER: "tester" },
    stdin: () => Promise.resolve(""),
    nowMs: () => Date.now(),
    onInterrupt: () => undefined,
    ask: () => Promise.resolve(answer),
  };
  const code = await runCli(
    args.split(" ").filter((w) => w !== ""),
    io,
  );
  return { code, out, err };
}

const payload = espImage({ size: 300_000, seed: 3 });
const own = espImage({ size: 200_000, version: "2.0.0", seed: 4 });

beforeAll(async () => {
  // A short folder: a socket's path must stay under 104 bytes.
  base = mkdtempSync(join(tmpdir(), "hsn-fwhub-"));
  dataDir = join(base, "data");
  writeFileSync(join(base, "rel.hsnf"), release({ payload }));
  writeFileSync(join(base, "bad.hsnf"), release({ payload, seed: STRANGER_SEED }));
  writeFileSync(join(base, "own.bin"), own);
  await start();
}, 30_000);

afterAll(async () => {
  await endProcesses();
  rmSync(base, { recursive: true, force: true });
});

function stored(): readonly string[] {
  return existsSync(storeFolder(dataDir)) ? readdirSync(storeFolder(dataDir)).toSorted() : [];
}

describe("on a real hub", () => {
  test("firmware list on an empty store", async () => {
    const run = await hsn("firmware list");
    expect(run).toEqual({ code: ExitCode.Ok, out: ["no firmware images are stored"], err: [] });
  });

  test("firmware add: a publisher's release, staged and stored under its hash", async () => {
    const run = await hsn(`firmware add ${join(base, "rel.hsnf")}`);
    expect(run.err).toEqual([]);
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out[0]).toMatch(
      /^added image 1: 1\.4\.0, official, sensor siren gateway, 300016 bytes/u,
    );
    expect(stored()).toEqual([imageFileName(sha256(payload))]);
    expect(
      new Uint8Array(readFileSync(join(storeFolder(dataDir), imageFileName(sha256(payload))))),
    ).toEqual(new Uint8Array(payload));
  }, 20_000);

  test("firmware add: refusals, the store as it was and no upload kept", async () => {
    const bad = await hsn(`firmware add ${join(base, "bad.hsnf")}`);
    expect(bad.code).toBe(ExitCode.Refused);
    expect(bad.err.join(" ")).toContain("badSignature");
    const wrongVersion = await hsn(`firmware add ${join(base, "own.bin")} --own --version 2.0.1`);
    expect(wrongVersion.code).toBe(ExitCode.Refused);
    expect(wrongVersion.err.join(" ")).toContain("badFile");
    answer = "n";
    const declined = await hsn(`firmware add ${join(base, "own.bin")} --own --version 2.0.0`);
    expect(declined.code).toBe(ExitCode.Refused);
    answer = "y";
    expect(stored()).toEqual([imageFileName(sha256(payload))]);
    expect(readdirSync(join(dataDir, "uploads"))).toEqual([]);
  }, 20_000);

  test("firmware add --own: an own build, marked as one", async () => {
    const run = await hsn(`firmware add ${join(base, "own.bin")} --own --version 2.0.0`);
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out.at(-1)).toMatch(/^added image 2: 2\.0\.0, own build \(not the publisher's\)/u);
    expect(readdirSync(join(dataDir, "uploads"))).toEqual([]);
    const json = await hsn("--json firmware list");
    const listed = JSON.parse(json.out[0] ?? "{}") as {
      images: { id: number; kind: string; version: string }[];
    };
    expect(listed.images.map((i) => [i.id, i.kind, i.version])).toEqual([
      [1, "official", "1.4.0"],
      [2, "ownBuild", "2.0.0"],
    ]);
  }, 20_000);

  test("firmware remove: the file goes; again, not found", async () => {
    const run = await hsn("firmware remove 1");
    expect(run).toEqual({ code: ExitCode.Ok, out: ["removed image 1"], err: [] });
    // The reply leaves in the turn whose file job then removes the file: a moment after.
    for (let i = 0; i < 100 && stored().length > 1; i++) await Bun.sleep(10);
    expect(stored()).toEqual([imageFileName(sha256(own))]);
    const again = await hsn("firmware remove 1");
    expect(again.code).toBe(ExitCode.Refused);
    expect(again.err.join(" ")).toContain("notFound");
  });

  test("rollout status, pause, resume and cancel with none open; start with no device refused", async () => {
    expect((await hsn("rollout status")).out).toEqual(["no rollout"]);
    for (const words of ["rollout pause", "rollout resume", "rollout cancel"]) {
      const run = await hsn(words);
      expect(run.code).toBe(ExitCode.Refused);
      expect(run.err).toEqual(["hsn: no rollout is open"]);
    }
    const start = await hsn("rollout start 2");
    expect(start.code).toBe(ExitCode.Refused);
    expect(start.err[0]).toMatch(/^hsn: refused: /u);
    const pilot = await hsn("rollout start 2 --pilot attic");
    expect(pilot.err).toEqual(["hsn: no device is called attic"]);
  });

  test("firmware.download on the control socket: the header and the image as file chunks; a damaged file fails", async () => {
    const download = async (): Promise<{
      readonly parts: Buffer[];
      readonly end: { readonly chunks: number; readonly sha256: string } | undefined;
      readonly failed: string | undefined;
    }> => {
      const session = (await Session.open(join(dataDir, "control.sock")))._unsafeUnwrap();
      const parts: Buffer[] = [];
      let end: { chunks: number; sha256: string } | undefined;
      let failed: string | undefined;
      const reply = await session.request(
        "tester",
        { kind: "op", op: "firmware.download", body: { image: 2 } },
        10_000,
        {
          onChunk: (chunk) => {
            parts.push(Buffer.from(chunk.data, "base64url"));
            end = chunk.end;
          },
          onFailed: (reason) => {
            failed = reason;
          },
        },
      );
      session.close();
      expect(reply.isOk() && reply.value.reply.ok).toBe(true);
      return { parts, end, failed };
    };
    const whole = await download();
    const bytes = Buffer.concat(whole.parts);
    expect(bytes.length).toBe(128 + own.length);
    expect(new Uint8Array(bytes.subarray(128))).toEqual(new Uint8Array(own));
    expect(whole.end).toEqual({
      chunks: whole.parts.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(whole.failed).toBeUndefined();
    const file = join(storeFolder(dataDir), imageFileName(sha256(own)));
    const damaged = new Uint8Array(own);
    damaged[150_000] = (damaged[150_000] ?? 0) ^ 1;
    writeFileSync(file, damaged);
    const broken = await download();
    expect(broken.failed).toBe("io");
    expect(broken.end).toBeUndefined();
    writeFileSync(file, own);
  }, 20_000);

  test("restarted over a damaged store: firmware_store_damaged, and the image gone from the list", async () => {
    await stop();
    writeFileSync(join(storeFolder(dataDir), imageFileName(sha256(own))), new Uint8Array(10));
    writeFileSync(join(storeFolder(dataDir), ".staging-2147483650"), new Uint8Array(10));
    await start();
    expect(stored()).toEqual([imageFileName(sha256(own))]);
    const log = await hsn("log --kind event");
    expect(log.out.join("\n")).toContain("firmware_store_damaged");
    expect((await hsn("firmware list")).out).toEqual(["no firmware images are stored"]);
    await stop();
  }, 30_000);
});

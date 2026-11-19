/**
 * `hsn firmware …` and `hsn rollout …` (`cli/firmware.ts`; docs/m3-updates-design.md section 4)
 * against a fake hub on a real control socket (the real socket server, its real upload store, a
 * sink that answers each operation): the words each command takes and refuses, the requests it
 * sends, its readable and JSON output, its exit codes; an own build confirmed or not; a reply this
 * `hsn` cannot read; a hub that is not running. `firmware-hub.test.ts` runs them on a real hub.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RolloutObject } from "@hsn/protocol/app";
import type {
  CommandResult,
  ControlCommand,
  ControlReply,
} from "../../../src/core/model/control.ts";
import { connId } from "../../../src/core/model/ids.ts";
import { UploadStore } from "../../../src/shell/app/uploads.ts";
import { ExitCode } from "../../../cli/exit-codes.ts";
import { OWN_BUILD_QUESTION, OWN_BUILD_WARNING } from "../../../cli/firmware.ts";
import { HELP, type CliIo, runCli } from "../../../cli/main.ts";
import { rootPlan } from "../../../cli/root-plan.ts";
import { type TestFolder, testFolder } from "../shell-control/support.ts";
import { ownSid } from "../shell-control/windows-folders.ts";
import { ok as okResult } from "neverthrow";
import { UnixControlServer } from "../../../src/shell/control/server.ts";

let where: TestFolder;
let hub: UnixControlServer;
let uploads: UploadStore;
/** The operations the hub was asked, in order. */
let asked: { readonly op: string; readonly body: unknown }[];
/** What the hub answers each operation with, by name. */
let answers: Record<string, ControlReply>;
/** What the person answers the own build's question with. */
let answer: string;
let questions: string[];

function ok(body: unknown): ControlReply {
  return { ok: true, result: { kind: "op", body } as CommandResult };
}

function refused(code: string, detail: Record<string, unknown> = {}): ControlReply {
  return {
    ok: false,
    error: { code: "opRefused", message: code, app: { code, detail } as never },
  };
}

const IMAGE = {
  id: 3,
  imageId: "5809a93fbda5fee2",
  version: "1.4.0",
  kind: "official",
  roles: [1, 2, 3],
  bytes: 1_503_232,
  addedMs: Date.UTC(2026, 10, 18, 12),
};

const ROLLOUT: RolloutObject = {
  id: 2,
  image: 3,
  version: "1.4.0",
  stage: "pilots",
  devices: [4, 7, 9],
  pilots: [7],
  approvedBy: "dimitri",
  approvedMs: Date.UTC(2026, 10, 18, 12),
  soakUntilMs: null,
  paused: null,
  endedMs: null,
};

const SNAPSHOT_DEVICES = {
  devices: [
    { id: 4, name: "front" },
    { id: 7, name: "hall-siren" },
    { id: 9, name: "gw1" },
  ],
};

beforeEach(async () => {
  where = testFolder();
  asked = [];
  questions = [];
  answer = "y";
  answers = {
    "firmware.list": ok({
      images: [IMAGE],
      devices: [
        {
          device: 4,
          version: "1.3.0",
          update: { state: "fetching", held: null, method: "ownLink" },
        },
        { device: 7, version: "1.3.0", update: null },
      ],
    }),
    "firmware.upload": ok(IMAGE),
    "firmware.remove": ok({}),
    "rollout.start": ok(ROLLOUT),
    "rollout.status": ok({
      rollout: ROLLOUT,
      devices: [
        {
          device: 4,
          state: "fetching",
          held: null,
          method: "ownLink",
          bytes: 65_536,
          of: 1_503_360,
          lastReason: null,
        },
        {
          device: 7,
          state: "planned",
          held: "armed",
          method: "ownLink",
          bytes: 0,
          of: 1_503_360,
          lastReason: "linkLost",
        },
      ],
    }),
    "rollout.pause": ok({ ...ROLLOUT, stage: "paused" }),
    "rollout.resume": ok({ ...ROLLOUT, stage: "rest" }),
    "rollout.cancel": ok({ ...ROLLOUT, stage: "cancelled", endedMs: Date.UTC(2026, 10, 18, 13) }),
    snapshot: ok(SNAPSHOT_DEVICES),
  };
  uploads = new UploadStore(where.folder);
  hub = await open();
  // As the hub does at start: its uploads folder, emptied.
  expect(uploads.clearAll().isOk()).toBe(true);
  hub.listen((event) => {
    if (event.kind !== "command") return;
    const command: ControlCommand = event.command;
    if (command.kind !== "op") return;
    asked.push({ op: command.operation.op, body: command.operation.body });
    if (command.operation.op === "firmware.upload") {
      // The upload is the shell's, kept on the connection that sent it, whole.
      const kept = uploads.finished({ conn: event.conn, job: 1 });
      expect(kept).toBeDefined();
      asked.push({
        op: "(upload)",
        body: kept === undefined ? null : readFileSync(kept.path).length,
      });
    }
    hub.respond(event.request, answers[command.operation.op] ?? refused("unavailable"));
  });
});

afterEach(async () => {
  expect((await hub.close()).isOk()).toBe(true);
  where.remove();
});

/** The real socket server, with the real upload store. */
async function open(): Promise<UnixControlServer> {
  const opened = await UnixControlServer.open({
    socketPath: where.socket,
    logQuery: () => okResult([]),
    deviceIdOf: () => undefined,
    writerStatus: () => ({
      lastCommitMs: null,
      stagedItems: 0,
      databaseBytes: null,
      historyShortened: false,
    }),
    uploads,
  });
  return opened._unsafeUnwrap();
}

interface Run {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

/** Runs the command against the fixture's real control socket. */
async function hsn(args: string): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(process.platform === "win32" ? { hubAccount: ownSid() } : {}),
    env: { HSN_DATA_DIR: where.folder, USER: "dimitri" },
    stdin: () => Promise.resolve(""),
    nowMs: () => Date.UTC(2026, 10, 18, 12),
    onInterrupt: () => undefined,
    ask: (question) => {
      questions.push(question);
      return Promise.resolve(answer);
    },
  };
  const code = await runCli(
    args.split(" ").filter((w) => w !== ""),
    io,
  );
  return { code, out, err };
}

describe("the words", () => {
  const usage: readonly string[] = [
    "firmware",
    "firmware show",
    "firmware list now",
    "firmware remove",
    "firmware remove x",
    "firmware remove 0",
    "firmware remove 1 2",
    "firmware add",
    "firmware add a.bin b.bin",
    "firmware add a.bin --own",
    "firmware add a.bin --version 1.4.0",
    "firmware add a.bin --own --version 1.4",
    "firmware add a.bin --own --version 1.256.0",
    "firmware add a.bin --own --version 01.4.0",
    "firmware add a.bin --bogus",
    "rollout",
    "rollout start",
    "rollout start x",
    "rollout start 3 4",
    "rollout start 3 --pilot",
    "rollout start 3 --pilot --pilot",
    "rollout start 3 --bogus",
    "rollout status now",
    "rollout pause 2",
    "rollout cancel 2",
    "rollout resume --force",
    "rollout resume --device",
    "rollout resume --device a --device b",
    "rollout resume 2",
    "rollout restart",
  ];
  for (const words of usage)
    test(`"${words}" is a usage error, and nothing is sent`, async () => {
      const run = await hsn(words);
      expect(run.code).toBe(ExitCode.Usage);
      expect(asked).toEqual([]);
    });

  test("the help names every firmware and rollout command", async () => {
    const run = await hsn("--help");
    const help = run.out.join("\n");
    for (const words of [
      "firmware add <file>",
      "firmware add <file> --own --version <v>",
      "firmware list",
      "firmware remove <image>",
      "rollout start <image> [--pilot <device>]…",
      "rollout status | pause | cancel",
      "rollout resume [--device <device> [--force]]",
    ])
      expect(HELP).toContain(words);
    expect(help).toContain("firmware list");
  });

  test("as root, only firmware add opens a file, as the person, to read", () => {
    expect(rootPlan(["firmware", "add", "/home/a/f.hsnf"], 0).helper).toEqual({
      kind: "file",
      mode: "read",
      path: "/home/a/f.hsnf",
    });
    expect(rootPlan(["firmware", "add", "f.bin", "--own", "--version", "1.0.0"], 0).helper).toEqual(
      {
        kind: "file",
        mode: "read",
        path: "f.bin",
      },
    );
    for (const words of ["firmware list", "firmware remove 3", "rollout start 3", "rollout pause"])
      expect(rootPlan(words.split(" "), 0)).toEqual({ helper: { kind: "none" }, keepsRoot: false });
  });
});

describe("each command on the control socket", () => {
  test("firmware list: the images, then each device's version and update, by name", async () => {
    const run = await hsn("firmware list");
    expect(run.code).toBe(ExitCode.Ok);
    expect(asked.map((a) => a.op)).toEqual(["firmware.list", "snapshot"]);
    expect(run.out).toEqual([
      "image 3: 1.4.0, official, sensor siren gateway, 1503232 bytes, added 2026-11-18T12:00:00.000Z, id 5809a93fbda5fee2",
      "front (4): runs 1.3.0, update fetching",
      "hall-siren (7): runs 1.3.0",
    ]);
  });

  test("a time no date can hold is printed as its number, not thrown", async () => {
    answers["firmware.list"] = ok({
      images: [{ ...IMAGE, addedMs: Number.MAX_SAFE_INTEGER }],
      devices: [],
    });
    const run = await hsn("firmware list");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out[0]).toContain(`added ${Number.MAX_SAFE_INTEGER} ms`);
  });

  test("firmware list with no image, and with --json the body as the hub gave it", async () => {
    answers["firmware.list"] = ok({ images: [], devices: [] });
    expect((await hsn("firmware list")).out).toEqual(["no firmware images are stored"]);
    const json = await hsn("--json firmware list");
    expect(json.out.map((l) => JSON.parse(l) as unknown)).toEqual([{ images: [], devices: [] }]);
  });

  test("firmware remove: the image's number; a refusal (in use) is exit 1 with the hub's reason", async () => {
    const run = await hsn("firmware remove 3");
    expect(asked).toEqual([{ op: "firmware.remove", body: { image: 3 } }]);
    expect(run.out).toEqual(["removed image 3"]);
    expect(run.code).toBe(ExitCode.Ok);
    answers["firmware.remove"] = refused("invalid", { field: "image", reason: "inUse", refs: [2] });
    const inUse = await hsn("firmware remove 3");
    expect(inUse.code).toBe(ExitCode.Refused);
    expect(inUse.err).toEqual([
      'hsn: refused: invalid {"field":"image","reason":"inUse","refs":[2]}',
    ]);
    const json = await hsn("--json firmware remove 3");
    expect(json.err).toEqual([
      '{"code":"invalid","detail":{"field":"image","reason":"inUse","refs":[2]}}',
    ]);
  });

  test("firmware add <file>: uploaded whole on the connection, then firmware.upload naming it", async () => {
    const file = join(where.folder, "hsn-firmware-1.4.0.hsnf");
    const bytes = new Uint8Array(150_000).map((_, i) => i % 253);
    writeFileSync(file, bytes);
    const run = await hsn(`firmware add ${file}`);
    expect(run.code).toBe(ExitCode.Ok);
    expect(asked).toEqual([
      { op: "firmware.upload", body: { job: 1 } },
      { op: "(upload)", body: bytes.length },
    ]);
    expect(questions).toEqual([]);
    expect(run.out).toEqual([
      `added image 3: 1.4.0, official, sensor siren gateway, 1503232 bytes, added 2026-11-18T12:00:00.000Z, id 5809a93fbda5fee2`,
    ]);
  });

  test("firmware add --own: told and asked first; yes sends the build marked own and confirmed", async () => {
    const file = join(where.folder, "app.bin");
    writeFileSync(file, new Uint8Array(70_000).fill(9));
    answers["firmware.upload"] = ok({ ...IMAGE, kind: "ownBuild", version: "2.0.1" });
    const run = await hsn(`firmware add ${file} --own --version 2.0.1`);
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out[0]).toBe(OWN_BUILD_WARNING);
    expect(questions).toEqual([OWN_BUILD_QUESTION]);
    expect(asked[0]).toEqual({
      op: "firmware.upload",
      body: { job: 1, own: { version: "2.0.1" }, confirmOwn: true },
    });
    expect(run.out.at(-1)).toContain("2.0.1, own build (not the publisher's)");
  });

  test("firmware add --own answered no: nothing sent, exit 1", async () => {
    const file = join(where.folder, "app.bin");
    writeFileSync(file, new Uint8Array(70_000).fill(9));
    for (const no of ["n", "", "no", "yess"]) {
      answer = no;
      const run = await hsn(`firmware add ${file} --own --version 2.0.1`);
      expect(run.code).toBe(ExitCode.Refused);
      expect(run.err).toEqual(["hsn: not added"]);
    }
    expect(asked).toEqual([]);
    expect(uploads.finished({ conn: connId(1), job: 1 })).toBeUndefined();
  });

  test("firmware add: a file that cannot be read, and the hub's refusal of the file", async () => {
    const missing = await hsn(`firmware add ${join(where.folder, "none.hsnf")}`);
    expect(missing.code).toBe(ExitCode.Refused);
    expect(asked).toEqual([]);
    const file = join(where.folder, "bad.hsnf");
    writeFileSync(file, new Uint8Array(10));
    answers["firmware.upload"] = refused("invalid", { field: "job", reason: "badSignature" });
    const bad = await hsn(`firmware add ${file}`);
    expect(bad.code).toBe(ExitCode.Refused);
    expect(bad.err).toEqual(['hsn: refused: invalid {"field":"job","reason":"badSignature"}']);
  });

  test("rollout start: pilots by name or number, names looked up in the snapshot", async () => {
    const run = await hsn("rollout start 3 --pilot hall-siren --pilot 9");
    expect(run.code).toBe(ExitCode.Ok);
    expect(asked).toEqual([
      { op: "snapshot", body: {} },
      { op: "rollout.start", body: { image: 3, pilots: [7, 9] } },
      { op: "snapshot", body: {} },
    ]);
    expect(run.out).toEqual([
      "rollout 2: image 3 (1.4.0), pilots, 3 devices, pilots hall-siren (7)",
    ]);
    asked = [];
    await hsn("rollout start 3 --pilot 4 --pilot 7");
    expect(asked[0]).toEqual({ op: "rollout.start", body: { image: 3, pilots: [4, 7] } });
    asked = [];
    await hsn("rollout start 3");
    expect(asked[0]).toEqual({ op: "rollout.start", body: { image: 3 } });
  });

  test("rollout start: a pilot no device is called is refused before the rollout is asked", async () => {
    const run = await hsn("rollout start 3 --pilot attic");
    expect(run.code).toBe(ExitCode.Refused);
    expect(run.err).toEqual(["hsn: no device is called attic"]);
    expect(asked.map((a) => a.op)).toEqual(["snapshot"]);
  });

  test("rollout status: the rollout, then each planned device", async () => {
    const run = await hsn("rollout status");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out).toEqual([
      "rollout 2: image 3 (1.4.0), pilots, 3 devices, pilots hall-siren (7)",
      "  front (4): fetching, 65536 of 1503360 bytes, method ownLink",
      "  hall-siren (7): planned, method ownLink, held: armed, last reason linkLost",
    ]);
    answers["rollout.status"] = ok({ rollout: null, devices: [] });
    expect((await hsn("rollout status")).out).toEqual(["no rollout"]);
  });

  test("rollout pause, resume and cancel act on the open rollout", async () => {
    const pause = await hsn("rollout pause");
    expect(asked.slice(0, 2)).toEqual([
      { op: "rollout.status", body: {} },
      { op: "rollout.pause", body: { rollout: 2 } },
    ]);
    expect(pause.out).toEqual([
      "rollout 2: image 3 (1.4.0), paused, 3 devices, pilots hall-siren (7)",
    ]);
    asked = [];
    await hsn("rollout resume");
    expect(asked[1]).toEqual({ op: "rollout.resume", body: { rollout: 2 } });
    asked = [];
    await hsn("rollout resume --device gw1 --force");
    expect(asked.filter((a) => a.op === "rollout.resume")).toEqual([
      { op: "rollout.resume", body: { rollout: 2, device: 9, force: true } },
    ]);
    asked = [];
    await hsn("rollout resume --device 9");
    expect(asked.filter((a) => a.op === "rollout.resume")).toEqual([
      { op: "rollout.resume", body: { rollout: 2, device: 9 } },
    ]);
    asked = [];
    const cancel = await hsn("rollout cancel");
    expect(asked[1]).toEqual({ op: "rollout.cancel", body: { rollout: 2 } });
    expect(cancel.out[0]).toContain("cancelled");
    expect(cancel.out[0]).toContain("ended 2026-11-18T13:00:00.000Z");
  });

  test("rollout pause with no open rollout (none, or one ended): exit 1, nothing more asked", async () => {
    for (const rollout of [null, { ...ROLLOUT, stage: "done", endedMs: 1 }]) {
      asked = [];
      answers["rollout.status"] = ok({ rollout, devices: [] });
      for (const words of ["rollout pause", "rollout resume", "rollout cancel"]) {
        const run = await hsn(words);
        expect(run.code).toBe(ExitCode.Refused);
        expect(run.err).toEqual(["hsn: no rollout is open"]);
      }
      expect(asked.every((a) => a.op === "rollout.status")).toBe(true);
    }
  });

  test("a reply this hsn cannot read: exit 76, never a guess", async () => {
    answers["firmware.list"] = ok({ images: [{ id: "three" }], devices: [] });
    const run = await hsn("firmware list");
    expect(run.code).toBe(ExitCode.BadReply);
    expect(run.err[0]).toContain("this hsn is older than the hub");
    answers["rollout.status"] = ok({ rollout: { ...ROLLOUT, stage: "sleeping" }, devices: [] });
    expect((await hsn("rollout status")).code).toBe(ExitCode.BadReply);
    answers["rollout.status"] = ok({ rollout: null });
    expect((await hsn("rollout pause")).code).toBe(ExitCode.BadReply);
  });

  test("a hub that does not take the request (badRequest): exit 1, said plainly", async () => {
    answers["firmware.list"] = {
      ok: false,
      error: { code: "badRequest", message: "not a request this hub knows" },
    };
    const run = await hsn("firmware list");
    expect(run.code).toBe(ExitCode.Refused);
    expect(run.err[0]).toContain("it may not know this command yet");
  });
});

test("the hub not running: exit 69", async () => {
  expect((await hub.close()).isOk()).toBe(true);
  for (const words of ["firmware list", "rollout status", "firmware remove 1"]) {
    const run = await hsn(words);
    expect(run.code).toBe(ExitCode.HubNotRunning);
  }
  // Reopened for afterEach's close.
  hub = await open();
});

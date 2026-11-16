/**
 * `hsn` (hub-design.md section 9) against a fake hub on a real control socket: every command of
 * the table, the request it sends, its readable output and its exit code; the hub not running;
 * refusals, timeouts and bad answers; `--json`; `--follow`; the password read from standard
 * input; text from the hub printed with its control characters escaped; and the real process's
 * exit code. The fake hub is the real socket server with a sink that answers by command.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { err as errResult, ok as okResult, type Result } from "neverthrow";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FILE_CHUNKS } from "@hsn/protocol/app";
import { CONTROL_LINE_BYTES, controlCommand } from "../../../src/control-protocol/index.ts";
import { chunksOf } from "../../../cli/files.ts";
import { qrLines } from "../../../cli/qr.ts";
import { createServer } from "node:net";
import { join } from "node:path";
import { toHex } from "@hsn/protocol";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import type {
  CommandResult,
  ControlCommand,
  ControlReply,
} from "../../../src/core/model/control.ts";
import { deviceId, seq } from "../../../src/core/model/ids.ts";
import type { UnixControlServer } from "../../../src/shell/control/server.ts";
import { type CliIo, runCli } from "../../../cli/main.ts";
import { ExitCode } from "../../../cli/exit-codes.ts";
import { since } from "../../../cli/args.ts";
import { Driver, CHIP_B, identityFrame, Role } from "../setup/support/driver.ts";
import { expectNoKeyLeaks, guardCounts, noteOutput } from "../setup/support/leak-guard.ts";
import { openServer, type TestFolder, testFolder } from "../shell-control/support.ts";

interface Run {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

let where: TestFolder;
let hub: UnixControlServer;
let received: ControlCommand[];
let answer: (command: ControlCommand) => ControlReply | undefined;
let records: readonly AuditRecord[];
/** The addresses `hsn open` gave its page, and how opening it ends. */
let browsed: string[];
let browserAnswer: () => Promise<Result<"read" | "unread", string>>;

function ok(result: CommandResult): ControlReply {
  return { ok: true, result };
}

beforeEach(async () => {
  where = testFolder();
  received = [];
  records = [];
  browsed = [];
  browserAnswer = () => Promise.resolve(okResult("read"));
  answer = (command) => ({
    ok: false,
    error: { code: "failed", message: `no answer set for ${command.kind}` },
  });
  const opened = await openServer(where.socket, {
    logQuery: () => ({ isErr: () => false, isOk: () => true, value: records }) as never,
  });
  hub = opened.server;
  hub.listen((event) => {
    if (event.kind !== "command") return;
    received.push(event.command);
    if (event.command.kind === "log") return;
    const reply = answer(event.command);
    if (reply !== undefined) hub.respond(event.request, reply);
  });
});

afterEach(async () => {
  expect((await hub.close()).isOk()).toBe(true);
  where.remove();
});

afterAll(() => {
  expect(guardCounts().outputs).toBeGreaterThan(0);
  expectNoKeyLeaks();
});

function io(stdin = "", onInterrupt: CliIo["onInterrupt"] = () => undefined) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    out: (line) => {
      noteOutput(line);
      out.push(line);
    },
    err: (line) => {
      noteOutput(line);
      err.push(line);
    },
    env: { HSN_DATA_DIR: where.folder, USER: "dimitri" },
    stdin: () => Promise.resolve(stdin),
    nowMs: () => Date.UTC(2026, 10, 13, 12),
    onInterrupt,
    ask: () => Promise.resolve("n"),
    openConsole: (url) => {
      browsed.push(url);
      return browserAnswer();
    },
  };
  return { value, out, err };
}

async function hsn(args: string, stdin = ""): Promise<Run> {
  const { value, out, err } = io(stdin);
  const code = await runCli(
    args.split(" ").filter((w) => w !== ""),
    value,
  );
  return { code, out, err };
}

import { TABLE } from "./table.ts";

describe("every command of section 9", () => {
  for (const [words, command, result, line] of TABLE) {
    test(`hsn ${words}`, async () => {
      answer = () => ok(result);
      const run = await hsn(words);
      expect(received).toEqual([command]);
      expect(run.out).toContain(line);
      expect(run.err).toEqual([]);
      expect(run.code).toBe(ExitCode.Ok);
    });
  }

  test("hsn log decodes the records it reads, and sends its filters", async () => {
    records = [
      {
        kind: "rx",
        table: "routine",
        row: {
          seq: seq(1),
          atMs: 0,
          clockOk: true,
          deviceId: deviceId(3),
          type: 1,
          counter: 9,
          path: 0,
          gatewayId: null,
          gwUs: null,
          gwCounter: null,
          rssi: null,
          snrQ: null,
          rate: null,
          body: new Uint8Array([7, 0x10, 100, 20, 0, 0, 0]),
        },
      },
      {
        kind: "deviceLog",
        row: {
          seq: seq(2),
          atMs: 0,
          clockOk: true,
          deviceId: deviceId(3),
          counter: 9,
          madeMs: 0,
          level: 3,
          code: 4,
          text: new TextEncoder().encode("bad\u001b[2Jtext"),
          repeatOf: null,
        },
      },
      {
        kind: "command",
        row: {
          seq: seq(3),
          atMs: 0,
          clockOk: true,
          actor: "dimitri",
          kind: "arm",
          args: "{}",
          outcome: "ok",
          detail: null,
        },
      },
    ];
    const run = await hsn("log --device front --kind rx --since 2026-11-13T00:00:00Z");
    expect(received).toEqual([
      { kind: "log", follow: false, device: "front", logKind: "rx", since: Date.UTC(2026, 10, 13) },
    ]);
    expect(run.out[0]).toContain('rx device 3 Heartbeat #9 LoRa {"settingsVersion":7');
    expect(run.out[1]).toBe(
      "1970-01-01T00:00:00.000Z log device 3 level 3 code 4: bad\\x1b[2Jtext",
    );
    expect(run.out[2]).toBe("1970-01-01T00:00:00.000Z command arm by dimitri: ok");
    expect(run.code).toBe(ExitCode.Ok);
  });

  test("hsn log --follow prints each streamed record until it is stopped", async () => {
    let stop: (() => void) | undefined;
    const { value, out } = io("", (end) => {
      stop = end;
    });
    const running = runCli(["log", "--follow"], value);
    const deadline = Date.now() + 2000;
    while (hub.followers().length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    hub.publish({
      kind: "hubEvent",
      row: {
        seq: seq(5),
        atMs: 0,
        clockOk: true,
        level: "warning",
        origin: "core/setup",
        code: "c",
        message: "streamed",
        detail: null,
      },
    });
    while (out.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    stop?.();
    expect(await running).toBe(ExitCode.Ok);
    expect(out).toEqual(["1970-01-01T00:00:00.000Z warning core/setup c: streamed"]);
  });
});

describe("exit codes and errors", () => {
  test("the hub not running: no socket file", async () => {
    const run = await hsn(`status --data ${join(where.folder, "elsewhere")}`);
    expect(run.code).toBe(ExitCode.HubNotRunning);
    expect(run.err.join("\n")).toContain("the hub is not running");
    expect(run.err.join("\n")).toContain("Start the hub, or pass --data <folder>");
  });

  test("the hub not running: a socket file nobody listens on", async () => {
    const stale = join(where.folder, "stale.sock");
    await new Promise<void>((resolve) => {
      const s = createServer().listen(stale, () => {
        s.close(() => {
          resolve();
        });
      });
    });
    const run = await hsn(`status --socket ${stale}`);
    expect(run.code).toBe(ExitCode.HubNotRunning);
  });

  const root = typeof process.getuid === "function" && process.getuid() === 0;
  test.skipIf(root)("a socket this account may not open: run as the hub's account", async () => {
    chmodSync(where.socket, 0o000);
    const run = await hsn("status");
    chmodSync(where.socket, 0o600);
    expect(run.code).toBe(ExitCode.NoPermission);
    expect(run.err[0]).toContain("run hsn as the account the hub runs as");
  });

  test("a refusal prints the hub's reason and the names, and exits 1", async () => {
    answer = () => ({
      ok: false,
      error: { code: "unknownDevice", message: "not paired sensors: x", names: ["x"] },
    });
    const run = await hsn("arm x");
    expect(run).toEqual({
      code: ExitCode.Refused,
      out: [],
      err: ["hsn: not paired sensors: x", "  x"],
    });
  });

  test("an arm stopped by open doors exits 3 (D50)", async () => {
    answer = () => ({
      ok: false,
      error: { code: "doorsOpen", message: "doors open: back", names: ["back"] },
    });
    expect((await hsn("arm --all")).code).toBe(ExitCode.DoorsOpen);
  });

  test("a board that gave no answer exits 75", async () => {
    answer = () => ({ ok: false, error: { code: "noAnswer", message: "run it again" } });
    expect((await hsn("usb add /dev/x --name a")).code).toBe(ExitCode.NoAnswer);
  });

  test("no answer in time exits 75 and says the command may still happen", async () => {
    answer = () => undefined;
    const run = await hsn("--timeout 0.2 status");
    expect(run.code).toBe(ExitCode.NoAnswer);
    expect(run.err[0]).toContain("it may still act on the command");
  });

  test("an answer that is not a reply exits 76", async () => {
    const bad = join(where.folder, "bad.sock");
    const server = createServer((socket) => {
      socket.on("data", () => {
        socket.write('{"id":1,"nonsense":true}\n');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(bad, () => {
        resolve();
      }),
    );
    const run = await hsn(`status --socket ${bad}`);
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    expect(run.code).toBe(ExitCode.BadReply);
  });

  const usage = [
    "",
    "nonsense",
    "arm",
    "arm --all front",
    "disarm --all --continue",
    "device show",
    "device rename a",
    "usb add /dev/x",
    "usb add --name a",
    "sensor set front loud=1",
    "sensor set front countdown=-1",
    "sensor set front countdown=999",
    "sensor set front reply-rate=DR9",
    "siren set hall max=0",
    "site set channel=868.2",
    "site change",
    "site wifi --name x",
    "log --kind nonsense",
    "log --since yesterday",
    "status --timeout",
    "siren test hall soon",
    "gateway set",
    "gateway show gw1",
    "gateway set gw1 status=0",
    "gateway set gw1 status=256",
    "gateway set gw1 interference=12",
    "gateway set gw1 interference=12/0",
    "gateway set gw1 power=23",
    "gateway set gw1 siren-power=-10",
    "gateway set gw1 power=-10",
    "gateway set gw1 loud=1",
    "op",
    "op mode.switch {not json",
    "op pong",
    'op mode.switch {"mode":0}',
    "arm --all --bogus",
  ];
  for (const words of usage) {
    test(`not a command: "hsn ${words}" exits 64 without reaching the hub`, async () => {
      const run = await hsn(words);
      expect(run.code).toBe(ExitCode.Usage);
      expect(run.err.at(-1)).toBe("see hsn --help");
      expect(received).toEqual([]);
    });
  }

  test("--help lists every command and the exit codes", async () => {
    const run = await hsn("--help");
    const text = run.out.join("\n");
    for (const word of [
      "status",
      "arm",
      "disarm",
      "devices",
      "device show",
      "device rename",
      "device remove",
      "usb list",
      "usb add",
      "usb erase",
      "sensor set",
      "siren set",
      "siren test",
      "gateway set",
      "site show",
      "site survey",
      "site set",
      "site wifi",
      "site change",
      "log",
    ]) {
      expect(text).toContain(word);
    }
    expect(text).toContain("69  the hub is not running");
    expect(run.code).toBe(ExitCode.Ok);
  });
});

describe("M2's forms (m2-design.md section 6)", () => {
  test("hsn op - reads the body from standard input, and a refusal prints {code, detail} as JSON", async () => {
    answer = () => ({
      ok: false,
      error: {
        code: "notBuilt",
        message: "not built",
        app: { code: "notBuilt", detail: { op: "mode.switch" } },
      },
    });
    const run = await hsn("--json op mode.switch -", '{"mode": 3}\n');
    expect(received).toEqual([{ kind: "op", operation: { op: "mode.switch", body: { mode: 3 } } }]);
    expect(run.err).toEqual(['{"code":"notBuilt","detail":{"op":"mode.switch"}}']);
    expect(run.code).toBe(ExitCode.Refused);
    const bad = await hsn("op mode.switch -", "{}");
    expect(bad.code).toBe(ExitCode.Usage);
  });

  test("hsn update install uploads on one connection; the shell answers its chunks, not built yet", async () => {
    const file = join(where.folder, "release.bin");
    writeFileSync(file, new Uint8Array(100_000).fill(7));
    const run = await hsn(`update install ${file}`);
    expect(received).toEqual([]);
    expect(JSON.parse(run.err.join("")) as unknown).toEqual({ code: "notBuilt", detail: {} });
    expect(run.code).toBe(ExitCode.Refused);
    const missing = await hsn(`update install ${join(where.folder, "none.bin")}`);
    expect(missing.err[0]).toContain("cannot read the file");
  });

  test("hsn backup export asks for the export, and writes nothing when it is refused", async () => {
    answer = () => ({
      ok: false,
      error: {
        code: "notBuilt",
        message: "not built",
        app: { code: "notBuilt", detail: { op: "backup.export" } },
      },
    });
    const file = join(where.folder, "home.hsnb");
    const run = await hsn(`backup export ${file} --history`);
    expect(received).toEqual([
      { kind: "op", operation: { op: "backup.export", body: { history: true } } },
    ]);
    expect(run.code).toBe(ExitCode.Refused);
    expect(existsSync(file)).toBe(false);
  });

  test("hsn backup export: the reply {job} first, then the chunks on the connection, then the file", async () => {
    const file = join(where.folder, "export.hsnb");
    const bytes = new Uint8Array(FILE_CHUNKS.maxChunkBytes + 10).map((_, i) => i % 251);
    hub.listen((event) => {
      if (event.kind !== "command") return;
      hub.respond(event.request, ok({ kind: "op", body: { job: 1 } }));
      // After the reply (the loop runs jobs after the turn's answers), on the asking connection.
      for (const { job, n, data, end } of chunksOf(bytes)) {
        const chunk = end === undefined ? { job, n, data } : { job, n, data, end };
        expect(hub.download(event.conn, { fileChunk: chunk })).toBe(true);
      }
    });
    const run = await hsn(`backup export ${file}`);
    expect(run.code).toBe(ExitCode.Ok);
    expect(new Uint8Array(readFileSync(file))).toEqual(bytes);
  });

  test("hsn backup export: a fileFailed after the reply saves nothing and says so", async () => {
    const file = join(where.folder, "failed.hsnb");
    hub.listen((event) => {
      if (event.kind !== "command") return;
      hub.respond(event.request, ok({ kind: "op", body: { job: 2 } }));
      hub.download(event.conn, { fileFailed: { job: 2, reason: "io" } });
    });
    const run = await hsn(`backup export ${file}`);
    expect(run.code).toBe(ExitCode.Refused);
    expect(run.err.join(" ")).toContain("nothing was saved");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.part`)).toBe(false);
  });

  test("a file's chunks: 48 KB each, numbered from 0, the last with the count and the hash", () => {
    const chunks = chunksOf(new Uint8Array(FILE_CHUNKS.maxChunkBytes * 2 + 1));
    expect(chunks.map((c) => c.n)).toEqual([0, 1, 2]);
    expect(chunks[2]?.end?.chunks).toBe(3);
    expect(chunks.slice(0, 2).every((c) => c.end === undefined)).toBe(true);
    for (const chunk of chunks) expect(controlCommand.safeParse(chunk).success).toBe(true);
    expect(chunksOf(new Uint8Array(0))).toHaveLength(1);
    // The largest chunk's line fits the control socket's 64 KiB (section 6).
    const line = JSON.stringify({ id: 2 ** 40, actor: "a".repeat(64), command: chunks[2] });
    const full = JSON.stringify({ id: 2 ** 40, actor: "a".repeat(64), command: chunks[0] });
    expect(Math.max(line.length, full.length)).toBeLessThan(CONTROL_LINE_BYTES);
  });

  test("the file commands' usage, and the restore QR drawn in the terminal", async () => {
    for (const words of [
      "update install",
      "restore",
      "restore a b",
      "backup export",
      "backup export a b",
    ]) {
      expect((await hsn(words)).code).toBe(ExitCode.Usage);
    }
    const lines = qrLines("hsn://restore/1?h=x");
    expect(lines.length).toBeGreaterThan(10);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });
});

describe("output and input", () => {
  test("--json prints the reply as one JSON line", async () => {
    answer = () => ok({ kind: "deviceRename", name: "porch" });
    const run = await hsn("--json device rename front porch");
    expect(run.out.map((l) => JSON.parse(l) as unknown)).toEqual([
      { id: 1, reply: { ok: true, result: { kind: "deviceRename", name: "porch" } } },
    ]);
  });

  test("site wifi --password - reads the password from standard input", async () => {
    answer = () => ok({ kind: "siteWifi" });
    const run = await hsn("site wifi --name home --password -", "s3cret phrase\n");
    expect(received).toEqual([{ kind: "siteWifi", name: "home", password: "s3cret phrase" }]);
    expect(run.code).toBe(ExitCode.Ok);
  });

  test("names and messages from the hub are printed with control characters escaped", async () => {
    answer = () => ok({ kind: "deviceRename", name: "evil\u001b]0;pwned\u0007" });
    const run = await hsn("device rename a b");
    expect(run.out).toEqual(["renamed to evil\\x1b]0;pwned\\x07"]);
  });

  test("the request carries the account's user name as its actor (AL8)", async () => {
    const seen: string[] = [];
    hub.listen((event) => {
      if (event.kind === "command") {
        seen.push(event.actor);
        hub.respond(event.request, ok({ kind: "siteWifi" }));
      }
    });
    await hsn("site wifi --name a --password b");
    expect(seen).toEqual(["dimitri"]);
  });

  test("--since takes a date and time or a time ago", () => {
    const now = Date.UTC(2026, 10, 13, 12);
    expect(since("10m", now)._unsafeUnwrap()).toBe(now - 600_000);
    expect(since("2h", now)._unsafeUnwrap()).toBe(now - 7_200_000);
    expect(since("1d", now)._unsafeUnwrap()).toBe(now - 86_400_000);
    expect(since("2026-11-13T00:00:00Z", now)._unsafeUnwrap()).toBe(Date.UTC(2026, 10, 13));
    expect(since("soon", now).isErr()).toBe(true);
  });
});

describe("the real process", () => {
  test("bun cli/hsn.ts with no hub exits 69 and says what to do", () => {
    const nowhere = join(where.folder, "none");
    mkdirSync(nowhere, { recursive: true });
    const run = Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "..", "..", "..", "cli", "hsn.ts"),
        "status",
        "--data",
        nowhere,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    noteOutput(run.stderr.toString());
    expect(run.exitCode).toBe(ExitCode.HubNotRunning);
    expect(run.stderr.toString()).toContain("the hub is not running");
  });
});

describe("no key reaches the CLI's output", () => {
  test("the records of a real provisioning, read through the socket and printed, hold no key", async () => {
    const core = new Driver();
    core.boot();
    const { link } = core.openUsb("/dev/ttyACM0");
    core.frame(link, identityFrame({ role: Role.Sensor, chipId: CHIP_B, development: true }));
    core.command({ kind: "usbAdd", port: "/dev/ttyACM0", name: "front" });
    records = core.all.flatMap((e) => (e.kind === "record" ? [e.record] : []));
    expect(records.length).toBeGreaterThan(2);
    const plain = await hsn("log");
    const json = await hsn("--json log");
    expect(plain.code).toBe(ExitCode.Ok);
    expect(json.out.join("")).toContain(toHex(new Uint8Array(16)));
    expectNoKeyLeaks();
  });
});

describe("hsn open (m2-design.md section 5, the console)", () => {
  const SECRET_URL = "http://127.0.0.1:8445/#console=q7Zx3kP9mW2vR8tY5nB1cA";
  const SECRET = "q7Zx3kP9mW2vR8tY5nB1cA";
  const TOKEN: CommandResult = {
    kind: "consoleToken",
    url: SECRET_URL,
    expiresInMs: 120_000,
    token: 1,
  };

  test("opens the token's address through its page and never prints it", async () => {
    answer = () => ok(TOKEN);
    const run = await hsn("open");
    expect(received).toEqual([{ kind: "consoleToken" }]);
    expect(browsed).toEqual([SECRET_URL]);
    expect(run.code).toBe(ExitCode.Ok);
    expect([...run.out, ...run.err].join("\n")).not.toContain(SECRET);
  });

  test("with --json, nor then", async () => {
    answer = () => ok(TOKEN);
    const run = await hsn("--json open");
    expect(browsed).toEqual([SECRET_URL]);
    expect(run.out.map((l) => JSON.parse(l) as unknown)).toEqual([
      { opened: true, expiresInMs: 120_000 },
    ]);
    expect([...run.out, ...run.err].join("\n")).not.toContain(SECRET);
  });

  test("when no browser opens, it says so, exits 1, and still prints no address", async () => {
    answer = () => ok(TOKEN);
    browserAnswer = () => Promise.resolve(errResult("the browser could not be opened for anna"));
    const run = await hsn("open");
    expect(run.code).toBe(ExitCode.Refused);
    expect(run.err[0]).toContain(
      "the console could not be opened: the browser could not be opened for anna",
    );
    expect([...run.out, ...run.err].join("\n")).not.toContain(SECRET);
  });

  test("a refused token opens nothing", async () => {
    answer = () => ({
      ok: false,
      error: { code: "failed", message: "the hub has not started yet" },
    });
    const run = await hsn("open");
    expect(browsed).toEqual([]);
    expect(run.code).toBe(ExitCode.Refused);
  });

  test("a page the browser did not read in time: said, and exit 75", async () => {
    answer = () => ok(TOKEN);
    browserAnswer = () => Promise.resolve(okResult("unread"));
    const run = await hsn("open");
    expect(run.code).toBe(ExitCode.NoAnswer);
    expect(run.err[0]).toContain("did not open the console within 120 s");
    expect([...run.out, ...run.err].join("\n")).not.toContain(SECRET);
  });
});

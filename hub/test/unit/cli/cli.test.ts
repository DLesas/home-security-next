/**
 * `hsn` (hub-design.md section 9) against a fake hub on a real control socket: every command of
 * the table, the request it sends, its readable output and its exit code; the hub not running;
 * refusals, timeouts and bad answers; `--json`; `--follow`; the password read from standard
 * input; text from the hub printed with its control characters escaped; and the real process's
 * exit code. The fake hub is the real socket server with a sink that answers by command.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
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

function ok(result: CommandResult): ControlReply {
  return { ok: true, result };
}

beforeEach(async () => {
  where = testFolder();
  received = [];
  records = [];
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

const STATUS: CommandResult = {
  kind: "status",
  sensors: [{ name: "front", arm: "armed", door: "closed", countdownSecondsLeft: null }],
  alarm: null,
  sirens: [
    {
      name: "hall",
      should: { kind: "off", secondsLeft: null },
      commanded: null,
      reported: { kind: "off", secondsLeft: null },
      wifi: "up",
      lora: "up",
    },
  ],
  gateways: [
    {
      name: "gw1",
      session: true,
      link: "/dev/ttyACM0",
      lastStatusMs: 0,
      noiseMedianDbm: -110,
      baselineDbm: -111.5,
    },
  ],
  lastCommitMs: null,
  stagedItems: 0,
  databaseBytes: null,
  historyShortened: false,
};

/** Every command of section 9: the words, the command the hub gets, its answer, and a line of output. */
const TABLE: readonly (readonly [string, ControlCommand, CommandResult, string])[] = [
  ["status", { kind: "status" }, STATUS, "front   armed  closed  -"],
  [
    "arm --all",
    { kind: "arm", sensors: "all", continue: false },
    { kind: "arm", armed: ["front", "back"], waitsForDoorToClose: [] },
    "armed: front, back",
  ],
  [
    "arm front back --continue",
    { kind: "arm", sensors: ["front", "back"], continue: true },
    { kind: "arm", armed: ["front"], waitsForDoorToClose: ["back"] },
    "armed, waiting for the door to close: back",
  ],
  [
    "disarm --all",
    { kind: "disarm", sensors: "all" },
    { kind: "disarm", disarmed: ["front"], countdownsCancelled: ["front"], alarmEnded: true },
    "the alarm ended",
  ],
  [
    "disarm front",
    { kind: "disarm", sensors: ["front"] },
    { kind: "disarm", disarmed: ["front"], countdownsCancelled: [], alarmEnded: false },
    "disarmed: front",
  ],
  [
    "devices",
    { kind: "devices" },
    {
      kind: "devices",
      devices: [
        {
          name: "front",
          role: "sensor",
          address: 0x5e000001,
          state: "contacted",
          firmware: "1.2.3",
          lastSeenMs: null,
        },
      ],
    },
    "front  sensor  contacted  0x5e000001  1.2.3     never",
  ],
  [
    "device show front",
    { kind: "deviceShow", name: "front" },
    {
      kind: "deviceShow",
      device: {
        name: "front",
        role: "sensor",
        address: 1,
        state: "paired",
        firmware: null,
        lastSeenMs: null,
      },
      settings: null,
      reading: null,
    },
    "front: sensor, paired",
  ],
  [
    "device rename front porch",
    { kind: "deviceRename", from: "front", to: "porch" },
    { kind: "deviceRename", name: "porch" },
    "renamed to porch",
  ],
  [
    "device remove front",
    { kind: "deviceRemove", name: "front" },
    { kind: "deviceRemove", name: "front" },
    "removed front: its key is deleted, its history kept",
  ],
  [
    "usb list",
    { kind: "usbList" },
    {
      kind: "usbList",
      ports: [
        {
          port: "/dev/ttyACM0",
          identity: {
            role: 3,
            chipId: "a1b2c3d4e5f6",
            firmware: "0.1.0",
            paired: false,
            ours: false,
            hubIdentity: null,
            development: true,
          },
        },
      ],
    },
    "/dev/ttyACM0  gateway  a1b2c3d4e5f6  0.1.0     no      development",
  ],
  [
    "usb add /dev/ttyACM0 --name front --role sensor",
    { kind: "usbAdd", port: "/dev/ttyACM0", name: "front", role: "sensor" },
    {
      kind: "usbAdd",
      device: 3,
      name: "front",
      role: "sensor",
      address: 0x1a2b3c4d,
      chip: "a1b2c3d4e5f6",
    },
    "added front: sensor, device 3, address 0x1a2b3c4d, chip a1b2c3d4e5f6; it restarts, and is contacted at its first packet",
  ],
  [
    "usb add /dev/ttyACM0 --name gw",
    { kind: "usbAdd", port: "/dev/ttyACM0", name: "gw" },
    { kind: "usbAdd", device: 1, name: "gw", role: "gateway", address: 7, chip: "010203040506" },
    "added gw: gateway, device 1, address 0x00000007, chip 010203040506; it restarts, and is contacted at its first packet",
  ],
  [
    "usb erase /dev/ttyACM0",
    { kind: "usbErase", port: "/dev/ttyACM0" },
    { kind: "usbErase", port: "/dev/ttyACM0" },
    "Erase sent to /dev/ttyACM0; the board restarts unpaired",
  ],
  [
    "sensor set front countdown=45 heartbeat=12 link-check=5 reply-rate=DR3 correction=-12",
    {
      kind: "sensorSet",
      name: "front",
      countdown: 45,
      heartbeat: 12,
      linkCheck: 5,
      replyRate: 3,
      correction: -12,
    },
    { kind: "sensorSet", name: "front", version: 8 },
    "front: settings version 8",
  ],
  [
    "sensor set front reply-rate=learn correction=learn",
    { kind: "sensorSet", name: "front", replyRate: "learn", correction: "learn" },
    { kind: "sensorSet", name: "front", version: 9 },
    "front: settings version 9",
  ],
  [
    "siren set hall max=120",
    { kind: "sirenSet", name: "hall", max: 120 },
    { kind: "sirenSet", name: "hall", version: 4 },
    "hall: settings version 4",
  ],
  [
    "gateway set gw1 status=20 interference=12/40 power=20 siren-power=-3",
    {
      kind: "gatewaySet",
      name: "gw1",
      statusS: 20,
      interferenceDb: 12,
      interferenceS: 40,
      powerDbm: 20,
      sirenPowerDbm: -3,
    },
    { kind: "gatewaySet", name: "gw1", version: 3 },
    "gw1: settings version 3",
  ],
  [
    "gateway set gw1 power=14",
    { kind: "gatewaySet", name: "gw1", powerDbm: 14 },
    { kind: "gatewaySet", name: "gw1", version: 4 },
    "gw1: settings version 4",
  ],
  [
    "siren test hall",
    { kind: "sirenTest", name: "hall" },
    { kind: "sirenTest", name: "hall", seconds: 3 },
    "hall: testing for 3 s",
  ],
  [
    "siren test hall 10",
    { kind: "sirenTest", name: "hall", seconds: 10 },
    { kind: "sirenTest", name: "hall", seconds: 10 },
    "hall: testing for 10 s",
  ],
  [
    "site show",
    { kind: "siteShow" },
    {
      kind: "siteShow",
      site: {
        channel: 1,
        rate: 5,
        countdownS: 30,
        autoStopS: 300,
        wifiName: "home",
        replyPowerDbm: 22,
        sirenPowerDbm: 22,
      },
    },
    "channel: 868.3 MHz",
  ],
  [
    "site survey",
    { kind: "siteSurvey" },
    {
      kind: "siteSurvey",
      channel: 2,
      noise: [
        { channel: 0, medianDbm: -100 },
        { channel: 2, medianDbm: -112.25 },
      ],
    },
    "quietest: 868.5 MHz",
  ],
  [
    "site set channel=868.1 rate=DR2 countdown=20 auto-stop=200",
    { kind: "siteSet", channel: 0, rate: 2, countdown: 20, autoStop: 200 },
    {
      kind: "siteSet",
      site: {
        channel: 0,
        rate: 2,
        countdownS: 20,
        autoStopS: 200,
        wifiName: null,
        replyPowerDbm: 22,
        sirenPowerDbm: 22,
      },
    },
    "Wi-Fi: not set",
  ],
  [
    "site wifi --name home --password hunter2",
    { kind: "siteWifi", name: "home", password: "hunter2" },
    { kind: "siteWifi" },
    "the site's Wi-Fi details are set",
  ],
  [
    "site change rate=DR2",
    { kind: "siteChange", rate: 2 },
    { kind: "siteChange", channel: 1, rate: 2, sensors: 2 },
    "announcing 868.3 MHz, DR2 to 2 sensors",
  ],
  [
    "site change channel=868.5 rate=DR0",
    { kind: "siteChange", channel: 2, rate: 0 },
    { kind: "siteChange", channel: 2, rate: 0, sensors: 2 },
    "announcing 868.5 MHz, DR0 to 2 sensors",
  ],
  [
    "site change status",
    { kind: "siteChangeStatus" },
    {
      kind: "siteChangeStatus",
      move: {
        id: 1,
        stage: "announcing",
        channel: 1,
        rate: 2,
        forced: false,
        confirmed: 1,
        followed: 0,
        total: 2,
        waiting: [{ name: "front", sinceMs: 0 }],
        graceEndsMs: null,
      },
    },
    "confirmed: 1 of 2",
  ],
  [
    "site change cancel",
    { kind: "siteChangeCancel" },
    { kind: "siteChangeCancel", sensors: 2 },
    "cancelled; 2 sensors clear the next settings at their next reply",
  ],
  [
    "site change force",
    { kind: "siteChangeForce", yes: false },
    { kind: "siteChangeForce", switched: false, leftBehind: ["front"] },
    "run `hsn site change force --yes` to switch",
  ],
  [
    "site change force --yes",
    { kind: "siteChangeForce", yes: true },
    { kind: "siteChangeForce", switched: true, leftBehind: ["front"] },
    "switched; left behind, to be paired again: front",
  ],
];

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

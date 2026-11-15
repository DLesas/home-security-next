/**
 * The control socket's schemas (hub-design.md sections 9 and 11): every command, its reply,
 * the stream and lockstep lines and the bench manifest, each with valid and invalid examples.
 */
import { describe, expect, test } from "bun:test";
import {
  benchManifest,
  type ParsedControlCommand,
  controlCommand,
  controlReply,
  lockstepFromHub,
  lockstepToHub,
  recordJson,
  replyLine,
  requestLine,
  streamLine,
} from "../../src/control-protocol/index.ts";

/** `schema` accepts `value` and gives it back unchanged. */
function expectParses(schema: { parse(value: unknown): unknown }, value: unknown): void {
  const parsed: unknown = schema.parse(value);
  expect(parsed).toEqual(value);
}

/** One valid example of every command of section 9, and of the D115 site move. */
const COMMANDS: readonly ParsedControlCommand[] = [
  { kind: "status" },
  { kind: "arm", sensors: "all", continue: false },
  { kind: "arm", sensors: ["front", "back"], continue: true },
  { kind: "disarm", sensors: "all" },
  { kind: "devices" },
  { kind: "deviceShow", name: "front" },
  { kind: "usbList" },
  { kind: "usbAdd", port: "/dev/ttyACM0", name: "front" },
  { kind: "usbAdd", port: "/dev/ttyACM0", name: "hall", role: "siren" },
  { kind: "usbErase", port: "/dev/ttyACM0" },
  { kind: "deviceRename", from: "front", to: "porch" },
  { kind: "deviceRemove", name: "porch" },
  { kind: "sensorSet", name: "front", countdown: 45, heartbeat: 12, linkCheck: 5 },
  { kind: "sensorSet", name: "front", replyRate: "learn", correction: -120 },
  { kind: "sensorSet", name: "front", replyRate: 3, correction: "learn" },
  { kind: "sirenSet", name: "hall", max: 300 },
  { kind: "sirenTest", name: "hall" },
  { kind: "sirenTest", name: "hall", seconds: 3 },
  {
    kind: "gatewaySet",
    name: "gw1",
    statusS: 20,
    interferenceDb: 12,
    interferenceS: 40,
    powerDbm: 22,
    sirenPowerDbm: -9,
  },
  { kind: "gatewaySet", name: "gw1", powerDbm: 14 },
  { kind: "siteShow" },
  { kind: "siteSurvey" },
  { kind: "siteSet", channel: 1, rate: 5, countdown: 30, autoStop: 300 },
  { kind: "siteChange", rate: 2 },
  { kind: "siteChange", channel: 2, rate: 0 },
  { kind: "siteChangeStatus" },
  { kind: "siteChangeCancel" },
  { kind: "siteChangeForce", yes: false },
  { kind: "siteWifi", name: "home", password: "secret" },
  { kind: "log", follow: false },
  { kind: "log", device: "front", since: 1_700_000_000_000, logKind: "decision", follow: true },
  // M2 (m2-design.md section 6).
  {
    kind: "op",
    op: "mode.switch",
    body: { mode: 1, confirm: { openDoors: true, lowBattery: false } },
  },
  { kind: "consoleToken" },
  { kind: "consoleTokenWait", token: 3 },
  { kind: "fileChunk", job: 1, n: 0, data: "AAEC", end: { chunks: 1, sha256: "0".repeat(64) } },
];

const INVALID_COMMANDS: readonly (readonly [string, unknown])[] = [
  ["no kind", {}],
  ["an unknown kind", { kind: "explode" }],
  ["arm with no sensors", { kind: "arm", sensors: [], continue: false }],
  ["arm without continue", { kind: "arm", sensors: "all" }],
  ["a name with a space", { kind: "deviceShow", name: "front door" }],
  ["an empty name", { kind: "deviceRemove", name: "" }],
  ["a countdown over a byte", { kind: "sensorSet", name: "a", countdown: 256 }],
  ["a heartbeat of 0 units", { kind: "sensorSet", name: "a", heartbeat: 0 }],
  ["reply rate DR6", { kind: "sensorSet", name: "a", replyRate: 6 }],
  ["a correction past 16 bits", { kind: "sensorSet", name: "a", correction: 40_000 }],
  ["a siren max of 0, not valid (§6)", { kind: "sirenSet", name: "hall", max: 0 }],
  ["a gateway status of 0 s", { kind: "gatewaySet", name: "gw1", statusS: 0 }],
  ["a gateway interference over a byte", { kind: "gatewaySet", name: "gw1", interferenceDb: 256 }],
  ["a gateway power over 22 dBm", { kind: "gatewaySet", name: "gw1", powerDbm: 23 }],
  ["a siren power under -9 dBm", { kind: "gatewaySet", name: "gw1", sirenPowerDbm: -10 }],
  ["a default power under -9 dBm", { kind: "gatewaySet", name: "gw1", powerDbm: -10 }],
  ["a siren power over 22 dBm", { kind: "gatewaySet", name: "gw1", sirenPowerDbm: 23 }],
  ["channel 3", { kind: "siteSet", channel: 3 }],
  ["a fractional rate", { kind: "siteSet", rate: 2.5 }],
  ["a site change to DR6", { kind: "siteChange", rate: 6 }],
  ["force without yes", { kind: "siteChangeForce" }],
  ["an unknown role", { kind: "usbAdd", port: "p", name: "x", role: "camera" }],
  ["an unknown log kind", { kind: "log", logKind: "all", follow: false }],
  ["a negative since", { kind: "log", since: -1, follow: false }],
];

describe("commands", () => {
  test.each(COMMANDS.map((c) => [c.kind, c] as const))("%s parses", (_, command) => {
    expectParses(controlCommand, command);
  });

  test("every command kind has an example", () => {
    const kinds = new Set(COMMANDS.map((c) => c.kind));
    expect(kinds.size).toBe(controlCommand.options.length);
  });

  test.each(INVALID_COMMANDS)("refuses %s", (_, command) => {
    expect(controlCommand.safeParse(command).success).toBe(false);
  });

  test("a request line carries an id and an actor", () => {
    const line = { id: 7, actor: "dimitri", command: { kind: "status" } };
    expectParses(requestLine, line);
    expect(requestLine.safeParse({ id: 7, command: { kind: "status" } }).success).toBe(false);
    expect(requestLine.safeParse({ ...line, id: -1 }).success).toBe(false);
  });
});

const site = {
  channel: 1,
  rate: 5,
  countdownS: 30,
  autoStopS: 300,
  wifiName: "home",
  replyPowerDbm: 22,
  sirenPowerDbm: 22,
};

const RESULTS: readonly unknown[] = [
  {
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
        link: "ws 192.168.1.5",
        lastStatusMs: 1,
        noiseMedianDbm: -110,
        baselineDbm: -109.5,
      },
    ],
    lastCommitMs: 2,
    stagedItems: 12,
    databaseBytes: null,
    historyShortened: false,
  },
  { kind: "arm", armed: ["front"], waitsForDoorToClose: ["back"] },
  { kind: "disarm", disarmed: ["front"], countdownsCancelled: ["front"], alarmEnded: true },
  {
    kind: "devices",
    devices: [
      {
        name: "front",
        role: "sensor",
        address: 0x5e000001,
        state: "contacted",
        firmware: "1.0.0",
        lastSeenMs: null,
      },
    ],
  },
  {
    kind: "deviceShow",
    device: {
      name: "gw1",
      role: "gateway",
      address: 2,
      state: "paired",
      firmware: null,
      lastSeenMs: null,
    },
    settings: {
      role: "gateway",
      version: 4,
      statusIntervalS: 30,
      interferenceDb: 10,
      interferenceS: 30,
      defaultPowerDbm: 22,
      sirenPowerDbm: 22,
    },
    reading: "00ff",
  },
  {
    kind: "usbList",
    ports: [
      {
        port: "/dev/ttyACM0",
        identity: {
          role: 3,
          chipId: "a1a2a3a4a5a6",
          firmware: "1.0.0",
          paired: false,
          ours: false,
          hubIdentity: null,
          development: true,
        },
      },
      { port: "/dev/ttyACM1", identity: null },
    ],
  },
  {
    kind: "usbAdd",
    device: 2,
    name: "gateway-a1a2a3a4a5a6",
    role: "gateway",
    address: 0x12345678,
    chip: "a1a2a3a4a5a6",
  },
  { kind: "siteSurvey", channel: 2, noise: [{ channel: 0, medianDbm: -101.5 }] },
  { kind: "siteSet", site },
  { kind: "siteChange", channel: 1, rate: 2, sensors: 30 },
  { kind: "siteChangeStatus", move: null },
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
      waiting: [{ name: "front", sinceMs: 1_700_000_000_000 }],
      graceEndsMs: null,
    },
  },
  { kind: "siteChangeCancel", sensors: 2 },
  { kind: "siteChangeForce", switched: false, leftBehind: ["front"] },
  { kind: "siteWifi" },
  { kind: "log", records: [] },
  // M2.
  { kind: "op", body: { armed: [3], disarmed: [], waiting: [] } },
  {
    kind: "consoleToken",
    url: "http://127.0.0.1:8445/#console=AAAAAAAAAAAAAAAAAAAAAA",
    expiresInMs: 120_000,
    token: 3,
  },
  { kind: "consoleTokenWait", used: true },
];

describe("replies", () => {
  test.each(RESULTS.map((r, i) => [i, r] as const))("result %i parses", (_, result) => {
    const reply = { ok: true, result };
    expectParses(controlReply, reply);
  });

  test("an error names its code and may name devices", () => {
    const reply = {
      ok: false,
      error: { code: "doorsOpen", message: "front is open", names: ["front"] },
    };
    expectParses(controlReply, reply);
    expect(
      controlReply.safeParse({ ok: false, error: { code: "oops", message: "" } }).success,
    ).toBe(false);
  });

  test("an operation's refusal carries the app's own error; notBuilt is a code of its own (M2)", () => {
    expectParses(controlReply, {
      ok: false,
      error: {
        code: "opRefused",
        message: "needsConfirmation",
        app: { code: "needsConfirmation", detail: { openDoors: [3], lowBattery: [] } },
      },
    });
    expectParses(controlReply, {
      ok: false,
      error: {
        code: "notBuilt",
        message: "mode.switch is not built yet",
        app: { code: "notBuilt", detail: { op: "mode.switch" } },
      },
    });
  });

  test.each([
    ["a result of no known kind", { ok: true, result: { kind: "explode" } }],
    [
      "a status missing its gateways",
      { ok: true, result: { ...asObject(RESULTS[0]), gateways: undefined } },
    ],
    [
      "an address past 32 bits",
      {
        ok: true,
        result: {
          kind: "usbAdd",
          device: 1,
          name: "x",
          role: "sensor",
          address: 2 ** 32,
          chip: "01",
        },
      },
    ],
    ["uppercase hex", { ok: true, result: { ...asObject(RESULTS[4]), reading: "FF" } }],
    ["odd-length hex", { ok: true, result: { ...asObject(RESULTS[4]), reading: "abc" } }],
  ])("refuses %s", (_, reply) => {
    expect(controlReply.safeParse(reply).success).toBe(false);
  });

  test("a reply line echoes the request's id", () => {
    const line = { id: 3, reply: { ok: true, result: { kind: "siteWifi" } } };
    expectParses(replyLine, line);
  });
});

function asObject(value: unknown): object {
  return typeof value === "object" && value !== null ? value : {};
}

const RECORDS: readonly unknown[] = [
  {
    kind: "rx",
    table: "routine",
    row: {
      seq: 4294967297,
      atMs: 1,
      clockOk: true,
      deviceId: 3,
      type: 1,
      counter: 3331,
      path: 0,
      gatewayId: 2,
      gwUs: 500_000_000,
      gwCounter: null,
      rssi: -95,
      snrQ: 32,
      rate: 5,
      body: "0703007815000000",
    },
  },
  {
    kind: "tx",
    table: "event",
    row: {
      seq: 4294967298,
      atMs: 2,
      clockOk: false,
      deviceId: 3,
      type: 0x82,
      counter: 9412,
      path: 0,
      gatewayId: 2,
      requestCounter: 61441,
      resultCounter: null,
      rate: 5,
      power: 22,
      outcome: 0,
      gwSentUs: 501_000_012,
      body: "",
    },
  },
  {
    kind: "decision",
    row: {
      seq: 3,
      atMs: 3,
      clockOk: true,
      kind: "countdown_started",
      deviceId: 3,
      causeSeq: 1,
      value: 30,
      detail: null,
    },
  },
  {
    kind: "deviceLog",
    row: {
      seq: 4,
      atMs: 4,
      clockOk: true,
      deviceId: 3,
      counter: 3400,
      madeMs: 3,
      level: 3,
      code: 17,
      text: "6869",
      repeatOf: null,
    },
  },
  {
    kind: "hubEvent",
    row: {
      seq: 5,
      atMs: 5,
      clockOk: true,
      level: "critical",
      origin: "shell/storage/writer",
      code: "commitFailed",
      message: "disk full",
      detail: null,
    },
  },
  {
    kind: "command",
    row: {
      seq: 6,
      atMs: 6,
      clockOk: true,
      actor: "dimitri",
      kind: "disarm",
      args: '{"sensors":"all"}',
      outcome: "ok",
      detail: null,
    },
  },
  {
    kind: "reject",
    row: {
      minute: 28_000_000,
      via: "device:2",
      reason: "badTag",
      count: 4,
      address: 0x1a2b3c4d,
      sample: "104d3c2b1a0100000000b6239b28a699",
    },
  },
  // M2 (m2-design.md section 4).
  {
    kind: "notification",
    row: {
      seq: 4294967310,
      atMs: 1_794_528_000_000,
      clockOk: true,
      kind: "countdown",
      category: "countdown",
      critical: true,
      deviceId: 3,
      causeSeq: 4294967309,
      recipients: "0100000002000000",
      detail: null,
    },
  },
  {
    kind: "notificationRead",
    row: {
      seq: 4294967311,
      atMs: 1_794_528_000_500,
      clockOk: true,
      notificationSeq: 4294967310,
      clientId: 7,
    },
  },
];

describe("records", () => {
  test.each(RECORDS.map((r, i) => [i, r] as const))("record %i parses", (_, record) => {
    expectParses(recordJson, record);
    expectParses(streamLine, { id: 1, record });
  });

  test("every record kind has an example", () => {
    const kinds = new Set(RECORDS.map((r) => (asObject(r) as { kind?: unknown }).kind));
    expect(kinds.size).toBe(recordJson.options.length);
  });

  /** Record `index` with some of its row's columns changed. */
  const withRow = (index: number, changes: object): object => {
    const record = asObject(RECORDS[index]) as { row?: object };
    return { ...record, row: { ...record.row, ...changes } };
  };
  test.each([
    ["an rx row with no body", withRow(0, { body: undefined })],
    ["a packet table that is neither routine nor event", { ...asObject(RECORDS[0]), table: "hot" }],
    ["a hub event level not listed", withRow(4, { level: "fatal" })],
    ["a negative seq", withRow(2, { seq: -1 })],
  ])("refuses %s", (_, record) => {
    expect(recordJson.safeParse(record).success).toBe(false);
  });
});

describe("lockstep (section 11)", () => {
  const seed = "00".repeat(32);
  const valid: readonly unknown[] = [
    { type: "start", version: 2, at: 1_000_000, wall: 1_794_528_000_000, trusted: true, seed },
    { type: "advance", to: 30_000_000 },
    { type: "frame", link: "gw1:usb", at: 29_999_000, bytes: "0102" },
    { type: "linkUp", link: "gw1:usb", kind: "usb", at: 0 },
    { type: "linkDown", link: "hall:network", at: 5 },
    {
      type: "control",
      at: 7,
      request: { id: 1, actor: "bench", command: { kind: "disarm", sensors: "all" } },
    },
    { type: "clock", at: 9, wall: 1_794_528_000_000, trusted: false },
    { type: "stop", at: 40_000_000 },
  ];
  test.each(valid.map((m, i) => [i, m] as const))("controller to hub %i parses", (_, message) => {
    expectParses(lockstepToHub, message);
  });

  test.each([
    ["advance without a time", { type: "advance" }],
    ["a frame with text for bytes", { type: "frame", link: "gw1:usb", at: 1, bytes: "hello" }],
    ["an empty frame", { type: "frame", link: "gw1:usb", at: 1, bytes: "" }],
    ["a link of no known kind", { type: "linkUp", link: "x", kind: "radio", at: 0 }],
    ["an unknown type", { type: "quit" }],
    ["an unknown field", { type: "advance", to: 1, extra: true }],
    [
      "a control command without its time",
      { type: "control", request: { id: 1, actor: "b", command: { kind: "status" } } },
    ],
    [
      "version 1, which has no `idle.closed`",
      { type: "start", version: 1, at: 0, wall: 0, trusted: true, seed },
    ],
    ["another version", { type: "start", version: 3, at: 0, wall: 0, trusted: true, seed }],
    ["a short seed", { type: "start", version: 2, at: 0, wall: 0, trusted: true, seed: "00" }],
    ["a time that is not a whole number", { type: "advance", to: 1.5 }],
  ])("refuses %s", (_, message) => {
    expect(lockstepToHub.safeParse(message).success).toBe(false);
  });

  test("idle carries the frames, the links the hub closed, records and answers, and the next wake", () => {
    const idle = {
      type: "idle",
      to: 30_000_000,
      boot: 1,
      frames: [{ link: "gw1:usb", at: 30_000_000, bytes: "18" }],
      closed: [{ link: "gw1:network", at: 30_000_000, reason: "gateway session replaced" }],
      records: [RECORDS[2]],
      replies: [{ id: 1, reply: { ok: true, result: { kind: "siteWifi" } } }],
      wake: 32_000_000,
    };
    expectParses(lockstepFromHub, idle);
    expectParses(lockstepFromHub, { ...idle, wake: null });
    expect(lockstepFromHub.safeParse({ ...idle, wake: undefined }).success).toBe(false);
    // Version 2: `closed` is always there, empty when the hub closed nothing.
    expect(lockstepFromHub.safeParse({ ...idle, closed: undefined }).success).toBe(false);
    expectParses(lockstepFromHub, { type: "stopped", at: 40_000_000 });
    expectParses(lockstepFromHub, { type: "error", message: "not JSON", line: "x" });
  });
});

describe("the bench manifest (section 11)", () => {
  const manifest = {
    version: 1,
    devices: [
      { name: "front", role: "sensor", links: [{ kind: "usb", path: "/dev/ttys004" }] },
      {
        name: "gw1",
        role: "gateway",
        links: [
          { kind: "usb", path: "/dev/ttys005" },
          { kind: "network", path: "/dev/ttys006" },
        ],
      },
    ],
  };

  test("parses", () => {
    expectParses(benchManifest, manifest);
  });

  test.each([
    ["another version", { ...manifest, version: 2 }],
    ["a role not listed", { version: 1, devices: [{ name: "x", role: "camera", links: [] }] }],
    [
      "a link with no path",
      { version: 1, devices: [{ name: "x", role: "siren", links: [{ kind: "usb", path: "" }] }] },
    ],
  ])("refuses %s", (_, value) => {
    expect(benchManifest.safeParse(value).success).toBe(false);
  });
});

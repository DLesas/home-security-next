/**
 * No text from the hub steers the terminal of the administrator who runs `hsn` (the security
 * review; hub-design.md section 9): every line `hsn` writes and every question it asks passes
 * through `terminalSafe` (`guardedIo`, main.ts), in text and JSON alike. For every command of the
 * table, each string of its reply in turn carries ESC, BEL, CSI as one character (U+009B), DEL, a C1
 * control (NEL, U+0085) and a bidirectional override (U+202E) and isolate (U+2066); none of them
 * reaches the output raw, and the JSON output still parses to the same values. Also `hsn op`'s
 * body and refusal, the file commands' header lines, the question they ask, and the QR code, which
 * is drawn only in the block characters `qr.ts` chooses.
 */
import { ownSid } from "../shell-control/windows-folders.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { controlReply } from "../../../src/control-protocol/index.ts";
import type {
  CommandResult,
  ControlCommand,
  ControlReply,
} from "../../../src/core/model/control.ts";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import { seq } from "../../../src/core/model/ids.ts";
import type { UnixControlServer } from "../../../src/shell/control/server.ts";
import type { Session } from "../../../cli/client.ts";
import { runFileCommand } from "../../../cli/files.ts";
import { printable, terminalSafe } from "../../../cli/format.ts";
import { type CliIo, guardedIo, runCli } from "../../../cli/main.ts";
import { qrLines } from "../../../cli/qr.ts";
import { openServer, type TestFolder, testFolder } from "../shell-control/support.ts";
import { TABLE } from "./table.ts";

const NASTY = "\u001b[2J\u0007\u009b31m\u007f\u0085‮evil⁦";

/** The characters that can steer a terminal, listed here on their own, not taken from `format.ts`. */
const STEERING: ReadonlySet<number> = new Set([
  ...Array.from({ length: 0x20 }, (_, i) => i),
  ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i),
  0x061c,
  0x200e,
  0x200f,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
]);

/** The lines with any character that could steer a terminal. */
function rawSteering(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    for (const c of line) if (STEERING.has(c.codePointAt(0) ?? 0)) return true;
    return false;
  });
}

let where: TestFolder;
let hub: UnixControlServer;
let answer: (command: ControlCommand) => ControlReply;
let records: readonly AuditRecord[] = [];

beforeEach(async () => {
  where = testFolder();
  answer = () => ({ ok: false, error: { code: "failed", message: NASTY } });
  records = [];
  const opened = await openServer(where.socket, {
    logQuery: () => ({ isErr: () => false, isOk: () => true, value: records }) as never,
  });
  hub = opened.server;
  hub.listen((event) => {
    if (event.kind === "command" && event.command.kind !== "log")
      hub.respond(event.request, answer(event.command));
  });
});

afterEach(async () => {
  expect((await hub.close()).isOk()).toBe(true);
  where.remove();
});

async function hsn(
  words: readonly string[],
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...(process.platform === "win32" ? { hubAccount: ownSid() } : {}),
    env: { HSN_DATA_DIR: where.folder, USER: "anna" },
    stdin: () => Promise.resolve(""),
    nowMs: () => Date.UTC(2026, 10, 13),
    onInterrupt: () => undefined,
    ask: () => Promise.resolve("n"),
    openConsole: () =>
      Promise.resolve({ isErr: () => true, isOk: () => false, error: NASTY } as never),
  };
  const code = await runCli(words, io);
  return { code, out, err };
}

/** Every string leaf of a value, with a path to replace it. */
function stringPaths(
  value: unknown,
  at: readonly (string | number)[] = [],
): (readonly (string | number)[])[] {
  if (typeof value === "string") return [at];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringPaths(v, [...at, i]));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => stringPaths(v, [...at, k]));
  }
  return [];
}

function withNasty(value: unknown, path: readonly (string | number)[]): unknown {
  if (path.length === 0) return `${String(value)}${NASTY}`;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const list: readonly unknown[] = value;
    return list.map((v, i) => (i === head ? withNasty(v, rest) : v));
  }
  const record = value as Record<string, unknown>;
  return { ...record, [String(head)]: withNasty(record[String(head)], rest) };
}

describe("every command's reply, every string in it", () => {
  for (const [words, , result] of TABLE) {
    test(`hsn ${words}, as text and as --json`, async () => {
      const injectable = stringPaths(result).filter((path) => {
        const reply = { ok: true, result: withNasty(result, path) };
        return controlReply.safeParse(reply).success && path.at(-1) !== "kind";
      });
      for (const path of injectable) {
        const nasty = withNasty(result, path) as CommandResult;
        answer = () => ({ ok: true, result: nasty });
        const text = await hsn(words.split(" "));
        expect(rawSteering([...text.out, ...text.err])).toEqual([]);
        const json = await hsn(["--json", ...words.split(" ")]);
        expect(rawSteering([...json.out, ...json.err])).toEqual([]);
        // JSON stays JSON, with the hub's values as they were.
        for (const line of json.out) expect(JSON.parse(line)).toBeDefined();
        // (`status` takes the writer's own fields from the socket server, so it is left out.)
        if (json.out.length === 1 && words !== "open" && result.kind !== "status") {
          expect((JSON.parse(json.out[0] ?? "{}") as { reply?: unknown }).reply).toEqual({
            ok: true,
            result: nasty,
          });
        }
      }
    });
  }

  test("a refusal's message and an operation's refusal detail", async () => {
    answer = () => ({
      ok: false,
      error: { code: "unknownDevice", message: NASTY, names: [NASTY] },
    });
    const refused = await hsn(["arm", "x"]);
    expect(refused.err.length).toBeGreaterThan(0);
    expect(rawSteering(refused.err)).toEqual([]);
    answer = () => ({
      ok: false,
      error: {
        code: "opRefused",
        message: NASTY,
        app: { code: "invalid", detail: { field: NASTY, reason: "format" } },
      },
    });
    const op = await hsn(["op", "mode.switch", '{"mode":1}']);
    expect(rawSteering([...op.out, ...op.err])).toEqual([]);
    expect(JSON.parse(op.err[0] ?? "")).toEqual({
      code: "invalid",
      detail: { field: NASTY, reason: "format" },
    });
  });

  test("hsn log's records, as text and as --json", async () => {
    records = [
      {
        kind: "command",
        row: {
          seq: seq(3),
          atMs: 0,
          clockOk: true,
          actor: NASTY,
          kind: NASTY,
          args: NASTY,
          outcome: NASTY,
          detail: NASTY,
        },
      },
    ] as unknown as readonly AuditRecord[];
    for (const words of [["log"], ["--json", "log"]]) {
      const run = await hsn(words);
      expect(run.out.length).toBeGreaterThan(0);
      expect(rawSteering([...run.out, ...run.err])).toEqual([]);
    }
  });

  test("an operation's body, printed as JSON", async () => {
    answer = () => ({ ok: true, result: { kind: "op", body: { name: NASTY, list: [NASTY] } } });
    const op = await hsn(["op", "hub.info"]);
    expect(rawSteering(op.out)).toEqual([]);
    expect(JSON.parse(op.out[0] ?? "")).toEqual({ name: NASTY, list: [NASTY] });
  });
});

describe("the file commands: the header, the question, the staged version, the QR code", () => {
  function fakeSession(body: Record<string, unknown>): Session {
    return {
      path: "/x",
      request: (_actor: string, command: { readonly kind: string }) =>
        Promise.resolve({
          isOk: () => true,
          isErr: () => false,
          value: {
            id: 1,
            reply:
              command.kind === "fileChunk"
                ? { ok: true, result: { kind: "fileChunk" } }
                : { ok: true, result: { kind: "op", body } },
          },
        }),
      close: () => undefined,
      closedByHub: () => Promise.resolve(),
    } as unknown as Session;
  }

  test.each(["restore", "updateInstall"] as const)("%s", async (kind) => {
    const file = `${where.folder}/f.bin`;
    await Bun.write(file, new Uint8Array(100));
    const out: string[] = [];
    const asked: string[] = [];
    const io = guardedIo({
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      env: {},
      stdin: () => Promise.resolve(""),
      nowMs: () => 0,
      onInterrupt: () => undefined,
      ask: (q) => {
        asked.push(q);
        return Promise.resolve("y\n");
      },
    });
    const body = {
      identity: NASTY,
      madeMs: 0,
      lastChangeMs: 0,
      qr: `hsn://restore/1?h=${NASTY}`,
      version: NASTY,
    };
    const done = await runFileCommand(
      kind === "restore" ? { kind, path: file } : { kind, path: file },
      fakeSession(body),
      "anna",
      { out: io.out, ask: io.ask, nowMs: io.nowMs },
      1000,
      qrLines,
    );
    if (done.isOk()) for (const line of done.value) io.out(line);
    expect(out.length + asked.length).toBeGreaterThan(0);
    expect(rawSteering([...out, ...asked])).toEqual([]);
  });

  test("the QR code is drawn only in the chosen block characters, never the hub's text", () => {
    const lines = qrLines(`hsn://restore/1?h=${NASTY}`);
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(line).toMatch(/^[█▄▀ ]+$/u);
  });
});

describe("the guard itself", () => {
  test("a question asked is guarded as a line is", async () => {
    const asked: string[] = [];
    const io = guardedIo({
      out: () => undefined,
      err: () => undefined,
      env: {},
      stdin: () => Promise.resolve(""),
      nowMs: () => 0,
      onInterrupt: () => undefined,
      ask: (q) => {
        asked.push(q);
        return Promise.resolve("n");
      },
    });
    await io.ask(`restore ${NASTY}? `);
    expect(asked).toHaveLength(1);
    expect(rawSteering(asked)).toEqual([]);
  });

  test("every character that can steer is escaped, in text and in JSON alike", () => {
    const all = [
      ...Array.from({ length: 0x20 }, (_, i) => i),
      ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i),
      0x061c,
      0x200e,
      0x200f,
      0x202a,
      0x202b,
      0x202c,
      0x202d,
      0x202e,
      0x2066,
      0x2067,
      0x2068,
      0x2069,
    ];
    const text = String.fromCodePoint(...all);
    expect(rawSteering([terminalSafe(text), printable(text)])).toEqual([]);
    const json = JSON.stringify({ text });
    expect(JSON.parse(terminalSafe(json))).toEqual({ text });
    // Ordinary text, accents and other scripts included, is left as it is.
    expect(terminalSafe("Anna’s phone, Zoë, 東京, עברית")).toBe("Anna’s phone, Zoë, 東京, עברית");
  });
});

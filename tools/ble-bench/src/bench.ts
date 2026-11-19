/**
 * The bench as one process serves it (`bridge/main.ts`, and the simulators' harness in
 * `app/e2e-native/`): the scripted air in real time, three unpaired release boards (a sensor, a
 * siren, a gateway) with their own codes, the bridge on this Mac's loopback, and on the same port
 * two pages: `/smoke` (the bridge's smoke run, a caller of the bench's own that a simulator's
 * browser opens) and `/desk` (the Chrome desk page for a real board).
 *
 * It says what happens as `BenchLine`s, one JSON object each, and takes `BenchCommand`s: a hold
 * of a board's button, power off and on, an update offer, faults. No board's pairing window is open
 * at the start, as on a real board: `hold` for 5000 ms opens one, for 15000 ms resets the board,
 * and the smoke page's siren is held when the page asks for its session. A line names a board and what it
 * did; the boards' codes and QR texts are what their displays show (scripted boards, test codes);
 * no key and no session byte is ever in a line.
 */
import { join } from "node:path";
import { BleAir } from "./air/air.ts";
import type { Faults } from "./air/faults.ts";
import { type BoardRole, PAIRING_HOLD_MS, ScriptedBoard } from "./boards/board.ts";
import { startBridge } from "./bridge/server.ts";
import { fromHex, toHex } from "./bridge/wire.ts";
import { realClock } from "./clock.ts";
import { fault, ok, type Outcome } from "./outcome.ts";
import { bundleForBrowser } from "./safe/build.ts";
import { parseJson } from "./safe/json.ts";
import { Role, testImage, testPairing } from "./test-keys.ts";
import { bluetoothSessionKey } from "../../../packages/protocol/src/update/bluetooth.ts";
import { encodeSetupMessage, SetupType } from "../../../packages/protocol/src/usb/setup.ts";

export interface BenchOptions {
  readonly port?: number;
  /** The smoke page's own two boards beside the three. */
  readonly smoke?: boolean;
}

export type BenchLine =
  | {
      readonly kind: "ready";
      readonly url: string;
      readonly pages: { readonly smoke: string; readonly desk: string };
      readonly security: "security2";
      readonly boards: readonly {
        readonly name: string;
        readonly id: string;
        readonly label: string;
        readonly code: string;
        readonly qr: string;
      }[];
    }
  | { readonly kind: "phone"; readonly event: "connected" | "gone"; readonly phones: number }
  | { readonly kind: "provisioned"; readonly board: string; readonly address: number }
  | {
      readonly kind: "update";
      readonly board: string;
      readonly stage: number;
      readonly reason: number;
    }
  | { readonly kind: "smoke"; readonly pass: boolean; readonly lines: readonly string[] }
  | {
      readonly kind: "state";
      readonly boards: readonly {
        readonly name: string;
        readonly window: string;
        readonly paired: boolean;
        readonly wrongCodes: number;
      }[];
    }
  | { readonly kind: "problem"; readonly message: string };

export type BenchCommand =
  /** The button held for `ms`: under 5 s nothing, from 5 s the window, from 15 s a reset. */
  | { readonly cmd: "hold"; readonly board: string; readonly ms: number }
  | { readonly cmd: "power"; readonly board: string; readonly on: boolean }
  | {
      readonly cmd: "offer";
      readonly board: string;
      readonly imageId: string;
      readonly nonce: string;
      readonly windowUnits: number;
    }
  | {
      readonly cmd: "faults";
      readonly board?: string;
      readonly latencyMs?: number;
      readonly boardDelayMs?: number;
    }
  | { readonly cmd: "state" }
  | { readonly cmd: "quit" };

export interface Bench {
  readonly url: string;
  readonly air: BleAir;
  readonly boards: ReadonlyMap<string, ScriptedBoard>;
  command(command: BenchCommand): void;
  stop(): void;
}

const ROLES: readonly [string, BoardRole][] = [
  ["sensor", Role.Sensor],
  ["siren", Role.Siren],
  ["gateway", Role.Gateway],
];

function chip(n: number): Uint8Array {
  return Uint8Array.of(0x3c, 0x84, 0x27, 0xe2, 0xb0 + n, 0x10 + n);
}

const SMOKE_IMAGE_BYTES = 13000;

function html(script: string, title: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>` +
      `<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:1.5rem;max-width:42rem;color:#1d2433;background:#fbfbf8}` +
      `h1{font-size:1.25rem;margin:0 0 .25rem}p{margin:.25rem 0 1rem;color:#4a5263}button{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid #1d2433;background:#1d2433;color:#fff}` +
      `button:disabled{opacity:.4}input{font:inherit;padding:.5rem;border:1px solid #9aa1ae;border-radius:.5rem;width:10rem;letter-spacing:.1em}` +
      `ol{padding-left:1.25rem}li{margin:.15rem 0}.ok{color:#11633a}.no{color:#a3241b}#verdict{font-weight:600;margin-top:1rem}</style>` +
      `</head><body><main id="page"></main><script type="module">${script}</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function startBench(
  options: BenchOptions,
  say: (line: BenchLine) => void,
): Promise<Outcome<Bench, "cannotListen" | "buildFailed">> {
  const air = new BleAir(realClock, { advertIntervalMs: 160, connectTimeoutMs: 5000 });
  const boards = new Map<string, ScriptedBoard>();
  const events = (name: string) => ({
    provisioned: (pairing: { readonly address: number }) => {
      say({ kind: "provisioned", board: name, address: pairing.address });
    },
    updateStatus: (status: { readonly stage: number; readonly reason: number }) => {
      say({ kind: "update", board: name, stage: status.stage, reason: status.reason });
    },
  });
  ROLES.forEach(([name, role], i) => {
    boards.set(name, new ScriptedBoard(realClock, { role, chipId: chip(i) }, events(name)));
  });

  // The smoke page's two: an unpaired siren and a paired sensor to update.
  const smokeImage = testImage(SMOKE_IMAGE_BYTES);
  const smokePairing = testPairing({ address: 0x5e0e0001 });
  if (options.smoke === true) {
    boards.set(
      "smoke-siren",
      new ScriptedBoard(realClock, { role: Role.Siren, chipId: chip(7) }, events("smoke-siren")),
    );
    boards.set(
      "smoke-sensor",
      new ScriptedBoard(
        realClock,
        { role: Role.Sensor, chipId: chip(8), pairing: smokePairing },
        events("smoke-sensor"),
      ),
    );
  }
  for (const board of boards.values()) {
    air.add(board);
    board.powerOn();
  }

  const smokeScript = await bundleForBrowser(join(import.meta.dir, "..", "pages", "smoke.ts"));
  const deskScript = await bundleForBrowser(join(import.meta.dir, "..", "pages", "desk.ts"));
  if (!smokeScript.ok || !deskScript.ok) return fault("buildFailed");

  const smokeSession = (): Response => {
    const siren = boards.get("smoke-siren");
    const sensor = boards.get("smoke-sensor");
    if (siren === undefined || sensor === undefined)
      return new Response("no smoke boards", { status: 404 });
    // The person holds the siren's button for 5 seconds: its pairing window opens.
    siren.holdButton(PAIRING_HOLD_MS);
    // A fresh session each time, as the hub's offer would make: a new nonce, its window.
    const nonce = crypto.getRandomValues(new Uint8Array(8));
    sensor.offerUpdate({ imageId: smokeImage.imageId, nonce, windowUnits: 12 });
    const key = bluetoothSessionKey(smokePairing.key, nonce, smokePairing.address);
    const provision = encodeSetupMessage({
      type: SetupType.Provision,
      pairing: testPairing({ address: 0x5e0e0002 }),
    });
    return Response.json({
      sirenCode: siren.code,
      sirenChip: toHex(siren.chipId),
      provision: toHex(provision),
      update: {
        address: smokePairing.address,
        sessionKey: key.ok ? toHex(key.value) : "",
        imageId: toHex(smokeImage.imageId),
        file: toHex(smokeImage.file),
      },
    });
  };

  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/smoke") return html(smokeScript.value, "Bridge smoke run");
    if (path === "/desk") return html(deskScript.value, "Pairing desk");
    if (path === "/smoke/session" && options.smoke === true) return smokeSession();
    if (path === "/smoke/result" && request.method === "POST") {
      const body = parseJson(await request.text());
      const value = body.ok ? (body.value as { pass?: unknown; lines?: unknown }) : {};
      const lines = Array.isArray(value.lines)
        ? value.lines.filter((l): l is string => typeof l === "string")
        : [];
      say({ kind: "smoke", pass: value.pass === true, lines });
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  };

  const bridge = startBridge({
    air,
    ...(options.port === undefined ? {} : { port: options.port }),
    fetch,
    onPhone: (event, phones) => {
      say({ kind: "phone", event, phones });
    },
  });
  if (!bridge.ok) return fault("cannotListen");
  const server = bridge.value;
  const http = `http://127.0.0.1:${String(server.port)}`;
  say({
    kind: "ready",
    url: server.url,
    pages: { smoke: `${http}/smoke`, desk: `${http}/desk` },
    security: "security2",
    boards: [...boards.entries()].map(([name, board]) => ({
      name,
      id: board.id,
      label: board.label,
      code: board.shownCode,
      qr: board.qr,
    })),
  });

  const command = (c: BenchCommand): void => {
    const name = "board" in c ? c.board : undefined;
    const board = name === undefined ? undefined : boards.get(name);
    if (name !== undefined && board === undefined) {
      say({ kind: "problem", message: `no board ${name}` });
      return;
    }
    switch (c.cmd) {
      case "hold":
        board?.holdButton(c.ms);
        break;
      case "power":
        if (c.on) board?.powerOn();
        else board?.powerOff();
        break;
      case "offer": {
        const imageId = fromHex(c.imageId);
        const nonce = fromHex(c.nonce);
        if (board === undefined || imageId?.length !== 8 || nonce?.length !== 8) {
          say({ kind: "problem", message: "offer: a board, an 8-byte image id and nonce in hex" });
          break;
        }
        board.offerUpdate({ imageId, nonce, windowUnits: c.windowUnits });
        break;
      }
      case "faults": {
        const faults: Faults = {
          ...(c.latencyMs === undefined ? {} : { latencyMs: c.latencyMs }),
          ...(c.boardDelayMs === undefined ? {} : { boardDelayMs: c.boardDelayMs }),
        };
        if (board === undefined) air.faults = faults;
        else air.setFaults(board.id, faults);
        break;
      }
      case "state":
        say({
          kind: "state",
          boards: [...boards.entries()].map(([name, b]) => ({
            name,
            window: b.window,
            paired: b.pairing !== undefined,
            wrongCodes: b.wrongCodes,
          })),
        });
        break;
      case "quit":
        break;
    }
  };

  return ok({
    url: server.url,
    air,
    boards,
    command,
    stop: () => {
      for (const board of boards.values()) board.powerOff();
      server.stop();
    },
  });
}

/** One command line, or undefined when it is not one. */
export function readCommand(text: string): BenchCommand | undefined {
  const parsed = parseJson(text);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return undefined;
  const c = parsed.value as Record<string, unknown>;
  const board = typeof c.board === "string" ? c.board : undefined;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  switch (c.cmd) {
    case "hold": {
      const ms = num(c.ms);
      return board === undefined || ms === undefined ? undefined : { cmd: "hold", board, ms };
    }
    case "power":
      return board === undefined || typeof c.on !== "boolean"
        ? undefined
        : { cmd: "power", board, on: c.on };
    case "offer":
      return board !== undefined &&
        typeof c.imageId === "string" &&
        typeof c.nonce === "string" &&
        num(c.windowUnits) !== undefined
        ? {
            cmd: "offer",
            board,
            imageId: c.imageId,
            nonce: c.nonce,
            windowUnits: num(c.windowUnits) ?? 0,
          }
        : undefined;
    case "faults": {
      const latencyMs = num(c.latencyMs);
      const boardDelayMs = num(c.boardDelayMs);
      return {
        cmd: "faults",
        ...(board === undefined ? {} : { board }),
        ...(latencyMs === undefined ? {} : { latencyMs }),
        ...(boardDelayMs === undefined ? {} : { boardDelayMs }),
      };
    }
    case "state":
      return { cmd: "state" };
    case "quit":
      return { cmd: "quit" };
    default:
      return undefined;
  }
}

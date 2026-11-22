/**
 * Serving an image to devices (`shell/firmware/serve.ts`; docs/m3-updates-design.md sections 4
 * and 5): every Get on a granted link answered with exactly the bytes asked and their CRC-32, the
 * header first; Gone with the right reason otherwise; a transfer frame on a link never granted
 * left to the core; progress every 64 KB ‡ and at the end. Then a whole image pulled by a scripted
 * device over a real WebSocket link and a real pseudo-terminal USB link, with lost and repeated
 * Gets and lost Data, a revoke mid-transfer for each reason and the resumption after, and a
 * dropped link resumed on a new one. Each answer's time is measured; the longest is printed.
 *
 * The tests that bound an answer's time (`LOADED_ANSWER_MS`: the burst, and the two whole
 * transfers) run in a child process holding only them, this file again with
 * `HSN_SERVE_TIMING_CHILD=1`, started by the last test here: in the whole test run's process its
 * own collections pause the thread 20 to 48 ms on the hosted runners (JSC's collection log, run
 * 44913617902), and an answer timed across one read 47 and 55 ms (runs 44944661562, 44944663126).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeUsbFrame, UsbFrameDecoder } from "@hsn/protocol";
import {
  crc32,
  decodeTransferFrame,
  encodeTransferFrame,
  GoneReason,
  TransferKind,
} from "@hsn/protocol/update";
import { ok } from "neverthrow";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { type LinkId, linkId } from "../../../src/core/model/ids.ts";
import { makeHeader, type HubSigner } from "../../../src/shell/firmware/sign.ts";
import { PROGRESS_STEP_BYTES, TransferServer } from "../../../src/shell/firmware/serve.ts";
import { imageFileName, storeFolder } from "../../../src/shell/firmware/store.ts";
import { LinkRegistry, TRANSFER_SEND_REF } from "../../../src/shell/links/registry.ts";
import { SerialLinks } from "../../../src/shell/links/serial.ts";
import { serveDevices } from "../../../src/shell/links/websocket.ts";
import { PullingDevice, until } from "./device.ts";
import { espImage, sha256, type TempFolder, tempFolder, testHubKeys } from "./support.ts";

/** A bound a loaded machine keeps for one frame's answer (a read of at most 1,000 bytes). */
const LOADED_ANSWER_MS = 20;
/** Section 3's limit for a turn ‡, asserted on a burst only with `HSN_TIMING=1`. */
const TURN_LIMIT_MS = 20;
const TIMING = process.env.HSN_TIMING === "1";
/** This file run as its own child, holding only the timed tests (see the header). */
const TIMING_CHILD = process.env.HSN_SERVE_TIMING_CHILD === "1";
/** The timed tests, by name, for the child's `-t`. */
const TIMED = "a burst: sixteen devices|a whole image over a real";

let folder: TempFolder;
let dataDir: string;
let signer: HubSigner;
let image: Uint8Array;
let header: Uint8Array;
let imageId: Uint8Array;
let file: string;
let fileBytes: number;
const longest: number[] = [];

beforeAll(async () => {
  folder = tempFolder("serve");
  dataDir = join(folder.path, "data");
  signer = (await testHubKeys()).signer;
  image = espImage({ size: 300_000, seed: 31 });
  const sha = sha256(image);
  header = makeHeader(
    {
      ownBuild: false,
      roles: 14,
      version: { major: 1, minor: 4, patch: 0 },
      imageBytes: image.length,
      imageSha256: sha,
    },
    signer,
  )._unsafeUnwrap();
  imageId = sha.slice(0, 8);
  file = imageFileName(sha);
  fileBytes = 128 + image.length;
  mkdirSync(storeFolder(dataDir), { recursive: true });
  writeFileSync(join(storeFolder(dataDir), file), image);
});

afterAll(() => {
  folder.remove();
  const which = TIMING_CHILD ? "" : " (the untimed tests here)";
  console.log(`longest answer to one frame${which}: ${Math.max(0, ...longest).toFixed(3)} ms`);
});

/** The file a device pulls. */
function whole(): Uint8Array {
  const out = new Uint8Array(fileBytes);
  out.set(header, 0);
  out.set(image, 128);
  return out;
}

/** A protocol result's value; a test fails loudly on an error. */
function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  expect(result.ok).toBe(true);
  return (result as { readonly value: T }).value;
}

function get(offset: number, length: number, id = imageId): Uint8Array {
  return must(
    encodeTransferFrame({
      kind: TransferKind.Get,
      imageId: id,
      offset,
      length,
    }),
  );
}

interface Bench {
  readonly server: TransferServer;
  readonly sent: { readonly link: LinkId; readonly bytes: Uint8Array }[];
  readonly events: HubEvent[];
}

function bench(): Bench {
  const sent: { link: LinkId; bytes: Uint8Array }[] = [];
  const events: HubEvent[] = [];
  const server = new TransferServer({
    dataDir,
    send: (link, bytes) => {
      sent.push({ link, bytes });
      return true;
    },
    emit: (event) => events.push(event),
    stopwatch: () => performance.now(),
  });
  return { server, sent, events };
}

function decoded(bytes: Uint8Array) {
  return must(decodeTransferFrame(bytes));
}

const L = linkId(1);

describe("an indexed image whose file is gone while the hub runs", () => {
  // The file put back whatever happens here: the other tests serve it.
  afterEach(() => {
    writeFileSync(join(storeFolder(dataDir), file), image);
  });

  // A removal off the loop racing a staging of the same image (`remove-job.ts`) can leave the
  // index naming an image whose file is gone until the next start's check. What a device then
  // gets, and what repairs it short of a restart: shown here, not yet fixed (reported).
  test("Gone notAvailable and the core told nothing; added again, the same grant still Gone; only a new grant serves it", () => {
    const { server, sent, events } = bench();
    const path = join(storeFolder(dataDir), file);
    rmSync(path);
    // The header is the grant's own; the payload's first Get finds no file.
    server.grant(L, { imageId, header, file });
    expect(server.take(L, get(128, 1000))).toBe(true);
    expect(decoded(sent.at(-1)?.bytes ?? new Uint8Array())).toMatchObject({
      kind: TransferKind.Gone,
      reason: GoneReason.NotAvailable,
    });
    // Nothing for the core: no inputRejected, no progress. The rollout goes on as if served.
    expect(events).toEqual([]);
    // The image added again: its staging puts the same bytes back under the same name.
    writeFileSync(path, image);
    expect(server.take(L, get(128, 1000))).toBe(true);
    expect(decoded(sent.at(-1)?.bytes ?? new Uint8Array())).toMatchObject({
      kind: TransferKind.Gone,
      reason: GoneReason.NotAvailable,
    });
    // A new grant (the device's Update query on a new link, or a restart's) opens it again.
    server.grant(L, { imageId, header, file });
    expect(server.take(L, get(128, 1000))).toBe(true);
    expect(decoded(sent.at(-1)?.bytes ?? new Uint8Array())).toMatchObject({
      kind: TransferKind.Data,
      offset: 128,
    });
    server.forget(L);
  });
});

describe("the answers on one link", () => {
  test("a Get for the header, one inside the image, one across both: the bytes asked, their CRC", () => {
    const { server, sent } = bench();
    server.grant(L, { imageId, header, file });
    for (const [offset, length] of [
      [0, 128],
      [128, 1000],
      [100, 1000],
      [5, 1],
      [fileBytes - 1, 1],
      [fileBytes - 1000, 1000],
    ] as const) {
      expect(server.take(L, get(offset, length))).toBe(true);
      const frame = decoded(sent.at(-1)?.bytes ?? new Uint8Array());
      expect(frame).toMatchObject({ kind: TransferKind.Data, imageId, offset });
      if (frame.kind !== TransferKind.Data) continue;
      expect(frame.data).toEqual(whole().subarray(offset, offset + length));
      expect(frame.crc32).toBe(crc32(frame.data));
    }
    longest.push(server.takeLongestMs());
  });

  test("outside the file: Gone outOfRange, and the core told of a refused frame", () => {
    const { server, sent, events } = bench();
    server.grant(L, { imageId, header, file });
    expect(server.take(L, get(fileBytes - 999, 1000))).toBe(true);
    expect(server.take(L, get(fileBytes, 1))).toBe(true);
    for (const out of sent)
      expect(decoded(out.bytes)).toEqual({
        kind: TransferKind.Gone,
        imageId,
        reason: GoneReason.OutOfRange,
      });
    expect(events).toEqual([
      { kind: "inputRejected", rejection: { source: "frame", link: L, reason: "badFrame" } },
      { kind: "inputRejected", rejection: { source: "frame", link: L, reason: "badFrame" } },
    ]);
  });

  test("another image: Gone notGranted; not a Get, or not a frame: Gone notAvailable; each told", () => {
    const { server, sent, events } = bench();
    server.grant(L, { imageId, header, file });
    const other = new Uint8Array(8).fill(9);
    server.take(L, get(0, 128, other));
    server.take(L, must(encodeTransferFrame({ kind: TransferKind.Gone, imageId, reason: 0 })));
    server.take(L, Uint8Array.of(0xf2, 0x7f));
    server.take(L, Uint8Array.of(0xf2));
    expect(sent.map((s) => decoded(s.bytes))).toEqual([
      { kind: TransferKind.Gone, imageId: other, reason: GoneReason.NotGranted },
      { kind: TransferKind.Gone, imageId, reason: GoneReason.NotAvailable },
      { kind: TransferKind.Gone, imageId, reason: GoneReason.NotAvailable },
      { kind: TransferKind.Gone, imageId, reason: GoneReason.NotAvailable },
    ]);
    expect(events).toHaveLength(4);
  });

  test("a packet, a setup message, and any frame on a link never granted are the core's", () => {
    const { server, sent } = bench();
    expect(server.take(L, get(0, 128))).toBe(false);
    server.grant(L, { imageId, header, file });
    expect(server.take(L, Uint8Array.of(0x10, 1, 2))).toBe(false);
    expect(server.take(L, Uint8Array.of(0xf1, 0x01))).toBe(false);
    expect(server.take(linkId(2), get(0, 128))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("revoked: Gone paused, or notGranted (also with no reason); Data again after a new grant", () => {
    for (const [reason, gone] of [
      ["paused", GoneReason.Paused],
      ["notGranted", GoneReason.NotGranted],
      [undefined, GoneReason.NotGranted],
    ] as const) {
      const { server, sent, events } = bench();
      server.grant(L, { imageId, header, file });
      server.revoke(L, reason);
      expect(server.take(L, get(128, 1000))).toBe(true);
      expect(decoded(sent.at(-1)?.bytes ?? new Uint8Array())).toEqual({
        kind: TransferKind.Gone,
        imageId,
        reason: gone,
      });
      // A frame that is not a Get, on a revoked link: told, not answered.
      server.take(L, Uint8Array.of(0xf2, 0x7f));
      expect(sent).toHaveLength(1);
      expect(events).toHaveLength(1);
      server.grant(L, { imageId, header, file });
      server.take(L, get(128, 1000));
      expect(decoded(sent.at(-1)?.bytes ?? new Uint8Array()).kind).toBe(TransferKind.Data);
    }
  });

  test("the link closed: its record goes, and a later frame on that link is the core's", () => {
    const { server } = bench();
    server.grant(L, { imageId, header, file });
    server.revoke(linkId(2), "paused");
    server.forget(L);
    server.forget(linkId(2));
    expect(server.holds(L)).toBe(false);
    expect(server.take(L, get(0, 128))).toBe(false);
    expect(server.take(linkId(2), get(0, 128))).toBe(false);
  });

  test("a file that is not there, or shorter than its header says: Gone notAvailable past the header", () => {
    const { server, sent } = bench();
    server.grant(L, { imageId, header, file: `${"0".repeat(64)}.bin` });
    server.take(L, get(0, 128));
    expect(decoded(sent.at(-1)?.bytes ?? new Uint8Array()).kind).toBe(TransferKind.Data);
    server.take(L, get(128, 1000));
    expect(decoded(sent.at(-1)?.bytes ?? new Uint8Array())).toEqual({
      kind: TransferKind.Gone,
      imageId,
      reason: GoneReason.NotAvailable,
    });
    const short = imageFileName(new Uint8Array(32).fill(5));
    writeFileSync(join(storeFolder(dataDir), short), image.subarray(0, 1000));
    server.grant(L, { imageId, header, file: short });
    server.take(L, get(128 + 500, 1000));
    expect(decoded(sent.at(-1)?.bytes ?? new Uint8Array()).kind).toBe(TransferKind.Gone);
    server.grant(L, { imageId, header, file: "../hub.db" });
    server.take(L, get(128, 10));
    expect(decoded(sent.at(-1)?.bytes ?? new Uint8Array())).toMatchObject({
      kind: TransferKind.Gone,
      reason: GoneReason.NotAvailable,
    });
    rmSync(join(storeFolder(dataDir), short));
  });

  test("progress: each 64 KB step once, then the end; repeats and re-asks add nothing", () => {
    const { server, events } = bench();
    server.grant(L, { imageId, header, file });
    server.take(L, get(0, 128));
    for (let at = 128; at < fileBytes; at += 1000) {
      const length = Math.min(1000, fileBytes - at);
      server.take(L, get(at, length));
      if (at % 7000 === 128) server.take(L, get(at, length));
    }
    server.take(L, get(0, 128));
    const bytes = events.map((e) => (e.kind === "transferProgress" ? e.bytes : -1));
    expect(bytes.every((b) => b > 0)).toBe(true);
    expect(bytes.at(-1)).toBe(fileBytes);
    const steps = bytes.slice(0, -1).map((b) => Math.floor(b / PROGRESS_STEP_BYTES));
    expect(steps).toEqual(Array.from({ length: steps.length }, (_, i) => i + 1));
    expect(steps.length).toBe(Math.floor(fileBytes / PROGRESS_STEP_BYTES));
    for (const event of events)
      expect(event).toMatchObject({ kind: "transferProgress", link: L, image: imageId });
  });

  test.skipIf(!TIMING_CHILD)(
    "a burst: sixteen devices with four Gets each, answered one at a time",
    () => {
      const { server, sent } = bench();
      for (let n = 1; n <= 16; n++) server.grant(linkId(n), { imageId, header, file });
      const started = performance.now();
      for (let n = 1; n <= 16; n++)
        for (let k = 0; k < 4; k++) server.take(linkId(n), get(128 + (n * 4 + k) * 1000, 1000));
      const burst = performance.now() - started;
      expect(sent).toHaveLength(64);
      const one = server.takeLongestMs();
      longest.push(one);
      console.log(
        `a burst of 64 Gets: ${burst.toFixed(3)} ms; the longest one ${one.toFixed(3)} ms`,
      );
      expect(one).toBeLessThan(LOADED_ANSWER_MS);
      if (TIMING) expect(burst).toBeLessThan(TURN_LIMIT_MS);
    },
  );
});

// ----- Real links -----

interface Link {
  readonly registry: LinkRegistry;
  readonly server: TransferServer;
  readonly events: HubEvent[];
}

function hubSide(): Link {
  const registry = new LinkRegistry();
  const events: HubEvent[] = [];
  registry.listen((e) => events.push(e));
  const server = new TransferServer({
    dataDir,
    send: (link, bytes) => registry.sendTransfer(link, bytes),
    emit: (event) => events.push(event),
    stopwatch: () => performance.now(),
  });
  registry.serveTransfers(server);
  return { registry, server, events };
}

function opened(events: readonly HubEvent[]): LinkId[] {
  return events.flatMap((e) => (e.kind === "linkOpened" ? [e.link] : []));
}

/** The device's end of a transport, and how it is closed. */
interface DeviceEnd {
  send(bytes: Uint8Array): void;
  close(): void;
}

/** Until the server has answered nothing new for 50 ms: the frames in flight have come. */
async function settled(server: TransferServer): Promise<void> {
  for (let last = -1; server.answered !== last;) {
    last = server.answered;
    await Bun.sleep(50);
  }
}

/** A whole transfer's script over a link that `connect` makes, on a fresh hub side. */
async function wholeTransfer(
  connect: (side: Link, device: PullingDevice) => Promise<DeviceEnd>,
): Promise<void> {
  const side = hubSide();
  const device = new PullingDevice(imageId, fileBytes, {
    faults: {
      loseGets: new Set([3, 40, 41, 90]),
      loseData: new Set([7, 60]),
      repeatGets: new Set([5, 50, 120]),
    },
  });
  // 1. A frame on the link before any grant goes to the core, as any frame does.
  let end = await connect(side, device);
  const first = opened(side.events)[0] ?? linkId(0);
  end.send(get(0, 128));
  expect(await until(() => side.events.some((e) => e.kind === "frame"))).toBe(true);
  expect(side.events.find((e) => e.kind === "frame")).toEqual({
    kind: "frame",
    link: first,
    bytes: get(0, 128),
  });
  // 2. Granted: the device pulls until a third of the file, then a countdown pauses it.
  side.server.grant(first, { imageId, header, file });
  device.watch = (held) => {
    if (held > fileBytes / 3) {
      device.watch = undefined;
      side.server.revoke(first, "paused");
    }
  };
  expect(await device.pull(end)).toBe("gone");
  expect(device.gones.at(-1)).toBe(GoneReason.Paused);
  const checkpoint = device.held;
  expect(checkpoint).toBeGreaterThan(0);
  // The Gets still in flight are answered Gone too; the device, stopped, lets them pass.
  await settled(side.server);
  // 3. The countdown ends: granted again, the device resumes from its checkpoint.
  side.server.grant(first, { imageId, header, file });
  // 4. The grant is taken back (not paused): Gone notGranted.
  device.watch = (held) => {
    if (held > (2 * fileBytes) / 3) {
      device.watch = undefined;
      side.server.revoke(first, "notGranted");
    }
  };
  expect(await device.pull(end)).toBe("gone");
  expect(device.held).toBeGreaterThan(checkpoint);
  await settled(side.server);
  expect(device.gones.at(-1)).toBe(GoneReason.NotGranted);
  // 5. The link drops; the device reconnects on a new link, which the core grants, and finishes.
  end.close();
  expect(await until(() => side.events.some((e) => e.kind === "linkClosed"))).toBe(true);
  expect(side.server.holds(first)).toBe(false);
  end = await connect(side, device);
  const second = opened(side.events)[1] ?? linkId(0);
  expect(second).not.toBe(first);
  side.server.grant(second, { imageId, header, file });
  expect(await device.pull(end)).toBe("done");
  end.close();
  expect(device.file).toEqual(whole());
  expect(sha256(device.file.subarray(128))).toEqual(sha256(image));
  // The faults happened, and were survived.
  expect(device.reasks).toBeGreaterThan(0);
  expect(device.dropped).toBeGreaterThan(0);
  expect(device.badCrc).toBe(0);
  // Progress for both links, rising on each, the last at the file's end.
  const progress = side.events.flatMap((e) => (e.kind === "transferProgress" ? [e] : []));
  expect(progress.some((p) => p.link === first)).toBe(true);
  expect(progress.at(-1)).toMatchObject({ link: second, bytes: fileBytes });
  // No transfer frame reached the core once granted: only the one before the grant.
  expect(side.events.filter((e) => e.kind === "frame")).toHaveLength(1);
  const one = side.server.takeLongestMs();
  longest.push(one);
  expect(one).toBeLessThan(LOADED_ANSWER_MS);
}

describe.skipIf(!TIMING_CHILD)("a whole image over a real WebSocket link", () => {
  const servers: { stop(force: boolean): unknown }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });

  test("lost and repeated Gets, lost Data, a revoke for each reason, resumption, a new link", async () => {
    await wholeTransfer(async (side, device) => {
      let server = servers[0] as ReturnType<typeof serveDevices> | undefined;
      if (server === undefined) {
        server = serveDevices(side.registry, 0);
        servers.push(server);
      }
      const before = opened(side.events).length;
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/device`);
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) device.receive(new Uint8Array(event.data));
      };
      await new Promise<void>((resolve) => {
        socket.onopen = () => {
          resolve();
        };
      });
      expect(await until(() => opened(side.events).length > before)).toBe(true);
      return {
        send: (bytes) => {
          socket.send(bytes);
        },
        close: () => {
          socket.close();
        },
      };
    });
  });
});

// The pseudo-terminal relay of the serial adapter's tests (no Python needed).
const RELAY = join(import.meta.dir, "..", "shell-links", "pty-relay.ts");
const ptys = process.platform !== "win32";

describe.skipIf(!ptys || !TIMING_CHILD)(
  "a whole image over a real USB link (a pseudo-terminal)",
  () => {
    const relays: { kill(): void }[] = [];
    afterEach(() => {
      for (const r of relays.splice(0)) r.kill();
    });

    test("lost and repeated Gets, lost Data, a revoke for each reason, resumption, a new link", async () => {
      await wholeTransfer(async (side, device) => {
        const proc = Bun.spawn(["bun", RELAY], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
        relays.push(proc);
        const reader = proc.stdout.getReader();
        // The relay prints its terminal's path first; nothing else comes before the hub writes.
        let header = "";
        let path = "";
        for (let reads = 0; path === "" && reads < 100; reads++) {
          const chunk = await reader.read();
          if (chunk.done) break;
          header += new TextDecoder().decode(chunk.value);
          const at = header.indexOf("\n");
          if (at >= 0) path = header.slice(0, at);
        }
        const decoder = new UsbFrameDecoder();
        const deliver = (bytes: Uint8Array): void => {
          for (const frame of decoder.push(bytes)) if (frame.ok) device.receive(frame.value);
        };
        void (async () => {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return;
            deliver(chunk.value);
          }
        })();
        const serial = new SerialLinks(side.registry);
        expect(serial.open(path).isOk()).toBe(true);
        return {
          send: (bytes) => {
            void proc.stdin.write(encodeUsbFrame(bytes));
            void proc.stdin.flush();
          },
          close: () => {
            proc.kill();
          },
        };
      });
    }, 30_000);
  },
);

test("the registry hands a transfer frame's answer to the link, and keeps its failure from the core", () => {
  const side = hubSide();
  const written: Uint8Array[] = [];
  const link = side.registry.open("network", "test", {
    send: (bytes) => {
      written.push(bytes);
      return ok(undefined);
    },
    close: () => ok(undefined),
  });
  side.server.grant(link, { imageId, header, file });
  side.registry.frame(link, get(0, 128));
  expect(written).toHaveLength(1);
  expect(side.events.filter((e) => e.kind === "frame")).toHaveLength(0);
  side.registry.failed(link, TRANSFER_SEND_REF, {
    kind: "link",
    origin: "test",
    message: "x",
    code: "closed",
  });
  expect(side.events.filter((e) => e.kind === "sendFailed")).toHaveLength(0);
  side.registry.closed(link, "remote");
  expect(side.server.holds(link)).toBe(false);
});

test.skipIf(TIMING_CHILD)(
  "the timed answers (a burst, a whole image over each real link), in a process that holds only them",
  async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", TIMED], {
      cwd: join(import.meta.dir, "..", "..", "..", ".."),
      env: { ...process.env, HSN_SERVE_TIMING_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const lines = `${out}\n${err}`.split("\n").map((line) => line.trim());
    for (const line of lines)
      if (line.startsWith("longest answer") || line.startsWith("a burst of")) console.log(line);
    expect({
      code,
      failed: lines.filter((line) => line.startsWith("(fail)")),
      passed: lines.find((line) => /^\d+ pass$/u.test(line)),
    }).toEqual({ code: 0, failed: [], passed: `${ptys ? 3 : 2} pass` });
  },
  60_000,
);

/** The app's transfer server answers the scripted sensor from an actual image file. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIRMWARE_BLUETOOTH_REFUSALS,
  type AppEvent,
  type BluetoothSessionObject,
} from "@hsn/protocol/app";
import { toHex } from "@hsn/protocol/messages";
import {
  bluetoothMaxData,
  bluetoothUpdateName,
  DEVICE_RANDOM_LENGTH,
  GoneReason,
  type HelloFrame,
  TransferKind,
  TransferResult,
  UpdateReason,
} from "@hsn/protocol/update";
import { createHubClient } from "../src/hub/client";
import { toBase64url } from "../src/hub/files";
import { realTimers } from "../src/hub/wire";
import { type ImageCache, downloadImage } from "../src/pairing/download";
import { NO_PROGRESS_MS, type ImageReader, serveImage } from "../src/pairing/firmware-server";
import { refusal, type PhoneHub } from "../src/pairing/hub";
import { updateGrant, updateTransfer } from "../src/pairing/update-flow";
import type { BleCentral, BluetoothUpdate } from "../src/platform/ble";
import { memoryRecordStore } from "../src/platform/client-key";
import { corruptNthData, type Faults, nthFrame } from "../../tools/ble-bench/src/air/faults";
import { ManualClock } from "../../tools/ble-bench/src/clock";
import { settled } from "../../tools/ble-bench/test/support/raw-phone";
import { offer, updateWorld, type UpdateWorld } from "../../tools/ble-bench/test/support/world";
import { firmwareLink } from "./support/firmware-link";

/** Opens fixture bytes as an actual random-access file and keeps its cleanup beside it. */
function fileOf(bytes: Uint8Array): ImageReader & { close(): void } {
  const folder = mkdtempSync(join(tmpdir(), "hsn-p4-image-"));
  const path = join(folder, "image.hsnf");
  writeFileSync(path, bytes);
  const fd = openSync(path, "r");
  return {
    size: bytes.length,
    read: (offset, length) => {
      const page = new Uint8Array(length);
      return page.subarray(0, readSync(fd, page, 0, length, offset));
    },
    close: () => {
      closeSync(fd);
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

/** Builds the grant the owner would have got from the hub for this scripted sensor. */
function grant(world: UpdateWorld): BluetoothUpdate {
  return {
    device: 1,
    address: world.session.address,
    imageId: world.session.imageId,
    version: "1.4.0",
    fileBytes: world.image.file.length,
    sha256: world.image.file.subarray(16, 48),
    sessionKey: world.session.sessionKey,
    windowS: 120,
    expiresAtMs: 300_000,
    needsWake: true,
  };
}

/** Drives the phone implementation through one full transfer or a scripted interruption. */
async function run(
  world: UpdateWorld,
  file: ImageReader,
  transfer = updateTransfer(world.central, world.clock, grant(world)),
  controller = new AbortController(),
) {
  const progress: number[] = [];
  const result = await settled(
    world.clock,
    transfer.run(
      file,
      controller.signal,
      0,
      () => undefined,
      (offset) => {
        progress.push(offset);
      },
    ),
    155_000,
  );
  return { result, progress, transfer };
}

const disturbances: [string, () => Faults][] = [
  ["ordinary", () => ({})],
  ["slow board", () => ({ boardDelayMs: 67, latencyMs: 15 })],
  ["lost Get", () => ({ lose: nthFrame(TransferKind.Get, 4) })],
  ["lost Data", () => ({ lose: nthFrame(TransferKind.Data, 5) })],
  ["repeated Get", () => ({ repeat: nthFrame(TransferKind.Get, 4) })],
  ["repeated Hello", () => ({ repeat: nthFrame(TransferKind.Hello, 1) })],
  ["repeated Data", () => ({ repeat: nthFrame(TransferKind.Data, 5) })],
  ["corrupted Data", () => ({ corrupt: corruptNthData(6) })],
];

for (const [name, faults] of disturbances) {
  test(`firmware transfer from a file with ${name}`, async () => {
    const world = updateWorld({ faults: faults(), central: { maxMtu: 185 } });
    expect(offer(world)).toBe(true);
    const file = fileOf(world.image.file);
    const done = await run(world, file);
    file.close();
    expect(done.result).toEqual({ kind: "done", verified: true, reason: 0 });
    expect(done.progress.at(-1)).toBe(world.image.file.length);
    expect(
      done.progress.every((offset, i) => i === 0 || offset > (done.progress[i - 1] ?? 0)),
    ).toBe(true);
    expect(world.board.update?.record?.stage).toBe("verified");
  });
}

for (const kind of [
  TransferKind.Hello,
  TransferKind.Open,
  TransferKind.Get,
  TransferKind.Data,
] as const) {
  test(`carries on after a drop following frame ${kind}`, async () => {
    const world = updateWorld({ faults: { dropAfter: nthFrame(kind, 1) } });
    expect(offer(world)).toBe(true);
    const file = fileOf(world.image.file);
    const initial = await run(world, file);
    expect(initial.result).toEqual({ kind: "failed", fault: "lost" });
    const carried = await run(world, file, initial.transfer);
    file.close();
    expect(carried.result).toEqual({ kind: "done", verified: true, reason: 0 });
    expect(world.board.connections).toBe(2);
  });
}

for (const kind of [TransferKind.Hello, TransferKind.Open] as const) {
  test(`a lost frame ${kind} cannot start an unauthenticated transfer`, async () => {
    const world = updateWorld({ faults: { lose: nthFrame(kind, 1) } });
    expect(offer(world)).toBe(true);
    const file = fileOf(world.image.file);
    const done = await run(world, file);
    file.close();
    expect(done.result).toEqual({ kind: "failed", fault: "windowEnded" });
    expect(done.progress).toEqual([]);
    expect(world.board.update?.record).toBeUndefined();
  });
}

test("a drop at the 30-second edge cannot start another transfer", async () => {
  const world = updateWorld({ faults: { dropAfter: nthFrame(TransferKind.Data, 9) } });
  expect(offer(world)).toBe(true);
  const file = fileOf(world.image.file);
  const initial = await run(world, file);
  expect(initial.result).toEqual({ kind: "failed", fault: "lost" });
  await world.clock.advance(NO_PROGRESS_MS);
  const next = await run(world, file, initial.transfer);
  file.close();
  expect(next.result).toEqual({ kind: "failed", fault: "windowEnded" });
  expect(world.board.connections).toBe(1);
});

test("a small MTU stops the phone before any transfer starts", async () => {
  const world = updateWorld({ central: { maxMtu: 184 } });
  expect(offer(world)).toBe(true);
  const file = fileOf(world.image.file);
  const done = await run(world, file);
  file.close();
  expect(done.result).toEqual({ kind: "failed", fault: "smallMtu" });
  expect(done.progress).toEqual([]);
});

test("cancel closes the update link before completion", async () => {
  const world = updateWorld({ faults: { boardDelayMs: 250 } });
  expect(offer(world)).toBe(true);
  const file = fileOf(world.image.file);
  const controller = new AbortController();
  world.clock.after(1000, () => {
    controller.abort();
  });
  const done = await run(world, file, undefined, controller);
  file.close();
  expect(done.result).toEqual({ kind: "failed", fault: "lost" });
  expect(world.board.update?.record?.stage).not.toBe("verified");
});

test("Done can be received immediately before the board disconnects", async () => {
  const world = updateWorld({ faults: { dropAfter: nthFrame(TransferKind.Done, 1) } });
  expect(offer(world)).toBe(true);
  const file = fileOf(world.image.file);
  const done = await run(world, file);
  file.close();
  expect(done.result).toEqual({ kind: "done", verified: true, reason: 0 });
});

test("all firmware hub refusal reasons survive channel mapping", () => {
  expect(
    Object.values(FIRMWARE_BLUETOOTH_REFUSALS).map((error) => refusal({ ok: false, error })),
  ).toEqual([
    "armed",
    "lowBattery",
    "countdown",
    "alarm",
    "siteMove",
    "keyChange",
    "notPaired",
    "onTrial",
    "noImage",
  ]);
});

/** Models the numbered events while keeping the app's real file and reply validation running. */
function streamHub() {
  const client = createHubClient({
    connect: () => Promise.resolve(undefined),
    records: memoryRecordStore(),
    timers: realTimers,
    app: "test",
  });
  const taps = new Set<(event: AppEvent) => void>();
  let next = 0;
  const hub: PhoneHub = {
    client: {
      ...client,
      onEvent: (receive) => {
        taps.add(receive);
        return () => {
          taps.delete(receive);
        };
      },
    },
    forward: () => Promise.resolve({ ok: true, body: { job: ++next }, repeat: false }),
    onNewEvent: () => () => undefined,
  };
  return {
    hub,
    emit: (body: Extract<AppEvent, { ev: "fileChunk" }>["body"]) => {
      for (const receive of taps) receive({ t: "evt", ev: "fileChunk", rev: 1, body });
    },
    listeners: () => taps.size,
  };
}

/** A cache spy with the same append and seek semantics as the Expo file. */
function cacheOf(): ImageCache {
  let bytes = new Uint8Array();
  return {
    get size() {
      return bytes.length;
    },
    read: (offset, length) => bytes.subarray(offset, offset + length),
    append: (part) => {
      bytes = Uint8Array.from([...bytes, ...part]);
      return true;
    },
    remove: () => {
      bytes = new Uint8Array();
    },
  };
}

test("a restarted download compares retained bytes and verifies both hashes", async () => {
  const clock = new ManualClock();
  const image = updateWorld({ size: 272 }).image;
  const cache = cacheOf();
  const source = streamHub();
  const fileBytes = image.file.length;
  const offer = {
    fileBytes,
    sha256: toHex(image.file.subarray(16, 48)),
    imageId: toHex(image.imageId),
  };
  const data = image.file.subarray(0, 200);
  const end = { chunks: 2, sha256: createHash("sha256").update(image.file).digest("hex") };
  const start = (signal: AbortSignal) =>
    downloadImage(source.hub, offer, 1, cache, clock, signal, () => undefined);
  const first = new AbortController();
  const interrupted = start(first.signal);
  source.emit({ job: 1, n: 0, data: toBase64url(data) });
  await clock.advance(1);
  expect(cache.size).toBe(200);
  first.abort();
  expect(await interrupted).toEqual({ ok: false, fault: "cancelled" });
  expect(source.listeners()).toBe(0);
  const retried = start(new AbortController().signal);
  source.emit({ job: 2, n: 0, data: toBase64url(data) });
  source.emit({ job: 2, n: 1, data: toBase64url(image.file.subarray(200)), end });
  expect(await retried).toEqual({ ok: true, value: undefined });
  expect(cache.size).toBe(fileBytes);
  expect(source.listeners()).toBe(0);

  const corrupt = start(new AbortController().signal);
  const changed = data.slice();
  changed[140] = (changed[140] ?? 0) ^ 1;
  source.emit({ job: 3, n: 0, data: toBase64url(changed) });
  expect(await corrupt).toEqual({ ok: false, fault: "corrupt" });
  expect(source.listeners()).toBe(0);
});

/** Runs the production server with scripted notifications and observable file reads. */
function serveFromLink(overrides: Partial<BluetoothUpdate> = {}, sizeDelta = 0) {
  const world = updateWorld({ size: 512 });
  const update = { ...grant(world), ...overrides };
  const { clock } = world;
  const radio = firmwareLink();
  const reads: [number, number][] = [];
  const progress: number[] = [];
  const file = {
    size: world.image.file.length + sizeDelta,
    read(offset: number, length: number) {
      reads.push([offset, length]);
      return world.image.file.subarray(offset, offset + length);
    },
  };
  const signal = new AbortController().signal;
  const result = serveImage(
    radio.link,
    update,
    file,
    (offset) => progress.push(offset),
    clock,
    signal,
    NO_PROGRESS_MS,
  );
  const hello: HelloFrame = {
    kind: TransferKind.Hello,
    address: update.address,
    deviceRandom: new Uint8Array(DEVICE_RANDOM_LENGTH).fill(1),
    imageId: update.imageId,
    bytesHeld: 0,
    largestData: 512,
  };
  /** Sends a supported Hello and checks that it opened the connection. */
  async function open(largestData = hello.largestData) {
    expect(radio.notify({ ...hello, largestData })).toBe(true);
    await clock.advance(0);
    expect(radio.replies).toEqual([{ kind: TransferKind.Open }]);
  }
  /** Sends a Get for this connection's image. */
  function get(offset: number, length: number) {
    return radio.notify({ kind: TransferKind.Get, imageId: update.imageId, offset, length });
  }
  return { radio, clock, file, update, result, hello, get, open, reads, progress };
}

for (const [name, patch] of [
  ["Hello must name the granted address", { address: 1 }],
  ["Hello must name the granted image", { imageId: new Uint8Array(8).fill(42) }],
  ["Hello cannot claim bytes beyond the image", { bytesHeld: 641 }],
] as const) {
  test(name, async () => {
    const { radio, clock, result, hello } = serveFromLink();
    expect(radio.notify({ ...hello, ...patch })).toBe(true);
    await clock.advance(0);
    expect(radio.replies).toEqual([]);
    expect(await settled(clock, result, 0)).toEqual({ ok: false, fault: "protocol" });
    expect(radio.closed()).toBe(true);
  });
}

for (const [name, largestData, range] of [
  ["Get must fit the link payload", 512, [0, bluetoothMaxData(185) + 1]],
  ["Get must fit the board payload", 32, [0, 33]],
  ["Get must end inside the file", 512, [639, 2]],
] as const) {
  test(name, async () => {
    const { radio, clock, get, open, reads } = serveFromLink();
    await open(largestData);
    expect(get(range[0], range[1])).toBe(true);
    await clock.advance(0);
    expect(radio.replies.slice(1)).toEqual([
      { kind: TransferKind.Gone, reason: GoneReason.OutOfRange },
    ]);
    expect(reads).toEqual([]);
  });
}

test("a Get before Open cannot read or send firmware", async () => {
  const { radio, clock, get, reads, progress } = serveFromLink();
  expect(get(0, 32)).toBe(true);
  await clock.advance(0);
  expect(radio.replies).toEqual([]);
  expect(reads).toEqual([]);
  expect(progress).toEqual([]);
});

test("serving new bytes moves the idle deadline", async () => {
  const { radio, clock, result, get, open, progress } = serveFromLink();
  await open();
  await clock.advance(NO_PROGRESS_MS - 1);
  expect(get(0, 32)).toBe(true);
  await clock.advance(NO_PROGRESS_MS - 1);
  expect(progress).toEqual([32]);
  expect(radio.closed()).toBe(false);
  await clock.advance(1);
  expect(await settled(clock, result, 0)).toEqual({ ok: false, fault: "windowEnded" });
  expect(radio.closed()).toBe(true);
});

test("a file of the wrong size cannot start serving", async () => {
  const { radio, clock, result } = serveFromLink({}, -1);
  expect(radio.watches()).toBe(0);
  expect(await settled(clock, result, 0)).toEqual({ ok: false, fault: "protocol" });
  expect(radio.closed()).toBe(true);
});

test("an expired grant closes before subscribing", async () => {
  const { radio, clock, result } = serveFromLink({ expiresAtMs: 0 });
  expect(radio.watches()).toBe(0);
  expect(radio.closed()).toBe(true);
  expect(await settled(clock, result, 0)).toEqual({ ok: false, fault: "expired" });
});

test("a refused Done cannot become a verified update", async () => {
  const { radio, clock, result, update, open } = serveFromLink();
  await open();
  expect(
    radio.notify({
      kind: TransferKind.Done,
      imageId: update.imageId,
      result: TransferResult.Refused,
      reason: UpdateReason.HashMismatch,
    }),
  ).toBe(true);
  expect(await settled(clock, result, 0)).toEqual({
    ok: true,
    value: { verified: false, reason: UpdateReason.HashMismatch },
  });
});

/** Starts a fresh hub stream with a real fixture image and a manual chunk clock. */
function streamedImage(cache = cacheOf()) {
  const clock = new ManualClock();
  const image = updateWorld({ size: 272 }).image;
  const source = streamHub();
  const bytes = image.file;
  const grant = {
    fileBytes: bytes.length,
    sha256: toHex(bytes.subarray(16, 48)),
    imageId: toHex(image.imageId),
  };
  const result = downloadImage(
    source.hub,
    grant,
    1,
    cache,
    clock,
    new AbortController().signal,
    () => undefined,
  );
  /** Delivers a numbered chunk to the active job and optionally terminates it. */
  function chunk(n: number, data: Uint8Array, end?: { chunks: number; sha256: string }) {
    source.emit({ job: 1, n, data: toBase64url(data), ...(end === undefined ? {} : { end }) });
  }
  return { bytes, cache, clock, result, chunk, source };
}

/** Computes a file digest independently of the download's implementation. */
function fileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

for (const [name, flipAt] of [
  ["the header digest must match the grant", 16],
  ["the payload digest must match the grant", 128],
  ["the file digest must match the stream", undefined],
] as const) {
  test(name, async () => {
    const { bytes, chunk, result } = streamedImage();
    const delivered = bytes.slice();
    if (flipAt !== undefined) delivered[flipAt] = (delivered[flipAt] ?? 0) ^ 1;
    chunk(0, delivered, {
      chunks: 1,
      sha256: flipAt === undefined ? "00".repeat(32) : fileHash(delivered),
    });
    expect(await result).toEqual({ ok: false, fault: "corrupt" });
  });
}

test("a skipped chunk number interrupts the download", async () => {
  const { bytes, chunk, result } = streamedImage();
  chunk(1, bytes, { chunks: 1, sha256: fileHash(bytes) });
  expect(await result).toEqual({ ok: false, fault: "interrupted" });
});

test("a chunk from another job never reaches the cache", async () => {
  const { bytes, cache, clock, chunk, result, source } = streamedImage();
  source.emit({ job: 2, n: 0, data: toBase64url(bytes.subarray(0, 32)) });
  await clock.advance(0);
  expect(cache.size).toBe(0);
  chunk(0, bytes, { chunks: 1, sha256: fileHash(bytes) });
  expect(await result).toEqual({ ok: true, value: undefined });
});

test("the end must report the number of chunks received", async () => {
  const { bytes, chunk, result } = streamedImage();
  chunk(0, bytes, { chunks: 2, sha256: fileHash(bytes) });
  expect(await result).toEqual({ ok: false, fault: "corrupt" });
});

test("a retained file cannot hide a short stream", async () => {
  const { bytes, cache, chunk, result } = streamedImage();
  expect(cache.append(bytes)).toBe(true);
  chunk(0, bytes.subarray(0, -1), { chunks: 1, sha256: fileHash(bytes) });
  expect(await result).toEqual({ ok: false, fault: "corrupt" });
});

test("a chunk past the grant size is refused before appending", async () => {
  const { bytes, cache, clock, chunk, result } = streamedImage();
  chunk(0, new Uint8Array(bytes.length + 1));
  await clock.advance(0);
  expect(cache.size).toBe(0);
  expect(await settled(clock, result, 0)).toEqual({ ok: false, fault: "corrupt" });
});

test("silence times out 15 seconds after the last chunk", async () => {
  const { bytes, clock, chunk, result, source } = streamedImage();
  await clock.advance(5000);
  chunk(0, bytes.subarray(0, 32));
  await clock.advance(14_999);
  expect(source.listeners()).toBe(1);
  await clock.advance(1);
  expect(await settled(clock, result, 0)).toEqual({ ok: false, fault: "interrupted" });
  expect(source.listeners()).toBe(0);
});

test("a grant must decode to a 32-byte session key", () => {
  const { clock, session, image } = updateWorld({ size: 272 });
  const offer: BluetoothSessionObject = {
    device: 1,
    address: session.address,
    imageId: toHex(session.imageId),
    version: "1.4.0",
    fileBytes: image.file.length,
    sha256: toHex(image.file.subarray(16, 48)),
    sessionKey: toBase64url(session.sessionKey),
    windowS: 120,
    expiresInMs: 120_000,
    needsWake: true,
  };
  expect(updateGrant(offer, clock) !== undefined).toBe(true);
  expect(
    updateGrant({ ...offer, sessionKey: toBase64url(new Uint8Array(31)) }, clock) === undefined,
  ).toBe(true);
});

test("a connection completing at the scan deadline cannot start serving", async () => {
  const world = updateWorld({ size: 272 });
  const { clock } = world;
  const update = { ...grant(world), windowS: 10 };
  const radio = firmwareLink();
  const central: BleCentral = {
    state: () => Promise.resolve("on"),
    scan(_service, found) {
      found({
        id: "sensor",
        name: bluetoothUpdateName(update.address),
        rssi: -60,
        serviceData: null,
      });
      return () => undefined;
    },
    connect: () =>
      new Promise((resolve) => {
        clock.after(10_000, () => {
          resolve({ ok: true, value: radio.link });
        });
      }),
  };
  const result = updateTransfer(central, clock, update).run(
    { size: update.fileBytes, read: () => undefined },
    new AbortController().signal,
    0,
    () => undefined,
    () => undefined,
  );
  expect(await settled(clock, result, 10_000)).toEqual({ kind: "failed", fault: "windowEnded" });
  expect(radio.closed()).toBe(true);
  expect(radio.watches()).toBe(0);
});

test("a phone dropped before Open may reconnect for as long as the sensor's window still advertises", async () => {
  // The link drops as the first Hello reaches the phone: the sensor never received an Open, so it
  // has not opened the session and goes back to advertising for the rest of its window (120 s,
  // update_session.cpp `poll_session`: the no-progress rule applies only once a phone has opened).
  const world = updateWorld({ faults: { dropAfter: nthFrame(TransferKind.Hello, 1) } });
  expect(offer(world)).toBe(true);
  const file = fileOf(world.image.file);
  const initial = await run(world, file);
  expect(initial.result).toEqual({ kind: "failed", fault: "lost" });
  // Before Open the resume runs to the window's end the first attempt allowed, not 30 s.
  expect(initial.transfer.resumeUntil()).toBe(120_000);
  // The person walks closer and taps "Carry on" a little over 30 s later, well inside the window.
  await world.clock.advance(NO_PROGRESS_MS + 1000);
  expect(world.board.update?.session).toBe("advertising");
  const carried = await run(world, file, initial.transfer);
  file.close();
  expect(carried.result).toEqual({ kind: "done", verified: true, reason: 0 });
  expect(world.board.connections).toBe(2);
});

test("before Open the phone stops trying at the window's end, and never past the grant's expiry", async () => {
  const world = updateWorld({ faults: { dropAfter: nthFrame(TransferKind.Hello, 1) } });
  expect(offer(world)).toBe(true);
  const file = fileOf(world.image.file);
  const initial = await run(world, file);
  expect(initial.result).toEqual({ kind: "failed", fault: "lost" });
  await world.clock.advance(120_000 - world.clock.now());
  expect(initial.transfer.resumeUntil()).toBe(world.clock.now());
  const late = await run(world, file, initial.transfer);
  expect(late.result).toEqual({ kind: "failed", fault: "windowEnded" });
  expect(world.board.connections).toBe(1);

  const short = updateWorld({ faults: { dropAfter: nthFrame(TransferKind.Hello, 1) } });
  expect(offer(short)).toBe(true);
  const transfer = updateTransfer(short.central, short.clock, {
    ...grant(short),
    expiresAtMs: 50_000,
  });
  const dropped = await run(short, file, transfer);
  expect(dropped.result).toEqual({ kind: "failed", fault: "lost" });
  expect(transfer.resumeUntil()).toBe(50_000);
  file.close();
});

test("once the sensor has accepted Open, the resume deadline is 30 s after its last progress", async () => {
  const world = updateWorld({
    faults: { dropAfter: nthFrame(TransferKind.Data, 3), latencyMs: 20 },
  });
  expect(offer(world)).toBe(true);
  const file = fileOf(world.image.file);
  let connectedAt = -1;
  let lastServedAt = -1;
  const transfer = updateTransfer(world.central, world.clock, grant(world));
  const result = await settled(
    world.clock,
    transfer.run(
      file,
      new AbortController().signal,
      0,
      () => {
        connectedAt = world.clock.now();
      },
      () => {
        lastServedAt = world.clock.now();
      },
    ),
    155_000,
  );
  file.close();
  expect(result).toEqual({ kind: "failed", fault: "lost" });
  expect(connectedAt).toBeGreaterThanOrEqual(0);
  expect(lastServedAt).toBeGreaterThan(connectedAt);
  expect(transfer.resumeUntil()).toBe(lastServedAt + NO_PROGRESS_MS);
});

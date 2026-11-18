/** W1's Win32 calls and worker exchange; the test supplies a serial driver on every host. */
import { describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { ok } from "neverthrow";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { linkId, sendRef } from "../../../src/core/model/ids.ts";
import { LinkRegistry } from "../../../src/shell/links/registry.ts";
import { SerialLinks } from "../../../src/shell/links/serial.ts";
import type { WindowsSerialCalls } from "../../../src/shell/safe/ffi-windows-serial.ts";
import {
  byteCleanMismatch,
  devicePath,
  newDcb,
  newOverlapped,
  serialTimeouts,
  setByteClean,
} from "../../../src/shell/safe/serial-windows-layout.ts";
import { openWindowsSerial } from "../../../src/shell/safe/serial-windows.ts";
import {
  DRAINED,
  FIRST_BYTE,
  GATE,
  READS,
  STOP,
  WAKE,
  WRITE,
  WRITES,
  type FakeMode,
} from "./serial-windows-mock-worker.ts";

type Failure =
  | "open"
  | "GetCommState"
  | "SetCommState"
  | "GetCommState read-back"
  | "read-back"
  | "SetCommTimeouts"
  | "PurgeComm";

/** Open/configure doubles observe the bytes handed to Win32 in call order. */
function windows(fail?: Failure, code = 5, shared?: Int32Array) {
  const operations: string[] = [];
  const settings = newDcb();
  const calls: WindowsSerialCalls = {
    CreateFileW: (name, access, share, security, disposition, flags, template) => {
      operations.push("CreateFileW");
      expect(name instanceof Uint16Array ? String.fromCharCode(...name) : "").toBe(
        "\\\\.\\COM10\0",
      );
      expect([access, share, security, disposition, flags, template]).toEqual([
        0xc000_0000,
        0,
        null,
        3,
        0x4000_0000,
        0n,
      ]);
      return fail === "open" ? -1n : 10n;
    },
    GetCommState: (handle, target) => {
      operations.push("GetCommState");
      expect(handle).toBe(10n);
      const call = operations.length > 2 ? "GetCommState read-back" : "GetCommState";
      if (!(target instanceof Uint8Array) || fail === call) return 0;
      target.set(settings);
      if (fail === "read-back" && operations.length > 2) target[18] = 7;
      return 1;
    },
    SetCommState: (_handle, dcb) => {
      operations.push("SetCommState");
      if (!(dcb instanceof Uint8Array) || fail === "SetCommState") return 0;
      settings.set(dcb);
      return 1;
    },
    SetCommTimeouts: (_handle, timeouts) => {
      operations.push("SetCommTimeouts");
      expect(timeouts).toEqual(Uint32Array.of(0xffff_ffff, 0xffff_ffff, 500, 0, 500));
      return fail === "SetCommTimeouts" ? 0 : 1;
    },
    PurgeComm: (_handle, flags) => {
      operations.push("PurgeComm");
      expect(flags).toBe(0x0f);
      return fail === "PurgeComm" ? 0 : 1;
    },
    ReadFileEx: () => 0,
    WriteFileEx: () => 0,
    WaitForMultipleObjectsEx: () => 0,
    CancelIoEx: () => 0,
    SleepEx: () => 0,
    CreateEventW: (_attributes, manual, initial, name) => {
      expect([_attributes, initial, name]).toEqual([null, 0, null]);
      operations.push(manual === 1 ? "stop event" : "write event");
      return manual === 1 ? 11n : 12n;
    },
    SetEvent: (event) => {
      if (shared === undefined) return 0;
      Atomics.or(shared, WAKE, event === 11n ? STOP : WRITE);
      Atomics.notify(shared, WAKE);
      return 1;
    },
    CloseHandle: (handle) => {
      operations.push(handle === 10n ? "CloseHandle" : `close event ${handle}`);
      return 1;
    },
    GetLastError: () => code,
  };
  return { calls, operations };
}

/** Waits for a data or error message sent by the worker. */
async function until(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(1);
  return check();
}

/** Opens COM10 with native-call doubles and the actual message loop in a worker. */
function fakePort(mode: FakeMode) {
  const shared = new Int32Array(new SharedArrayBuffer(6 * 4));
  const { calls, operations } = windows(undefined, 5, shared);
  const port = openWindowsSerial("COM10", {
    system: calls,
    startWorker: (job, stopping) => {
      expect(job.kind).toBe("port");
      return new Worker(new URL("./serial-windows-mock-worker.ts", import.meta.url), {
        workerData: { ...job, stopping, mode, shared },
        transferList: job.kind === "port" ? [job.incoming] : [],
      });
    },
  })._unsafeUnwrap();
  let ready = false;
  port.stream.on("ready", () => {
    ready = true;
  });
  const received: Uint8Array[] = [];
  const errors: string[] = [];
  port.stream.on("data", (bytes: Uint8Array) => {
    received.push(bytes);
  });
  port.stream.on("error", (error: { message: string }) => {
    errors.push(error.message);
  });
  return { port, shared, received, errors, operations, ready: () => ready };
}

// Aim for 5 ms. Leave 5 ms for local cross-thread scheduling and more on the hosted Windows VM.
const wakeBudgetMs = process.platform === "win32" ? 50 : 10;

describe("the Windows COM adapter", () => {
  test("DCB fields and timeouts match the documented byte layouts", () => {
    const settings = newDcb();
    // Microsoft's DCB declaration: length and baud DWORDs at 0 and 4; DWORD bit-fields
    // at 8; three WORDs at 12, 14 and 16; ByteSize, Parity and StopBits at 18–20;
    // five chars at 21–25 and the final WORD at 26.
    new DataView(settings.buffer).setUint32(4, 115_200, true);
    settings.fill(255, 8, 12);
    setByteClean(settings);
    expect(Buffer.from(settings).toString("hex")).toBe(
      "1c00000000c201000100000000000000000008000000000000000000",
    );
    expect(byteCleanMismatch(settings)).toBeUndefined();
    // DCB bit positions are taken from winbase.h in declaration order.
    for (const [name, bit, actual, expected] of [
      ["fBinary", 0, 0, 1],
      ["fParity", 1, 1, 0],
      ["fOutxCtsFlow", 2, 1, 0],
      ["fOutxDsrFlow", 3, 1, 0],
      ["fDtrControl", 5, 2, 0],
      ["fDsrSensitivity", 6, 1, 0],
      ["fOutX", 8, 1, 0],
      ["fInX", 9, 1, 0],
      ["fErrorChar", 10, 1, 0],
      ["fNull", 11, 1, 0],
      ["fRtsControl", 13, 2, 0],
      ["fAbortOnError", 14, 1, 0],
    ] as const) {
      const changed = settings.slice();
      new DataView(changed.buffer).setUint32(8, 1 ^ (1 << bit), true);
      expect(byteCleanMismatch(changed)).toBe(`${name} reported ${actual}, expected ${expected}`);
    }
    for (const [name, offset, expected] of [
      ["ByteSize", 18, 8],
      ["Parity", 19, 0],
      ["StopBits", 20, 0],
    ] as const) {
      const changed = settings.slice();
      changed[offset] = 17;
      expect(byteCleanMismatch(changed)).toBe(`${name} reported 17, expected ${expected}`);
    }
    new DataView(settings.buffer).setUint32(8, 0xffff_8081, true);
    expect(byteCleanMismatch(settings)).toBeUndefined();
    setByteClean(settings, { dtr: true, rts: true });
    expect(new DataView(settings.buffer).getUint32(8, true)).toBe(0x1011);
    expect(byteCleanMismatch(settings, { dtr: true, rts: true })).toBeUndefined();
    expect(Buffer.from(serialTimeouts().buffer).toString("hex")).toBe(
      "fffffffffffffffff401000000000000f4010000",
    );
  });

  test("single-digit, high and already prefixed COM names", () => {
    expect(devicePath("COM0")).toBeUndefined();
    expect(devicePath("COM1")).toBe("\\\\.\\COM1");
    expect(devicePath("com10")).toBe("\\\\.\\COM10");
    expect(devicePath("\\\\.\\COM12")).toBe("\\\\.\\COM12");
    expect(devicePath("\\\\.\\PhysicalDrive0")).toBeUndefined();
  });

  test.each([
    ["access denied", 5],
    ["file not found", 2],
    ["sharing violation", 32],
  ] as const)("open fails with %s and nothing to release", (_reason, code) => {
    const { calls, operations } = windows("open", code);
    const refused = openWindowsSerial("COM10", { system: calls });
    expect(refused._unsafeUnwrapErr().message).toContain(`CreateFileW failed (Win32 ${code})`);
    expect(operations).toEqual(["CreateFileW"]);
  });

  test.each([
    ["GetCommState", "GetCommState failed", "GetCommState"],
    ["SetCommState", "SetCommState failed", "SetCommState"],
    ["GetCommState read-back", "GetCommState read-back failed", "GetCommState"],
    ["read-back", "not byte-clean", "GetCommState"],
    ["SetCommTimeouts", "SetCommTimeouts failed", "SetCommTimeouts"],
    ["PurgeComm", "PurgeComm failed", "PurgeComm"],
  ] as const)("%s failure closes the handle before a worker can start", (fault, message, last) => {
    const { calls, operations } = windows(fault);
    const result = openWindowsSerial("COM10", { system: calls });
    expect(result._unsafeUnwrapErr().message).toContain(message);
    expect(operations.slice(-2)).toEqual([last, "CloseHandle"]);
    expect(operations.filter((name) => name === "CloseHandle")).toHaveLength(1);
  });

  test("open order and all 256 bytes independently through the actual worker both ways", async () => {
    const { port, received, operations } = fakePort("echo");
    const inbound = Uint8Array.from({ length: 256 }, (_, i) => i);
    const outbound = Uint8Array.from({ length: 256 }, (_, i) => 255 - i);
    const ready = await until(() => received.length > 0);
    const sent = await port.write(outbound);
    const echoed = await until(() => received.length > 1);
    port.close();
    await port.closed;
    expect(ready && echoed && sent.isOk()).toBe(true);
    expect(received).toEqual([Buffer.from(inbound), Buffer.from(outbound)]);
    expect(operations).toEqual([
      "CreateFileW",
      "GetCommState",
      "SetCommState",
      "GetCommState",
      "SetCommTimeouts",
      "PurgeComm",
      "stop event",
      "write event",
      "CloseHandle",
      "close event 11",
      "close event 12",
    ]);
  });

  test("a failed read after data tears down the worker and frees the port", async () => {
    const { port, received, errors, operations } = fakePort("unplug");
    await port.closed;
    expect(await until(() => errors.length > 0)).toBe(true);
    expect(received).toHaveLength(1);
    expect(errors[0]).toContain("ReadFileEx failed (Win32 1167)");
    expect(operations.slice(-3)).toEqual(["CloseHandle", "close event 11", "close event 12"]);
  });

  test.each([
    ["partial", "WriteFileEx sent 2 of 3 bytes"],
    ["write-error", "WriteFileEx failed (Win32 1167)"],
  ] as const)("%s reports a write failure and releases the handle", async (mode, message) => {
    const { port, operations } = fakePort(mode);
    const sent = await port.write(Uint8Array.of(1, 2, 3));
    await port.closed;
    expect(sent._unsafeUnwrapErr().message).toContain(message);
    expect(operations.slice(-3)).toEqual(["CloseHandle", "close event 11", "close event 12"]);
  });

  test("close twice during a pending read releases once and consumes no further bytes", async () => {
    const { port, shared, received, operations } = fakePort("waiting");
    const reading = await until(() => Atomics.load(shared, READS) === 1);
    const started = performance.now();
    port.close();
    port.close();
    await port.closed;
    const elapsed = performance.now() - started;
    console.log(`COM double: pending read to released handle ${elapsed.toFixed(3)} ms`);
    expect(reading).toBe(true);
    expect(elapsed).toBeLessThan(wakeBudgetMs);
    expect(Atomics.load(shared, READS)).toBe(1);
    expect(Atomics.load(shared, DRAINED)).toBe(2);
    expect(received).toEqual([]);
    expect(operations.filter((name) => name === "CloseHandle")).toHaveLength(1);
  });

  test("OVERLAPPED x64 starts with the documented zero fields", () => {
    const bytes = newOverlapped();
    expect(bytes).toHaveLength(32);
    // Internal at 0, InternalHigh at 8, Offset/OffsetHigh at 16/20, hEvent at 24.
    expect(Buffer.from(bytes).toString("hex")).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  test.each([
    ["waiting", READS],
    ["before-read", GATE],
    ["after-read", GATE],
  ] as const)("a write wakes the worker %s", async (mode, phase) => {
    const { port, shared } = fakePort(mode);
    const reached = await until(() => Atomics.load(shared, phase) > 0);
    const started = performance.now();
    const sent = await port.write(Uint8Array.of(1, 2, 3));
    const elapsed = performance.now() - started;
    port.close();
    await port.closed;
    console.log(`COM double: ${mode} write through completion ${elapsed.toFixed(3)} ms`);
    expect(reached && sent.isOk()).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(wakeBudgetMs);
  });

  test("a second write wakes the same pending read without waiting for its timeout", async () => {
    const { port, shared } = fakePort("waiting");
    const reading = await until(() => Atomics.load(shared, READS) > 0);
    const delays: number[] = [];
    const outcomes = [];
    for (let index = 0; index < 2; index++) {
      const asked = performance.now();
      outcomes.push((await port.write(Uint8Array.of(index, 1, 2))).isOk());
      delays.push(performance.now() - asked);
    }
    port.close();
    await port.closed;
    console.log(
      `COM double: back-to-back write through completion ${delays.map((ms) => ms.toFixed(3)).join(", ")} ms`,
    );
    expect(reading && outcomes.every(Boolean)).toBe(true);
    expect(Atomics.load(shared, READS)).toBe(1);
    for (const ms of delays) {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(wakeBudgetMs);
    }
  });

  test("stop wins over an already queued write when the read is about to start", async () => {
    const { port, shared } = fakePort("close-race");
    const reached = await until(() => Atomics.load(shared, GATE) > 0);
    const pending = port.write(Uint8Array.of(1, 2, 3));
    port.close();
    Atomics.store(shared, GATE, 2);
    Atomics.notify(shared, GATE);
    const result = await pending;
    await port.closed;
    expect(reached).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("closed");
    expect(Atomics.load(shared, WRITES)).toBe(0);
    expect(Atomics.load(shared, DRAINED)).toBe(2);
  });

  test("the parent drops a data message already in flight when the port stops", async () => {
    const { port, ready, received } = fakePort("late-data");
    const started = await until(ready);
    port.close();
    await port.closed;
    expect(started).toBe(true);
    expect(received).toEqual([]);
  });
});

/** Runs the framed link over a succession of real workers with doubled serial devices. */
function recoveringLink(second: FakeMode) {
  const registry = new LinkRegistry();
  const events: HubEvent[] = [];
  const ports: ReturnType<typeof fakePort>[] = [];
  registry.listen((event) => {
    events.push(event);
  });
  const links = new SerialLinks(registry, (path) => {
    expect(path).toBe("COM10");
    if (ports.length > 0) expect(ports.at(-1)?.operations).toContain("CloseHandle");
    const opened = fakePort(ports.length === 0 ? "partial" : second);
    ports.push(opened);
    const { port } = opened;
    return ok({
      path,
      stream: port.stream,
      write: (bytes) => port.write(bytes),
      close: () => {
        port.close();
        return ok(undefined);
      },
      closed: port.closed,
    });
  });
  const first = links.open("COM10")._unsafeUnwrap();
  return { registry, links, events, ports, first };
}

test("a timed-out serial write reports every queued frame and reopens once on a fresh link", async () => {
  const { registry, links, first, ports, events } = recoveringLink("loopback");
  for (const index of [1, 2, 3])
    expect(registry.send(first, Uint8Array.of(7, index), sendRef(index)).isOk()).toBe(true);
  const second = linkId(2);
  const reopened = await until(() => registry.isOpen(second));
  expect(registry.send(first, Uint8Array.of(1), sendRef(4))._unsafeUnwrapErr().code).toBe("closed");
  const firstEvents = events.slice();
  const next = Uint8Array.of(8, 9);
  const sent = registry.send(second, next, sendRef(5));
  const delivered = await until(() => events.some((event) => event.kind === "frame"));
  await links.closeAsyncPorts();
  expect(reopened && sent.isOk() && delivered).toBe(true);
  expect(firstEvents).toEqual([
    { kind: "linkOpened", link: first, linkKind: "usb", label: "COM10" },
    { kind: "sendFailed", link: first, ref: sendRef(1), error: "writeFailed" },
    { kind: "sendFailed", link: first, ref: sendRef(2), error: "writeFailed" },
    { kind: "sendFailed", link: first, ref: sendRef(3), error: "writeFailed" },
    { kind: "linkClosed", link: first, reason: "error" },
    { kind: "linkOpened", link: second, linkKind: "usb", label: "COM10" },
  ]);
  expect(ports).toHaveLength(2);
  expect(ports[1]?.shared[FIRST_BYTE]).toBe(0);
  expect(events.filter((event) => event.kind === "frame")).toEqual([
    { kind: "frame", link: second, bytes: next },
  ]);
});

test("a second write failure before receiving a frame waits for a device notification", async () => {
  const { registry, links, first, ports, events } = recoveringLink("partial");
  registry.send(first, Uint8Array.of(7, 1), sendRef(1))._unsafeUnwrap();
  const second = linkId(2);
  const reopened = await until(() => registry.isOpen(second));
  registry.send(second, Uint8Array.of(7, 2), sendRef(2))._unsafeUnwrap();
  const closed = await until(() => !registry.isOpen(second));
  expect(reopened && closed).toBe(true);
  expect(ports).toHaveLength(2);
  expect(events.at(-1)).toEqual({ kind: "linkClosed", link: second, reason: "error" });
  links.open("COM10")._unsafeUnwrap();
  expect(registry.isOpen(linkId(3))).toBe(true);
  await links.closeAsyncPorts();
});

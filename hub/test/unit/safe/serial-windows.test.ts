/** W1's Win32 calls and worker exchange; the test supplies a serial driver on every host. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ok } from "neverthrow";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { linkId, sendRef } from "../../../src/core/model/ids.ts";
import { LinkRegistry } from "../../../src/shell/links/registry.ts";
import { SerialLinks } from "../../../src/shell/links/serial.ts";
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
  WRITES,
  type FakeMode,
} from "./serial-windows-mock-worker.ts";
import { expectClosed, fakePort, until, windows } from "./serial-windows-doubles.ts";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
/** The timed tests, in a process of their own (`serial-windows-timing.child.test.ts`). */
const TIMING_CHILD = join(import.meta.dir, "serial-windows-timing.child.test.ts");
/** Its tests: the close twice, a write's wake in four phases, two writes back to back. */
const TIMED_TESTS = 6;

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

  test("the timed wakes (a close during a pending read, a write through its completion), in a process that holds only them", async () => {
    // The whole test run's heap has its own collections pause this thread 20 to 30 ms on the
    // hosted runners (JSC's collection log, run 44931950021), across a 2 to 3 ms timed close: the
    // timed tests run in a child process of their own, with their budgets as they are.
    const child = Bun.spawn([process.execPath, "test", TIMING_CHILD], {
      cwd: REPO,
      env: { ...process.env, HSN_SERIAL_TIMING_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const lines = `${out}\n${err}`.split("\n").map((line) => line.trim());
    for (const line of lines) if (line.startsWith("COM double:")) console.log(line);
    expect({
      code,
      failed: lines.filter((line) => line.startsWith("(fail)")),
      passed: lines.find((line) => /^\d+ pass$/u.test(line)),
    }).toEqual({ code: 0, failed: [], passed: `${TIMED_TESTS} pass` });
  }, 60_000);

  test.each([
    ["cancel-failed", ["COM10: CancelIoEx failed (Win32 1167)"]],
    ["cancel-not-found", []],
  ] as const)("%s still drains the queued completion and closes once", async (mode, expected) => {
    const { port, shared, errors, operations, ready } = fakePort(mode);
    const reading = await until(ready);
    port.close();
    await expectClosed(shared, port.closed);
    expect(reading).toBe(true);
    expect(Atomics.load(shared, DRAINED)).toBe(2);
    expect(operations.filter((name) => name === "CloseHandle")).toHaveLength(1);
    expect(errors).toEqual([...expected]);
  });

  test("OVERLAPPED x64 starts with the documented zero fields", () => {
    const bytes = newOverlapped();
    expect(bytes).toHaveLength(32);
    // Internal at 0, InternalHigh at 8, Offset/OffsetHigh at 16/20, hEvent at 24.
    expect(Buffer.from(bytes).toString("hex")).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  test("stop wins over an already queued write when the read is about to start", async () => {
    const { port, shared } = fakePort("close-race");
    const reached = await until(() => Atomics.load(shared, GATE) > 0);
    const pending = port.write(Uint8Array.of(1, 2, 3));
    port.close();
    Atomics.store(shared, GATE, 2);
    Atomics.notify(shared, GATE);
    await expectClosed(shared, port.closed);
    const result = await pending;
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
function recoveringLink(second: FakeMode, initial: FakeMode = "partial") {
  const registry = new LinkRegistry();
  const events: HubEvent[] = [];
  const ports: ReturnType<typeof fakePort>[] = [];
  const errors: string[] = [];
  registry.listen((event) => {
    events.push(event);
  });
  const links = new SerialLinks(
    registry,
    (path) => {
      expect(path).toBe("COM10");
      if (ports.length > 0) expect(ports.at(-1)?.operations).toContain("CloseHandle");
      const opened = fakePort(ports.length === 0 ? initial : second);
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
    },
    (error) => {
      errors.push(error.message);
    },
  );
  const first = links.open("COM10")._unsafeUnwrap();
  return { registry, links, events, ports, first, errors };
}

test("a driver that never completes either request still lets the hub close and reports why", async () => {
  const { registry, links, first, ports, errors } = recoveringLink("loopback", "no-completion");
  const [opened] = ports;
  expect(opened).toBeDefined();
  if (opened === undefined) return;
  registry.send(first, Uint8Array.of(7, 1), sendRef(1))._unsafeUnwrap();
  const writing = await until(() => Atomics.load(opened.shared, WRITES) === 1);
  const started = performance.now();
  await expectClosed(opened.shared, links.closeAsyncPorts());
  const elapsed = performance.now() - started;
  expect(writing).toBe(true);
  expect(elapsed).toBeGreaterThanOrEqual(995);
  expect(Atomics.load(opened.shared, READS)).toBe(1);
  expect(Atomics.load(opened.shared, DRAINED)).toBe(1);
  expect(errors).toEqual(["COM10: serial I/O drain timed out after 1000 ms"]);
  expect(opened.operations.filter((name) => name === "CloseHandle")).toHaveLength(1);
  expect(ports).toHaveLength(1);
}, 6000);

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

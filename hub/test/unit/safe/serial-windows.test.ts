/** W1's Win32 calls and worker exchange; the test supplies a serial driver on every host. */
import { describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import type { WindowsSerialCalls } from "../../../src/shell/safe/ffi-windows-serial.ts";
import {
  devicePath,
  isByteClean,
  newDcb,
  serialTimeouts,
  setByteClean,
} from "../../../src/shell/safe/serial-windows-layout.ts";
import { openWindowsSerial } from "../../../src/shell/safe/serial-windows.ts";

type Failure =
  | "open"
  | "GetCommState"
  | "SetCommState"
  | "GetCommState read-back"
  | "read-back"
  | "SetCommTimeouts"
  | "PurgeComm";

/** Open/configure doubles observe the bytes handed to Win32 in call order. */
function windows(fail?: Failure, code = 5) {
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
        0,
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
    ReadFile: () => 0,
    WriteFile: () => 0,
    CloseHandle: (handle) => {
      expect(handle).toBe(10n);
      operations.push("CloseHandle");
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
function fakePort(mode: "echo" | "unplug" | "partial" | "waiting") {
  const { calls, operations } = windows();
  const shared = new Int32Array(new SharedArrayBuffer(8));
  const port = openWindowsSerial(
    "COM10",
    calls,
    (_job, stopping) =>
      new Worker(new URL("./serial-windows-mock-worker.ts", import.meta.url), {
        workerData: { mode, stopping, shared },
      }),
  )._unsafeUnwrap();
  const received: Uint8Array[] = [];
  const errors: string[] = [];
  port.stream.on("data", (bytes: Uint8Array) => {
    received.push(bytes);
  });
  port.stream.on("error", (error: { message: string }) => {
    errors.push(error.message);
  });
  return { port, shared, received, errors, operations };
}

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
    expect(isByteClean(settings)).toBe(true);
    for (const offset of [8, 9, 10, 11, 18, 19, 20]) {
      const changed = settings.slice();
      changed[offset] = (changed[offset] ?? 0) ^ 0x10;
      expect(isByteClean(changed)).toBe(false);
    }
    expect(Buffer.from(serialTimeouts().buffer).toString("hex")).toBe(
      "fffffffffffffffff401000000000000f4010000",
    );
  });

  test("single-digit, high and already prefixed COM names", () => {
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
    const refused = openWindowsSerial("COM10", calls);
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
    const result = openWindowsSerial("COM10", calls);
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
      "CloseHandle",
    ]);
  });

  test("a failed read after data tears down the worker and frees the port", async () => {
    const { port, received, errors, operations } = fakePort("unplug");
    await port.closed;
    expect(await until(() => errors.length > 0)).toBe(true);
    expect(received).toHaveLength(1);
    expect(errors[0]).toContain("ReadFile failed (Win32 1167)");
    expect(operations.at(-1)).toBe("CloseHandle");
  });

  test("a partial write reports failure and releases the handle", async () => {
    const { port, operations } = fakePort("partial");
    const sent = await port.write(Uint8Array.of(1, 2, 3));
    await port.closed;
    expect(sent._unsafeUnwrapErr().message).toContain("WriteFile sent 2 of 3 bytes");
    expect(operations.at(-1)).toBe("CloseHandle");
  });

  test("close twice during a pending read releases once and consumes no further bytes", async () => {
    const { port, shared, received, operations } = fakePort("waiting");
    const reading = await until(() => Atomics.load(shared, 0) === 1);
    port.close();
    port.close();
    Atomics.store(shared, 1, 1);
    Atomics.notify(shared, 1);
    await port.closed;
    expect(reading).toBe(true);
    expect(Atomics.load(shared, 0)).toBe(1);
    expect(received).toEqual([]);
    expect(operations.filter((name) => name === "CloseHandle")).toHaveLength(1);
  });
});

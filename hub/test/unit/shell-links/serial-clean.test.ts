/**
 * A serial link is byte-clean (hub-design.md section 3; protocol.md §10): on a pseudo-terminal
 * left as a new one is (canonical input, echo, output processing, start/stop flow control: as a
 * USB serial port or the bench's terminal comes), every one of the 256 byte values crosses both
 * ways unchanged, in one write and one byte at a time, and frames that contain or end in the
 * bytes a terminal likes to translate (0x0A, 0x0D, 0x11, 0x13, 0x03, 0x04, 0x7F) arrive whole.
 * The terminal comes from `pty-relay.ts --cooked`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { encodeUsbFrame } from "@hsn/protocol";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { type LinkId, sendRef } from "../../../src/core/model/ids.ts";
import { LinkRegistry } from "../../../src/shell/links/registry.ts";
import { SerialLinks } from "../../../src/shell/links/serial.ts";
import {
  byteCleanProblem,
  callOutPath,
  changeFlag,
  closeTty,
  layoutFor,
  listedPorts,
  openTty,
  terminalSettings,
  type TtyPort,
  writeTty,
} from "../../../src/shell/safe/serial.ts";

const RELAY = join(import.meta.dir, "pty-relay.ts");
/** The relay runs on Bun itself; pseudo-terminals exist on macOS and Linux. */
const ptys = process.platform !== "win32";
const TRICKY = [0x0a, 0x0d, 0x11, 0x13, 0x03, 0x04, 0x7f] as const;
const ALL = Uint8Array.from({ length: 256 }, (_, i) => i);

interface Terminal {
  readonly path: string;
  write(bytes: Uint8Array): Promise<void>;
  readonly received: number[];
  kill(): void;
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanup.splice(0)) done();
});

async function cookedTerminal(): Promise<Terminal> {
  const proc = Bun.spawn(["bun", RELAY, "--cooked"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = proc.stdout.getReader();
  const received: number[] = [];
  let header = "";
  let path = "";
  for (let reads = 0; path === "" && reads < 100; reads++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const text = new TextDecoder().decode(chunk.value);
    const end = (header + text).indexOf("\n");
    if (end >= 0) {
      path = (header + text).slice(0, end);
      // Whatever came after the path line is terminal output already.
      received.push(...chunk.value.subarray(chunk.value.indexOf(0x0a) + 1));
    } else header += text;
  }
  void (async () => {
    for (let reads = 0; reads < 100_000; reads++) {
      const chunk = await reader.read();
      if (chunk.done) return;
      received.push(...chunk.value);
    }
  })();
  const t: Terminal = {
    path,
    write: async (bytes) => {
      await proc.stdin.write(bytes);
      await proc.stdin.flush();
    },
    received,
    kill: () => {
      proc.kill();
    },
  };
  cleanup.push(() => {
    t.kill();
  });
  return t;
}

async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < ms) await Bun.sleep(5);
  if (!condition()) expect(`timed out waiting for ${what}`).toBe("");
}

function opened(path: string): { port: TtyPort; received: number[] } {
  const result = openTty(path);
  expect(result.isOk() ? "opened" : result.error.message).toBe("opened");
  const port = result._unsafeUnwrap();
  const received: number[] = [];
  port.stream.on("data", (chunk: Buffer) => received.push(...chunk));
  cleanup.unshift(() => {
    closeTty(port).match(
      () => undefined,
      () => undefined,
    );
  });
  return { port, received };
}

describe.skipIf(!ptys)("a serial link is byte-clean", () => {
  test("a new terminal is not; opened by the hub, every translation, flow control and echo is off, eight bits", async () => {
    const t = await cookedTerminal();
    const { port } = opened(t.path);
    const settings = terminalSettings(port.fd)._unsafeUnwrap();
    expect(byteCleanProblem(settings)).toBeUndefined();
  });

  test("all 256 byte values from the hub, in one write and then one at a time", async () => {
    const t = await cookedTerminal();
    const { port } = opened(t.path);
    (await writeTty(port, ALL))._unsafeUnwrap();
    await until(() => t.received.length >= 256, "256 bytes at the device");
    expect(t.received).toEqual([...ALL]);
    t.received.length = 0;
    for (const byte of ALL) (await writeTty(port, new Uint8Array([byte])))._unsafeUnwrap();
    await until(() => t.received.length >= 256, "256 single bytes at the device");
    expect(t.received).toEqual([...ALL]);
  });

  test("all 256 byte values from the device, in one write and then one at a time", async () => {
    const t = await cookedTerminal();
    const { received } = opened(t.path);
    await t.write(ALL);
    await until(() => received.length >= 256, "256 bytes at the hub");
    expect(received).toEqual([...ALL]);
    received.length = 0;
    for (const byte of ALL) await t.write(new Uint8Array([byte]));
    await until(() => received.length >= 256, "256 single bytes at the hub");
    expect(received).toEqual([...ALL]);
    // Nothing came back: no echo.
    expect(t.received).toEqual([]);
  });

  test("frames containing and ending in 0x0A 0x0D 0x11 0x13 0x03 0x04 0x7F arrive whole, both ways", async () => {
    const t = await cookedTerminal();
    const registry = new LinkRegistry();
    const events: HubEvent[] = [];
    registry.listen((e) => events.push(e));
    const serial = new SerialLinks(registry);
    const link: LinkId = serial.open(t.path)._unsafeUnwrap();
    cleanup.unshift(() => {
      registry.close(link, "test over").match(
        () => undefined,
        () => undefined,
      );
    });
    const payloads = TRICKY.flatMap((byte) => [
      new Uint8Array([0x30, byte, byte, 0x31, byte]),
      new Uint8Array([byte]),
      new Uint8Array([...TRICKY, byte]),
    ]);
    // Device to hub.
    for (const payload of payloads) await t.write(encodeUsbFrame(payload));
    const frames = () => events.flatMap((e) => (e.kind === "frame" ? [[...e.bytes]] : []));
    await until(() => frames().length >= payloads.length, "every frame at the hub");
    expect(frames()).toEqual(payloads.map((p) => [...p]));
    // Hub to device: exactly the encoded frames, one after another.
    const expected = payloads.flatMap((p) => [...encodeUsbFrame(p)]);
    payloads.forEach((payload, i) => {
      registry.send(link, payload, sendRef(i + 1))._unsafeUnwrap();
    });
    await until(() => t.received.length >= expected.length, "every frame at the device");
    expect(t.received).toEqual(expected);
  });
});

describe("the ports the hub opens, by name", () => {
  test("on macOS a listed /dev/tty.X is opened as /dev/cu.X, which does not wait for carrier", () => {
    expect(callOutPath("/dev/tty.usbmodem1101", "darwin")).toBe("/dev/cu.usbmodem1101");
    expect(callOutPath("/dev/cu.usbmodem1101", "darwin")).toBe("/dev/cu.usbmodem1101");
    expect(callOutPath("/dev/ttys004", "darwin")).toBe("/dev/ttys004");
    expect(callOutPath("/dev/ttyACM0", "linux")).toBe("/dev/ttyACM0");
    expect(
      listedPorts(
        [
          { path: "/dev/tty.usbmodem1101", vendorId: "303A" },
          { path: "/dev/tty.Bluetooth-Incoming-Port" },
        ],
        "darwin",
      ),
    ).toEqual([
      { path: "/dev/cu.usbmodem1101", vendorId: "303a" },
      { path: "/dev/cu.Bluetooth-Incoming-Port", vendorId: undefined },
    ]);
    expect(listedPorts([{ path: "/dev/ttyACM0", vendorId: "303a" }], "linux")).toEqual([
      { path: "/dev/ttyACM0", vendorId: "303a" },
    ]);
  });
});

describe("a flag field changed in place", () => {
  test("on macOS's 64-bit fields a high bit cleared or set never spreads into the upper half", () => {
    const layout = layoutFor("darwin");
    expect(layout).toBeDefined();
    if (layout === undefined) return;
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, 0x1_0000_0000n | 0xffff_ffffn, true);
    changeFlag(view, 0, layout, 0x8000_0000, 0);
    expect(view.getBigUint64(0, true)).toBe(0x1_7fff_ffffn);
    changeFlag(view, 0, layout, 0, 0x8000_0000);
    expect(view.getBigUint64(0, true)).toBe(0x1_ffff_ffffn);
  });

  test("on Linux's 32-bit fields the same", () => {
    const layout = layoutFor("linux");
    if (layout === undefined) return;
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, 0xffff_ffff, true);
    changeFlag(view, 0, layout, 0x8000_0000, 0);
    expect(view.getUint32(0, true)).toBe(0x7fff_ffff);
    changeFlag(view, 0, layout, 0, 0x8000_0000);
    expect(view.getUint32(0, true)).toBe(0xffff_ffff);
  });
});

/** A terminal whose relay reports the far end's first bytes and its hang-up (`--watch`). */
async function watchedTerminal(): Promise<{ path: string; states: string[] }> {
  const proc = Bun.spawn(["bun", RELAY, "--watch"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(() => {
    proc.kill();
  });
  const reader = proc.stdout.getReader();
  let header = "";
  for (let reads = 0; !header.includes("\n") && reads < 100; reads++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    header += new TextDecoder().decode(chunk.value);
  }
  const states: string[] = [];
  void (async () => {
    const errors = proc.stderr.getReader();
    let pending = "";
    for (let reads = 0; reads < 100_000; reads++) {
      const chunk = await errors.read();
      if (chunk.done) return;
      pending += new TextDecoder().decode(chunk.value);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      states.push(...lines);
    }
  })();
  return { path: header.slice(0, header.indexOf("\n")), states };
}

describe.skipIf(!ptys)("opening and closing a terminal", () => {
  test("bytes the far end wrote before the hub opened it never arrive (TCSAFLUSH)", async () => {
    const t = await cookedTerminal();
    // Written while the terminal is as it was made: cooked, so held as an unfinished line.
    await t.write(new Uint8Array([0x41, 0x00, 0x42, 0x43]));
    await Bun.sleep(100);
    const { received } = opened(t.path);
    await t.write(new Uint8Array([0x01, 0x02, 0x03]));
    await until(() => received.length >= 3, "the bytes written after the open");
    await Bun.sleep(100);
    expect(received).toEqual([0x01, 0x02, 0x03]);
  });

  test("closed by the hub, the far end sees the hang-up at once, though no byte came", async () => {
    const t = await watchedTerminal();
    const port = openTty(t.path)._unsafeUnwrap();
    port.stream.on("data", () => undefined);
    // A first byte tells the far end the hub is there; the relay then lets go of its own copy.
    (await writeTty(port, new Uint8Array([0x55])))._unsafeUnwrap();
    await until(() => t.states.includes("open"), "the far end seeing the hub");
    await Bun.sleep(200);
    const closedAt = Date.now();
    expect(closeTty(port).isOk()).toBe(true);
    await until(() => t.states.includes("closed"), "the far end seeing the hang-up", 1000);
    expect(Date.now() - closedAt).toBeLessThan(500);
    // Closing again does nothing: the number may be another file's by now.
    expect(closeTty(port).isOk()).toBe(true);
  });

  test("after a close, nothing of the old port is left waiting: a reopen gets every byte", async () => {
    const t = await cookedTerminal();
    const first = opened(t.path);
    await Bun.sleep(100);
    expect(closeTty(first.port).isOk()).toBe(true);
    await Bun.sleep(100);
    // Its descriptor is closed: the read it held has returned (none waits to take a byte).
    expect(() => fstatSync(first.port.fd)).toThrow();
    const second = opened(t.path);
    await t.write(new Uint8Array([0x0a, 0x41, 0x42, 0x43]));
    await until(() => second.received.length >= 4, "the bytes at the reopened port");
    expect(second.received).toEqual([0x0a, 0x41, 0x42, 0x43]);
    expect(first.received).toEqual([]);
  });
});

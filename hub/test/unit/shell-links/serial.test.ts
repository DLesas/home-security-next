/**
 * The serial adapter against a pseudo-terminal (hub-design.md section 3, "Serial links";
 * protocol.md §10): COBS framing both ways, a stream split anywhere, a bad frame costing only
 * itself and counted, and a link that closes. The terminal comes from `pty-relay.ts`; the tests
 * are skipped where there are no pseudo-terminals (Windows).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cobsEncode, encodeUsbFrame } from "@hsn/protocol";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { type LinkId, sendRef } from "../../../src/core/model/ids.ts";
import { LinkRegistry } from "../../../src/shell/links/registry.ts";
import { SerialLinks } from "../../../src/shell/links/serial.ts";

const RELAY = join(import.meta.dir, "pty-relay.ts");
/** The relay runs on Bun itself; pseudo-terminals exist on macOS and Linux. */
const ptys = process.platform !== "win32";

interface Terminal {
  readonly path: string;
  /** Bytes as the device sends them. */
  write(bytes: Uint8Array): void;
  /** Everything the hub has written so far. */
  readonly received: number[];
  kill(): void;
}

const running: Terminal[] = [];
afterEach(() => {
  for (const t of running.splice(0)) t.kill();
});

async function terminal(): Promise<Terminal> {
  const proc = Bun.spawn(["bun", RELAY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = proc.stdout.getReader();
  const received: number[] = [];
  let path = "";
  let header = "";
  // Bounded: a relay that never says its terminal's path fails the test instead of hanging it.
  for (let reads = 0; path === "" && reads < 100; reads++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    header += new TextDecoder().decode(chunk.value);
    const end = header.indexOf("\n");
    if (end >= 0) path = header.slice(0, end);
  }
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      received.push(...chunk.value);
    }
  })();
  const t: Terminal = {
    path,
    write: (bytes) => {
      void proc.stdin.write(bytes);
      void proc.stdin.flush();
    },
    received,
    kill: () => {
      proc.kill();
    },
  };
  running.push(t);
  return t;
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < ms) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

function setup(): {
  readonly registry: LinkRegistry;
  readonly serial: SerialLinks;
  readonly events: HubEvent[];
} {
  const registry = new LinkRegistry();
  const events: HubEvent[] = [];
  registry.listen((e) => events.push(e));
  return { registry, serial: new SerialLinks(registry), events };
}

function opened(serial: SerialLinks, path: string): LinkId {
  const result = serial.open(path);
  expect(result.isOk()).toBe(true);
  const link = result.isOk() ? result.value : undefined;
  expect(link).toBeDefined();
  return link ?? (0 as LinkId);
}

describe.skipIf(!ptys)("a serial link on a pseudo-terminal", () => {
  test("opens as a USB link named by its path, once", async () => {
    const t = await terminal();
    const { serial, events } = setup();
    const link = opened(serial, t.path);
    expect(events).toEqual([{ kind: "linkOpened", link, linkKind: "usb", label: t.path }]);
    const again = serial.open(t.path);
    expect(again.isOk() && again.value).toBe(link);
    expect(events).toHaveLength(1);
  });

  test("frames from the device, split anywhere and two in one chunk, arrive whole and in order", async () => {
    const t = await terminal();
    const { serial, events } = setup();
    const link = opened(serial, t.path);
    const one = Uint8Array.from([0x10, 0, 1, 2, 0, 0, 3]);
    const two = Uint8Array.from(Array.from({ length: 300 }, (_, i) => (i * 7) % 256));
    const stream = Uint8Array.from([
      ...encodeUsbFrame(one),
      ...encodeUsbFrame(two),
      0,
      ...encodeUsbFrame(one),
    ]);
    t.write(stream.slice(0, 3));
    await Bun.sleep(20);
    t.write(stream.slice(3));
    await until(() => events.filter((e) => e.kind === "frame").length === 3);
    expect(events.filter((e) => e.kind === "frame")).toEqual([
      { kind: "frame", link, bytes: one },
      { kind: "frame", link, bytes: two },
      { kind: "frame", link, bytes: one },
    ]);
  });

  test("the hub's frames leave COBS-encoded with a zero byte, in send order", async () => {
    const t = await terminal();
    const { registry, serial } = setup();
    const link = opened(serial, t.path);
    const a = Uint8Array.from([0xf1, 0x01]);
    const b = Uint8Array.from([0x18, 0, 0, 7]);
    expect(registry.send(link, a, sendRef(1)).isOk()).toBe(true);
    expect(registry.send(link, b, sendRef(1)).isOk()).toBe(true);
    const expected = [...encodeUsbFrame(a), ...encodeUsbFrame(b)];
    await until(() => t.received.length >= expected.length);
    expect(t.received).toEqual(expected);
  });

  test("a frame that is not COBS, or too long, reaches the core as rejected and costs only itself", async () => {
    const t = await terminal();
    const { serial, events } = setup();
    const link = opened(serial, t.path);
    const good = Uint8Array.from([1, 2, 3]);
    const notCobs = Uint8Array.from([0x05, 1, 2, 0]); // a block running past the frame's end
    const tooLong = Uint8Array.from([...cobsEncode(new Uint8Array(1100).fill(1)), 0]);
    t.write(Uint8Array.from([...notCobs, ...tooLong, ...encodeUsbFrame(good)]));
    await until(() => events.some((e) => e.kind === "frame"));
    expect(events.filter((e) => e.kind === "frame")).toEqual([
      { kind: "frame", link, bytes: good },
    ]);
    expect(events.filter((e) => e.kind === "inputRejected")).toEqual([
      { kind: "inputRejected", rejection: { source: "frame", link, reason: "badFrame" } },
      { kind: "inputRejected", rejection: { source: "frame", link, reason: "tooLong" } },
    ]);
  });

  test("the device going away closes the link once, and a send to it is refused as closed", async () => {
    const t = await terminal();
    const { registry, serial, events } = setup();
    const link = opened(serial, t.path);
    t.kill();
    await until(() => events.some((e) => e.kind === "linkClosed"));
    expect(events.filter((e) => e.kind === "linkClosed")).toHaveLength(1);
    const sent = registry.send(link, Uint8Array.from([1]), sendRef(1));
    expect(sent.isErr() && sent.error.code).toBe("closed");
    expect(serial.has(t.path)).toBe(false);
  });

  test("the hub's close: linkClosed closedByHub, and the path can be opened again", async () => {
    const t = await terminal();
    const { registry, serial, events } = setup();
    const link = opened(serial, t.path);
    expect(registry.close(link, "test").isOk()).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "linkClosed", link, reason: "closedByHub" });
    await Bun.sleep(50);
    expect(events.filter((e) => e.kind === "linkClosed")).toHaveLength(1);
    expect(serial.open(t.path).isOk()).toBe(true);
  });

  test("a path that does not exist is an error, and nothing opens", () => {
    const { serial, events } = setup();
    const result = serial.open("/dev/does-not-exist-hsn");
    expect(result.isErr()).toBe(true);
    expect(events).toEqual([]);
    expect(serial.has("/dev/does-not-exist-hsn")).toBe(false);
  });
});

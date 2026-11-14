/**
 * The send queue's limit (hub-design.md section 3: a link whose queue passes 64 frames drops the
 * newest and reports it), opening serial ports on sight with no polling (section 3), and the
 * bench's lockstep link (section 11).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { type LinkId, linkId, type SendRef, sendRef } from "../../../src/core/model/ids.ts";
import type { LinkError } from "../../../src/ports/links.ts";
import { LockstepLinks } from "../../../src/shell/links/lockstep.ts";
import { SEND_QUEUE_LIMIT, SendQueue } from "../../../src/shell/links/queue.ts";
import { LinkRegistry } from "../../../src/shell/links/registry.ts";
import { type PortOpener, UsbWatch } from "../../../src/shell/links/usb-watch.ts";
import { linkError } from "../../../src/shell/safe/link-error.ts";

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < ms) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

describe("the send queue", () => {
  test("holds 64 frames; the 65th, the newest, is refused as queueFull; they leave in order", async () => {
    const written: number[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new SendQueue(
      (bytes) => ResultAsync.fromSafePromise(gate.then(() => void written.push(bytes[0] ?? -1))),
      () => undefined,
    );
    expect(SEND_QUEUE_LIMIT).toBe(64);
    for (let i = 0; i < 64; i++)
      expect(queue.push(Uint8Array.from([i]), sendRef(1)).isOk()).toBe(true);
    const full = queue.push(Uint8Array.from([64]), sendRef(1));
    expect(full.isErr() && full.error.code).toBe("queueFull");
    release();
    await until(() => written.length === 64);
    expect(written).toEqual(Array.from({ length: 64 }, (_, i) => i));
    expect(queue.push(Uint8Array.from([65]), sendRef(1)).isOk()).toBe(true);
  });

  test("a failed write stops the queue and is reported once, naming every send that will not leave", async () => {
    const failures: { error: LinkError; refs: readonly SendRef[] }[] = [];
    const queue = new SendQueue(
      () => errAsync(linkError("writeFailed", "test", "broken")),
      (error, refs) => failures.push({ error, refs }),
    );
    expect(queue.push(Uint8Array.from([1]), sendRef(1)).isOk()).toBe(true);
    expect(queue.push(Uint8Array.from([2]), sendRef(2)).isOk()).toBe(true);
    await until(() => failures.length === 1);
    await Bun.sleep(10);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.refs).toEqual([sendRef(1), sendRef(2)]);
    const after = queue.push(Uint8Array.from([3]), sendRef(1));
    expect(after.isErr() && after.error.code).toBe("closed");
  });
});

describe("opening serial ports on sight", () => {
  function opener(): PortOpener & { readonly opened: string[] } {
    const opened: string[] = [];
    return {
      opened,
      has: (path) => opened.includes(path),
      open: (path): Result<unknown, LinkError> => {
        if (path.includes("missing")) return err(linkError("writeFailed", "test", "no such port"));
        opened.push(path);
        return ok(undefined);
      },
    };
  }

  test("at start: Espressif's ports and the --serial paths, nothing else; a missing path is reported", async () => {
    const ports = opener();
    const failed: string[] = [];
    let lists = 0;
    const folder = mkdtempSync(join(tmpdir(), "hsn-watch-"));
    const watch = new UsbWatch(ports, {
      extraPaths: ["/dev/pts/7", "/dev/missing"],
      folders: [folder],
      list: () => {
        lists++;
        return okAsync([
          { path: "/dev/ttyACM0", vendorId: "303a" },
          { path: "/dev/ttyUSB0", vendorId: "10c4" },
          { path: "/dev/ttyS0", vendorId: undefined },
        ]);
      },
      failed: (e) => failed.push(e.message),
    });
    expect(watch.start().every((r) => r.isOk())).toBe(true);
    await watch.settled();
    expect(ports.opened.toSorted()).toEqual(["/dev/pts/7", "/dev/ttyACM0"]);
    expect(failed).toEqual(["no such port"]);
    expect(lists).toBe(1);
    watch.stop();
    rmSync(folder, { recursive: true });
  });

  test("lists again only when the watched folder changes, never on a timer", async () => {
    const ports = opener();
    let present = false;
    let lists = 0;
    const folder = mkdtempSync(join(tmpdir(), "hsn-watch-"));
    const watch = new UsbWatch(ports, {
      extraPaths: [],
      folders: [folder],
      list: () => {
        lists++;
        return okAsync(present ? [{ path: "/dev/ttyACM1", vendorId: "303A".toLowerCase() }] : []);
      },
      failed: () => undefined,
    });
    expect(watch.start().every((r) => r.isOk())).toBe(true);
    await watch.settled();
    await Bun.sleep(300);
    expect(lists).toBe(1);
    present = true;
    writeFileSync(join(folder, "ttyACM1"), "");
    await until(() => ports.opened.includes("/dev/ttyACM1"));
    await watch.settled();
    watch.stop();
    rmSync(folder, { recursive: true });
  });

  test("a folder that cannot be watched is an error from start", () => {
    const watch = new UsbWatch(opener(), {
      extraPaths: [],
      folders: ["/no/such/folder/hsn"],
      list: () => okAsync([]),
      failed: () => undefined,
    });
    expect(watch.start().map((r) => r.isErr())).toEqual([true]);
  });
});

describe("the bench's lockstep link", () => {
  function setup() {
    const registry = new LinkRegistry();
    const events: HubEvent[] = [];
    registry.listen((e) => events.push(e));
    let now = 0;
    const lockstep = new LockstepLinks(registry, () => now);
    return { registry, events, lockstep, setNow: (t: number) => (now = t) };
  }

  test("messages act only once the bench advances to their time, earliest first", () => {
    const { events, lockstep } = setup();
    lockstep.accept({ type: "frame", link: "gw/usb", at: 20, bytes: "0102" });
    lockstep.accept({ type: "linkUp", link: "gw/usb", kind: "usb", at: 10 });
    lockstep.accept({ type: "frame", link: "gw/usb", at: 30, bytes: "03" });
    expect(lockstep.release(5)).toEqual([]);
    expect(events).toEqual([]);
    expect(lockstep.release(20)).toEqual([10, 20]);
    const link: LinkId = linkId(1);
    expect(events).toEqual([
      { kind: "linkOpened", link, linkKind: "usb", label: "gw/usb" },
      { kind: "frame", link, bytes: Uint8Array.from([1, 2]) },
    ]);
    expect(lockstep.release(30)).toEqual([30]);
    expect(events.at(-1)).toEqual({ kind: "frame", link, bytes: Uint8Array.from([3]) });
  });

  test("the hub's frames are kept with the time they left, for the idle answer, once", () => {
    const { registry, lockstep, setNow } = setup();
    lockstep.accept({ type: "linkUp", link: "siren/net", kind: "network", at: 0 });
    lockstep.release(0);
    setNow(1234);
    expect(registry.send(linkId(1), Uint8Array.from([0x18, 0xff]), sendRef(1)).isOk()).toBe(true);
    expect(lockstep.drainSent()).toEqual([{ link: "siren/net", at: 1234, bytes: "18ff" }]);
    expect(lockstep.drainSent()).toEqual([]);
  });

  test("linkDown closes the link as remote; frames for it are dropped; the hub may close it too", () => {
    const { registry, events, lockstep } = setup();
    lockstep.accept({ type: "linkUp", link: "a", kind: "network", at: 0 });
    lockstep.accept({ type: "linkDown", link: "a", at: 5 });
    lockstep.accept({ type: "frame", link: "a", at: 6, bytes: "01" });
    lockstep.release(10);
    expect(events.map((e) => e.kind)).toEqual(["linkOpened", "linkClosed"]);
    expect(events[1]).toEqual({ kind: "linkClosed", link: linkId(1), reason: "remote" });
    lockstep.accept({ type: "linkUp", link: "b", kind: "usb", at: 11 });
    lockstep.release(11);
    expect(registry.close(linkId(2), "test").isOk()).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "linkClosed", link: linkId(2), reason: "closedByHub" });
  });

  test("a frame on a link the hub closed is counted as closedLink, never lost (D110)", () => {
    const { registry, events, lockstep } = setup();
    lockstep.accept({ type: "linkUp", link: "gw/usb", kind: "usb", at: 0 });
    lockstep.release(0);
    expect(registry.close(linkId(1), "gateway session not proven").isOk()).toBe(true);
    lockstep.accept({ type: "frame", link: "gw/usb", at: 5, bytes: "0102" });
    lockstep.release(5);
    expect(events.at(-1)).toEqual({
      kind: "inputRejected",
      rejection: { source: "frame", link: linkId(1), reason: "closedLink" },
    });
    // The controller's linkDown ends it: later frames are for a link that is gone on both ends.
    lockstep.accept({ type: "linkDown", link: "gw/usb", at: 6 });
    lockstep.accept({ type: "frame", link: "gw/usb", at: 7, bytes: "03" });
    const before = events.length;
    lockstep.release(7);
    expect(events).toHaveLength(before);
  });
});

describe("the link registry", () => {
  function registry() {
    const links = new LinkRegistry();
    const events: HubEvent[] = [];
    links.listen((e) => events.push(e));
    const link = links.open("network", "peer", {
      send: () => ok(undefined),
      close: () => ok(undefined),
    });
    return { links, events, link };
  }

  test("a link is reported closed once, whoever notices first", () => {
    const { links, events, link } = registry();
    links.closed(link, "remote");
    links.closed(link, "error");
    expect(links.close(link, "late").isOk()).toBe(true);
    expect(events.filter((e) => e.kind === "linkClosed")).toEqual([
      { kind: "linkClosed", link, reason: "remote" },
    ]);
  });

  test("no frame is passed on from a closed link", () => {
    const { links, events, link } = registry();
    links.closed(link, "textMessage");
    links.frame(link, Uint8Array.from([1]));
    expect(events.filter((e) => e.kind === "frame")).toEqual([]);
  });
});

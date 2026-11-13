/**
 * The `/device` WebSocket endpoint against a local client (hub-design.md section 3, "WebSocket
 * links"; protocol.md §10): one packet per binary message both ways, a text message closing the
 * socket with 1003, an oversized message reaching the core to be counted, the idle close, and a
 * closed link.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { type LinkId, sendRef } from "../../../src/core/model/ids.ts";
import { LinkRegistry } from "../../../src/shell/links/registry.ts";
import { type DeviceSocket, serveDevices } from "../../../src/shell/links/websocket.ts";

const servers: Server<DeviceSocket>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true);
});

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < ms) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

interface Client {
  readonly socket: WebSocket;
  readonly messages: Uint8Array[];
  closed: { code: number; reason: string } | undefined;
}

async function setup(idleMs?: number) {
  const registry = new LinkRegistry();
  const events: HubEvent[] = [];
  registry.listen((e) => events.push(e));
  const server = serveDevices(registry, 0, idleMs === undefined ? {} : { idleMs });
  servers.push(server);
  const client = await connect(server, "/device");
  await until(() => events.some((e) => e.kind === "linkOpened"));
  const opened = events.find((e) => e.kind === "linkOpened");
  const link = (opened?.kind === "linkOpened" ? opened.link : 0) as LinkId;
  return { registry, events, server, client, link };
}

async function connect(server: Server<DeviceSocket>, path: string): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
  socket.binaryType = "arraybuffer";
  const client: Client = { socket, messages: [], closed: undefined };
  socket.addEventListener("message", (e: MessageEvent) => {
    if (e.data instanceof ArrayBuffer) client.messages.push(new Uint8Array(e.data));
  });
  socket.addEventListener("close", (e: CloseEvent) => {
    client.closed = { code: e.code, reason: e.reason };
  });
  await new Promise<void>((resolve) => {
    socket.addEventListener("open", () => {
      resolve();
    });
    socket.addEventListener("error", () => {
      resolve();
    });
  });
  return client;
}

describe("the /device endpoint", () => {
  test("a socket opens as a network link named by its peer", async () => {
    const { events, link } = await setup();
    expect(events[0]).toMatchObject({ kind: "linkOpened", link, linkKind: "network" });
    expect(events[0]?.kind === "linkOpened" ? events[0].label : "").toMatch(
      /^127\.0\.0\.1:\d+$|^::ffff:127\.0\.0\.1:\d+$/,
    );
  });

  test("another path is not upgraded", async () => {
    const { server, events } = await setup();
    const response = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(response.status).toBe(404);
    expect(events.filter((e) => e.kind === "linkOpened")).toHaveLength(1);
  });

  test("each binary message is one frame, in order; each send is one message", async () => {
    const { registry, events, client, link } = await setup();
    const a = Uint8Array.from([0x10, 1, 2, 3]);
    const b = Uint8Array.from(Array.from({ length: 1024 }, (_, i) => i % 256));
    client.socket.send(a);
    client.socket.send(b);
    await until(() => events.filter((e) => e.kind === "frame").length === 2);
    expect(events.filter((e) => e.kind === "frame")).toEqual([
      { kind: "frame", link, bytes: a },
      { kind: "frame", link, bytes: b },
    ]);
    expect(registry.send(link, Uint8Array.from([0x18, 9]), sendRef(1)).isOk()).toBe(true);
    expect(registry.send(link, Uint8Array.from([0x18, 10]), sendRef(1)).isOk()).toBe(true);
    await until(() => client.messages.length === 2);
    expect(client.messages).toEqual([Uint8Array.from([0x18, 9]), Uint8Array.from([0x18, 10])]);
  });

  test("a text message closes the socket with 1003, reported once as textMessage", async () => {
    const { events, client, link } = await setup();
    client.socket.send("hello");
    await until(() => client.closed !== undefined);
    expect(client.closed?.code).toBe(1003);
    await Bun.sleep(20);
    expect(events.filter((e) => e.kind === "linkClosed")).toEqual([
      { kind: "linkClosed", link, reason: "textMessage" },
    ]);
    expect(events.filter((e) => e.kind === "frame")).toEqual([]);
  });

  test("a message over 1,024 bytes reaches the core whole, which refuses it as tooLong", async () => {
    const { events, client, link } = await setup();
    const big = new Uint8Array(2000).fill(0x10);
    client.socket.send(big);
    await until(() => events.some((e) => e.kind === "frame"));
    expect(events.find((e) => e.kind === "frame")).toEqual({ kind: "frame", link, bytes: big });
  });

  test("a socket idle for its time is closed, reported as idle; a message keeps it open", async () => {
    const { events, client, link } = await setup(150);
    await Bun.sleep(100);
    client.socket.send(Uint8Array.from([1]));
    await Bun.sleep(100);
    expect(events.some((e) => e.kind === "linkClosed")).toBe(false);
    await until(() => client.closed !== undefined, 1000);
    expect(events.filter((e) => e.kind === "linkClosed")).toEqual([
      { kind: "linkClosed", link, reason: "idle" },
    ]);
  });

  test("the far end closing reports remote once; a send to the closed link is refused as closed", async () => {
    const { registry, events, client, link } = await setup();
    client.socket.close();
    await until(() => events.some((e) => e.kind === "linkClosed"));
    expect(events.filter((e) => e.kind === "linkClosed")).toEqual([
      { kind: "linkClosed", link, reason: "remote" },
    ]);
    const sent = registry.send(link, Uint8Array.from([1]), sendRef(1));
    expect(sent.isErr() && sent.error.code).toBe("closed");
  });

  test("the hub's close: the client sees 1000, the core closedByHub, once", async () => {
    const { registry, events, client, link } = await setup();
    expect(registry.close(link, "gateway session replaced").isOk()).toBe(true);
    await until(() => client.closed !== undefined);
    expect(client.closed).toEqual({ code: 1000, reason: "gateway session replaced" });
    await Bun.sleep(20);
    expect(events.filter((e) => e.kind === "linkClosed")).toEqual([
      { kind: "linkClosed", link, reason: "closedByHub" },
    ]);
  });
});

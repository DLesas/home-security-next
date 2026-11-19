/**
 * The bridge end to end, in process (m3-design.md section 5, "A bridge for the simulators"): the
 * scripted air served by `startBridge` on this Mac's loopback, and `bridgeBleCentral` over a real
 * WebSocket to it, as a development build in a simulator uses it. A whole update and a whole
 * pairing (with the test stand-in) run through it; faults cross it; two sockets are two phones;
 * the client refuses a release build and any address not on this Mac; the wire refuses what is not
 * one of its messages.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  encodeSetupMessage,
  ProvisionResultCode,
  SetupType,
} from "../../../packages/protocol/src/usb/setup.ts";
import { PROTOCOMM } from "../../../packages/protocol/src/pairing/constants.ts";
import type { PairingCodeText } from "../../../packages/protocol/src/pairing/types.ts";
import {
  BLUETOOTH_UPDATE,
  bluetoothSessionKey,
} from "../../../packages/protocol/src/update/bluetooth.ts";
import type { PairingData } from "../../../packages/protocol/src/pairing.ts";
import { BleAir } from "../src/air/air.ts";
import { nthFrame, TransferKind } from "../src/air/faults.ts";
import { PAIRING_HOLD_MS, ScriptedBoard } from "../src/boards/board.ts";
import { standInSecurity } from "../src/boards/pairing-security.ts";
import { type BridgeCentral, bridgeBleCentral } from "../src/bridge/client.ts";
import { type BridgeServer, startBridge } from "../src/bridge/server.ts";
import { BRIDGE_WIRE, isLocalBridge, readToBench, readToPhone } from "../src/bridge/wire.ts";
import { realClock } from "../src/clock.ts";
import { openStandInSession } from "../src/stand-in-client.ts";
import { Role, testImage, testPairing } from "./support/images.ts";
import { ScriptPhone } from "../src/script-phone.ts";
import { countingRandom, NONCE } from "./support/world.ts";

const CODE = "0000000Y" as PairingCodeText;

const running: { server?: BridgeServer; centrals: BridgeCentral[] } = { centrals: [] };

afterEach(() => {
  for (const central of running.centrals) central.shutdown();
  running.centrals = [];
  running.server?.stop();
  delete running.server;
});

/** The air with `boards` powered on; each unpaired one is held for 5 seconds, opening its window. */
function bench(boards: (air: BleAir) => ScriptedBoard[]) {
  const air = new BleAir(realClock, { advertIntervalMs: 20, connectTimeoutMs: 400 });
  const made = boards(air);
  for (const board of made) {
    air.add(board);
    board.powerOn();
    if (board.pairing === undefined) board.holdButton(PAIRING_HOLD_MS);
  }
  const started = startBridge({ air });
  expect(started.ok).toBe(true);
  // A bridge that did not start fails the line above; the stand-in keeps the types simple.
  const server: BridgeServer = started.ok
    ? started.value
    : { port: 0, url: "ws://127.0.0.1:1", phones: 0, stop: () => undefined };
  running.server = server;
  return { air, boards: made, server };
}

function phone(server: BridgeServer): BridgeCentral {
  const central = bridgeBleCentral(server.url);
  running.centrals.push(central);
  return central;
}

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return check();
}

describe("the bridge, end to end over a WebSocket", () => {
  test("it listens on the Mac's loopback only, and says the wire's version first", async () => {
    const { server } = bench(() => []);
    expect(server.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/u);
    const central = phone(server);
    expect(await central.ready).toBe(true);
    expect(await central.state()).toBe("on");
  });

  test("a whole update of a scripted sensor through the bridge", async () => {
    const pairing = testPairing();
    const image = testImage(13000);
    const { boards, server } = bench(() => [
      new ScriptedBoard(realClock, {
        role: Role.Sensor,
        chipId: Uint8Array.of(1, 2, 3, 4, 5, 6),
        code: CODE,
        pairing,
        random: countingRandom(),
      }),
    ]);
    const [sensor] = boards;
    sensor?.offerUpdate({ imageId: image.imageId, nonce: NONCE, windowUnits: 12 });
    const key = bluetoothSessionKey(pairing.key, NONCE, pairing.address);
    const script = new ScriptPhone(phone(server), realClock, {
      address: pairing.address,
      sessionKey: key.ok ? key.value : new Uint8Array(32),
      imageId: image.imageId,
      file: image.file,
    });
    script.start();
    expect(await until(() => script.done !== undefined)).toBe(true);
    expect(script.done?.result).toBe(0);
    expect(script.servedTo).toBe(image.file.length);
    expect(sensor?.update?.writtenImage()).toEqual(image.image);
    expect(sensor?.statuses.at(-1)?.stage).toBe(2);
  });

  test("a drop crosses the bridge: the phone sees the link lost, reconnects, and finishes", async () => {
    const pairing = testPairing();
    const image = testImage(13000);
    const { air, boards, server } = bench(() => [
      new ScriptedBoard(realClock, {
        role: Role.Sensor,
        chipId: new Uint8Array(6),
        code: CODE,
        pairing,
        random: countingRandom(),
      }),
    ]);
    air.faults = { dropAfter: nthFrame(TransferKind.Data, 20) };
    boards[0]?.offerUpdate({ imageId: image.imageId, nonce: NONCE, windowUnits: 12 });
    const key = bluetoothSessionKey(pairing.key, NONCE, pairing.address);
    const script = new ScriptPhone(
      phone(server),
      realClock,
      {
        address: pairing.address,
        sessionKey: key.ok ? key.value : new Uint8Array(32),
        imageId: image.imageId,
        file: image.file,
      },
      { dropAfterData: 20, reconnectAfterMs: 50 },
    );
    script.start();
    expect(await until(() => script.done !== undefined)).toBe(true);
    expect(script.connections).toBe(2);
    expect(script.disconnections).toBe(2);
    expect(script.done?.result).toBe(0);
  });

  test("a whole pairing through the bridge with the test stand-in: Identify, Provision, the result, the restart", async () => {
    const provisioned: PairingData[] = [];
    const { server } = bench(() => [
      new ScriptedBoard(
        realClock,
        {
          role: Role.Siren,
          chipId: Uint8Array.of(9, 9, 9, 9, 0x4f, 0x2a),
          code: CODE,
          security: standInSecurity,
        },
        { provisioned: (p) => provisioned.push(p) },
      ),
    ]);
    const central = phone(server);
    const found: { id: string; name: string | null; data: Uint8Array | null }[] = [];
    const stop = central.scan(PROTOCOMM.serviceUuid, (advert) =>
      found.push({ id: advert.id, name: advert.name, data: advert.serviceData }),
    );
    expect(await until(() => found.length > 0)).toBe(true);
    stop();
    expect(found[0]?.data).toBeNull();
    expect(found[0]?.name).toBe("hsn-pair-4f2a");
    const connected = await central.connect(found[0]?.id ?? "", 517);
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    expect(connected.value.mtu).toBe(517);
    const opened = await openStandInSession(connected.value, CODE);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const identity = await opened.value.exchange(encodeSetupMessage({ type: SetupType.Identify }));
    expect(identity.ok && identity.value[1]).toBe(SetupType.Identity);
    const closed: (string | null)[] = [];
    connected.value.onClosed((why) => closed.push(why));
    const result = await opened.value.exchange(
      encodeSetupMessage({ type: SetupType.Provision, pairing: testPairing() }),
    );
    expect(result).toEqual({
      ok: true,
      value: encodeSetupMessage({
        type: SetupType.ProvisionResult,
        result: ProvisionResultCode.Accepted,
      }),
    });
    expect(await until(() => provisioned.length === 1 && closed.length === 1)).toBe(true);
    expect(closed).toEqual(["lost"]);
  });

  test("a wrong code through the bridge is wrongCode", async () => {
    const { boards, server } = bench(() => [
      new ScriptedBoard(realClock, {
        role: Role.Gateway,
        chipId: new Uint8Array(6),
        code: CODE,
        security: standInSecurity,
      }),
    ]);
    const connected = await phone(server).connect(boards[0]?.id ?? "", 185);
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    expect(await openStandInSession(connected.value, "0000001Z" as PairingCodeText)).toEqual({
      ok: false,
      fault: "wrongCode",
    });
    expect(boards[0]?.wrongCodes).toBe(1);
  });

  test("two sockets are two phones: the second cannot connect while the first is connected", async () => {
    const { boards, server } = bench(() => [
      new ScriptedBoard(realClock, {
        role: Role.Siren,
        chipId: new Uint8Array(6),
        code: CODE,
        security: standInSecurity,
      }),
    ]);
    const id = boards[0]?.id ?? "";
    const first = await phone(server).connect(id, 517);
    expect(first.ok).toBe(true);
    expect(await phone(server).connect(id, 517)).toEqual({ ok: false, fault: "timeout" });
    expect(server.phones).toBe(2);
  });

  test("the bridge going: every link is lost and every pending call answers lost", async () => {
    const { boards, server } = bench(() => [
      new ScriptedBoard(realClock, {
        role: Role.Siren,
        chipId: new Uint8Array(6),
        code: CODE,
        security: standInSecurity,
      }),
    ]);
    const central = phone(server);
    const connected = await central.connect(boards[0]?.id ?? "", 517);
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    const closed: (string | null)[] = [];
    connected.value.onClosed((why) => closed.push(why));
    server.stop();
    expect(await until(() => closed.length === 1)).toBe(true);
    expect(closed).toEqual(["lost"]);
    expect(await connected.value.read(BLUETOOTH_UPDATE.txUuid)).toEqual({
      ok: false,
      fault: "lost",
    });
    expect(await central.connect("x", 23)).toEqual({ ok: false, fault: "lost" });
  });

  test("closing a link from the phone: onClosed(null), and the board is free again", async () => {
    const { boards, server } = bench(() => [
      new ScriptedBoard(realClock, {
        role: Role.Siren,
        chipId: new Uint8Array(6),
        code: CODE,
        security: standInSecurity,
      }),
    ]);
    const central = phone(server);
    const connected = await central.connect(boards[0]?.id ?? "", 517);
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    const closed: (string | null)[] = [];
    connected.value.onClosed((why) => closed.push(why));
    connected.value.close();
    expect(closed).toEqual([null]);
    expect(await until(() => boards[0]?.advertising() !== null)).toBe(true);
    expect((await central.connect(boards[0]?.id ?? "", 517)).ok).toBe(true);
  });
});

describe("the client refuses what it must", () => {
  test("in a release build it opens nothing: Bluetooth is unsupported, every connect fails", async () => {
    const opened: string[] = [];
    const global = globalThis as { __DEV__?: boolean };
    global.__DEV__ = false;
    const central = bridgeBleCentral("ws://127.0.0.1:9", {
      makeSocket: (url) => {
        opened.push(url);
        return {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: () => undefined,
          close: () => undefined,
        };
      },
    });
    delete global.__DEV__;
    expect(opened).toEqual([]);
    expect(await central.state()).toBe("unsupported");
    expect(await central.connect("a", 23)).toEqual({ ok: false, fault: "failed" });
    expect(await central.ready).toBe(false);
  });

  test("an address not on this Mac is refused before anything is opened", () => {
    for (const url of [
      "ws://192.168.1.20:8787",
      "wss://127.0.0.1:8787",
      "ws://example.com:8787",
      "ws://127.0.0.1.example.com:1",
      "ws://10.0.2.3:8787",
    ]) {
      expect(isLocalBridge(url)).toBe(false);
    }
    for (const url of [
      "ws://127.0.0.1:8787",
      "ws://localhost:1",
      "ws://10.0.2.2:8787",
      "ws://[::1]:8787/x",
    ]) {
      expect(isLocalBridge(url)).toBe(true);
    }
    const opened: string[] = [];
    bridgeBleCentral("ws://192.168.1.20:8787", {
      makeSocket: (url) => {
        opened.push(url);
        return {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: () => undefined,
          close: () => undefined,
        };
      },
    });
    expect(opened).toEqual([]);
  });

  test("a bridge that is not running: ready is false and calls answer lost", async () => {
    const central = bridgeBleCentral("ws://127.0.0.1:1");
    running.centrals.push(central);
    expect(await central.ready).toBe(false);
    expect(await central.connect("x", 23)).toEqual({ ok: false, fault: "lost" });
  });
});

describe("the wire", () => {
  test("reads each message, and refuses anything else", () => {
    expect(readToBench(JSON.stringify({ t: "hello", v: BRIDGE_WIRE }))).toEqual({
      t: "hello",
      v: BRIDGE_WIRE,
    });
    expect(
      readToBench(
        JSON.stringify({ t: "write", id: 1, link: 2, char: "c", data: "0aff", response: false }),
      ),
    ).toEqual({
      t: "write",
      id: 1,
      link: 2,
      char: "c",
      data: "0aff",
      response: false,
    });
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ t: "write", id: 1, link: 2, char: "c", data: "0AFF", response: false }),
      JSON.stringify({ t: "write", id: 1, link: 2, char: "c", data: "abc", response: false }),
      JSON.stringify({ t: "connect", id: -1, device: "d", mtu: 23 }),
      JSON.stringify({ t: "connect", id: 1.5, device: "d", mtu: 23 }),
      JSON.stringify({ t: "unknown" }),
    ]) {
      expect(readToBench(bad)).toBeUndefined();
    }
    expect(readToPhone(JSON.stringify({ t: "reply", id: 3, ok: false, fault: "lost" }))).toEqual({
      t: "reply",
      id: 3,
      ok: false,
      fault: "lost",
    });
    expect(
      readToPhone(JSON.stringify({ t: "reply", id: 3, ok: false, fault: "gone" })),
    ).toBeUndefined();
    expect(readToPhone(JSON.stringify({ t: "closed", link: 1, fault: null }))).toEqual({
      t: "closed",
      link: 1,
      fault: null,
    });
  });

  test("a socket that does not say the wire's version first is closed", async () => {
    const { server } = bench(() => []);
    const socket = new WebSocket(server.url);
    let closed = false;
    socket.onclose = () => {
      closed = true;
    };
    await new Promise<void>((resolve) => {
      socket.onopen = () => {
        resolve();
      };
    });
    socket.send(JSON.stringify({ t: "hello", v: "hsn-ble-bench/0" }));
    expect(await until(() => closed)).toBe(true);
  });
});

/**
 * The phone's Bluetooth central over react-native-ble-plx (`app/src/platform/ble.native.ts`), with
 * the library and React Native's `Platform` and `PermissionsAndroid` stood in for
 * (`support/ble-plx-fake.ts`): how each native error becomes a fault, base64 both ways, which
 * service each characteristic is sent to, the link's closing, Android's permissions, the MTU, and
 * the bounds on a connect's steps.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { pairingCharacteristic, PROTOCOMM } from "@hsn/protocol/pairing";
import { BLUETOOTH_UPDATE } from "@hsn/protocol/update";
import type * as BleNative from "../src/platform/ble.native";
import type { BleFault } from "../src/platform/ble-types";
import { ManualClock } from "../../tools/ble-bench/src/clock";
import {
  BleError,
  BleErrorCode,
  bleFake,
  blePlxModule,
  never,
  reactNativeModule,
} from "./support/ble-plx-fake";
import { nativeWeb } from "./support/native-web";

await mock.module("react-native-ble-plx", () => blePlxModule);
await mock.module("react-native", () => reactNativeModule(nativeWeb));
// The file reads Metro's development flag once, at its load; nothing else under Bun may see it.
const scope = globalThis as { __DEV__?: boolean };
scope.__DEV__ = false;
const ble: typeof BleNative = await import("../src/platform/ble.native");
delete scope.__DEV__;

afterAll(async () => {
  // Later files render through React Native Web, as `support/render.ts` installs it.
  await mock.module("react-native", () => nativeWeb);
});

beforeEach(() => {
  bleFake.reset();
});

/** Opens the manager as the permission page does, then connects with `clock` bounding each step. */
async function connected(clock = new ManualClock(), id = "board") {
  expect(await ble.askBluetooth()).toBe("on");
  const pending = ble.blePlxCentral(clock).connect(id, 517);
  await clock.advance(0);
  const link = await pending;
  expect(link.ok).toBe(true);
  return link.ok ? link.value : undefined;
}

describe("a native error as a fault", () => {
  const named: Record<string, BleFault> = {
    BluetoothPoweredOff: "off",
    BluetoothUnauthorized: "unauthorized",
    DeviceNotFound: "notFound",
    OperationTimedOut: "timeout",
    DeviceConnectionFailed: "timeout",
    DeviceDisconnected: "lost",
    DeviceNotConnected: "lost",
    OperationCancelled: "lost",
  };

  test("the library declares every code named here", () => {
    for (const name of Object.keys(named)) expect(BleErrorCode[name]).toBeNumber();
    expect(Object.keys(BleErrorCode).length).toBeGreaterThan(30);
  });

  test("a dropped device is 'lost', which makes a drop resumable", () => {
    expect(ble.fault(new BleError(BleErrorCode.DeviceDisconnected ?? -1))).toBe("lost");
  });

  test("every code of the library: the named ones as named, every other one 'failed'", () => {
    for (const [name, code] of Object.entries(BleErrorCode))
      expect({ name, fault: ble.fault(new BleError(code)) }).toEqual({
        name,
        fault: named[name] ?? "failed",
      });
  });

  test("anything not the library's error is 'failed'", () => {
    for (const thrown of [new Error("x"), "text", undefined, null, { errorCode: 102 }])
      expect(ble.fault(thrown)).toBe("failed");
  });
});

describe("base64, as the library carries values", () => {
  test("bytes are sent as padded standard base64, and read back", () => {
    for (const [bytes, text] of [
      [[], ""],
      [[0xff], "/w=="],
      [[0xfb, 0xff], "+/8="],
      [[0x01, 0x02, 0x03], "AQID"],
      [[0xf8, 0x3e, 0x00, 0x7f], "+D4Afw=="],
    ] as const) {
      const value = Uint8Array.from(bytes);
      expect(ble.encode(value)).toBe(text);
      expect(ble.decode(text)).toEqual(value);
    }
  });

  test("an empty value is no bytes; a missing value, or one not base64, is none", () => {
    expect(ble.decode("")).toEqual(new Uint8Array());
    expect(ble.decode(null)).toBeUndefined();
    expect(ble.decode(undefined)).toBeUndefined();
    expect(ble.decode("not base64!")).toBeUndefined();
  });
});

describe("which service a characteristic is sent to", () => {
  test("pairing's endpoints to protocomm's service, the update's to the update service", () => {
    for (const { uuid16 } of Object.values(PROTOCOMM.endpoints))
      expect(ble.serviceFor(pairingCharacteristic(uuid16))).toBe(PROTOCOMM.serviceUuid);
    expect(ble.serviceFor(BLUETOOTH_UPDATE.rxUuid)).toBe(BLUETOOTH_UPDATE.serviceUuid);
    expect(ble.serviceFor(BLUETOOTH_UPDATE.txUuid)).toBe(BLUETOOTH_UPDATE.serviceUuid);
  });

  test("a link writes, reads and watches each on its own service", async () => {
    const link = await connected();
    if (link === undefined) return;
    const session = pairingCharacteristic(PROTOCOMM.endpoints.session.uuid16);
    expect(await link.write(session, Uint8Array.of(1, 2), true)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await link.write(BLUETOOTH_UPDATE.rxUuid, Uint8Array.of(0xff), false)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(bleFake.writes).toEqual([
      { service: PROTOCOMM.serviceUuid, characteristic: session, value: "AQI=", response: true },
      {
        service: BLUETOOTH_UPDATE.serviceUuid,
        characteristic: BLUETOOTH_UPDATE.rxUuid,
        value: "/w==",
        response: false,
      },
    ]);
    expect(await link.read(session)).toEqual({ ok: true, value: Uint8Array.of(1, 2) });
    bleFake.readValue = null;
    expect(await link.read(session)).toEqual({ ok: false, fault: "failed" });
    expect(bleFake.reads.map(({ service }) => service)).toEqual([
      PROTOCOMM.serviceUuid,
      PROTOCOMM.serviceUuid,
    ]);
    link.watch(BLUETOOTH_UPDATE.txUuid, () => undefined);
    expect(bleFake.monitors.map(({ service }) => service)).toEqual([BLUETOOTH_UPDATE.serviceUuid]);
  });
});

describe("the link's end", () => {
  test("a drop tells each listener once, and a late listener at once, with the same fault", async () => {
    const link = await connected();
    if (link === undefined) return;
    const heard: (BleFault | null)[] = [];
    link.onClosed((why) => heard.push(why));
    bleFake.disconnected.get("board")?.(null);
    expect(heard).toEqual(["lost"]);
    // The library's listener is gone: a second report reaches nobody.
    expect(bleFake.disconnected.has("board")).toBe(false);
    const late: (BleFault | null)[] = [];
    link.onClosed((why) => late.push(why));
    expect(late).toEqual(["lost"]);
    expect(heard).toEqual(["lost"]);
    link.close();
    expect(bleFake.cancelled).toEqual([]);
  });

  test("a drop reported twice by the library keeps the first report's fault", async () => {
    const link = await connected();
    if (link === undefined) return;
    const heard: (BleFault | null)[] = [];
    link.onClosed((why) => heard.push(why));
    // A report already on its way from the native side when the first one arrives.
    const report = bleFake.disconnected.get("board");
    report?.(null);
    report?.(new BleError(BleErrorCode.BluetoothPoweredOff ?? -1));
    expect(heard).toEqual(["lost"]);
    const late: (BleFault | null)[] = [];
    link.onClosed((why) => late.push(why));
    expect(late).toEqual(["lost"]);
  });

  test("a drop with the library's error is that error's fault", async () => {
    const link = await connected();
    if (link === undefined) return;
    const heard: (BleFault | null)[] = [];
    link.onClosed((why) => heard.push(why));
    bleFake.disconnected.get("board")?.(new BleError(BleErrorCode.BluetoothPoweredOff ?? -1));
    expect(heard).toEqual(["off"]);
  });

  test("close cancels the connection once and tells the listeners null, once", async () => {
    const link = await connected();
    if (link === undefined) return;
    const heard: (BleFault | null)[] = [];
    link.onClosed((why) => heard.push(why));
    link.close();
    link.close();
    expect(bleFake.cancelled).toEqual(["board"]);
    expect(heard).toEqual([null]);
    const late: (BleFault | null)[] = [];
    link.onClosed((why) => late.push(why));
    expect(late).toEqual([null]);
  });

  test("a watch's error other than a cancellation closes the link and cancels the connection", async () => {
    const link = await connected();
    if (link === undefined) return;
    const heard: (BleFault | null)[] = [];
    const data: Uint8Array[] = [];
    link.onClosed((why) => heard.push(why));
    link.watch(BLUETOOTH_UPDATE.txUuid, (bytes) => data.push(bytes));
    const monitor = bleFake.monitors[0]?.listener;
    monitor?.(null, { value: "AQID" });
    expect(data).toEqual([Uint8Array.of(1, 2, 3)]);
    monitor?.(new BleError(BleErrorCode.OperationCancelled ?? -1), null);
    expect(heard).toEqual([]);
    expect(bleFake.cancelled).toEqual([]);
    monitor?.(new BleError(BleErrorCode.DeviceDisconnected ?? -1), null);
    expect(heard).toEqual(["lost"]);
    expect(bleFake.cancelled).toEqual(["board"]);
    // Nothing after the end reaches the watcher.
    monitor?.(null, { value: "AQID" });
    expect(data).toHaveLength(1);
  });
});

describe("Android's permissions", () => {
  test("from API 31 scan and connect, below it fine location", () => {
    for (const api of [31, 34])
      expect(ble.androidPermissions(api)).toEqual([
        "android.permission.BLUETOOTH_SCAN",
        "android.permission.BLUETOOTH_CONNECT",
      ]);
    for (const api of [23, 30])
      expect(ble.androidPermissions(api)).toEqual(["android.permission.ACCESS_FINE_LOCATION"]);
  });

  test("asking Bluetooth asks the set for the phone's own API level; iOS asks none", async () => {
    bleFake.platform.OS = "android";
    bleFake.platform.Version = 31;
    expect(await ble.askBluetooth()).toBe("on");
    bleFake.platform.Version = 30;
    expect(await ble.askBluetooth()).toBe("on");
    expect(bleFake.requested).toEqual([
      ["android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"],
      ["android.permission.ACCESS_FINE_LOCATION"],
    ]);
    bleFake.platform.OS = "ios";
    expect(await ble.askBluetooth()).toBe("on");
    expect(bleFake.requested).toHaveLength(2);
  });

  test("a permission refused is Bluetooth not allowed", async () => {
    bleFake.platform.OS = "android";
    bleFake.granted = false;
    expect(await ble.askBluetooth()).toBe("unauthorized");
    expect(await ble.bleCentral.state()).toBe("unauthorized");
  });
});

describe("connecting", () => {
  test("on Android the MTU asked for is requested; on iOS it is not", async () => {
    bleFake.platform.OS = "android";
    const android = await connected();
    expect(bleFake.mtuAsked).toEqual([517]);
    expect(android?.mtu).toBe(517);
    bleFake.reset();
    const ios = await connected();
    expect(bleFake.mtuAsked).toEqual([]);
    expect(ios?.mtu).toBe(23);
  });

  test("an MTU the phone refuses keeps the connection at its own MTU", async () => {
    bleFake.platform.OS = "android";
    bleFake.requestMtu = () => Promise.reject(new BleError(BleErrorCode.OperationTimedOut ?? -1));
    const link = await connected();
    expect(link?.mtu).toBe(23);
    expect(bleFake.cancelled).toEqual([]);
  });

  test("a failed connect is its fault, and a failed discovery cancels the connection", async () => {
    expect(await ble.askBluetooth()).toBe("on");
    bleFake.connect = () => Promise.reject(new BleError(BleErrorCode.DeviceConnectionFailed ?? -1));
    expect(await ble.blePlxCentral(new ManualClock()).connect("board", 517)).toEqual({
      ok: false,
      fault: "timeout",
    });
    expect(bleFake.cancelled).toEqual([]);
    bleFake.connect = () => Promise.resolve();
    bleFake.discover = () => Promise.reject(new BleError(BleErrorCode.DeviceDisconnected ?? -1));
    expect(await ble.blePlxCentral(new ManualClock()).connect("board", 517)).toEqual({
      ok: false,
      fault: "lost",
    });
    expect(bleFake.cancelled).toEqual(["board"]);
  });

  for (const [step, stall] of [
    ["an MTU request", "requestMtu"],
    ["a discovery of the services", "discover"],
  ] as const)
    test(`${step} that never answers is a timeout after its bound, and the connection is cancelled`, async () => {
      bleFake.platform.OS = "android";
      expect(await ble.askBluetooth()).toBe("on");
      bleFake[stall] = never;
      const clock = new ManualClock();
      let answer: { ok: boolean; fault?: BleFault } | undefined;
      void ble
        .blePlxCentral(clock)
        .connect("board", 517)
        .then((value) => {
          answer = value.ok ? { ok: true } : value;
        });
      await clock.advance(ble.CONNECT_STEP_MS - 1);
      expect(answer).toBeUndefined();
      expect(bleFake.cancelled).toEqual([]);
      await clock.advance(1);
      expect(answer).toEqual({ ok: false, fault: "timeout" });
      expect(bleFake.cancelled).toEqual(["board"]);
      expect(clock.pending).toBe(0);
    });

  test("each step's bound is the connect's own, 6.5 s", () => {
    expect(ble.CONNECT_STEP_MS).toBe(6500);
  });
});

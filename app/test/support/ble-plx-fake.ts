/**
 * Small stand-ins for the native modules `app/src/platform/ble.native.ts` imports, so it runs under
 * `bun test`: `react-native-ble-plx` (a manager, its devices, its error and codes, its states) and
 * the parts of `react-native` it uses (`Platform`, `PermissionsAndroid`). A test installs them
 * with `bun:test`'s `mock.module` before importing the file, steers them through `bleFake`, and
 * reads back what the file asked of them. The error codes are read from the library's own type
 * declarations, so they are its numbers.
 */
import { readFileSync } from "node:fs";

/** `BleErrorCode`, every name with its number, as `react-native-ble-plx` declares it. */
export const BleErrorCode: Readonly<Record<string, number>> = (() => {
  const declarations = readFileSync(
    Bun.resolveSync("react-native-ble-plx/src/index.d.ts", import.meta.dir),
    "utf8",
  );
  const block = /export enum BleErrorCode \{([\s\S]*?)\n {2}\}/u.exec(declarations)?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/^\s+(\w+) = (\d+),?$/gmu)].map((m) => [m[1] ?? "", Number(m[2])]),
  );
})();

/** `State`, as the library declares it. */
export const State = {
  Unknown: "Unknown",
  Resetting: "Resetting",
  Unsupported: "Unsupported",
  Unauthorized: "Unauthorized",
  PoweredOff: "PoweredOff",
  PoweredOn: "PoweredOn",
} as const;

/** The library's error: only its code is read. */
export class BleError extends Error {
  constructor(readonly errorCode: number) {
    super("a stand-in Bluetooth error");
  }
}

/** A promise that never settles: a native call that never returns. */
export const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

type Listener = (error: BleError | null, value: { value: string | null } | null) => void;

/** What the stand-ins do, and what they were asked; a test changes it before each call. */
export const bleFake = {
  platform: { OS: "ios" as "ios" | "android", Version: 34 as number | string },
  granted: true,
  requested: [] as string[][],
  state: State.PoweredOn as string,
  /** How `connectToDevice`, `requestMTU` and `discoverAllServicesAndCharacteristics` answer. */
  connect: (): Promise<void> => Promise.resolve(),
  requestMtu: (): Promise<void> => Promise.resolve(),
  discover: (): Promise<void> => Promise.resolve(),
  mtuAsked: [] as number[],
  cancelled: [] as string[],
  writes: [] as { service: string; characteristic: string; value: string; response: boolean }[],
  reads: [] as { service: string; characteristic: string }[],
  readValue: "AQI=" as string | null,
  monitors: [] as { service: string; characteristic: string; listener: Listener }[],
  disconnected: new Map<string, (error: BleError | null) => void>(),
  managers: 0,
  /** Resets what was asked and what is answered. */
  reset(): void {
    bleFake.platform.OS = "ios";
    bleFake.platform.Version = 34;
    bleFake.granted = true;
    bleFake.requested = [];
    bleFake.state = State.PoweredOn;
    bleFake.connect = () => Promise.resolve();
    bleFake.requestMtu = () => Promise.resolve();
    bleFake.discover = () => Promise.resolve();
    bleFake.mtuAsked = [];
    bleFake.cancelled = [];
    bleFake.writes = [];
    bleFake.reads = [];
    bleFake.readValue = "AQI=";
    bleFake.monitors = [];
    bleFake.disconnected.clear();
  },
};

/** One device, as `connectToDevice` gives it. */
class Device {
  mtu = 23;
  constructor(readonly id: string) {}

  /** Asks the stand-in's MTU answer; the device then has it. */
  async requestMTU(mtu: number): Promise<Device> {
    bleFake.mtuAsked.push(mtu);
    await bleFake.requestMtu();
    this.mtu = mtu;
    return this;
  }

  /** Answers as the stand-in says. */
  async discoverAllServicesAndCharacteristics(): Promise<Device> {
    await bleFake.discover();
    return this;
  }

  /** Records the write with response. */
  writeCharacteristicWithResponseForService(
    service: string,
    characteristic: string,
    value: string,
  ) {
    bleFake.writes.push({ service, characteristic, value, response: true });
    return Promise.resolve(this);
  }

  /** Records the write without response. */
  writeCharacteristicWithoutResponseForService(
    service: string,
    characteristic: string,
    value: string,
  ) {
    bleFake.writes.push({ service, characteristic, value, response: false });
    return Promise.resolve(this);
  }

  /** Records the read and answers the stand-in's value. */
  readCharacteristicForService(service: string, characteristic: string) {
    bleFake.reads.push({ service, characteristic });
    return Promise.resolve({ value: bleFake.readValue });
  }

  /** Keeps the listener for the test to call. */
  monitorCharacteristicForService(service: string, characteristic: string, listener: Listener) {
    const entry = { service, characteristic, listener };
    bleFake.monitors.push(entry);
    return {
      remove: () => {
        bleFake.monitors = bleFake.monitors.filter((m) => m !== entry);
      },
    };
  }
}

/** The manager: one per app. */
class BleManager {
  constructor() {
    bleFake.managers += 1;
  }

  /** The stand-in's state. */
  state(): Promise<string> {
    return Promise.resolve(bleFake.state);
  }

  /** Never changes in these tests. */
  onStateChange() {
    return { remove: () => undefined };
  }

  /** Answers as the stand-in says, with a device of that id. */
  async connectToDevice(id: string): Promise<Device> {
    await bleFake.connect();
    return new Device(id);
  }

  /** Records the cancel. */
  cancelDeviceConnection(id: string): Promise<Device> {
    bleFake.cancelled.push(id);
    return Promise.resolve(new Device(id));
  }

  /** Keeps the listener so a test can drop the link. */
  onDeviceDisconnected(id: string, listener: (error: BleError | null) => void) {
    bleFake.disconnected.set(id, listener);
    return {
      remove: () => {
        bleFake.disconnected.delete(id);
      },
    };
  }

  /** Scans nothing. */
  startDeviceScan(): Promise<void> {
    return Promise.resolve();
  }

  /** Stops nothing. */
  stopDeviceScan(): Promise<void> {
    return Promise.resolve();
  }
}

/** The stand-in `react-native-ble-plx`. */
export const blePlxModule = { BleError, BleErrorCode, BleManager, State };

/** Android's permission names, as React Native gives them. */
const PERMISSIONS = {
  BLUETOOTH_SCAN: "android.permission.BLUETOOTH_SCAN",
  BLUETOOTH_CONNECT: "android.permission.BLUETOOTH_CONNECT",
  ACCESS_FINE_LOCATION: "android.permission.ACCESS_FINE_LOCATION",
} as const;

/** The parts of `react-native` the file uses, over `base` (React Native Web, for other files). */
export function reactNativeModule(base: Record<string, unknown>) {
  return {
    ...base,
    Platform: bleFake.platform,
    PermissionsAndroid: {
      PERMISSIONS,
      /** Whether the stand-in grants everything. */
      check: () => Promise.resolve(bleFake.granted),
      /** Records the set asked, and answers every one granted or denied. */
      requestMultiple: (asked: string[]) => {
        bleFake.requested.push(asked);
        return Promise.resolve(
          Object.fromEntries(asked.map((p) => [p, bleFake.granted ? "granted" : "denied"])),
        );
      },
    },
  };
}

/** Bluetooth central over the native BLE stack. A manager is opened only on demand. */
import { pairingCharacteristic, PROTOCOMM } from "@hsn/protocol/pairing";
import { BLUETOOTH_UPDATE } from "@hsn/protocol/update";
import { PermissionsAndroid, Platform } from "react-native";
import { BleError, BleErrorCode, BleManager, type Device, State } from "react-native-ble-plx";
import type { BleCentral, BleFault, BleState, GattLink } from "./ble-types";
import type { Outcome } from "./split";
import { fromBase64url, toBase64url } from "../hub/files";

export type * from "./ble-types";

let manager: BleManager | undefined;
const pairing = new Set(
  Object.values(PROTOCOMM.endpoints).map(({ uuid16 }) => pairingCharacteristic(uuid16)),
);
const permissions =
  Number(Platform.Version) >= 31
    ? [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

/** Converts a BLE error without retaining native error messages or characteristic values. */
function fault(error: unknown): BleFault {
  if (!(error instanceof BleError)) return "failed";
  switch (error.errorCode) {
    case BleErrorCode.BluetoothPoweredOff:
      return "off";
    case BleErrorCode.BluetoothUnauthorized:
      return "unauthorized";
    case BleErrorCode.DeviceNotFound:
      return "notFound";
    case BleErrorCode.OperationTimedOut:
    case BleErrorCode.DeviceConnectionFailed:
      return "timeout";
    case BleErrorCode.DeviceDisconnected:
    case BleErrorCode.DeviceNotConnected:
    case BleErrorCode.OperationCancelled:
      return "lost";
    default:
      return "failed";
  }
}

/** Keeps native promise rejections inside the frozen Bluetooth result shape. */
function result<T>(pending: Promise<T>): Promise<Outcome<T, BleFault>> {
  return pending.then(
    (value) => ({ ok: true, value }),
    (failure: unknown) => ({ ok: false, fault: fault(failure) }),
  );
}

/** Selects the known GATT service for one of the phone's characteristics. */
function serviceFor(characteristic: string): string {
  return pairing.has(characteristic) ? PROTOCOMM.serviceUuid : BLUETOOTH_UPDATE.serviceUuid;
}

/** ble-plx sends characteristic values as padded standard base64. */
function encode(bytes: Uint8Array): string {
  const text = toBase64url(bytes).replaceAll("-", "+").replaceAll("_", "/");
  return text.padEnd(Math.ceil(text.length / 4) * 4, "=");
}

/** Reads ble-plx's base64 value, or recognizes a missing or malformed read. */
function decode(value: string | null | undefined): Uint8Array | undefined {
  return value === null || value === undefined
    ? undefined
    : fromBase64url(value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""));
}

/** Wraps the discovered GATT connection and reports closure once to all its listeners. */
function gatt(device: Device, ble: BleManager): GattLink {
  const listeners = new Set<(fault: BleFault | null) => void>();
  let ended: BleFault | null | undefined;

  /** Releases the link listeners, remembering the result for late subscribers. */
  function finish(reason: BleFault | null): void {
    if (ended !== undefined) return;
    ended = reason;
    disconnected.remove();
    for (const listener of listeners) listener(reason);
    listeners.clear();
  }

  const disconnected = ble.onDeviceDisconnected(device.id, (failure) => {
    finish(failure === null ? "lost" : fault(failure));
  });
  return {
    mtu: device.mtu,
    async write(characteristic, data, response) {
      const value = encode(data);
      const service = serviceFor(characteristic);
      const written = await result(
        response
          ? device.writeCharacteristicWithResponseForService(service, characteristic, value)
          : device.writeCharacteristicWithoutResponseForService(service, characteristic, value),
      );
      return written.ok ? { ok: true, value: undefined } : written;
    },
    async read(characteristic) {
      const read = await result(
        device.readCharacteristicForService(serviceFor(characteristic), characteristic),
      );
      if (!read.ok) return read;
      const value = decode(read.value.value);
      return value === undefined ? { ok: false, fault: "failed" } : { ok: true, value };
    },
    watch(characteristic, data) {
      const watched = device.monitorCharacteristicForService(
        serviceFor(characteristic),
        characteristic,
        (failure, value) => {
          if (ended !== undefined) return;
          if (failure !== null) {
            if (failure.errorCode === BleErrorCode.OperationCancelled) return;
            finish(fault(failure));
            void ble.cancelDeviceConnection(device.id).catch(() => undefined);
            return;
          }
          const bytes = decode(value?.value);
          if (bytes !== undefined) data(bytes);
        },
      );
      return () => {
        watched.remove();
      };
    },
    onClosed(closed) {
      if (ended === undefined) listeners.add(closed);
      else closed(ended);
    },
    close() {
      if (ended !== undefined) return;
      finish(null);
      void ble.cancelDeviceConnection(device.id).catch(() => undefined);
    },
  };
}

/** Reads the initialized native manager's current radio state. */
async function nativeState(): Promise<BleState> {
  if (
    Platform.OS === "android" &&
    !(
      await Promise.all(
        permissions.map((permission) => PermissionsAndroid.check(permission).catch(() => false)),
      )
    ).every(Boolean)
  )
    return "unauthorized";
  if (manager === undefined) return "unauthorized";
  const current = await manager.state().catch(() => State.Unsupported);
  switch (current) {
    case State.PoweredOn:
      return "on";
    case State.PoweredOff:
    case State.Resetting:
      return "off";
    case State.Unauthorized:
      return "unauthorized";
    default:
      return "unsupported";
  }
}

/** Starts the manager after the explanatory page and asks Android's system permission. */
async function askNativeBluetooth(): Promise<BleState> {
  if (Platform.OS === "android") {
    const answered = await PermissionsAndroid.requestMultiple(permissions).catch(() => null);
    if (!permissions.every((permission) => answered?.[permission] === "granted"))
      return "unauthorized";
  }
  manager ??= new BleManager();
  return new Promise((resolve) => {
    /** Initial CoreBluetooth state may be unknown until its delegate runs. */
    function finish(state: Promise<BleState>) {
      clearTimeout(timeout);
      subscription.remove();
      void state.then(resolve);
    }
    const timeout = setTimeout(() => {
      finish(nativeState());
    }, 2000);
    const subscription = manager?.onStateChange((state) => {
      if (state !== State.Unknown && state !== State.Resetting) finish(nativeState());
    }, false) ?? { remove: () => undefined };
    void manager?.state().then(
      (state) => {
        if (state !== State.Unknown && state !== State.Resetting) finish(nativeState());
      },
      () => {
        finish(Promise.resolve("unsupported"));
      },
    );
  });
}

/** Scans and connects using ble-plx. BlueTooth state is read without prompting here. */
function blePlxCentral(): BleCentral {
  return {
    state: nativeState,
    scan(service, found) {
      const ble = manager;
      if (ble === undefined) return () => undefined;
      let scanning = true;
      void ble
        .startDeviceScan([service], { allowDuplicates: true }, (error, device) => {
          if (!scanning || error !== null || device === null) return;
          found({
            id: device.id,
            name: device.localName ?? device.name,
            serviceData: null,
            rssi: device.rssi ?? 0,
          });
        })
        .catch(() => undefined);
      return () => {
        if (!scanning) return;
        scanning = false;
        void ble.stopDeviceScan().catch(() => undefined);
      };
    },
    async connect(id, wantMtu) {
      const ble = manager;
      if (ble === undefined) return { ok: false, fault: "unauthorized" };
      const connected = await result(ble.connectToDevice(id, { timeout: 6500 }));
      if (!connected.ok) return connected;
      const device = connected.value;
      const mtuDevice =
        Platform.OS === "android" ? await device.requestMTU(wantMtu).catch(() => device) : device;
      const discovered = await result(mtuDevice.discoverAllServicesAndCharacteristics());
      if (discovered.ok) return { ok: true, value: gatt(discovered.value, ble) };
      void ble.cancelDeviceConnection(id).catch(() => undefined);
      return discovered;
    },
  };
}

let central: BleCentral = blePlxCentral();
let ask = askNativeBluetooth;
if (__DEV__ && process.env.EXPO_PUBLIC_HSN_BLE_BENCH !== undefined) {
  // Metro needs this dev-only require in a foldable branch.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { bridgeBleCentral } = require("../../../tools/ble-bench/src/bridge/client.ts") as {
    bridgeBleCentral: (url: string) => BleCentral;
  };
  central = bridgeBleCentral(process.env.EXPO_PUBLIC_HSN_BLE_BENCH as string);
  ask = () => central.state();
}

export { central as bleCentral, ask as askBluetooth };

/**
 * `BleCentral` over Chrome's Web Bluetooth, for the desk page (m3-design.md section 5, "A real
 * board without a phone"). Web Bluetooth's calls reject rather than return, so this file is in
 * `safe/` (rule 3), each turned into the frozen `Outcome`. What Web Bluetooth gives and does not:
 *
 * - **No passive scan.** `scan` asks Chrome for a device with the service (`requestDevice`), which
 *   shows Chrome's chooser and must come from a click; the advertisement's service data and signal
 *   are not given, so an `Advert` from here has `serviceData: null` and `rssi: 0`.
 * - **No MTU.** Chrome and the Mac settle it; the link says 23, Bluetooth's least, since a page
 *   cannot learn it. Pairing's writes with response and reads are long by themselves.
 */
import type {
  Advert,
  BleCentral,
  BleFault,
  BleState,
  GattLink,
} from "../../../../app/src/platform/ble.ts";
import { fault, ok, type Outcome } from "../../src/outcome.ts";

interface Characteristic {
  writeValueWithResponse(data: BufferSource): Promise<void>;
  writeValueWithoutResponse(data: BufferSource): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  readonly value?: DataView | null;
  addEventListener(type: "characteristicvaluechanged", listener: () => void): void;
  removeEventListener(type: "characteristicvaluechanged", listener: () => void): void;
}
interface Service {
  getCharacteristic(uuid: string): Promise<Characteristic>;
}
interface Server {
  readonly connected: boolean;
  connect(): Promise<Server>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<Service>;
}
interface Device {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: Server;
  addEventListener(type: "gattserverdisconnected", listener: () => void): void;
}
interface WebBluetooth {
  getAvailability(): Promise<boolean>;
  requestDevice(options: {
    filters: { services: string[] }[];
    optionalServices?: string[];
  }): Promise<Device>;
}

function bluetooth(): WebBluetooth | undefined {
  return (navigator as unknown as { readonly bluetooth?: WebBluetooth }).bluetooth;
}

/** The fault for a rejection from Web Bluetooth, by its DOMException name. */
function faultOf(thrown: unknown): BleFault {
  const name = thrown instanceof DOMException ? thrown.name : "";
  if (name === "NotFoundError") return "notFound";
  if (name === "SecurityError" || name === "NotAllowedError") return "unauthorized";
  if (name === "NetworkError") return "lost";
  if (name === "TimeoutError") return "timeout";
  return "failed";
}

function bytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

class WebLink implements GattLink {
  readonly mtu = 23;
  readonly #closed: ((fault: BleFault | null) => void)[] = [];
  #ended = false;
  #closing = false;
  readonly #characteristics = new Map<string, Characteristic>();

  constructor(
    readonly device: Device,
    readonly server: Server,
    readonly service: Service,
  ) {
    device.addEventListener("gattserverdisconnected", () => {
      if (this.#ended) return;
      this.#ended = true;
      const why = this.#closing ? null : "lost";
      for (const listener of this.#closed.splice(0)) listener(why);
    });
  }

  /** Read again after an await: the link may have gone meanwhile. */
  #isEnded(): boolean {
    return this.#ended;
  }

  async #characteristic(uuid: string): Promise<Outcome<Characteristic, BleFault>> {
    const known = this.#characteristics.get(uuid);
    if (known !== undefined) return ok(known);
    try {
      const found = await this.service.getCharacteristic(uuid);
      this.#characteristics.set(uuid, found);
      return ok(found);
    } catch (thrown) {
      return fault(faultOf(thrown));
    }
  }

  async write(
    characteristic: string,
    data: Uint8Array,
    response: boolean,
  ): Promise<Outcome<void, BleFault>> {
    if (this.#ended) return fault("lost");
    const found = await this.#characteristic(characteristic);
    if (!found.ok) return found;
    try {
      const copy = data.slice();
      if (response) await found.value.writeValueWithResponse(copy);
      else await found.value.writeValueWithoutResponse(copy);
      return ok(undefined);
    } catch (thrown) {
      return fault(this.#isEnded() ? "lost" : faultOf(thrown));
    }
  }

  async read(characteristic: string): Promise<Outcome<Uint8Array, BleFault>> {
    if (this.#ended) return fault("lost");
    const found = await this.#characteristic(characteristic);
    if (!found.ok) return found;
    try {
      return ok(bytes(await found.value.readValue()));
    } catch (thrown) {
      return fault(this.#isEnded() ? "lost" : faultOf(thrown));
    }
  }

  watch(characteristic: string, data: (bytes: Uint8Array) => void): () => void {
    let stop = false;
    let unhook: () => void = () => undefined;
    void this.#characteristic(characteristic).then(async (found) => {
      if (!found.ok || stop) return;
      const c = found.value;
      const listener = () => {
        if (c.value !== undefined && c.value !== null) data(bytes(c.value));
      };
      c.addEventListener("characteristicvaluechanged", listener);
      unhook = () => {
        c.removeEventListener("characteristicvaluechanged", listener);
        void c.stopNotifications().catch(() => undefined);
      };
      try {
        await c.startNotifications();
      } catch {
        unhook();
      }
    });
    return () => {
      stop = true;
      unhook();
    };
  }

  onClosed(closed: (fault: BleFault | null) => void): void {
    if (this.#ended)
      queueMicrotask(() => {
        closed(this.#closing ? null : "lost");
      });
    else this.#closed.push(closed);
  }

  close(): void {
    this.#closing = true;
    this.server.disconnect();
  }
}

/** Web Bluetooth as a `BleCentral`, for the one service the page pairs over. */
export function webBluetoothCentral(service: string): BleCentral {
  const chosen = new Map<string, Device>();
  return {
    async state(): Promise<BleState> {
      const web = bluetooth();
      if (web === undefined) return "unsupported";
      try {
        return (await web.getAvailability()) ? "on" : "off";
      } catch {
        return "unsupported";
      }
    },
    scan(wanted: string, found: (advert: Advert) => void): () => void {
      const web = bluetooth();
      let stopped = false;
      if (web === undefined) return () => undefined;
      web
        .requestDevice({ filters: [{ services: [wanted] }], optionalServices: [service] })
        .then((device) => {
          chosen.set(device.id, device);
          if (!stopped)
            found({ id: device.id, name: device.name ?? null, serviceData: null, rssi: 0 });
        })
        .catch(() => undefined);
      return () => {
        stopped = true;
      };
    },
    async connect(id: string): Promise<Outcome<GattLink, BleFault>> {
      const device = chosen.get(id);
      if (device?.gatt === undefined) return fault("notFound");
      try {
        const server = await device.gatt.connect();
        const primary = await server.getPrimaryService(service);
        return ok(new WebLink(device, server, primary));
      } catch (thrown) {
        return fault(faultOf(thrown));
      }
    },
  };
}

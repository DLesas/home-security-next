/**
 * The scripted air and `ScriptedCentral` on their own, with a bare peripheral: MTU negotiation and
 * the limits it puts on writes and notifications, long writes and reads, scanning (by service,
 * Android's repeats or iOS's once), the phone's Bluetooth states, the ends of a connection, and
 * the faults (latency in order, lost, repeated, corrupted, a drop, a refused connect, the sniffer).
 */
import { describe, expect, test } from "bun:test";
import { BleAir } from "../src/air/air.ts";
import { type CentralOptions, ScriptedCentral } from "../src/air/central.ts";
import type { Faults } from "../src/air/faults.ts";
import type {
  AdvertData,
  ConnectionHandlers,
  Peripheral,
  PeripheralConnection,
} from "../src/air/gatt.ts";
import { ManualClock } from "../src/clock.ts";
import { settled } from "./support/raw-phone.ts";

const SERVICE = "0000aaaa-0000-1000-8000-00805f9b34fb";
const IN = "0000aaa1-0000-1000-8000-00805f9b34fb";
const OUT = "0000aaa2-0000-1000-8000-00805f9b34fb";
const LONG = "0000aaa3-0000-1000-8000-00805f9b34fb";

class Probe implements Peripheral {
  readonly id = "probe";
  readonly rssi = -50;
  advertisingOn = true;
  connection: PeripheralConnection | undefined;
  readonly written: { data: Uint8Array; withResponse: boolean }[] = [];
  readonly subscriptions: [string, boolean][] = [];
  closedBy: boolean[] = [];
  constructor(readonly maxMtu = 517) {}
  advertising(): AdvertData | null {
    return this.advertisingOn && this.connection === undefined
      ? { serviceUuids: [SERVICE], serviceData: [[SERVICE, Uint8Array.of(7)]], localName: "probe" }
      : null;
  }
  accept(connection: PeripheralConnection): ConnectionHandlers | undefined {
    if (this.advertising() === null) return undefined;
    this.connection = connection;
    return {
      services: [
        {
          uuid: SERVICE,
          characteristics: [
            { uuid: IN, write: true, writeWithoutResponse: true },
            { uuid: OUT, notify: true },
            { uuid: LONG, read: true },
          ],
        },
      ],
      write: (_, data, withResponse) => {
        this.written.push({ data, withResponse });
        return data[0] === 0xee ? { ok: false, error: "invalidPdu" } : { ok: true };
      },
      read: () => ({ ok: true, value: new Uint8Array(512).fill(5) }),
      subscribed: (characteristic, on) => {
        this.subscriptions.push([characteristic, on]);
      },
      closed: (byCentral) => {
        this.closedBy.push(byCentral);
        this.connection = undefined;
      },
    };
  }
}

function world(faults: Faults = {}, central: CentralOptions = {}, probe = new Probe()) {
  const clock = new ManualClock();
  const air = new BleAir(clock, { advertIntervalMs: 100, connectTimeoutMs: 1000 });
  air.faults = faults;
  air.add(probe);
  return { clock, air, probe, central: new ScriptedCentral(air, central) };
}

async function linked(w: ReturnType<typeof world>, mtu = 517) {
  const connected = await settled(w.clock, w.central.connect("probe", mtu));
  return connected?.ok === true ? connected.value : undefined;
}

describe("MTU and its limits", () => {
  test("the link takes the least of the ask, the phone's and the board's, never under 23", async () => {
    for (const [ask, phone, board, agreed] of [
      [517, 517, 517, 517],
      [185, 517, 517, 185],
      [517, 185, 517, 185],
      [517, 517, 247, 247],
      [10, 517, 517, 23],
    ] as const) {
      const w = world({}, { maxMtu: phone }, new Probe(board));
      expect((await linked(w, ask))?.mtu).toBe(agreed);
    }
  });

  test("a write without response carries MTU − 3 at most; with response, a long write to 512", async () => {
    const w = world();
    const link = await linked(w, 185);
    if (link === undefined) return;
    expect(await settled(w.clock, link.write(IN, new Uint8Array(182), false))).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await settled(w.clock, link.write(IN, new Uint8Array(183), false))).toEqual({
      ok: false,
      fault: "failed",
    });
    expect(await settled(w.clock, link.write(IN, new Uint8Array(512), true))).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await settled(w.clock, link.write(IN, new Uint8Array(513), true))).toEqual({
      ok: false,
      fault: "failed",
    });
    expect(w.probe.written.map((x) => [x.data.length, x.withResponse])).toEqual([
      [182, false],
      [512, true],
    ]);
  });

  test("a notification carries MTU − 3 at most, and only once subscribed", async () => {
    const w = world();
    const link = await linked(w, 185);
    if (link === undefined) return;
    expect(w.probe.connection?.notify(OUT, new Uint8Array(10))).toBe(false);
    const got: number[] = [];
    link.watch(OUT, (bytes) => got.push(bytes.length));
    await w.clock.advance(1);
    expect(w.probe.subscriptions).toEqual([[OUT, true]]);
    expect(w.probe.connection?.notify(OUT, new Uint8Array(182))).toBe(true);
    expect(w.probe.connection?.notify(OUT, new Uint8Array(183))).toBe(false);
    await w.clock.advance(1);
    expect(got).toEqual([182]);
  });

  test("a long read returns all 512 bytes; an ATT error is failed; an unknown characteristic is failed", async () => {
    const w = world();
    const link = await linked(w, 23);
    if (link === undefined) return;
    const read = await settled(w.clock, link.read(LONG));
    expect(read?.ok === true && read.value.length).toBe(512);
    expect(await settled(w.clock, link.write(IN, Uint8Array.of(0xee), true))).toEqual({
      ok: false,
      fault: "failed",
    });
    expect(await settled(w.clock, link.read(IN))).toEqual({ ok: false, fault: "failed" });
    expect(
      await settled(
        w.clock,
        link.write("0000ffff-0000-1000-8000-00805f9b34fb", Uint8Array.of(1), true),
      ),
    ).toEqual({
      ok: false,
      fault: "failed",
    });
  });
});

describe("scanning and the phone's Bluetooth", () => {
  test("by service, every 100 ms as Android reports; once per scan as iOS does", async () => {
    const android = world();
    const seen: string[] = [];
    const stop = android.central.scan(SERVICE, (a) =>
      seen.push(`${a.id}:${a.name ?? ""}:${String(a.rssi)}`),
    );
    const none: string[] = [];
    android.central.scan("0000bbbb-0000-1000-8000-00805f9b34fb", (a) => none.push(a.id));
    await android.clock.advance(250);
    stop();
    await android.clock.advance(500);
    expect(seen).toEqual(["probe:probe:-50", "probe:probe:-50", "probe:probe:-50"]);
    expect(none).toEqual([]);
    const ios = world({}, { duplicates: false });
    const once: string[] = [];
    ios.central.scan(SERVICE, (a) => once.push(a.id));
    await ios.clock.advance(1000);
    expect(once).toEqual(["probe"]);
  });

  test("off, unauthorized, unsupported: nothing found, connect answers the state", async () => {
    for (const [state, fault] of [
      ["off", "off"],
      ["unauthorized", "unauthorized"],
      ["unsupported", "failed"],
    ] as const) {
      const w = world({}, { state });
      expect(await w.central.state()).toBe(state);
      const seen: string[] = [];
      w.central.scan(SERVICE, (a) => seen.push(a.id));
      await w.clock.advance(300);
      expect(seen).toEqual([]);
      expect(await settled(w.clock, w.central.connect("probe", 517))).toEqual({ ok: false, fault });
    }
  });

  test("connect: an unknown board is notFound; one that does not advertise times out; a refused one fails", async () => {
    const w = world({ refuseConnect: (attempt) => attempt === 2 });
    expect(await settled(w.clock, w.central.connect("nobody", 23))).toEqual({
      ok: false,
      fault: "notFound",
    });
    w.probe.advertisingOn = false;
    const started = w.clock.now();
    expect(await settled(w.clock, w.central.connect("probe", 23))).toEqual({
      ok: false,
      fault: "timeout",
    });
    expect(w.clock.now() - started).toBe(1000);
    w.probe.advertisingOn = true;
    expect(await settled(w.clock, w.central.connect("probe", 23))).toEqual({
      ok: false,
      fault: "failed",
    });
    expect((await settled(w.clock, w.central.connect("probe", 23)))?.ok).toBe(true);
  });
});

describe("the ends of a connection", () => {
  test("the phone closes: null for the phone, once; the board hears it; later calls are lost", async () => {
    const w = world();
    const link = await linked(w);
    if (link === undefined) return;
    const ends: (string | null)[] = [];
    link.onClosed((why) => ends.push(why));
    link.close();
    link.close();
    await w.clock.advance(1);
    expect(ends).toEqual([null]);
    expect(w.probe.closedBy).toEqual([true]);
    expect(await settled(w.clock, link.write(IN, Uint8Array.of(1), true))).toEqual({
      ok: false,
      fault: "lost",
    });
    const late: (string | null)[] = [];
    link.onClosed((why) => late.push(why));
    await w.clock.advance(1);
    expect(late).toEqual([null]);
  });

  test("the board closes: what was on its way arrives first, then lost", async () => {
    const w = world({ latencyMs: 20 });
    const link = await linked(w);
    if (link === undefined) return;
    const events: string[] = [];
    link.watch(OUT, () => events.push("notify"));
    link.onClosed((why) => events.push(`closed:${String(why)}`));
    await w.clock.advance(25);
    w.probe.connection?.notify(OUT, Uint8Array.of(1));
    w.probe.connection?.disconnect();
    await w.clock.advance(100);
    expect(events).toEqual(["notify", "closed:lost"]);
    expect(w.probe.closedBy).toEqual([false]);
  });

  test("a drop: both ends at once, and nothing on its way arrives", async () => {
    const w = world({ latencyMs: 20, dropAfter: (c) => c.kind === "write" && c.index === 1 });
    const link = await linked(w);
    if (link === undefined) return;
    const events: string[] = [];
    link.watch(OUT, () => events.push("notify"));
    link.onClosed((why) => events.push(`closed:${String(why)}`));
    await w.clock.advance(25);
    // The write reaches the board at +20 and the link drops; the notification sent at +10 would
    // have arrived at +30.
    const write = link.write(IN, Uint8Array.of(1), true);
    await w.clock.advance(10);
    w.probe.connection?.notify(OUT, Uint8Array.of(1));
    expect(await settled(w.clock, write)).toEqual({ ok: false, fault: "lost" });
    await w.clock.advance(100);
    expect(events).toEqual(["closed:lost"]);
    expect(w.probe.closedBy).toEqual([false]);
  });
});

describe("faults on the way", () => {
  test("latency keeps the order; lost and repeated notifications; a corrupted write; the sniffer hears all as sent", async () => {
    const w = world({
      latencyMs: 30,
      lose: (c) => c.kind === "notify" && c.index === 2,
      repeat: (c) => c.kind === "notify" && c.index === 3,
      corrupt: (c) => (c.kind === "write" && c.index === 1 ? Uint8Array.of(9) : undefined),
    });
    const heard: string[] = [];
    w.air.sniff((_, c) => heard.push(`${c.direction}:${c.kind}:${String(c.data[0])}`));
    const link = await linked(w);
    if (link === undefined) return;
    const got: number[] = [];
    link.watch(OUT, (bytes) => got.push(bytes[0] ?? -1));
    await w.clock.advance(31);
    for (let i = 1; i <= 4; i++) w.probe.connection?.notify(OUT, Uint8Array.of(i));
    await settled(w.clock, link.write(IN, Uint8Array.of(1), false));
    await w.clock.advance(100);
    expect(got).toEqual([1, 3, 3, 4]);
    expect(w.probe.written.map((x) => x.data[0])).toEqual([9]);
    expect(heard).toEqual([
      "toPhone:notify:1",
      "toPhone:notify:2",
      "toPhone:notify:3",
      "toPhone:notify:4",
      "toBoard:write:1",
    ]);
  });

  test("a lost write without response says ok to the phone, and never arrives", async () => {
    const w = world({ lose: (c) => c.kind === "write" });
    const link = await linked(w);
    if (link === undefined) return;
    expect(await settled(w.clock, link.write(IN, Uint8Array.of(1), false))).toEqual({
      ok: true,
      value: undefined,
    });
    await w.clock.advance(10);
    expect(w.probe.written).toEqual([]);
    // A write with response cannot be lost so: it arrives.
    await settled(w.clock, link.write(IN, Uint8Array.of(2), true));
    expect(w.probe.written.map((x) => x.data[0])).toEqual([2]);
  });

  test("a board's own faults replace the air's", async () => {
    const w = world({ latencyMs: 500 });
    w.air.setFaults("probe", { latencyMs: 1 });
    const started = w.clock.now();
    await linked(w);
    expect(w.clock.now() - started).toBe(2);
  });
});

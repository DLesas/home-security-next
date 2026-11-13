/**
 * The links module (hub-design.md section 2, module 3; section 8, "Accepting a device packet";
 * section 10): the link table and the sorting of frames. A USB frame starting 0xF1 is a setup
 * frame; a gateway's address, a gateway packet; a siren's address on a network link, a device
 * packet; anything else a counted rejection, with no AES spent.
 */
import { describe, expect, test } from "bun:test";
import { MessageType, toHex } from "@hsn/protocol";
import { linkId } from "../../../src/core/model/ids.ts";
import { DeviceState } from "../../../src/core/model/rows.ts";
import { CLOSED_LINKS_KEPT } from "../../../src/core/links/state.ts";
import {
  deviceAtAddress,
  linkCarrier,
  linkLabel,
  openLinks,
} from "../../../src/core/links/view.ts";
import {
  deviceOf,
  deviceRow,
  fieldCase,
  GATEWAY_ADDRESS,
  Harness,
  ofKind,
  rejectedCases,
  SENSOR_ADDRESS,
  SIREN_ADDRESS,
  snapshotWith,
} from "../gateways/harness.ts";

const siren = fieldCase("siren-report.json", "");
const heartbeat = fieldCase("heartbeat.json", "");
const hello = fieldCase("hello.json", "gateway hello");

function booted(): Harness {
  const h = new Harness();
  h.boot();
  return h;
}

/** What the links module made of one frame: the kinds of the messages it emitted. */
function sorted(h: Harness, link: number, bytes: Uint8Array) {
  const out = h.frame(linkId(link), bytes);
  return out.messages[0];
}

describe("sorting frames", () => {
  test("a USB frame starting 0xF1 is a setup frame; on a network link it is a rejection", () => {
    const h = booted();
    h.open(1, "usb");
    h.open(2, "network");
    // An Identity message (§10): 0xF1 0x02 and 21 bytes of fields.
    const identify = Uint8Array.from([0xf1, 0x02, ...new Uint8Array(21).fill(1)]);
    expect(sorted(h, 1, identify)).toEqual({
      kind: "setupFrame",
      link: linkId(1),
      bytes: identify,
    });
    expect(sorted(h, 2, identify)).toMatchObject({
      kind: "rejected",
      reason: "badVersion",
      source: { link: linkId(2) },
    });
  });

  test("a gateway's address is a gateway packet, on USB and network links alike", () => {
    const h = booted();
    h.open(1, "usb");
    h.open(2, "network");
    expect(sorted(h, 1, hello.packet)).toEqual({
      kind: "gatewayPacket",
      link: linkId(1),
      bytes: hello.packet,
    });
    expect(sorted(h, 2, hello.packet)).toEqual({
      kind: "gatewayPacket",
      link: linkId(2),
      bytes: hello.packet,
    });
  });

  test("a siren's address on a network link is a device packet arriving by Wi-Fi; on USB it is wrongPath", () => {
    const h = booted();
    h.open(1, "network");
    h.open(2, "usb");
    expect(sorted(h, 1, siren.packet)).toEqual({
      kind: "devicePacket",
      bytes: siren.packet,
      arrival: { path: "wifi", link: linkId(1) },
    });
    expect(sorted(h, 2, siren.packet)).toMatchObject({
      kind: "rejected",
      reason: "wrongPath",
      address: SIREN_ADDRESS,
    });
  });

  test("a sensor's address on a link is wrongPath: sensors talk through gateways (§5)", () => {
    const h = booted();
    h.open(1, "network");
    expect(sorted(h, 1, heartbeat.packet)).toMatchObject({
      kind: "rejected",
      reason: "wrongPath",
      address: SENSOR_ADDRESS,
      source: { link: linkId(1) },
    });
  });

  test("an address the hub does not know is unknownAddress, with no AES spent", () => {
    const h = new Harness();
    h.boot(snapshotWith({ devices: [] }));
    h.open(1, "network");
    const opened: number[] = [];
    const inner = h.cipher;
    h.cipher = {
      seal: (...args) => inner.seal(...args),
      open: (device, packet, request) => {
        opened.push(device);
        return inner.open(device, packet, request);
      },
    };
    for (const bytes of [siren.packet, hello.packet]) {
      const out = h.frame(linkId(1), bytes);
      expect(out.messages).toHaveLength(1);
      expect(out.messages[0]).toMatchObject({ kind: "rejected", reason: "unknownAddress" });
    }
    expect(opened).toEqual([]);
  });

  test("a packet in the hub's own direction is wrongDirection before any key is looked up", () => {
    const h = booted();
    h.open(1, "network");
    const fromHub = fieldCase("welcome.json", "welcome, bound").packet;
    expect(sorted(h, 1, fromHub)).toMatchObject({
      kind: "rejected",
      reason: "wrongDirection",
      address: GATEWAY_ADDRESS,
    });
  });

  test("every header-level rejected vector is counted with its error, its first 16 bytes as the sample", () => {
    // The errors the clear header shows; a packet under 18 bytes is truncated before the header.
    const headerErrors = new Set(["badVersion", "badAddress", "badCounter"]);
    const cases = rejectedCases().filter(
      (c) =>
        c.expectedDirection === 0 &&
        (headerErrors.has(c.error) || (c.error === "truncated" && c.packet.length < 18)),
    );
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const c of cases) {
      const h = booted();
      h.open(1, "network");
      const out = h.frame(linkId(1), c.packet);
      const rejections = ofKind(out.messages, "rejected");
      expect(rejections.map((r) => [r.reason, toHex(r.sample)])).toEqual([
        [c.error, toHex(c.packet.slice(0, 16))],
      ]);
      expect(out.messages).toHaveLength(1);
    }
  });

  test("a frame on a link the core never saw open is rejected", () => {
    const h = booted();
    expect(sorted(h, 9, hello.packet)).toMatchObject({
      kind: "rejected",
      reason: "wrongPath",
      source: { link: linkId(9) },
    });
  });

  test("a removed device is no longer known, an added one is", () => {
    const h = booted();
    h.open(1, "network");
    h.input({ kind: "deviceRemoved", device: deviceOf(SIREN_ADDRESS) });
    expect(sorted(h, 1, siren.packet)).toMatchObject({ reason: "unknownAddress" });
    h.input({
      kind: "deviceAdded",
      device: deviceOf(SIREN_ADDRESS),
      role: 2,
      address: SIREN_ADDRESS,
      name: "hall",
    });
    expect(sorted(h, 1, siren.packet)).toMatchObject({ kind: "devicePacket" });
    expect(deviceAtAddress(h.state, SIREN_ADDRESS)).toEqual({
      device: deviceOf(SIREN_ADDRESS),
      address: SIREN_ADDRESS,
      role: 2,
    });
  });

  test("the boot snapshot's removed devices are not known", () => {
    const h = new Harness();
    h.boot(snapshotWith({ devices: [deviceRow(SIREN_ADDRESS, 2, DeviceState.Removed)] }));
    h.open(1, "network");
    expect(sorted(h, 1, siren.packet)).toMatchObject({ reason: "unknownAddress" });
  });
});

describe("the link table", () => {
  test("a link opens with its kind and label, carrier unknown; closing it keeps its label for a while", () => {
    const h = booted();
    h.open(3, "usb", "/dev/ttyACM0");
    expect(openLinks(h.state)).toEqual([{ link: linkId(3), kind: "usb", label: "/dev/ttyACM0" }]);
    expect(linkCarrier(h.state, linkId(3))).toEqual({ kind: "unknown" });
    h.input({ kind: "linkClosed", link: linkId(3), reason: "remote" });
    expect(openLinks(h.state)).toEqual([]);
    expect(linkLabel(h.state, linkId(3))).toBe("/dev/ttyACM0");
    for (let i = 0; i < CLOSED_LINKS_KEPT; i++) {
      h.open(100 + i);
      h.input({ kind: "linkClosed", link: linkId(100 + i), reason: "remote" });
    }
    expect(linkLabel(h.state, linkId(3))).toBeUndefined();
  });

  test("a text message's close is counted as a textFrame rejection on that link", () => {
    const h = booted();
    h.open(4, "network", "192.168.1.9:5000");
    const out = h.input({ kind: "linkClosed", link: linkId(4), reason: "textMessage" });
    expect(ofKind(out.messages, "rejected").map((r) => [r.reason, r.source])).toEqual([
      ["textFrame", { link: linkId(4) }],
    ]);
    expect(
      ofKind(
        h.input({ kind: "linkClosed", link: linkId(5), reason: "remote" }).messages,
        "rejected",
      ),
    ).toEqual([]);
  });

  test("a proven gateway session marks its link; a siren's accepted Wi-Fi packet marks its socket", () => {
    const h = booted();
    h.open(1);
    h.open(2);
    h.input({ kind: "gatewayUp", gateway: deviceOf(GATEWAY_ADDRESS), link: linkId(1) });
    expect(linkCarrier(h.state, linkId(1))).toEqual({
      kind: "gateway",
      device: deviceOf(GATEWAY_ADDRESS),
    });
    h.input({ kind: "gatewayUp", gateway: deviceOf(GATEWAY_ADDRESS), link: linkId(2) });
    expect(linkCarrier(h.state, linkId(1))).toEqual({ kind: "unknown" });
    h.input({
      kind: "accepted",
      device: deviceOf(SIREN_ADDRESS),
      role: 2,
      counter: 1,
      message: {
        type: MessageType.Started,
        role: 2,
        firmwareVersion: { major: 1, minor: 0, patch: 0 },
        resetCause: 1,
        lastFatalError: 0,
        settingsVersion: 1,
      },
      arrival: { path: "wifi", link: linkId(1) },
      record: 0 as never,
      newest: true,
    });
    expect(linkCarrier(h.state, linkId(1))).toEqual({
      kind: "siren",
      device: deviceOf(SIREN_ADDRESS),
    });
  });
});

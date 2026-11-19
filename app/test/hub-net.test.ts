/**
 * `hub-net`'s TypeScript side (`app/modules/hub-net/`), over a stand-in for the native module: the
 * TXT record as iOS's bytes and as Android's map, every shape of the hub's three keys, good and
 * bad; addresses; the events and answers the native side may send, understood or dropped; found,
 * updated and lost hubs; the browse's window and its sessions; every fault; the local network
 * permission; and the `HubFinder` as the phone's client uses it (`src/hub/finder.ts`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatIdentity } from "@hsn/protocol/app";
import { appConfig } from "../app.config.ts";
import { browseFor, foundTargets } from "../src/hub/finder";
import { type HubChange, hubBrowser } from "../modules/hub-net/src/browser";
import {
  DNS_POLICY_DENIED,
  HUB_SERVICE,
  type HubNetNative,
  NSD_PERMISSION_DENIED,
  readEvent,
  readPermission,
  readStartAnswer,
} from "../modules/hub-net/src/contract";
import { finderFault, finderOf, hubNetOver } from "../modules/hub-net/src/finder";
import {
  readAddress,
  readAddresses,
  readHubRecord,
  txtFromEntries,
  txtFromWire,
} from "../modules/hub-net/src/record";
import { manualTimers, settle } from "./support/timers";

const AID = formatIdentity(new Uint8Array(16).fill(0x11));
const OTHER_AID = formatIdentity(new Uint8Array(16).fill(0x22));
const ID = "0123456789abcdef";

const ascii = (text: string) => [...new TextEncoder().encode(text)];

/** A TXT record's bytes: each string a length byte and its bytes. */
function wire(...strings: readonly (string | readonly number[])[]): number[] {
  return strings.flatMap((s) => {
    const bytes = typeof s === "string" ? ascii(s) : [...s];
    return [bytes.length, ...bytes];
  });
}

/** The record the hub gives once its apps' listener is open (`txtRecord` in mdns.ts). */
const hubWire = (app = "8444", aid = AID, id = ID) => wire(`id=${id}`, `app=${app}`, `aid=${aid}`);

const readWire = (bytes: readonly number[]) => readHubRecord(txtFromWire(new Uint8Array(bytes)));

const entries = (map: Readonly<Record<string, string | null>>) =>
  Object.entries(map).map(([k, v]) => [k, v === null ? null : new Uint8Array(ascii(v))] as const);

// ----- The TXT record and the hub's keys -----

describe("the TXT record as bytes (iOS), RFC 6763 section 6", () => {
  test("the hub's record is read: its three keys, the device identity lower-cased", () => {
    expect(readWire(hubWire())).toEqual({
      ok: true,
      record: { id: ID, identity: AID, appsPort: 8444 },
    });
    expect(readWire(hubWire("8444", AID, ID.toUpperCase()))).toEqual({
      ok: true,
      record: { id: ID, identity: AID, appsPort: 8444 },
    });
  });

  test("keys are matched without regard to case; other keys and their order do not matter", () => {
    const bytes = wire("txtvers=1", `AID=${AID}`, "App=8444", `Id=${ID}`, "flag");
    expect(readWire(bytes)).toEqual({
      ok: true,
      record: { id: ID, identity: AID, appsPort: 8444 },
    });
  });

  test("a key given twice keeps its first value, whichever it is", () => {
    expect(readWire([...hubWire(), ...wire("app=1")]).ok).toBe(true);
    expect(readWire([...wire("app=bad"), ...hubWire()])).toEqual({
      ok: false,
      fault: "malformedKey",
    });
    expect(readWire([...wire("APP=9000"), ...hubWire()])).toMatchObject({
      record: { appsPort: 9000 },
    });
  });

  test("empty strings, strings with no key and keys that are not printable ASCII are skipped", () => {
    expect(readWire([0, ...wire("=x"), ...hubWire(), 0]).ok).toBe(true);
    expect(txtFromWire(new Uint8Array(wire("=8444")))?.size).toBe(0);
    expect(readWire(wire([0x69, 0x64, 0x01, 0x3d, 0x31], "app=8444", `aid=${AID}`))).toEqual({
      ok: false,
      fault: "missingKey",
    });
    expect(txtFromWire(new Uint8Array(wire([0xc3, 0xa9, 0x3d, 0x31])))?.size).toBe(0);
  });

  test("a string that runs past the record's end makes the whole record unreadable", () => {
    const good = hubWire();
    expect(readWire([...good, 5, 0x61])).toEqual({ ok: false, fault: "malformedTxt" });
    expect(readWire([...good.slice(0, -1)])).toEqual({ ok: false, fault: "malformedTxt" });
    expect(readWire([1])).toEqual({ ok: false, fault: "malformedTxt" });
    // A string of exactly the bytes left is whole.
    expect(txtFromWire(new Uint8Array([1, 0x61]))?.get("a")).toBeNull();
  });

  test("an empty record, or one with `id` alone (no apps' listener yet), is missing keys", () => {
    expect(readWire([])).toEqual({ ok: false, fault: "missingKey" });
    expect(readWire(wire(`id=${ID}`))).toEqual({ ok: false, fault: "missingKey" });
    expect(readWire(wire(`id=${ID}`, "app=8444"))).toEqual({ ok: false, fault: "missingKey" });
    expect(readWire(wire(`id=${ID}`, `aid=${AID}`))).toEqual({ ok: false, fault: "missingKey" });
    expect(readWire(wire("app=8444", `aid=${AID}`))).toEqual({ ok: false, fault: "missingKey" });
  });

  test("a key with no `=`, or an empty value, is malformed", () => {
    expect(readWire(wire(`id=${ID}`, "app", `aid=${AID}`))).toEqual({
      ok: false,
      fault: "malformedKey",
    });
    expect(readWire(wire("id=", "app=8444", `aid=${AID}`))).toEqual({
      ok: false,
      fault: "malformedKey",
    });
  });
});

describe("the hub's keys, at their edges", () => {
  const port = (app: string) => readWire(hubWire(app));
  const aid = (value: string) => readWire(hubWire("8444", value));
  const id = (value: string) => readWire(hubWire("8444", AID, value));

  test("`app`: decimal 1 to 65535, no sign, no leading zero, no space", () => {
    expect(port("1")).toMatchObject({ ok: true, record: { appsPort: 1 } });
    expect(port("65535")).toMatchObject({ ok: true, record: { appsPort: 65_535 } });
    for (const bad of [
      "0",
      "65536",
      "99999",
      "100000",
      "08444",
      "+8444",
      "-1",
      " 8444",
      "8444 ",
      "84.4",
      "0x20fc",
      "",
    ])
      expect(port(bad)).toEqual({ ok: false, fault: "malformedKey" });
  });

  test("`aid`: 26 characters of the protocol's base32, lower case", () => {
    expect(aid(AID).ok).toBe(true);
    for (const bad of [
      AID.slice(0, 25),
      `${AID}a`,
      AID.toUpperCase(),
      `${AID.slice(0, 25)}1`,
      `${AID.slice(0, 25)}8`,
      `${AID.slice(0, 25)}=`,
    ])
      expect(aid(bad)).toEqual({ ok: false, fault: "malformedKey" });
  });

  test("`id`: 16 hex digits", () => {
    expect(id("ffffffffffffffff").ok).toBe(true);
    for (const bad of [ID.slice(0, 15), `${ID}0`, `${ID.slice(0, 15)}g`, `0x${ID.slice(2)}`])
      expect(id(bad)).toEqual({ ok: false, fault: "malformedKey" });
  });

  test("a value that is not printable ASCII is malformed", () => {
    const bytes = wire(`id=${ID}`, [...ascii("app=844"), 0xb4], `aid=${AID}`);
    expect(readWire(bytes)).toEqual({ ok: false, fault: "malformedKey" });
    expect(readWire(wire(`id=${ID}`, [...ascii("app=8444"), 0], `aid=${AID}`)).ok).toBe(false);
  });
});

describe("the TXT record as Android's map", () => {
  test("the hub's record is read, its keys in any case", () => {
    expect(readHubRecord(txtFromEntries(entries({ id: ID, app: "8444", aid: AID })))).toEqual({
      ok: true,
      record: { id: ID, identity: AID, appsPort: 8444 },
    });
    expect(readHubRecord(txtFromEntries(entries({ ID: ID, APP: "8444", Aid: AID }))).ok).toBe(true);
  });

  test("a key in two cases with one value is kept; with two values the record cannot be read", () => {
    expect(
      readHubRecord(txtFromEntries(entries({ id: ID, app: "8444", APP: "8444", aid: AID }))).ok,
    ).toBe(true);
    expect(
      readHubRecord(txtFromEntries(entries({ id: ID, app: "8444", APP: "9000", aid: AID }))),
    ).toEqual({ ok: false, fault: "malformedTxt" });
    expect(
      readHubRecord(txtFromEntries(entries({ id: ID, app: null, APP: "8444", aid: AID }))),
    ).toEqual({ ok: false, fault: "malformedTxt" });
  });

  test("a key with no value is malformed; a key that is not ASCII is skipped", () => {
    expect(readHubRecord(txtFromEntries(entries({ id: ID, app: null, aid: AID })))).toEqual({
      ok: false,
      fault: "malformedKey",
    });
    expect(readHubRecord(txtFromEntries(entries({ ïd: ID, app: "8444", aid: AID })))).toEqual({
      ok: false,
      fault: "missingKey",
    });
  });
});

// ----- Addresses -----

describe("addresses, in the form the app's finder takes", () => {
  test("IPv4 first, then IPv6, then IPv6 link-local with its zone; each once", () => {
    expect(
      readAddresses([
        "fe80::1%en0",
        "FD00::20",
        "192.168.1.20",
        "[fd00::21]",
        "192.168.1.20",
        "fd00::20",
        "10.0.0.5",
      ]),
    ).toEqual(["192.168.1.20", "10.0.0.5", "fd00::20", "fd00::21", "fe80::1%en0"]);
  });

  test("an IPv6 address in RFC 5952's text, as Java's every-group form or any other", () => {
    for (const [given, text] of [
      ["FD00:0:0:0:0:0:0:20", "fd00::20"],
      ["fd00:0000:0000:0000:0000:0000:0000:0020", "fd00::20"],
      ["fe80:0:0:0:200:f8ff:fe21:67cf%wlan0", "fe80::200:f8ff:fe21:67cf%wlan0"],
      ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
      ["2001:db8:0:1:0:0:0:1", "2001:db8:0:1::1"],
      ["1:0:2:0:3:0:4:0", "1:0:2:0:3:0:4:0"],
      ["0:0:0:0:0:0:0:1", "::1"],
      ["::", "::"],
      ["fd00::", "fd00::"],
      // One zero group is never "::" (RFC 5952 4.2.2); the longest run is, the first of two alike.
      ["::2:3:4:5:6:7:8", "0:2:3:4:5:6:7:8"],
      ["1:0:0:2:0:0:0:3", "1:0:0:2::3"],
      ["1:0:0:2:0:0:3:4", "1::2:0:0:3:4"],
      ["fd00::10.0.0.1", "fd00::a00:1"],
    ] as const)
      expect(readAddress(given)?.address).toBe(text);
  });

  test("an IPv4-mapped IPv6 address is its IPv4 address", () => {
    expect(readAddress("::ffff:192.168.1.20")).toEqual({ address: "192.168.1.20", rank: 0 });
    expect(readAddress("::ffff:c0a8:0114")).toEqual({ address: "192.168.1.20", rank: 0 });
  });

  test("anything that is not an address is left out", () => {
    for (const bad of [
      "",
      "hub.local",
      "192.168.1.256",
      "192.168.1",
      "192.168.01.1",
      "1.2.3.4.5",
      "fd00::1::2",
      "10.0.0.1::1",
      "fd00:10.0.0.1::1",
      "fd00:1:2:3:4:5:6:7:8",
      "fe80::1%",
      "fe80::1%en 0",
      "/192.168.1.20",
      "fd00::g",
    ])
      expect(readAddress(bad)).toBeUndefined();
    expect(readAddresses(["nope", "10.0.0.1"])).toEqual(["10.0.0.1"]);
  });

  test("a link-local address keeps its zone, which the phone's finder then leaves out", () => {
    expect(readAddress("FE80::1%wlan0")).toEqual({ address: "fe80::1%wlan0", rank: 2 });
    expect(readAddress("fe80::1")).toEqual({ address: "fe80::1", rank: 2 });
    expect(readAddress("febf::1")?.rank).toBe(2);
    expect(readAddress("fec0::1")?.rank).toBe(1);
    expect(
      foundTargets(
        [{ identity: AID, appsPort: 8444, addresses: readAddresses(["fe80::1%en0", "fd00::1"]) }],
        AID,
      ),
    ).toEqual([{ identity: AID, addresses: ["fd00::1"], port: 8444 }]);
  });
});

// ----- What the native side sends -----

describe("the native side's events and answers, read as unknown", () => {
  const good = {
    kind: "service",
    session: 1,
    name: "hsn-0123456789abcdef",
    port: 8443,
    addresses: ["192.168.1.20"],
    txt: { raw: hubWire() },
  };

  test("a service event, with a raw or a mapped TXT record", () => {
    expect(readEvent(good)).toMatchObject({ kind: "service", session: 1, port: 8443 });
    expect(readEvent({ ...good, txt: { entries: { id: ascii(ID), flag: null } } })).toMatchObject({
      txt: {
        kind: "entries",
        entries: [
          ["id", new Uint8Array(ascii(ID))],
          ["flag", null],
        ],
      },
    });
  });

  test("every other kind, and anything malformed, dropped", () => {
    expect(readEvent({ kind: "lost", session: 2, name: "x" })).toEqual({
      kind: "lost",
      session: 2,
      name: "x",
    });
    expect(readEvent({ kind: "network", session: 2, local: false })).toEqual({
      kind: "network",
      session: 2,
      local: false,
    });
    expect(
      readEvent({ kind: "state", session: 2, state: "waiting", domain: "dns", code: -65_570 }),
    ).toEqual({ kind: "state", session: 2, state: "waiting", domain: "dns", code: -65_570 });
    for (const bad of [
      null,
      "service",
      [],
      { ...good, session: -1 },
      { ...good, session: 1.5 },
      { ...good, session: "1" },
      { ...good, name: "" },
      { ...good, port: "8443" },
      { ...good, addresses: "192.168.1.20" },
      { ...good, addresses: [1] },
      { ...good, txt: undefined },
      { ...good, txt: { raw: [256] } },
      { ...good, txt: { raw: [-1] } },
      { ...good, txt: { raw: [1.5] } },
      { ...good, txt: { raw: "id=1" } },
      { ...good, txt: { entries: { id: "abc" } } },
      { ...good, txt: { entries: [] } },
      { ...good, kind: "found" },
      { kind: "lost", session: 1 },
      { kind: "network", session: 1, local: "no" },
      { kind: "state", session: 1, state: "lost", domain: "dns", code: 1 },
      { kind: "state", session: 1, state: "ready", domain: "mdns", code: 1 },
      { kind: "state", session: 1, state: "ready", domain: "dns", code: 1.5 },
    ])
      expect(readEvent(bad)).toBeUndefined();
  });

  test("start's answer: started, or refused; anything else is a failure", () => {
    expect(readStartAnswer({ started: true })).toEqual({ kind: "started" });
    expect(readStartAnswer({ refused: "unsupported", code: 0 })).toEqual({
      kind: "refused",
      why: "unsupported",
      code: 0,
    });
    expect(readStartAnswer({ refused: "failed", code: 4 })).toEqual({
      kind: "refused",
      why: "failed",
      code: 4,
    });
    for (const odd of [undefined, null, { started: "yes" }, { refused: "maybe" }, "started"])
      expect(readStartAnswer(odd)).toMatchObject({ kind: "refused", why: "failed" });
  });

  test("a permission: one of four states and whether it can be asked again", () => {
    expect(readPermission({ state: "unreadable", canAskAgain: true })).toEqual({
      state: "unreadable",
      canAskAgain: true,
    });
    for (const odd of [
      { state: "granted" },
      { state: "maybe", canAskAgain: true },
      null,
      "granted",
    ])
      expect(readPermission(odd)).toBeUndefined();
  });
});

// ----- The browse, over a stand-in native module -----

interface StandIn {
  readonly native: HubNetNative;
  readonly calls: string[];
  /** The session the last start named. */
  readonly session: () => number;
  readonly listening: () => number;
  emit(event: unknown): void;
  answerStart(answer: unknown): void;
  rejectStart(): void;
  setPermission(answer: unknown, asked?: unknown): void;
}

function standIn(): StandIn {
  const listeners = new Set<(event: unknown) => void>();
  const calls: string[] = [];
  let session = 0;
  let start: () => Promise<unknown> = () => Promise.resolve({ started: true });
  let permission: unknown = { state: "granted", canAskAgain: true };
  let asked: unknown = permission;
  const native: HubNetNative = {
    start: (type, named) => {
      calls.push(`start ${type} ${String(named)}`);
      session = named;
      return start();
    },
    stop: (named) => {
      calls.push(`stop ${String(named)}`);
      return Promise.resolve(null);
    },
    permission: () => {
      calls.push("permission");
      return Promise.resolve(permission);
    },
    ask: () => {
      calls.push("ask");
      return Promise.resolve(asked);
    },
    listen: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    native,
    calls,
    session: () => session,
    listening: () => listeners.size,
    emit: (event) => {
      for (const l of [...listeners]) l(event);
    },
    answerStart: (answer) => {
      start = () => Promise.resolve(answer);
    },
    rejectStart: () => {
      start = () => Promise.reject(new Error("no module"));
    },
    setPermission: (answer, askAnswer = answer) => {
      permission = answer;
      asked = askAnswer;
    },
  };
}

const NAME = "hsn-0123456789abcdef";

const service = (
  session: number,
  options: { name?: string; addresses?: readonly string[]; txt?: unknown } = {},
) => ({
  kind: "service",
  session,
  name: options.name ?? NAME,
  port: 8443,
  addresses: options.addresses ?? ["192.168.1.20"],
  txt: options.txt ?? { raw: hubWire() },
});

const hubAt = (addresses: readonly string[], extra: { name?: string; identity?: string } = {}) => ({
  name: extra.name ?? NAME,
  id: ID,
  identity: extra.identity ?? AID,
  appsPort: 8444,
  addresses,
});

function setUp() {
  const timers = manualTimers();
  const side = standIn();
  const browser = hubBrowser(side.native, timers);
  const seen: HubChange[] = [];
  return { timers, side, browser, seen, record: (c: HubChange) => seen.push(c) };
}

describe("watching: found, updated, lost", () => {
  test("the browse starts at the first watch, for the hub's service, and stops at the last", async () => {
    const { side, browser, record } = setUp();
    const stopA = browser.watch(record);
    const stopB = browser.watch(() => undefined);
    expect(side.calls).toEqual([`start ${HUB_SERVICE} 1`]);
    expect(side.listening()).toBe(1);
    stopA();
    stopA();
    expect(side.calls).toEqual([`start ${HUB_SERVICE} 1`]);
    stopB();
    await settle();
    expect(side.calls).toEqual([`start ${HUB_SERVICE} 1`, "stop 1"]);
    expect(side.listening()).toBe(0);
    expect(browser.diagnostics().browsing).toBe(false);
  });

  test("a hub found, its addresses changed, its record unchanged (nothing told), then lost", () => {
    const { side, browser, seen, record } = setUp();
    browser.watch(record);
    side.emit(service(1));
    side.emit(service(1, { addresses: ["192.168.1.20", "fd00::20"] }));
    side.emit(service(1, { addresses: ["fd00::20", "192.168.1.20"] }));
    side.emit({ kind: "lost", session: 1, name: NAME });
    side.emit({ kind: "lost", session: 1, name: NAME });
    expect(seen).toEqual([
      { kind: "found", hub: hubAt(["192.168.1.20"]) },
      { kind: "updated", hub: hubAt(["192.168.1.20", "fd00::20"]) },
      { kind: "lost", name: NAME },
    ]);
  });

  test("a record that turns malformed is lost and counted; turning good again, it is found", () => {
    const { side, browser, seen, record } = setUp();
    browser.watch(record);
    side.emit(service(1));
    side.emit(service(1, { txt: { raw: hubWire("0") } }));
    expect(browser.diagnostics().ignored).toEqual({
      missingKey: 0,
      malformedKey: 1,
      malformedTxt: 0,
    });
    side.emit(service(1));
    expect(seen.map((c) => c.kind)).toEqual(["found", "lost", "found"]);
    expect(browser.diagnostics().ignored.malformedKey).toBe(0);
  });

  test("a good record with no address yet is not found until one comes", () => {
    const { side, browser, seen, record } = setUp();
    browser.watch(record);
    side.emit(service(1, { addresses: [] }));
    side.emit(service(1, { addresses: ["hub.local"] }));
    expect(seen).toEqual([]);
    side.emit(service(1, { addresses: ["10.0.0.9"] }));
    side.emit(service(1, { addresses: [] }));
    const expected: HubChange[] = [
      { kind: "found", hub: hubAt(["10.0.0.9"]) },
      { kind: "lost", name: NAME },
    ];
    expect(seen).toEqual(expected);
  });

  test("a second watcher is told what the first already has", () => {
    const { side, browser, record, seen } = setUp();
    browser.watch(() => undefined);
    side.emit(service(1));
    side.emit({
      kind: "state",
      session: 1,
      state: "waiting",
      domain: "dns",
      code: DNS_POLICY_DENIED,
    });
    browser.watch(record);
    expect(seen).toEqual([
      { kind: "found", hub: hubAt(["192.168.1.20"]) },
      { kind: "fault", fault: "localNetworkDenied" },
    ]);
  });

  test("events of another session are not this one's, whenever they come", async () => {
    const { side, browser, seen, record } = setUp();
    const stop = browser.watch(record);
    stop();
    await settle();
    browser.watch(record);
    expect(side.session()).toBe(2);
    side.emit(service(1));
    side.emit({ kind: "lost", session: 1, name: NAME });
    side.emit({ kind: "state", session: 1, state: "failed", domain: "dns", code: -65_537 });
    expect(seen).toEqual([]);
    side.emit(service(2));
    expect(seen).toEqual([{ kind: "found", hub: hubAt(["192.168.1.20"]) }]);
  });

  test("events that arrive before start's answer are the session's", async () => {
    const { side, browser, seen, record } = setUp();
    let answer: (value: unknown) => void = () => undefined;
    side.native.start = (type, named) => {
      side.calls.push(`start ${type} ${String(named)}`);
      return new Promise((resolve) => {
        answer = resolve;
      });
    };
    browser.watch(record);
    side.emit(service(1));
    answer({ started: true });
    await settle();
    expect(seen).toEqual([{ kind: "found", hub: hubAt(["192.168.1.20"]) }]);
  });

  test("an event the TypeScript side cannot read is counted, never thrown on", () => {
    const { side, browser, seen, record } = setUp();
    browser.watch(record);
    side.emit({ kind: "service", session: 1 });
    side.emit(undefined);
    side.emit({
      kind: "service",
      session: 1,
      name: NAME,
      port: 1,
      addresses: [],
      txt: { raw: [300] },
    });
    expect(seen).toEqual([]);
    expect(browser.diagnostics().unreadEvents).toBe(3);
  });
});

describe("browse(ms): the window a HubFinder asks for", () => {
  test("answers the hubs found by the window's end, then stops the native browse", async () => {
    const { timers, side, browser } = setUp();
    const found = browser.browse(2000);
    side.emit(service(1));
    side.emit(service(1, { name: "hsn-other", txt: { raw: hubWire("9000", OTHER_AID) } }));
    timers.advance(1999);
    await settle();
    expect(side.calls).toEqual([`start ${HUB_SERVICE} 1`]);
    timers.advance(1);
    expect(await found).toEqual({
      ok: true,
      value: [
        hubAt(["192.168.1.20"]),
        { ...hubAt(["192.168.1.20"], { name: "hsn-other", identity: OTHER_AID }), appsPort: 9000 },
      ],
    });
    expect(side.calls).toEqual([`start ${HUB_SERVICE} 1`, "stop 1"]);
    expect(timers.asked).toEqual([2000]);
  });

  test("a hub lost before the window ends is not answered", async () => {
    const { timers, side, browser } = setUp();
    const found = browser.browse(2000);
    side.emit(service(1));
    side.emit({ kind: "lost", session: 1, name: NAME });
    timers.advance(2000);
    expect(await found).toEqual({ ok: true, value: [] });
  });

  test("two records of one app identity are one hub: the one changed last", async () => {
    const { timers, side, browser } = setUp();
    const found = browser.browse(2000);
    side.emit(service(1, { name: "hsn-a", addresses: ["10.0.0.1"] }));
    side.emit(service(1, { name: "hsn-b", addresses: ["10.0.0.2"] }));
    side.emit(service(1, { name: "hsn-a", addresses: ["10.0.0.3"] }));
    timers.advance(2000);
    expect(await found).toEqual({ ok: true, value: [hubAt(["10.0.0.3"], { name: "hsn-a" })] });
  });

  test("nothing found is not a failure; the records left out are counted, by why", async () => {
    const { timers, side, browser } = setUp();
    const found = browser.browse(2000);
    side.emit(service(1, { name: "a", txt: { raw: wire(`id=${ID}`) } }));
    side.emit(service(1, { name: "b", txt: { raw: hubWire("8444", "nope") } }));
    side.emit(service(1, { name: "c", txt: { raw: [9, 1] } }));
    side.emit(service(1, { name: "d", txt: { entries: { id: ascii(ID) } } }));
    timers.advance(2000);
    expect(await found).toEqual({ ok: true, value: [] });
    expect(browser.diagnostics()).toEqual({
      browsing: false,
      found: 0,
      ignored: { missingKey: 2, malformedKey: 1, malformedTxt: 1 },
      unreadEvents: 0,
      fault: null,
    });
  });

  test("a window of 0, or not a number, ends at once", async () => {
    const { timers, browser } = setUp();
    const zero = browser.browse(0);
    const odd = browser.browse(Number.NaN);
    timers.advance(0);
    expect(await zero).toEqual({ ok: true, value: [] });
    expect(await odd).toEqual({ ok: true, value: [] });
    expect(timers.asked).toEqual([0, 0]);
  });

  test("two browses at once share one native browse; the next starts afresh", async () => {
    const { timers, side, browser } = setUp();
    const first = browser.browse(2000);
    timers.advance(1000);
    const second = browser.browse(2000);
    side.emit(service(1));
    timers.advance(1000);
    expect(await first).toMatchObject({ ok: true, value: [{ name: NAME }] });
    expect(side.calls).toEqual([`start ${HUB_SERVICE} 1`]);
    timers.advance(1000);
    expect(await second).toMatchObject({ ok: true, value: [{ name: NAME }] });
    const third = browser.browse(2000);
    timers.advance(2000);
    expect(await third).toEqual({ ok: true, value: [] });
    await settle();
    expect(side.calls).toEqual([
      `start ${HUB_SERVICE} 1`,
      "stop 1",
      `start ${HUB_SERVICE} 2`,
      "stop 2",
    ]);
  });
});

describe("faults: every failure an answer, never a throw", () => {
  test("no native module (a build without it): unsupported, at once, nothing started", async () => {
    const timers = manualTimers();
    const browser = hubBrowser(null, timers);
    expect(await browser.browse(2000)).toEqual({ ok: false, fault: "unsupported" });
    expect(timers.asked).toEqual([]);
    expect(await browser.localNetwork.permission()).toEqual({
      state: "undetermined",
      canAskAgain: true,
    });
    expect(await browser.localNetwork.ask()).toEqual({ state: "undetermined", canAskAgain: true });
  });

  test("refused at start: unsupported, or failed, at once", async () => {
    for (const [answer, fault] of [
      [{ refused: "unsupported", code: 0 }, "unsupported"],
      [{ refused: "failed", code: 0 }, "failed"],
      [{ nonsense: true }, "failed"],
    ] as const) {
      const { side, browser } = setUp();
      side.answerStart(answer);
      expect(await browser.browse(2000)).toEqual({ ok: false, fault });
      expect(side.listening()).toBe(0);
    }
    const { side, browser } = setUp();
    side.rejectStart();
    expect(await browser.browse(2000)).toEqual({ ok: false, fault: "failed" });
  });

  test("Android 17 refusing NSD without ACCESS_LOCAL_NETWORK: localNetworkDenied, at once", async () => {
    const { side, browser, seen, record } = setUp();
    browser.watch(record);
    const found = browser.browse(2000);
    side.emit({
      kind: "state",
      session: 1,
      state: "failed",
      domain: "nsd",
      code: NSD_PERMISSION_DENIED,
    });
    expect(await found).toEqual({ ok: false, fault: "localNetworkDenied" });
    expect(seen).toEqual([{ kind: "ended", fault: "localNetworkDenied" }]);
  });

  test("the system's browse failing for another reason: failed, at once", async () => {
    const { side, browser } = setUp();
    const found = browser.browse(2000);
    side.emit({ kind: "state", session: 1, state: "failed", domain: "nsd", code: 0 });
    expect(await found).toEqual({ ok: false, fault: "failed" });
  });

  test("iOS waiting with PolicyDenied: localNetworkDenied at the window's end; ready again clears it", async () => {
    const { timers, side, browser, seen, record } = setUp();
    browser.watch(record);
    const denied = browser.browse(2000);
    side.emit({
      kind: "state",
      session: 1,
      state: "waiting",
      domain: "dns",
      code: DNS_POLICY_DENIED,
    });
    timers.advance(2000);
    expect(await denied).toEqual({ ok: false, fault: "localNetworkDenied" });
    side.emit({ kind: "state", session: 1, state: "ready", domain: "other", code: 0 });
    expect(seen).toEqual([
      { kind: "fault", fault: "localNetworkDenied" },
      { kind: "fault", fault: null },
    ]);
    expect(browser.diagnostics().fault).toBeNull();
  });

  test("waiting for any other reason, or a refusal code in another domain, is not a fault", async () => {
    const { timers, side, browser } = setUp();
    const found = browser.browse(2000);
    side.emit({ kind: "state", session: 1, state: "waiting", domain: "posix", code: 50 });
    side.emit({
      kind: "state",
      session: 1,
      state: "waiting",
      domain: "posix",
      code: DNS_POLICY_DENIED,
    });
    side.emit({
      kind: "state",
      session: 1,
      state: "waiting",
      domain: "dns",
      code: NSD_PERMISSION_DENIED,
    });
    side.emit({ kind: "state", session: 1, state: "waiting", domain: "nsd", code: 6 });
    timers.advance(2000);
    expect(await found).toEqual({ ok: true, value: [] });
  });

  test("a hub found wins over a refusal seen first", async () => {
    const { timers, side, browser } = setUp();
    const found = browser.browse(2000);
    side.emit({
      kind: "state",
      session: 1,
      state: "waiting",
      domain: "dns",
      code: DNS_POLICY_DENIED,
    });
    side.emit(service(1));
    timers.advance(2000);
    expect(await found).toMatchObject({ ok: true, value: [{ name: NAME }] });
  });

  test("no Wi-Fi or Ethernet and nothing found: wifiOff; with a hub found, the hub", async () => {
    const off = setUp();
    const nothing = off.browser.browse(2000);
    off.side.emit({ kind: "network", session: 1, local: false });
    off.timers.advance(2000);
    expect(await nothing).toEqual({ ok: false, fault: "wifiOff" });

    const back = setUp();
    const later = back.browser.browse(2000);
    back.side.emit({ kind: "network", session: 1, local: false });
    back.side.emit({ kind: "network", session: 1, local: true });
    back.timers.advance(2000);
    expect(await later).toEqual({ ok: true, value: [] });

    const found = setUp();
    const hub = found.browser.browse(2000);
    found.side.emit({ kind: "network", session: 1, local: false });
    found.side.emit(service(1));
    found.timers.advance(2000);
    expect(await hub).toMatchObject({ ok: true, value: [{ name: NAME }] });
  });
});

describe("the local network permission (rule 7's pages)", () => {
  test("Android's, as the native side reads it; ask is the native side's request", async () => {
    const { side, browser } = setUp();
    side.setPermission(
      { state: "undetermined", canAskAgain: true },
      { state: "denied", canAskAgain: false },
    );
    expect(await browser.localNetwork.permission()).toEqual({
      state: "undetermined",
      canAskAgain: true,
    });
    expect(await browser.localNetwork.ask()).toEqual({ state: "denied", canAskAgain: false });
    expect(side.calls).toEqual(["permission", "ask"]);
  });

  test("an answer that cannot be read, or a rejection, is undetermined", async () => {
    const { side, browser } = setUp();
    side.setPermission({ state: "yes" });
    expect(await browser.localNetwork.permission()).toEqual({
      state: "undetermined",
      canAskAgain: true,
    });
    side.native.ask = () => Promise.reject(new Error("no activity"));
    expect(await browser.localNetwork.ask()).toEqual({ state: "undetermined", canAskAgain: true });
  });

  test("iOS's, unreadable, is what the browses saw: undetermined, then denied, then granted", async () => {
    const { timers, side, browser } = setUp();
    side.setPermission({ state: "unreadable", canAskAgain: true });
    expect(await browser.localNetwork.permission()).toEqual({
      state: "undetermined",
      canAskAgain: true,
    });
    const first = browser.browse(2000);
    side.emit({
      kind: "state",
      session: 1,
      state: "waiting",
      domain: "dns",
      code: DNS_POLICY_DENIED,
    });
    timers.advance(2000);
    await first;
    expect(await browser.localNetwork.permission()).toEqual({
      state: "denied",
      canAskAgain: false,
    });
    expect(await browser.localNetwork.ask()).toEqual({ state: "denied", canAskAgain: false });
    const second = browser.browse(2000);
    side.emit(service(2));
    timers.advance(2000);
    await second;
    expect(await browser.localNetwork.permission()).toEqual({
      state: "granted",
      canAskAgain: true,
    });
  });

  test("iOS ready again after a refusal is no longer denied", async () => {
    const { timers, side, browser } = setUp();
    side.setPermission({ state: "unreadable", canAskAgain: true });
    const found = browser.browse(2000);
    side.emit({
      kind: "state",
      session: 1,
      state: "waiting",
      domain: "dns",
      code: DNS_POLICY_DENIED,
    });
    side.emit({ kind: "state", session: 1, state: "ready", domain: "other", code: 0 });
    timers.advance(2000);
    await found;
    expect(await browser.localNetwork.permission()).toEqual({
      state: "undetermined",
      canAskAgain: true,
    });
  });
});

describe("the HubFinder the phone's client takes", () => {
  test("its faults in the frozen FinderFault's words: wifiOff is failed", () => {
    expect(finderFault("wifiOff")).toBe("failed");
    expect(finderFault("localNetworkDenied")).toBe("localNetworkDenied");
    expect(finderFault("unsupported")).toBe("unsupported");
    expect(finderFault("failed")).toBe("failed");
  });

  test("browseFor takes its hubs as targets: this hub's identity, home addresses only", async () => {
    const timers = manualTimers();
    const side = standIn();
    const net = hubNetOver(side.native, timers);
    let denied = 0;
    const targets = browseFor(net.finder, AID, { localNetworkDenied: () => denied++ }, 2000);
    side.emit(service(1, { addresses: ["fe80::1%en0", "192.168.1.20", "8.8.8.8", "fd00::20"] }));
    side.emit(service(1, { name: "hsn-other", txt: { raw: hubWire("8444", OTHER_AID) } }));
    timers.advance(2000);
    expect(await targets).toEqual({
      ok: true,
      value: [{ identity: AID, addresses: ["192.168.1.20", "fd00::20"], port: 8444 }],
    });
    expect(denied).toBe(0);
  });

  test("a refusal reaches the client's reach state; wifiOff reaches it as failed", async () => {
    const denied = setUp();
    let told = 0;
    const refused = browseFor(finderOf(denied.browser), null, { localNetworkDenied: () => told++ });
    denied.side.emit({
      kind: "state",
      session: 1,
      state: "failed",
      domain: "nsd",
      code: NSD_PERMISSION_DENIED,
    });
    expect(await refused).toEqual({ ok: false, fault: "localNetworkDenied" });
    expect(told).toBe(1);

    const off = setUp();
    const nothing = finderOf(off.browser).browse(2000);
    off.side.emit({ kind: "network", session: 1, local: false });
    off.timers.advance(2000);
    expect(await nothing).toEqual({ ok: false, fault: "failed" });
    expect(off.browser.diagnostics().fault).toBe("wifiOff");
  });
});

describe("what the build gives the module (app.config.ts, expo-module.config.json)", () => {
  test("iOS may browse for the hub's service, and says why it uses the local network", () => {
    for (const release of [false, true]) {
      const plist = appConfig(release).ios?.infoPlist ?? {};
      expect(plist.NSBonjourServices).toContain(HUB_SERVICE);
      expect(typeof plist.NSLocalNetworkUsageDescription).toBe("string");
    }
  });

  test("Android declares the local network and the network state, in a release build too", () => {
    for (const release of [false, true]) {
      const permissions = appConfig(release).android?.permissions ?? [];
      expect(permissions).toContain("android.permission.ACCESS_LOCAL_NETWORK");
      expect(permissions).toContain("android.permission.ACCESS_NETWORK_STATE");
    }
  });

  test("the module is linked on both platforms under the name the binding asks for", () => {
    const dir = join(import.meta.dir, "../modules/hub-net");
    const config = JSON.parse(readFileSync(join(dir, "expo-module.config.json"), "utf8")) as {
      apple: { modules: string[] };
      android: { modules: string[] };
    };
    expect(config.apple.modules).toEqual(["HubNetModule"]);
    expect(config.android.modules).toEqual(["app.hsn.hubnet.HubNetModule"]);
    const binding = readFileSync(join(dir, "src/native.ts"), "utf8");
    const swift = readFileSync(join(dir, "ios/HubNetModule.swift"), "utf8");
    const kotlin = readFileSync(
      join(dir, "android/src/main/java/app/hsn/hubnet/HubNetModule.kt"),
      "utf8",
    );
    expect(binding).toContain('Reflect.get(expo.modules, "HubNet")');
    for (const side of [swift, kotlin]) {
      expect(side).toContain('Name("HubNet")');
      for (const fn of ["start", "stop", "permission", "ask"])
        expect(side).toContain(`AsyncFunction("${fn}")`);
    }
    expect(swift).toContain('Events("hubNet")');
    expect(kotlin).toContain('private const val EVENT = "hubNet"');
    expect(DNS_POLICY_DENIED).toBe(-65_570);
    expect(NSD_PERMISSION_DENIED).toBe(7);
  });
});

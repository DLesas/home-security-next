/**
 * Finding and reaching the hub from a phone (`src/hub/finder.ts`; m3-design.md sections 2 and 3):
 * which hosts the phone opens, every form of code it is given, good and bad, the order of
 * addresses and its fallbacks, and the socket to one address, each given its time.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatLinkAddress,
  formatLinkQr,
  formatTypedCode,
  LINKING,
  parseTypedCode,
} from "@hsn/protocol/app";
import {
  addressOrder,
  browseFor,
  DEFAULT_APPS_PORT,
  foundTargets,
  hubSocketConnect,
  isHomeHost,
  isLocalNetworkDenied,
  isReachableHomeHost,
  NO_FINDER,
  PER_ADDRESS_MS,
  readCode,
  readTypedCode,
  reachOf,
  type SocketLike,
  storedHubConnect,
  targetsConnect,
  typedAddress,
  urlHost,
} from "../src/hub/finder";
import type { HubFinder } from "../src/platform/finder";
import type { HubReach } from "../src/platform/records";
import { manualTimers, settle } from "./support/timers";

const IDENTITY = "abcdefghijklmnopqrstuvwxya";
const OTHER = "bbcdefghijklmnopqrstuvwxya";
const SECRET = new Uint8Array(16).fill(5);
const FINGERPRINT = new Uint8Array(32).fill(1);

const qr = (addresses: readonly string[], extra: { relay?: string } = {}) =>
  formatLinkQr({
    identity: IDENTITY,
    secret: SECRET,
    addresses,
    port: 8444,
    fingerprint: FINGERPRINT,
    ...extra,
  });

describe("home hosts: the rule plugins/hub-tls applies natively (D132)", () => {
  const cases: readonly [string, boolean][] = [
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["127.0.0.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["192.168.1.20", true],
    ["192.169.1.20", false],
    ["169.254.3.4", true],
    ["100.64.0.1", false],
    ["8.8.8.8", false],
    ["1.2.3", false],
    ["1.2.3.256", false],
    ["01.2.3.4", false],
    ["::1", true],
    ["[::1]", true],
    ["fd00::20", true],
    ["fc00::1", true],
    ["fe80::1", true],
    ["febf::1", true],
    ["fec0::1", false],
    ["2001:db8::1", false],
    ["::ffff:192.168.1.1", false],
    ["hub.local", true],
    ["HUB.LOCAL", true],
    ["hub.localhost", false],
    ["localhost", false],
    ["example.com", false],
    ["", false],
  ];
  for (const [host, home] of cases)
    test(`${host || "(empty)"}: ${home ? "home" : "not home"}`, () => {
      expect(isHomeHost(host)).toBe(home);
    });

  test("the native rule names the same ranges (read from plugins/hub-tls)", () => {
    const objc = readFileSync(
      join(import.meta.dir, "..", "plugins", "hub-tls", "HSNHubTls.m"),
      "utf8",
    );
    for (const piece of [
      "== 10",
      "== 127",
      "== 0xAC1",
      "== 0xC0A8",
      "== 0xA9FE",
      "0xFC",
      "0x80",
      ".local",
    ])
      expect(objc).toContain(piece);
  });

  test("a link-local IPv6 address needs a zone no code carries: not tried", () => {
    expect(isReachableHomeHost("fe80::1")).toBe(false);
    expect(isReachableHomeHost("fe80::1%en0")).toBe(false);
    expect(isReachableHomeHost("fd00::1")).toBe(true);
    expect(isReachableHomeHost("169.254.1.1")).toBe(true);
  });

  test("an IPv6 address is bracketed in a URL", () => {
    expect(urlHost("fd00::20")).toBe("[fd00::20]");
    expect(urlHost("[fd00::20]")).toBe("[fd00::20]");
    expect(urlHost("192.168.1.20")).toBe("192.168.1.20");
  });
});

describe("an address a person types", () => {
  const cases: readonly [string, { address: string; port: number } | undefined][] = [
    ["192.168.1.20", { address: "192.168.1.20", port: DEFAULT_APPS_PORT }],
    [" 192.168.1.20:9000 ", { address: "192.168.1.20", port: 9000 }],
    ["https://192.168.1.20:8444/", { address: "192.168.1.20", port: 8444 }],
    ["fd00::20", { address: "fd00::20", port: DEFAULT_APPS_PORT }],
    ["[fd00::20]:8445", { address: "fd00::20", port: 8445 }],
    ["Hub.Local", { address: "hub.local", port: DEFAULT_APPS_PORT }],
    ["192.168.1.20:0", undefined],
    ["192.168.1.20:70000", undefined],
    ["8.8.8.8", undefined],
    ["example.com", undefined],
    ["fe80::1", undefined],
    ["[fd00::20", undefined],
    ["", undefined],
  ];
  for (const [text, want] of cases)
    test(`"${text}"`, () => {
      expect(typedAddress(text)).toEqual(want);
    });
});

describe("every form of code, good and bad", () => {
  test("a QR code or deep link: its secret, identity, home addresses, port and relay", () => {
    const read = readCode(
      qr(["192.168.1.20", "8.8.8.8", "fd00::20"], { relay: "wss://relay.example" }),
    );
    if (!read.ok || read.value.kind !== "link") throw new Error(JSON.stringify(read));
    expect(read.value.from).toBe("qr");
    const secret = read.value.secret;
    expect(
      secret.kind === "secret" && [secret.identity, Buffer.from(secret.secret).toString("hex")],
    ).toEqual([IDENTITY, Buffer.from(SECRET).toString("hex")]);
    // The public address is not a hub's at home: never opened (D132).
    expect(reachOf(secret)).toEqual({
      addresses: ["192.168.1.20", "fd00::20"],
      port: 8444,
      relay: "wss://relay.example",
    });
  });

  test("a QR code with spaces around it, as a camera may read it", () => {
    expect(readCode(`  ${qr(["192.168.1.20"])}\n`).ok).toBe(true);
  });

  test("a restore code: the new hub's identity, its secret and addresses", () => {
    const text = formatLinkQr(
      {
        identity: IDENTITY,
        secret: SECRET,
        addresses: ["192.168.1.30"],
        port: 8500,
        fingerprint: FINGERPRINT,
      },
      "restore",
    );
    const read = readCode(text);
    expect(read).toEqual({
      ok: true,
      value: {
        kind: "restore",
        restore: {
          identity: IDENTITY,
          secret: SECRET,
          reach: { addresses: ["192.168.1.30"], port: 8500 },
        },
      },
    });
  });

  test("a board's pairing code is passed on whole, for pairing", () => {
    const text = "hsn://pair/1?c=ABCD1234&d=a1b2c3d4e5f6";
    expect(readCode(text)).toEqual({ ok: true, value: { kind: "pair", text } });
  });

  test("a link address pasted: its own address and port", () => {
    const text = formatLinkAddress("192.168.1.20", 8444, IDENTITY, SECRET);
    const read = readCode(text);
    if (!read.ok || read.value.kind !== "link") throw new Error(JSON.stringify(read));
    expect(read.value.from).toBe("linkAddress");
    expect(reachOf(read.value.secret)).toEqual({ addresses: ["192.168.1.20"], port: 8444 });
    const v6 = readCode(formatLinkAddress("[fd00::20]", 8444, IDENTITY, SECRET));
    expect(v6.ok && v6.value.kind === "link" && reachOf(v6.value.secret)).toEqual({
      addresses: ["fd00::20"],
      port: 8444,
    });
  });

  test("a typed code, forgiven as the protocol reads it, alone or with an address", () => {
    const code = formatTypedCode({ tokenId: 1234, secret: 0x12345678n }) ?? "";
    for (const form of [
      code,
      code.toLowerCase(),
      code.replaceAll("-", ""),
      ` ${code.replaceAll("-", " ")} `,
    ]) {
      const read = readCode(form);
      expect(read.ok && read.value.kind).toBe("typed");
    }
    expect(readTypedCode(code)).toEqual({
      ok: true,
      value: { kind: "typed", code: parseTypedCode(code) ?? { tokenId: 0, secret: 0n } },
    });
    const withAddress = readTypedCode(code, "192.168.1.20:8444");
    expect(withAddress.ok && reachOf(withAddress.value)).toEqual({
      addresses: ["192.168.1.20"],
      port: 8444,
    });
    const blank = readTypedCode(code, "   ");
    expect(blank.ok && reachOf(blank.value)).toBeUndefined();
    expect(readTypedCode(code, "8.8.8.8")).toEqual({ ok: false, fault: "badAddress" });
  });

  test("bad typed codes: a wrong check character, a U, too short or too long, are refused, never read as another", () => {
    const code = formatTypedCode({ tokenId: 1234, secret: 0x12345678n }) ?? "";
    const wrongCheck = code.slice(0, -1) + (code.endsWith("0") ? "1" : "0");
    for (const bad of [wrongCheck, `U${code.slice(1)}`, code.slice(0, -2), `${code}0`])
      expect(readTypedCode(bad)).toEqual({ ok: false, fault: "badCode" });
    expect(readCode(wrongCheck)).toEqual({ ok: false, fault: "unreadable" });
  });

  test("bad QR codes: each missing or wrong part makes it unreadable", () => {
    const good = qr(["192.168.1.20"]);
    const bad = [
      good.replace(`h=${IDENTITY}`, "h=short"),
      good.replace(/s=[^&]+/u, "s=AAAA"),
      good.replace(/&p=\d+/u, "&p=0"),
      good.replace(/&p=\d+/u, "&p=70000"),
      good.replace(/a=[^&]+/u, "a="),
      good.replace(/c=[^&]+/u, "c=zz"),
      `${LINKING.qrPrefix}?`,
      `${LINKING.restoreQrPrefix}?h=${IDENTITY}`,
    ];
    for (const text of bad)
      expect({ text, read: readCode(text) }).toEqual({
        text,
        read: { ok: false, fault: "unreadable" },
      });
  });

  test("a code whose addresses are none of the home's still links: the hub is found by a browse", () => {
    const read = readCode(qr(["8.8.8.8"]));
    expect(read.ok && read.value.kind === "link" && reachOf(read.value.secret)?.addresses).toEqual(
      [],
    );
  });

  test("not ours: another scheme, a web page, the console's token, a later version of a link", () => {
    const notOurs = [
      "https://example.com/",
      "WIFI:S:home;T:WPA;P:secret;;",
      "hsn://link/2?h=x",
      "hsn:///settings",
      "http://127.0.0.1:8445/#console=AAAAAAAAAAAAAAAAAAAAAA",
      formatLinkAddress("192.168.1.20", 8444, IDENTITY, SECRET).replace("#link=", "#console="),
    ];
    for (const text of notOurs)
      expect({ text, read: readCode(text) }).toEqual({
        text,
        read: { ok: false, fault: "notOurs" },
      });
  });

  test("a link address on a host that is not at home is refused as such; a broken one as unreadable", () => {
    expect(readCode(formatLinkAddress("8.8.8.8", 8444, IDENTITY, SECRET))).toEqual({
      ok: false,
      fault: "notHome",
    });
    expect(
      readCode(formatLinkAddress("192.168.1.20", 8444, IDENTITY, SECRET).slice(0, -3)),
    ).toEqual({
      ok: false,
      fault: "unreadable",
    });
  });
});

describe("the order of addresses, and its fallbacks", () => {
  const reach = (over: Partial<HubReach> = {}): HubReach => ({
    addresses: ["192.168.1.20", "fd00::20"],
    appsPort: 8444,
    lastAddress: null,
    relayUrl: null,
    homeName: "",
    ...over,
  });

  test("the address that last worked, then the hub's own list, each once, home hosts only", () => {
    expect(addressOrder(reach())).toEqual(["192.168.1.20", "fd00::20"]);
    expect(addressOrder(reach({ lastAddress: "fd00::20" }))).toEqual(["fd00::20", "192.168.1.20"]);
    expect(addressOrder(reach({ lastAddress: "10.0.0.9" }))).toEqual([
      "10.0.0.9",
      "192.168.1.20",
      "fd00::20",
    ]);
    expect(addressOrder(reach({ addresses: ["8.8.8.8", "FD00::20", "fe80::1"] }))).toEqual([
      "fd00::20",
    ]);
    expect(addressOrder(reach({ addresses: [] }))).toEqual([]);
  });

  test("a browse's hubs: of this identity only (every hub for a typed code), each at its own port", () => {
    const found = [
      { identity: IDENTITY, addresses: ["192.168.1.21", "8.8.8.8"], appsPort: 9000 },
      { identity: OTHER, addresses: ["192.168.1.22"], appsPort: 8444 },
      { identity: "not-an-identity", addresses: ["192.168.1.23"], appsPort: 8444 },
      { identity: IDENTITY, addresses: ["8.8.8.8"], appsPort: 8444 },
    ];
    expect(foundTargets(found, IDENTITY)).toEqual([
      { identity: IDENTITY, addresses: ["192.168.1.21"], port: 9000 },
    ]);
    expect(foundTargets(found, null).map((t) => t.identity)).toEqual([IDENTITY, OTHER]);
  });

  test("until P1's browse exists, it finds nothing and says why", async () => {
    let denied = 0;
    expect(
      await browseFor(NO_FINDER, IDENTITY, { localNetworkDenied: () => (denied += 1) }),
    ).toEqual({
      ok: false,
      fault: "notBuilt",
    });
    const refused: HubFinder = {
      browse: () => Promise.resolve({ ok: false, fault: "localNetworkDenied" }),
    };
    expect(
      (await browseFor(refused, IDENTITY, { localNetworkDenied: () => (denied += 1) })).ok,
    ).toBe(false);
    expect(denied).toBe(1);
  });
});

/** Sockets that open, fail or hang as a test says, recording each URL and Origin asked for. */
function fakeSockets(behaviour: (url: string) => "open" | "refuse" | "hang" | "deny" | "late") {
  const made: { url: string; origin: string; socket: SocketLike }[] = [];
  const make = (url: string, origin: string): SocketLike => {
    const socket: SocketLike = {
      binaryType: "blob",
      readyState: 0,
      send: () => undefined,
      close: () => {
        (socket as { readyState: number }).readyState = 3;
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    made.push({ url, origin, socket });
    const what = behaviour(url);
    setTimeout(() => {
      if (what === "open") {
        (socket as { readyState: number }).readyState = 1;
        socket.onopen?.({});
      } else if (what === "refuse") socket.onclose?.({ code: 1006 });
      else if (what === "deny") {
        socket.onerror?.({
          message: "The Internet connection appears to be offline. Local network prohibited",
        });
        socket.onclose?.({ code: 1006 });
      }
    }, 0);
    return socket;
  };
  return { make, made };
}

describe("the socket to each address in turn", () => {
  test("wss:// to the address, Origin https:// and the same host, the first that opens answers", async () => {
    const timers = manualTimers();
    const { make, made } = fakeSockets((url) => (url.includes("192.168.1.21") ? "open" : "refuse"));
    const answered: string[] = [];
    const connect = hubSocketConnect(
      make,
      timers,
    )({
      addresses: ["192.168.1.20", "192.168.1.21", "192.168.1.22"],
      port: 8444,
      perAddressMs: PER_ADDRESS_MS,
      answered: (a) => answered.push(a),
      localNetworkDenied: () => undefined,
    });
    const wire = await connect("session", { message: () => undefined, closed: () => undefined });
    expect(wire).toBeDefined();
    expect(made.map((m) => [m.url, m.origin])).toEqual([
      ["wss://192.168.1.20:8444/app", "https://192.168.1.20:8444"],
      ["wss://192.168.1.21:8444/app", "https://192.168.1.21:8444"],
    ]);
    expect(answered).toEqual(["192.168.1.21"]);
    expect(made[1]?.socket.binaryType).toBe("arraybuffer");
  });

  test("an address that hangs is given 1.5 s, then the next; one that opens late is closed", async () => {
    const timers = manualTimers();
    const { make, made } = fakeSockets((url) => (url.includes("[fd00::20]") ? "open" : "hang"));
    const pending = hubSocketConnect(
      make,
      timers,
    )({
      addresses: ["192.168.1.20", "fd00::20"],
      port: 8444,
      perAddressMs: PER_ADDRESS_MS,
      answered: () => undefined,
      localNetworkDenied: () => undefined,
    })("link", { message: () => undefined, closed: () => undefined });
    await settle();
    expect(made).toHaveLength(1);
    timers.advance(PER_ADDRESS_MS - 1);
    await settle();
    expect(made).toHaveLength(1);
    timers.advance(1);
    await settle();
    expect(made.map((m) => m.url)).toEqual([
      "wss://192.168.1.20:8444/app/link",
      "wss://[fd00::20]:8444/app/link",
    ]);
    expect(made[0]?.socket.readyState).toBe(3);
    expect(await pending).toBeDefined();
    // The first one opening now, after its time, is closed at once.
    (made[0]?.socket as { readyState: number }).readyState = 1;
    made[0]?.socket.onopen?.({});
    expect(made[0]?.socket.readyState).toBe(3);
  });

  test("none answers: undefined; a socket the system refused for the local network says so", async () => {
    const timers = manualTimers();
    let denied = 0;
    const { make } = fakeSockets(() => "deny");
    const wire = await hubSocketConnect(
      make,
      timers,
    )({
      addresses: ["192.168.1.20"],
      port: 8444,
      perAddressMs: PER_ADDRESS_MS,
      answered: () => undefined,
      localNetworkDenied: () => (denied += 1),
    })("session", { message: () => undefined, closed: () => undefined });
    expect(wire).toBeUndefined();
    expect(denied).toBe(1);
    expect(isLocalNetworkDenied({ message: "connection refused" })).toBe(false);
  });

  test("a socket that cannot even be made is the next address's turn", async () => {
    const timers = manualTimers();
    const { make: inner } = fakeSockets(() => "open");
    let n = 0;
    const wire = await hubSocketConnect((url, origin) => {
      n += 1;
      if (n === 1) throw new Error("bad url");
      return inner(url, origin);
    }, timers)({
      addresses: ["192.168.1.20", "192.168.1.21"],
      port: 8444,
      perAddressMs: PER_ADDRESS_MS,
      answered: () => undefined,
      localNetworkDenied: () => undefined,
    })("session", { message: () => undefined, closed: () => undefined });
    expect(wire).toBeDefined();
    expect(n).toBe(2);
  });

  test("messages after opening: binary to the channel, text closes the socket; the close is told", async () => {
    const timers = manualTimers();
    const { make, made } = fakeSockets(() => "open");
    const got: unknown[] = [];
    const wire = await hubSocketConnect(
      make,
      timers,
    )({
      addresses: ["192.168.1.20"],
      port: 8444,
      perAddressMs: PER_ADDRESS_MS,
      answered: () => undefined,
      localNetworkDenied: () => undefined,
    })("session", { message: (d) => got.push([...d]), closed: (c) => got.push(c) });
    const socket = made[0]?.socket;
    socket?.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
    socket?.onmessage?.({ data: "text" });
    socket?.onclose?.({ code: 4002 });
    expect(got).toEqual([[1, 2], 4002]);
    expect(wire).toBeDefined();
  });
});

describe("a stored hub's connection: last, list, then browse", () => {
  const order = async (finder: HubFinder, reach: HubReach, opens: string) => {
    const timers = manualTimers();
    const { make, made } = fakeSockets((url) => (url.includes(opens) ? "open" : "refuse"));
    const answered: [string, number][] = [];
    const connect = storedHubConnect(
      hubSocketConnect(make, timers),
      finder,
      () => ({ identity: IDENTITY, reach }),
      { answered: (a, p) => answered.push([a, p]), localNetworkDenied: () => undefined },
    );
    const wire = await connect("session", { message: () => undefined, closed: () => undefined });
    return { wire, urls: made.map((m) => m.url), answered };
  };
  const reach: HubReach = {
    addresses: ["192.168.1.20", "192.168.1.21"],
    appsPort: 8444,
    lastAddress: "192.168.1.21",
    relayUrl: null,
    homeName: "",
  };
  const finder: HubFinder = {
    browse: () =>
      Promise.resolve({
        ok: true,
        value: [
          { identity: OTHER, addresses: ["192.168.1.50"], appsPort: 8444 },
          { identity: IDENTITY, addresses: ["192.168.1.20", "192.168.1.40"], appsPort: 8444 },
        ],
      }),
  };

  test("the last address first, then the list", async () => {
    const { urls, answered } = await order(NO_FINDER, reach, "192.168.1.20");
    expect(urls).toEqual(["wss://192.168.1.21:8444/app", "wss://192.168.1.20:8444/app"]);
    expect(answered).toEqual([["192.168.1.20", 8444]]);
  });

  test("none of the known addresses: the browse's of this hub, an address already tried not again", async () => {
    const { urls, answered } = await order(finder, reach, "192.168.1.40");
    expect(urls).toEqual([
      "wss://192.168.1.21:8444/app",
      "wss://192.168.1.20:8444/app",
      "wss://192.168.1.40:8444/app",
    ]);
    expect(answered).toEqual([["192.168.1.40", 8444]]);
  });

  test("nothing answers and no browse: unreachable", async () => {
    const { wire, urls } = await order(NO_FINDER, reach, "nowhere");
    expect(wire).toBeUndefined();
    expect(urls).toHaveLength(2);
  });

  test("no hub chosen: nothing is opened", async () => {
    const timers = manualTimers();
    const { make, made } = fakeSockets(() => "open");
    const connect = storedHubConnect(hubSocketConnect(make, timers), NO_FINDER, () => undefined, {
      answered: () => undefined,
      localNetworkDenied: () => undefined,
    });
    expect(
      await connect("session", { message: () => undefined, closed: () => undefined }),
    ).toBeUndefined();
    expect(made).toEqual([]);
  });

  test("targets: each address once across them", async () => {
    const timers = manualTimers();
    const { make, made } = fakeSockets(() => "refuse");
    await targetsConnect(
      hubSocketConnect(make, timers),
      [
        { identity: null, addresses: ["192.168.1.20", "192.168.1.21"], port: 8444 },
        { identity: null, addresses: ["192.168.1.21", "192.168.1.22"], port: 8444 },
        { identity: null, addresses: ["192.168.1.21"], port: 9000 },
      ],
      { answered: () => undefined, localNetworkDenied: () => undefined },
    )("link", { message: () => undefined, closed: () => undefined });
    expect(made.map((m) => m.url)).toEqual([
      "wss://192.168.1.20:8444/app/link",
      "wss://192.168.1.21:8444/app/link",
      "wss://192.168.1.22:8444/app/link",
      "wss://192.168.1.21:9000/app/link",
    ]);
  });
});

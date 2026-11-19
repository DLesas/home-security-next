/**
 * The phone's client (`src/hub/phone-client.ts`; m3-design.md sections 2 to 4) against a scripted
 * hub that speaks channel version 2 (`support/hub-end.ts`), the frozen schemas of
 * `packages/protocol/src/app/` checking every message: today's real hub speaks version 1 only, so
 * what needs version 2 (`backup.keyHeld`, the snapshot's `backupKeyEpoch`, `hub.info`'s
 * `addresses`) is joined here and nowhere else yet. `phone-real-hub.test.ts` runs what today's hub
 * can show against the real process.
 */
import { describe, expect, test } from "bun:test";
import { formatLinkQr, parseTypedCode } from "@hsn/protocol/app";
import { readCode, readTypedCode, NO_FINDER, type PhoneLinkSecret } from "../src/hub/finder";
import { arrivals, isCodeLink, type LinkSource, startPhoneClient } from "../src/hub/phone-client";
import { PHONE_PROTO } from "../src/hub/restore";
import type { FoundHub, HubFinder } from "../src/platform/finder";
import * as phoneKeys from "../src/platform/keys.native";
import { itemsOf, memorySecureItems, type MemoryItems } from "../src/platform/vault";
import { HubEnd } from "./support/hub-end";
import { phoneSockets } from "./support/phone-sockets";
import { manualTimers, settle } from "./support/timers";

const HOME = "192.168.1.20";
const KEY = (n: number) => new Uint8Array(32).fill(n);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

interface Setup {
  readonly speaks?: readonly [number, number];
  readonly proto?: readonly [number, number];
  readonly finder?: HubFinder;
  readonly disk?: Map<string, string>;
  readonly others?: ReadonlyMap<string, HubEnd>;
  readonly hub?: HubEnd;
}

function world(setup: Setup = {}) {
  const hub = setup.hub ?? new HubEnd();
  hub.speaks = setup.speaks ?? [1, 2];
  hub.backupKey = { key: b64(KEY(3)), epoch: 3 };
  hub.v2 = { addresses: [HOME], appsPort: 8444, backupKeyEpoch: 3 };
  const hubs = new Map<string, HubEnd>([[HOME, hub], ...(setup.others ?? new Map())]);
  const sockets = phoneSockets(hubs);
  const timers = manualTimers();
  const items: MemoryItems = memorySecureItems(setup.disk ?? new Map<string, string>());
  const phone = startPhoneClient({
    items,
    makeSocket: sockets.make,
    finder: setup.finder ?? NO_FINDER,
    timers,
    app: "0.1.0",
    proto: setup.proto ?? PHONE_PROTO,
    keys: phoneKeys,
  });
  return { hub, sockets, timers, items, phone, client: phone.client };
}

/** A QR code from `hub`'s own token, read as the phone reads it. */
function qrFor(hub: HubEnd, addresses: readonly string[] = [HOME], name = "Ana"): PhoneLinkSecret {
  const secret = hub.tokenWithSecret("newPerson", null, name);
  const read = readCode(
    formatLinkQr({ identity: hub.identity, secret, addresses, port: 8444, fingerprint: KEY(1) }),
  );
  if (!read.ok || read.value.kind !== "link") throw new Error("qr");
  return read.value.secret;
}

async function linkedWorld(setup: Setup = {}) {
  const w = world(setup);
  w.client.start();
  await settle();
  await w.client.link(qrFor(w.hub), "qr", { name: "Ana's phone", kind: "phone" });
  await settle(60);
  return w;
}

/** The ops the hub saw from the phone, with their `seq` and body. */
const ops = (hub: HubEnd) =>
  hub.seen.map((s) => [s.op, s.seq === undefined ? null : "seq", s.body]);

describe("linking a phone", () => {
  test("by QR code: linked as a phone at the code's address, Origin its own; key, record and backup key written; a version 2 session opens", async () => {
    const w = await linkedWorld();
    expect(w.client.local.getState().link).toEqual({ kind: "linked", from: "qr" });
    expect(w.sockets.opened[0]).toEqual({
      url: `wss://${HOME}:8444/app/link`,
      origin: `https://${HOME}:8444`,
    });
    expect([...w.hub.clients.values()].map((c) => c.kind)).toEqual(["phone"]);
    const listed = await w.phone.records.list();
    expect(listed).toEqual({ ok: true, value: [w.hub.identity] });
    const record = await w.phone.records.hub(w.hub.identity).read();
    if (!record.ok || record.value === undefined) throw new Error("record");
    expect(record.value.reach).toEqual({
      addresses: [HOME],
      appsPort: 8444,
      lastAddress: HOME,
      relayUrl: null,
      homeName: "",
    });
    expect(await w.phone.records.backupKeys.held(w.hub.identity)).toEqual({
      ok: true,
      value: [{ epoch: 3, key: KEY(3) }],
    });
    expect(await w.phone.records.backupKeys.confirmed(w.hub.identity)).toEqual({
      ok: true,
      value: 3,
    });
    const connection = w.client.live.getState().connection;
    expect(connection.kind).toBe("open");
    expect(w.client.live.getState().session?.kind).toBe("phone");
    expect(w.hub.openSessions).toBe(1);
    // The epoch held and confirmed: nothing more is asked.
    expect(ops(w.hub).map(([op]) => op)).toEqual(["snapshot", "subscribe"]);
  });

  test("a phone links as one whatever kind a page passes, so the hub gives it the backup key", async () => {
    const w = world();
    await w.client.link(qrFor(w.hub), "qr", { name: "Ana's phone", kind: "web" });
    expect([...w.hub.clients.values()].map((c) => c.kind)).toEqual(["phone"]);
    const listed = await w.phone.records.list();
    const identity = listed.ok ? (listed.value[0] ?? "") : "";
    const held = await w.phone.records.backupKeys.held(identity);
    expect(held.ok && held.value.map((k) => k.epoch)).toEqual([3]);
  });

  test("a version 2 phone and a hub of version 1: refused before message 2, nothing stored, and the code still works once the hub speaks 2", async () => {
    const w = world({ speaks: [1, 1] });
    w.client.start();
    await settle();
    const code = qrFor(w.hub);
    await w.client.link(code, "qr", { name: "Ana's phone", kind: "phone" });
    expect(w.client.local.getState().link).toEqual({
      kind: "failed",
      from: "qr",
      failure: "refused",
    });
    expect(await w.phone.records.list()).toEqual({ ok: true, value: [] });
    expect(w.items.writes).toEqual([]);
    w.hub.speaks = [1, 2];
    await w.client.link(code, "qr", { name: "Ana's phone", kind: "phone" });
    expect(w.client.local.getState().link).toEqual({ kind: "linked", from: "qr" });
  });

  test("a QR code whose identity is not the hub's: stopped before message 3, nothing stored", async () => {
    const w = world();
    const code = qrFor(w.hub);
    const forged: PhoneLinkSecret = {
      ...code,
      ...(code.kind === "secret" ? { identity: "a".repeat(26) } : {}),
    };
    await w.client.link(forged, "qr", { name: "Ana's phone", kind: "phone" });
    expect(w.client.local.getState().link).toEqual({
      kind: "failed",
      from: "qr",
      failure: "wrongHub",
    });
    expect(w.items.writes).toEqual([]);
  });

  test("a typed code with the hub's address typed too", async () => {
    const w = world();
    const typed = readTypedCode(w.hub.typedCode("newPerson", null, "Bo"), `${HOME}:8444`);
    if (!typed.ok) throw new Error("typed");
    await w.client.link(typed.value, "typed", { name: "Bo's phone", kind: "phone" });
    expect(w.client.local.getState().link).toEqual({ kind: "linked", from: "typed" });
  });

  test("a typed code alone, until P1's browse exists: nothing to try, and the browse says why", async () => {
    const w = world();
    const code = parseTypedCode(w.hub.typedCode("newPerson", null, "Bo"));
    if (code === undefined) throw new Error("code");
    await w.client.link({ kind: "typed", code }, "typed", { name: "Bo's phone", kind: "phone" });
    expect(w.client.local.getState().link).toEqual({
      kind: "failed",
      from: "typed",
      failure: "unreachable",
    });
    expect(w.phone.reach.getState().browse).toBe("notBuilt");
    expect(w.sockets.opened).toEqual([]);
  });

  test("a typed code alone, with a browse: each hub found in turn; one that does not hold the code costs no try", async () => {
    const stranger = new HubEnd(new Uint8Array(32).fill(9));
    stranger.speaks = [1, 2];
    const ours = new HubEnd();
    const found: FoundHub[] = [
      { identity: stranger.identity, addresses: ["192.168.1.30"], appsPort: 8444 },
      { identity: ours.identity, addresses: [HOME], appsPort: 8444 },
    ];
    const w = world({
      hub: ours,
      others: new Map([["192.168.1.30", stranger]]),
      finder: { browse: () => Promise.resolve({ ok: true, value: found }) },
    });
    const code = parseTypedCode(ours.typedCode("newPerson", null, "Bo"));
    if (code === undefined) throw new Error("code");
    await w.client.link({ kind: "typed", code }, "typed", { name: "Bo's phone", kind: "phone" });
    await settle(40);
    expect(w.client.local.getState().link).toEqual({ kind: "linked", from: "typed" });
    expect(w.sockets.opened.map((o) => o.url)).toEqual([
      "wss://192.168.1.30:8444/app/link",
      `wss://${HOME}:8444/app/link`,
      `wss://${HOME}:8444/app`,
    ]);
    expect(stranger.clients.size).toBe(0);
  });

  test("the hub asks for the new person's name: asked, then linked with it", async () => {
    const w = world();
    const secret = w.hub.tokenWithSecret("newPerson", null);
    const read = readCode(
      formatLinkQr({
        identity: w.hub.identity,
        secret,
        addresses: [HOME],
        port: 8444,
        fingerprint: KEY(1),
      }),
    );
    if (!read.ok || read.value.kind !== "link") throw new Error("qr");
    await w.client.link(read.value.secret, "qr", { name: "Cy's phone", kind: "phone" });
    expect(w.client.local.getState().link).toEqual({ kind: "askingName", from: "qr" });
    await w.client.giveName("Cy");
    expect(w.client.local.getState().link).toEqual({ kind: "linked", from: "qr" });
    expect([...w.hub.people.values()]).toEqual(["Cy"]);
  });

  test("a vault that cannot write the link: failed as storage, the phone not linked", async () => {
    const w = world();
    w.items.failNext({ op: "set", fault: "full" });
    await w.client.link(qrFor(w.hub), "qr", { name: "Ana's phone", kind: "phone" });
    expect(w.client.local.getState().link).toEqual({
      kind: "failed",
      from: "qr",
      failure: "storage",
    });
    expect(await w.phone.records.list()).toEqual({ ok: true, value: [] });
    expect(w.phone.vault.getState().fault).toBe("full");
  });
});

describe("the backup key over sessions (version 2)", () => {
  function answerKey(hub: HubEnd, epoch: number, key = KEY(epoch)) {
    hub.handleV2("backup.key", () => ({ ok: true, body: { key: b64(key), epoch } }));
  }

  test("a snapshot naming an epoch not held: backup.key, the key written, then backup.keyHeld with a seq", async () => {
    const w = await linkedWorld();
    answerKey(w.hub, 4);
    w.hub.handleV2("backup.keyHeld", () => ({ ok: true, body: {} }));
    w.hub.v2.backupKeyEpoch = 4;
    w.hub.dropAll();
    await settle(20);
    w.timers.advance(1000);
    await settle(80);
    expect(ops(w.hub).slice(2)).toEqual([
      ["snapshot", null, {}],
      ["subscribe", null, expect.anything()],
      ["backup.key", null, {}],
      ["backup.keyHeld", "seq", { epoch: 4 }],
    ]);
    const held = await w.phone.records.backupKeys.held(w.hub.identity);
    expect(held.ok && held.value.map((k) => k.epoch)).toEqual([4, 3]);
    expect(await w.phone.records.backupKeys.confirmed(w.hub.identity)).toEqual({
      ok: true,
      value: 4,
    });
    expect(w.phone.keeper()?.last).toEqual({ kind: "kept", epoch: 4, confirmed: true });
  });

  test("backupKeyChanged during a session: fetched at once", async () => {
    const w = await linkedWorld();
    answerKey(w.hub, 5);
    w.hub.handleV2("backup.keyHeld", () => ({ ok: true, body: {} }));
    w.hub.emit("backupKeyChanged", { epoch: 5 });
    await settle(60);
    expect(
      ops(w.hub)
        .slice(2)
        .map(([op]) => op),
    ).toEqual(["backup.key", "backup.keyHeld"]);
    expect(await w.phone.records.backupKeys.confirmed(w.hub.identity)).toEqual({
      ok: true,
      value: 5,
    });
  });

  test("a key that cannot be written is not confirmed", async () => {
    const w = await linkedWorld();
    answerKey(w.hub, 5);
    w.items.failNext({ op: "set", name: itemsOf(w.hub.identity)?.backup ?? "", fault: "full" });
    w.hub.emit("backupKeyChanged", { epoch: 5 });
    await settle(60);
    expect(
      ops(w.hub)
        .slice(2)
        .map(([op]) => op),
    ).toEqual(["backup.key"]);
    expect(w.phone.keeper()?.last).toEqual({ kind: "notWritten" });
  });

  test("a confirmation refused as no longer current (replaced meanwhile): fetched again", async () => {
    const w = await linkedWorld();
    let epoch = 5;
    w.hub.handleV2("backup.key", () => ({ ok: true, body: { key: b64(KEY(epoch)), epoch } }));
    w.hub.handleV2("backup.keyHeld", (body) => {
      const asked = (body as { epoch: number }).epoch;
      if (asked === 5) {
        epoch = 6;
        return {
          ok: false,
          error: { code: "invalid", detail: { field: "epoch", reason: "range" } },
        };
      }
      return { ok: true, body: {} };
    });
    w.hub.emit("backupKeyChanged", { epoch: 5 });
    await settle(100);
    expect(ops(w.hub).slice(2)).toEqual([
      ["backup.key", null, {}],
      ["backup.keyHeld", "seq", { epoch: 5 }],
      ["backup.key", null, {}],
      ["backup.keyHeld", "seq", { epoch: 6 }],
    ]);
    const held = await w.phone.records.backupKeys.held(w.hub.identity);
    expect(held.ok && held.value.map((k) => k.epoch)).toEqual([6, 5, 3]);
    expect(await w.phone.records.backupKeys.confirmed(w.hub.identity)).toEqual({
      ok: true,
      value: 6,
    });
  });

  test("killed between writing the key and backup.keyHeld: the next session confirms it, without asking for the key again", async () => {
    const w = await linkedWorld();
    // As if the phone had written epoch 4 and died before confirming it.
    await w.phone.records.backupKeys.keep(w.hub.identity, { epoch: 4, key: KEY(4) });
    w.hub.handleV2("backup.keyHeld", () => ({ ok: true, body: {} }));
    w.hub.v2.backupKeyEpoch = 4;
    w.hub.dropAll();
    await settle(20);
    w.timers.advance(1000);
    await settle(80);
    expect(ops(w.hub).slice(4)).toEqual([["backup.keyHeld", "seq", { epoch: 4 }]]);
    expect(await w.phone.records.backupKeys.confirmed(w.hub.identity)).toEqual({
      ok: true,
      value: 4,
    });
  });

  test("on a version 1 session (today's hub): backup.key alone, never backup.keyHeld", async () => {
    const w = await linkedWorld({ speaks: [1, 1], proto: [1, 1] });
    expect(w.client.live.getState().connection.kind).toBe("open");
    answerKey(w.hub, 5);
    w.hub.emit("backupKeyChanged", { epoch: 5 });
    await settle(60);
    expect(
      ops(w.hub)
        .slice(2)
        .map(([op]) => op),
    ).toEqual(["backup.key"]);
    expect(w.phone.keeper()?.last).toEqual({ kind: "kept", epoch: 5, confirmed: true });
  });
});

describe("reaching the hub over sessions", () => {
  test("hub.info's addresses (version 2) replace the code's; the address that answered is kept first", async () => {
    const w = await linkedWorld();
    w.hub.v2.addresses = ["192.168.1.40", HOME, "8.8.8.8"];
    w.hub.v2.appsPort = 8444;
    w.hub.dropAll();
    await settle(20);
    w.timers.advance(1000);
    await settle(80);
    const record = await w.phone.records.hub(w.hub.identity).read();
    expect(record.ok && record.value?.reach).toEqual({
      addresses: ["192.168.1.40", HOME],
      appsPort: 8444,
      lastAddress: HOME,
      relayUrl: null,
      homeName: "",
    });
    // The next connection tries the address that last worked first.
    w.sockets.opened.length = 0;
    w.hub.dropAll();
    await settle(20);
    w.timers.advance(2000);
    await settle(80);
    expect(w.sockets.opened[0]?.url).toBe(`wss://${HOME}:8444/app`);
  });

  test("seq is written before a change is sent: a store that cannot write it sends nothing", async () => {
    const w = await linkedWorld();
    const before = w.hub.seen.length;
    w.items.failNext({ op: "set", name: itemsOf(w.hub.identity)?.record ?? "", fault: "full" });
    expect(await w.client.request("site.set", { countdown: 30 })).toEqual({
      ok: false,
      local: "storage",
    });
    await settle();
    expect(w.hub.seen.length).toBe(before);
    w.hub.handle("site.set", () => ({ ok: true, body: w.hub.snapshot.site }));
    const sent = await w.client.request("site.set", { countdown: 30 });
    expect(sent.ok).toBe(true);
    expect(w.hub.seen.at(-1)?.seq).toBe(1);
  });

  test("removed by the hub: its record, key and backup keys are deleted, and it says so", async () => {
    const w = await linkedWorld();
    const client = [...w.hub.clients.values()][0];
    w.hub.remove(client?.id ?? 0);
    await settle(60);
    expect(w.client.live.getState().connection.kind).toBe("removed");
    expect(await w.phone.records.list()).toEqual({ ok: true, value: [] });
    expect([...w.items.disk.keys()].filter((k) => k.startsWith("hub."))).toEqual([]);
  });

  test("refused before message 2, again and again: perhaps removed, and the keys are kept", async () => {
    const w = await linkedWorld();
    for (const c of w.hub.clients.values()) c.removed = true;
    w.hub.dropAll();
    for (let i = 0; i < 8; i++) {
      w.timers.advance(10_000);
      await settle(40);
    }
    const connection = w.client.live.getState().connection;
    expect(connection.kind).toBe("waiting");
    expect(connection.kind === "waiting" && connection.mayBeRemoved).toBe(true);
    expect(await w.phone.records.list()).toEqual({ ok: true, value: [w.hub.identity] });
  });

  test("a phone restarted and not yet unlocked: not readable, said as `locked`; read once the app comes to the front unlocked", async () => {
    const first = await linkedWorld();
    const disk = first.items.disk;
    first.client.stop();
    const w = world({ disk, hub: first.hub });
    w.items.fail("locked");
    w.client.start();
    await settle(40);
    expect(w.client.live.getState().connection.kind).toBe("noStorage");
    expect(w.phone.vault.getState()).toEqual({ fault: "locked", identity: null });
    w.items.fail(null);
    w.phone.resume();
    await settle(80);
    expect(w.client.live.getState().connection.kind).toBe("open");
    expect(w.phone.vault.getState().fault).toBeNull();
  });

  test("the app killed and started again: the same key, the hub reached, the next seq above the last", async () => {
    const first = await linkedWorld();
    first.hub.handle("site.set", () => ({ ok: true, body: first.hub.snapshot.site }));
    await first.client.request("site.set", { countdown: 30 });
    first.client.stop();
    const w = world({ disk: first.items.disk, hub: first.hub });
    w.client.start();
    await settle(80);
    expect(w.client.live.getState().connection.kind).toBe("open");
    w.hub.handle("site.set", () => ({ ok: true, body: w.hub.snapshot.site }));
    await w.client.request("site.set", { countdown: 40 });
    expect(w.hub.seen.filter((s) => s.op === "site.set").map((s) => s.seq)).toEqual([1, 2]);
    expect(w.hub.clients.size).toBe(1);
  });

  test("forgetting the home: its record and keys go, and the phone is not linked", async () => {
    const w = await linkedWorld();
    await w.client.forget();
    await settle(40);
    expect(w.client.live.getState().connection.kind).toBe("notLinked");
    expect([...w.items.disk.keys()].filter((k) => k.startsWith("hub."))).toEqual([]);
  });
});

describe("codes that arrive as links", () => {
  function source(initial: string | null): LinkSource & { open(url: string): void } {
    let listener: ((url: string) => void) | undefined;
    return {
      initial: () => Promise.resolve(initial),
      listen: (opened) => {
        listener = opened;
        return () => undefined;
      },
      open: (url) => listener?.(url),
    };
  }

  test("the code the app was opened with is held until claimed, once", async () => {
    const s = source("hsn://link/1?h=x");
    const a = arrivals(s);
    await settle();
    expect(a.claim()).toEqual({ from: "deepLink", text: "hsn://link/1?h=x" });
    expect(a.claim()).toBeUndefined();
  });

  test("later codes go to the listeners; with none, the newest is held; other links are not codes", async () => {
    const s = source(null);
    const a = arrivals(s);
    await settle();
    s.open("hsn:///settings");
    s.open("https://example.com/");
    expect(a.claim()).toBeUndefined();
    s.open("hsn://restore/1?h=a");
    s.open("hsn://pair/1?c=b");
    expect(a.claim()).toEqual({ from: "deepLink", text: "hsn://pair/1?c=b" });
    const heard: unknown[] = [];
    const off = a.on((code) => heard.push(code));
    s.open("HSN://link/1?h=c");
    expect(heard).toEqual([{ from: "deepLink", text: "HSN://link/1?h=c" }]);
    expect(a.claim()).toBeUndefined();
    off();
    s.open("hsn://link/1?h=d");
    expect(heard).toHaveLength(1);
    expect(isCodeLink("hsn://link/2?h=x")).toBe(false);
  });
});

describe("nothing secret in the stores the pages read", () => {
  test("the live and local stores, at every step of linking and of a key fetched, hold no key, code or backup key", async () => {
    const w = world();
    const seen: string[] = [];
    w.client.live.subscribe((state) => seen.push(JSON.stringify(state)));
    w.client.local.subscribe((state) => seen.push(JSON.stringify(state)));
    w.phone.vault.subscribe((state) => seen.push(JSON.stringify(state)));
    w.phone.reach.subscribe((state) => seen.push(JSON.stringify(state)));
    w.client.start();
    const code = qrFor(w.hub);
    await w.client.link(code, "qr", { name: "Ana's phone", kind: "phone" });
    await settle(60);
    w.hub.handleV2("backup.key", () => ({ ok: true, body: { key: b64(KEY(5)), epoch: 5 } }));
    w.hub.handleV2("backup.keyHeld", () => ({ ok: true, body: {} }));
    w.hub.emit("backupKeyChanged", { epoch: 5 });
    await settle(60);
    const record = await w.phone.records.hub(w.hub.identity).read();
    if (!record.ok || record.value === undefined || code.kind !== "secret")
      throw new Error("record");
    const text = seen.join("\n");
    expect(seen.length).toBeGreaterThan(3);
    for (const bytes of [record.value.key.privateKey, code.secret, KEY(3), KEY(5)]) {
      expect(text).not.toContain(Buffer.from(bytes).toString("hex"));
      expect(text).not.toContain(b64(bytes));
    }
  });
});

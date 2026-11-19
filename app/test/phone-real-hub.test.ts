/**
 * The phone's client code against the real hub (`hub/test/world/hub-entry.ts` as a process,
 * `support/real-hub.ts`): the vault over an in-memory secure store, the phone's key, its address
 * order and its socket, over `wss://` at this computer's home-network address with the hub's own
 * certificate (D132), and the Noise handshakes. Today's hub speaks channel version 1 only (B6 is
 * moving it to 2), so the phone's client is run here at version 1; the phone itself offers 2 only
 * (`PHONE_PROTO`), and what needs version 2 is in `phone-client.test.ts` against a scripted hub.
 *
 * Restore end to end: a phone linked to hub A keeps A's backup key through a replacement; A's
 * backup is uploaded to a fresh hub B; the phone runs restore's six messages against B, which
 * restarts as A; the phone reaches it with IK as the client the file holds, and its first change is
 * answered `seqTooLow` once (the 2³² jump) and then made.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseConsoleFragment } from "@hsn/protocol/app";
import { createHubClient, type HubClient } from "../src/hub/client";
import { downloadFile, sendFile, uploadJob } from "../src/hub/files";
import {
  type MakeSocket,
  NO_FINDER,
  type PhoneLinkSecret,
  readCode,
  readTypedCode,
  type RestoreCode,
  type SocketLike,
  targetsConnect,
  hubSocketConnect,
} from "../src/hub/finder";
import { type PhoneClient, startPhoneClient } from "../src/hub/phone-client";
import { PHONE_PROTO, restoreHub } from "../src/hub/restore";
import { memoryRecordStore } from "../src/platform/client-key";
import * as phoneKeys from "../src/platform/keys.native";
import { memorySecureItems, type MemoryItems } from "../src/platform/vault";
import { realTimers } from "../src/hub/wire";
import {
  connectFrom,
  homeAddress,
  type RealHub,
  startRealHub,
  stopAllHubs,
} from "./support/real-hub";

/** Bun's WebSocket as the phone opens one: the `Origin` it sends, the hub's certificate taken. */
const bunSocket: MakeSocket = (url, origin) => {
  const options = { headers: { Origin: origin }, tls: { rejectUnauthorized: false } };
  return new WebSocket(url, options as unknown as string[]) as unknown as SocketLike;
};

const HOME = homeAddress();
let hubA: RealHub;
let consoleA: HubClient;

/** Everything written to the console while these tests run, and every secret they handled. */
const output: string[] = [];
const secrets = new Set<string>();
const realConsole = { ...console };

function secret(bytes: Uint8Array): void {
  secrets.add(Buffer.from(bytes).toString("hex"));
  secrets.add(Buffer.from(bytes).toString("base64url"));
}

/** The keys a phone holds, noted as secrets: its private keys and its backup keys. */
async function noteKeys(phone: PhoneClient): Promise<void> {
  const list = await phone.records.list();
  for (const identity of list.ok ? list.value : []) {
    const record = await phone.records.hub(identity).read();
    if (record.ok && record.value !== undefined) secret(record.value.key.privateKey);
    const held = await phone.records.backupKeys.held(identity);
    for (const key of held.ok ? held.value : []) secret(key.key);
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

async function consoleOf(hub: RealHub): Promise<HubClient> {
  const client = createHubClient({
    connect: connectFrom(hub.consoleOrigin),
    records: memoryRecordStore(),
    timers: realTimers,
    app: "0.1.0",
  });
  client.start();
  const url = await hub.consoleCode();
  const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1));
  if (secret === undefined) throw new Error("no console code");
  await client.link({ kind: "secret", secret, identity: undefined }, "console", {
    name: "The hub computer",
    kind: "web",
  });
  if (!(await until(() => client.live.getState().connection.kind === "open")))
    throw new Error("console not open");
  return client;
}

/** The phone's client as the app builds it, at version 1 for today's hub. */
function phoneOn(
  items: MemoryItems = memorySecureItems(),
  proto: readonly [number, number] = [1, 1],
): PhoneClient {
  return startPhoneClient({
    items,
    makeSocket: bunSocket,
    finder: NO_FINDER,
    timers: realTimers,
    app: "0.1.0",
    proto,
    keys: phoneKeys,
  });
}

async function qrCode(console: HubClient, name: string): Promise<PhoneLinkSecret> {
  const made = await console.request("link.create", { kind: { newPerson: { name } }, form: "qr" });
  if (!made.ok || made.body.qr === undefined) throw new Error(JSON.stringify(made));
  const read = readCode(made.body.qr);
  if (!read.ok || read.value.kind !== "link") throw new Error("not a link code");
  if (read.value.secret.kind === "secret") secret(read.value.secret.secret);
  return read.value.secret;
}

async function linkedPhone(name: string): Promise<{ phone: PhoneClient; items: MemoryItems }> {
  const items = memorySecureItems();
  const phone = phoneOn(items);
  phone.client.start();
  await phone.client.link(await qrCode(consoleA, name), "qr", {
    name: `${name}'s phone`,
    kind: "phone",
  });
  if (phone.client.local.getState().link.kind !== "linked")
    throw new Error(JSON.stringify(phone.client.local.getState().link));
  if (!(await until(() => phone.client.live.getState().connection.kind === "open")))
    throw new Error("phone not open");
  await noteKeys(phone);
  return { phone, items };
}

/** The identity of the hub a phone is linked to. */
async function linkedIdentity(phone: PhoneClient): Promise<string> {
  const list = await phone.records.list();
  if (!list.ok || list.value[0] === undefined) throw new Error("not linked");
  return list.value[0];
}

beforeAll(async () => {
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    console[level] = (...args: unknown[]) => {
      output.push(Bun.inspect(args));
      realConsole[level](...args);
    };
  if (HOME === undefined) throw new Error("these tests need this computer on a home network");
  hubA = await startRealHub();
  consoleA = await consoleOf(hubA);
}, 60_000);

afterAll(async () => {
  await stopAllHubs();
  Object.assign(console, realConsole);
});

describe("the phone's client against the real hub, at its home-network address", () => {
  let pat: { phone: PhoneClient; items: MemoryItems };

  test("a QR code links it as a phone over wss:// with the hub's own certificate; its session opens", async () => {
    pat = await linkedPhone("Pat");
    const identity = await linkedIdentity(pat.phone);
    const record = await pat.phone.records.hub(identity).read();
    if (!record.ok || record.value === undefined) throw new Error("record");
    expect(record.value.reach?.lastAddress).toBe(HOME);
    expect(record.value.reach?.appsPort).toBe(hubA.lanPort);
    expect(pat.phone.client.live.getState().session?.kind).toBe("phone");
    // A phone is given the backup key at linking (D78), written with the record.
    const held = await pat.phone.records.backupKeys.held(identity);
    expect(held.ok && held.value.length).toBe(1);
    expect(held.ok && held.value[0]?.key.length).toBe(32);
  }, 30_000);

  test("its changes carry seq, written first; killed as it reserves one, the next start goes on above it", async () => {
    const ok = await pat.phone.client.request("site.set", { countdown: 30 });
    expect(ok.ok).toBe(true);
    const identity = await linkedIdentity(pat.phone);
    const before = await pat.phone.records.hub(identity).read();
    const last = before.ok ? (before.value?.lastSeq ?? 0) : 0;
    // The process dies at the next write: the seq for this change is never written, nor sent.
    pat.items.killAfter(0);
    const dead = await Promise.race([
      pat.phone.client.request("site.set", { countdown: 31 }),
      Bun.sleep(500).then(() => "dead" as const),
    ]);
    expect(dead).toBe("dead");
    pat.phone.client.stop();
    // Started again on what the store kept: the same key, the same hub, the next number.
    const again = phoneOn(memorySecureItems(pat.items.disk));
    again.client.start();
    expect(await until(() => again.client.live.getState().connection.kind === "open")).toBe(true);
    const next = await again.client.request("site.set", { countdown: 32 });
    expect(next.ok).toBe(true);
    const after = await again.records.hub(identity).read();
    expect(after.ok && after.value?.lastSeq).toBe(last + 1);
    pat = { phone: again, items: memorySecureItems(pat.items.disk) };
  }, 30_000);

  test("a typed code with the hub's address typed too", async () => {
    const made = await consoleA.request("link.create", {
      kind: { newPerson: { name: "Ty" } },
      form: "code",
    });
    if (!made.ok || made.body.code === undefined) throw new Error(JSON.stringify(made));
    const typed = readTypedCode(made.body.code, `${HOME ?? ""}:${String(hubA.lanPort)}`);
    if (!typed.ok) throw new Error(typed.fault);
    const phone = phoneOn();
    phone.client.start();
    await phone.client.link(typed.value, "typed", { name: "Ty's phone", kind: "phone" });
    expect(phone.client.local.getState().link).toEqual({ kind: "linked", from: "typed" });
    expect(await until(() => phone.client.live.getState().connection.kind === "open")).toBe(true);
    phone.client.stop();
  }, 30_000);

  test("the phone as built (version 2 only): it links at version 2; its session opens once the hub's version 2 snapshot has version 2's fields, and until then the phone closes it at the snapshot", async () => {
    // Today (B6 has the shell at versions 1 and 2): the hub agrees version 2, but its snapshot
    // lacks `hub.addresses`, `hub.appsPort` (H1), `hub.relay` and `push` (the relay stream),
    // `backupKeyEpoch` (A8) and notifications' `happenedAtMs`, which the frozen schema requires,
    // so the phone closes each session at the snapshot and tries again. When those land, the
    // session opens, and this test checks that instead.
    const v2 = phoneOn(memorySecureItems(), PHONE_PROTO);
    const kinds: string[] = [];
    v2.client.live.subscribe((state) => kinds.push(state.connection.kind));
    await v2.client.link(await qrCode(consoleA, "Vi"), "qr", { name: "Vi's phone", kind: "phone" });
    expect(v2.client.local.getState().link).toEqual({ kind: "linked", from: "qr" });
    const identity = await linkedIdentity(v2);
    const held = await v2.records.backupKeys.held(identity);
    expect(held.ok && held.value.length).toBe(1);
    const applied = await until(() => v2.client.live.getState().session !== null, 8000);
    if (applied) expect(v2.client.live.getState().session?.kind).toBe("phone");
    // Not yet: admitted at version 2 again and again (HubHello each time), the snapshot never
    // applied, as the phone closes each session at it.
    else expect(kinds.filter((k) => k === "open").length).toBeGreaterThanOrEqual(2);
    v2.client.stop();
  }, 30_000);

  test("a phone removed elsewhere: the hub replaces the backup key, and the remaining phone fetches and keeps the new one beside the old", async () => {
    const identity = await linkedIdentity(pat.phone);
    const before = await pat.phone.records.backupKeys.held(identity);
    const other = await linkedPhone("Oz");
    const otherRecord = await other.phone.records.hub(identity).read();
    if (!otherRecord.ok || otherRecord.value === undefined) throw new Error("oz");
    const removed = await consoleA.request("client.remove", {
      client: otherRecord.value.hub.client,
      also: [],
    });
    expect(removed.ok).toBe(true);
    // Oz's phone is told it was removed, and deletes what it held.
    expect(
      await until(() => other.phone.client.live.getState().connection.kind === "removed"),
    ).toBe(true);
    expect(
      await until(
        async () =>
          (await other.phone.records.list()).ok &&
          [...other.items.disk.keys()].every((k) => !k.startsWith("hub.")),
      ),
    ).toBe(true);
    // Pat's phone keeps the new epoch and the old.
    expect(
      await until(async () => {
        const held = await pat.phone.records.backupKeys.held(identity);
        return held.ok && held.value.length === 2;
      }),
    ).toBe(true);
    const after = await pat.phone.records.backupKeys.held(identity);
    expect(after.ok && before.ok && after.value[1]?.epoch).toBe(
      before.ok ? before.value[0]?.epoch : -1,
    );
    expect(
      after.ok &&
        after.value[0] &&
        before.ok &&
        after.value[0].epoch > (before.value[0]?.epoch ?? 0),
    ).toBe(true);
  }, 40_000);
});

describe("restore with a key that is not the file's", () => {
  let code: RestoreCode;
  let connect: ReturnType<typeof targetsConnect>;
  let identityA: string;
  let rightKey: PhoneClient;

  test("a phone holding a key of the offer's epoch that does not open the file: wrongKey", async () => {
    const hub = await startRealHub();
    const console = await consoleOf(hub);
    const phone = await linkedPhone("Sol");
    rightKey = phone.phone;
    identityA = await linkedIdentity(phone.phone);
    const file = await downloadFile(consoleA, false, realTimers);
    if (!file.ok || !("bytes" in file)) throw new Error(JSON.stringify(file));
    const job = uploadJob();
    expect((await sendFile(console, job, file.bytes)).ok).toBe(true);
    const started = await console.request("restore.start", { job });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const read = readCode(started.body.qr);
    if (!read.ok || read.value.kind !== "restore") throw new Error("not a restore code");
    code = read.value.restore;
    secret(code.secret);
    connect = targetsConnect(
      hubSocketConnect(bunSocket, realTimers),
      [{ identity: code.identity, addresses: code.reach.addresses, port: code.reach.port }],
      { answered: () => undefined, localNetworkDenied: () => undefined },
    );
    const held = await phone.phone.records.backupKeys.held(identityA);
    const epoch = held.ok ? (held.value[0]?.epoch ?? 0) : 0;
    const wrong = phoneOn();
    await wrong.records.backupKeys.keep(identityA, { epoch, key: new Uint8Array(32).fill(7) });
    const outcome = await restoreHub(code, {
      connect,
      timers: realTimers,
      app: "0.1.0",
      proto: [1, 1],
      held: (identity) => wrong.records.backupKeys.held(identity),
    });
    expect(outcome).toMatchObject({
      ok: false,
      fault: "wrongKey",
      offer: { identity: identityA, epoch },
    });
  }, 60_000);

  // m2-design.md section 9: after `wrongKey` "the token stays usable until it expires". Today the
  // hub frees the uploaded file after every `applyRestore`, failed or not
  // (`hub/src/shell/app-wiring.ts`, `ended`), so the right key afterwards is answered `busy`.
  // This fails until the hub keeps the file; it then passes, and `.failing` comes off.
  test("after wrongKey, the same code restores with the right key (the hub's, not yet)", async () => {
    const outcome = await restoreHub(code, {
      connect,
      timers: realTimers,
      app: "0.1.0",
      proto: [1, 1],
      held: (identity) => rightKey.records.backupKeys.held(identity),
    });
    expect(outcome).toMatchObject({ ok: true });
  }, 30_000);
});

describe("restore from the phone, end to end", () => {
  test("the restore's refusals, then the restore: the new hub becomes the old, and the phone reaches it as before", async () => {
    // Pat's phone, linked to A, holding A's current backup key.
    const pat = await linkedPhone("Rae");
    const identityA = await linkedIdentity(pat.phone);
    const file = await downloadFile(consoleA, false, realTimers);
    if (!file.ok || !("bytes" in file)) throw new Error(JSON.stringify(file));

    // A new hub, B, with no devices; A's backup uploaded on B's console, which shows the code.
    const hubB = await startRealHub();
    const consoleB = await consoleOf(hubB);
    const job = uploadJob();
    expect((await sendFile(consoleB, job, file.bytes)).ok).toBe(true);
    const started = await consoleB.request("restore.start", { job });
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(started.body.identity).toBe(identityA);
    const read = readCode(started.body.qr);
    if (!read.ok || read.value.kind !== "restore") throw new Error("not a restore code");
    const code: RestoreCode = read.value.restore;
    secret(code.secret);
    expect(code.reach.port).toBe(hubB.lanPort);
    expect(code.reach.addresses).toContain(HOME ?? "no home address");
    const connect = targetsConnect(
      hubSocketConnect(bunSocket, realTimers),
      [{ identity: code.identity, addresses: code.reach.addresses, port: code.reach.port }],
      { answered: () => undefined, localNetworkDenied: () => undefined },
    );
    const deps = (held: PhoneClient["records"]["backupKeys"]["held"]) => ({
      connect,
      timers: realTimers,
      app: "0.1.0",
      proto: [1, 1] as const,
      held,
    });
    const noKeys = memorySecureItems();

    // A code naming another hub: stopped before message 3.
    const forged = await restoreHub(
      { ...code, identity: identityA },
      deps((identity) => phoneOn(noKeys).records.backupKeys.held(identity)),
    );
    expect(forged).toEqual({ ok: false, fault: "wrongHub" });
    // A secret no token has: closed before message 2.
    const unknown = await restoreHub(
      { ...code, secret: new Uint8Array(16).fill(1) },
      deps((identity) => phoneOn(noKeys).records.backupKeys.held(identity)),
    );
    expect(unknown).toEqual({ ok: false, fault: "refused" });
    // A phone without the key: it sees the offer, sends nothing, and closes.
    const without = await restoreHub(
      code,
      deps((identity) => phoneOn(noKeys).records.backupKeys.held(identity)),
    );
    expect(without.ok).toBe(false);
    expect(!without.ok && without.fault).toBe("noKey");
    expect(!without.ok && without.offer?.identity).toBe(identityA);

    // The phone also holds a key of a later epoch, newest first: only the offer's is sent.
    const offerEpoch = !without.ok ? (without.offer?.epoch ?? 0) : 0;
    await pat.phone.records.backupKeys.keep(identityA, {
      epoch: offerEpoch + 1,
      key: new Uint8Array(32).fill(9),
    });
    const held = await pat.phone.records.backupKeys.held(identityA);
    expect(held.ok && held.value.map((k) => k.epoch)).toEqual([offerEpoch + 1, offerEpoch]);

    // The old hub stays off (m2-design.md section 9); the phone restores.
    await hubA.stop();
    let offered = "";
    const restored = await pat.phone.restore(code, (offer) => {
      offered = offer.identity;
    });
    expect(restored).toMatchObject({ ok: true });
    expect(offered).toBe(identityA);
    // B stops and exits for its launcher to start it again as the restored hub.
    await hubB.stop();
    await hubB.start();
    // The phone reaches it at B's address and port, as the client the file holds.
    expect(
      await until(() => pat.phone.client.live.getState().connection.kind === "open", 40_000),
    ).toBe(true);
    const record = await pat.phone.records.hub(identityA).read();
    expect(record.ok && record.value?.reach?.appsPort).toBe(hubB.lanPort);
    const lastBefore = record.ok ? (record.value?.lastSeq ?? 0) : 0;
    // Its first change: `seqTooLow` once (every client's last raised by 2³²), then made above it.
    const change = await pat.phone.client.request("site.set", { countdown: 45 });
    expect(change.ok).toBe(true);
    const after = await pat.phone.records.hub(identityA).read();
    expect(after.ok && (after.value?.lastSeq ?? 0) > 2 ** 32).toBe(true);
    expect(lastBefore).toBeLessThan(2 ** 32);
    pat.phone.client.stop();
  }, 120_000);
});

describe("nothing secret in the output", () => {
  test("no private key, link secret, restore secret or backup key the tests handled was ever written to the console", () => {
    expect(secrets.size).toBeGreaterThan(10);
    const text = output.join("\n");
    for (const value of secrets) expect(text.includes(value)).toBe(false);
  });
});

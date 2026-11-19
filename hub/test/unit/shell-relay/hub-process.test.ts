/**
 * A phone's whole session through B2's real relay to the real hub and back (docs/m4-design.md
 * sections 4 and 9): the hub process started as `main.ts` starts it, pointed at a relay on loopback
 * with `hsn op relay.set` (a version 2 operation on the control socket); the relay sees it join
 * under its app identity; a phone linked through the relay with an invite's secret, then in a
 * version 2 session through it: a request and its reply, version 2's own operations
 * (`relay.status`, `push.register`, `push.test`) reaching the core's relay module, an event the
 * core raises, and the roster and the test push that leave through the relay link, sealed with the
 * phone's key. Every byte crosses a real socket.
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  appIdentityBytes,
  formatIdentity,
  linkPrologue,
  NOISE_PATTERNS,
  parseLinkFragment,
  secretLookup,
  secretPsk,
  sessionPrologue,
  startHandshake,
  type TransportSession,
} from "@hsn/protocol/app";
import { pushOpener } from "@hsn/protocol/relay";
import { exchange } from "../../../cli/client.ts";
import { endProcesses, spawnTracked } from "../../world/processes.ts";
import { RelayPhone, startRelayRun, staticKeyOf, stopAll, testKey, until } from "./support.ts";

const MAIN = join(import.meta.dir, "..", "..", "world", "hub-entry.ts");
const root = mkdtempSync(join(tmpdir(), "hsn-relay-hub-"));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

afterAll(async () => {
  await endProcesses();
  await stopAll();
  rmSync(root, { recursive: true, force: true });
});

function must<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string },
): T {
  expect(result.ok ? "ok" : result.error).toBe("ok");
  return (result as { readonly value: T }).value;
}

const json = (value: unknown) => encoder.encode(JSON.stringify(value));
const parse = (bytes: Uint8Array | undefined) =>
  JSON.parse(decoder.decode(bytes ?? new Uint8Array())) as Record<string, unknown>;

/** One `hsn op` on the control socket: the operation's reply body, or the error. */
async function op(sock: string, name: string, body: unknown): Promise<Record<string, unknown>> {
  const answer = await exchange(
    sock,
    { id: 1, actor: "relay test", command: { kind: "op", op: name, body } },
    5000,
  );
  const reply = answer._unsafeUnwrap().reply.reply;
  return reply.ok && reply.result.kind === "op"
    ? { ok: true, body: reply.result.body }
    : { ok: false, error: reply.ok ? undefined : reply.error };
}

/** A version 2 session's requests and replies, events kept apart. */
class Session {
  readonly events: Record<string, unknown>[] = [];
  #id = 1;
  #seq = 0;

  constructor(
    readonly phone: RelayPhone,
    readonly transport: TransportSession,
  ) {}

  async request(name: string, body: unknown, change = false): Promise<Record<string, unknown>> {
    const id = this.#id++;
    const frame = { t: "req", id, ...(change ? { seq: ++this.#seq } : {}), op: name, body };
    this.phone.send(must(this.transport.encrypt(json(frame))));
    for (;;) {
      const message = parse(
        must(this.transport.decrypt((await this.phone.next(5000)) ?? new Uint8Array())),
      );
      if (message.t === "res" && message.id === id) return message;
      this.events.push(message);
    }
  }

  async event(ev: string): Promise<Record<string, unknown>> {
    for (;;) {
      const found = this.events.find((e) => e.ev === ev);
      if (found !== undefined) return found;
      this.events.push(
        parse(must(this.transport.decrypt((await this.phone.next(5000)) ?? new Uint8Array()))),
      );
    }
  }
}

test("a phone links, opens a version 2 session, registers for push and is pushed to, all through the relay", async () => {
  const run = startRelayRun();
  const dataDir = mkdtempSync(join(root, "hub-"));
  const hub = spawnTracked(
    ["bun", MAIN, "--data", dataDir, "--port", "0", "--no-usb-watch", "--app-ports", "0,0"],
    { stdout: "ignore", stderr: "pipe" },
  );
  // The hub's whole standard error, searched at the end for the push key.
  let stderr = "";
  void (async () => {
    for await (const chunk of hub.stderr as ReadableStream<Uint8Array>)
      stderr += decoder.decode(chunk);
  })();
  const sock = join(dataDir, "control.sock");
  await until(() => existsSync(sock), "the hub's control socket", 20_000);
  await Bun.sleep(300);

  // `hsn op relay.set`: version 2's operation from the hub computer, to the core's relay module.
  const set = await op(sock, "relay.set", { url: run.url });
  expect(set).toMatchObject({ ok: true, body: { url: run.url, isDefault: false } });
  await until(() => run.joined === 1, "the hub's link to the relay", 10_000);
  expect((await op(sock, "relay.status", {})).body).toMatchObject({ url: run.url, state: "up" });

  // An invite for a new person; its address carries the hub's identity and the secret.
  const made = await op(sock, "link.create", {
    kind: { newPerson: { name: "Anna" } },
    form: "url",
  });
  const url = (made.body as { url?: string } | undefined)?.url ?? "";
  const fragment = parseLinkFragment(url.slice(url.indexOf("#") + 1));
  expect(fragment).toBeDefined();
  const identity = fragment?.identity ?? "";

  // Linking through the relay (XXpsk3 on the link path), as a phone.
  const phoneKey = staticKeyOf(90);
  const secret = fragment?.secret ?? new Uint8Array(16);
  const linkHs = must(
    startHandshake({
      pattern: NOISE_PATTERNS.link,
      initiator: true,
      prologue: linkPrologue("link"),
      staticKey: phoneKey,
      psk: secretPsk(sha256, secret),
    }),
  );
  const linking = await RelayPhone.open(run.url, identity, "link");
  linking.send(
    must(await linkHs.writeMessage(json({ proto: [2, 2], find: secretLookup(sha256, secret) }))),
  );
  expect(
    parse(must(await linkHs.readMessage((await linking.next(5000)) ?? new Uint8Array()))),
  ).toMatchObject({
    proto: 2,
  });
  linking.send(must(await linkHs.writeMessage(json({ name: "Anna's phone", kind: "phone" }))));
  const linkTransport = must(linkHs.split());
  const result = parse(must(linkTransport.decrypt((await linking.next(5000)) ?? new Uint8Array())));
  expect(result).toMatchObject({ client: expect.any(Number) as unknown as number });
  expect(await linking.closed(5000)).toBe(1000);
  const hubKey = linkHs.remoteStatic() ?? new Uint8Array(32);
  expect(formatIdentity(appIdentityBytes(sha256, hubKey))).toBe(identity);

  // A version 2 session through the relay.
  const sessionHs = must(
    startHandshake({
      pattern: NOISE_PATTERNS.session,
      initiator: true,
      prologue: sessionPrologue(appIdentityBytes(sha256, hubKey)),
      staticKey: phoneKey,
      remoteStatic: hubKey,
    }),
  );
  const phone = await RelayPhone.open(run.url, identity, "session");
  phone.send(must(await sessionHs.writeMessage(json({ proto: [2, 2], app: "2.0.0" }))));
  const hello = parse(
    must(await sessionHs.readMessage((await phone.next(5000)) ?? new Uint8Array())),
  );
  expect(hello).toMatchObject({ proto: 2, client: { kind: "phone" } });
  const session = new Session(phone, must(sessionHs.split()));

  // A request and its reply; a version 2 operation answered by the core's relay module.
  expect(await session.request("snapshot", {})).toMatchObject({ ok: true });
  expect(await session.request("relay.status", {})).toMatchObject({
    ok: true,
    body: { url: run.url, state: "up" },
  });
  expect(await session.request("subscribe", { topics: ["config"] })).toMatchObject({ ok: true });

  // An event the core raises, through the relay: a group made on the hub computer.
  expect(
    await op(sock, "group.create", { name: "Upstairs", sensors: [], sirens: "all" }),
  ).toMatchObject({
    ok: true,
  });
  expect(await session.event("config")).toMatchObject({ t: "evt", ev: "config" });

  // push.register: the key reaches the shell's PushKeys, and the roster the relay.
  const pushKey = testKey(sha256(Uint8Array.of(91)));
  const keyId = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
  const registered = await session.request(
    "push.register",
    {
      platform: "fcm",
      environment: "production",
      token: "fcm-token-for-anna",
      keyId: Buffer.from(keyId).toString("hex"),
      key: Buffer.from(pushKey).toString("base64url"),
    },
    true,
  );
  expect(registered).toMatchObject({ ok: true, body: { registered: true } });
  await until(() => run.targets(identity).length === 1, "the roster stored", 5000);
  const target = run.targets(identity)[0];
  expect(target).toMatchObject({ key: "0102030405060708", token: "fcm-token-for-anna" });
  const keyFor = () => pushKey;
  expect(pushOpener.open(target?.unreachable ?? "", keyFor)).toMatchObject({
    ok: true,
    value: { hub: identity, n: { kind: "hub_unreachable" } },
  });

  // push.test: sealed by the hub with the phone's key, carried by the relay to its push sender.
  expect(await session.request("push.test", {}, true)).toMatchObject({
    ok: true,
    body: { sent: true },
  });
  await until(() => run.push.items.length === 1, "the test push at the relay's sender", 5000);
  const item = run.push.items[0];
  expect(item).toMatchObject({ hub: identity, token: "fcm-token-for-anna", platform: "fcm" });
  expect(pushOpener.open(item?.h ?? "", keyFor)).toMatchObject({
    ok: true,
    value: { hub: identity, n: { kind: "push_test" } },
  });

  // The push key in no record, no log line: `push.register`'s `commands` row has it left out.
  const db = new Database(join(dataDir, "hub.db"), { readonly: true });
  const args = db
    .query<{ args: string }, []>(`SELECT args FROM commands WHERE kind = 'push.register'`)
    .all()
    .map((row) => row.args);
  const everything =
    db
      .query<{ text: string }, []>(
        `SELECT group_concat(coalesce(args, '') || coalesce(detail, ''), ' ') AS text FROM commands`,
      )
      .get()?.text ?? "";
  db.close();
  expect(args).toHaveLength(1);
  expect(JSON.parse(args[0] ?? "{}")).toMatchObject({ key: "***", keyId: "0102030405060708" });
  for (const text of [
    Buffer.from(pushKey).toString("base64url"),
    Buffer.from(pushKey).toString("base64"),
    Buffer.from(pushKey).toString("hex"),
  ]) {
    expect(everything.includes(text)).toBe(false);
    expect(stderr.includes(text)).toBe(false);
    expect(run.log.text().includes(text)).toBe(false);
  }
}, 60_000);

/**
 * The push role as its own process (section 3, "Roles"): `bun relay/src/push/main.ts` with key
 * files given on the command line, the operator's relay on its local socket, pushes through to
 * both stand-ins, the refused keys read again on SIGHUP, a clean stop on SIGTERM, a refusal to
 * start on a key file others may read. Its whole standard error is searched for every secret it
 * handled. Also the same role started in this process over TLS, with more of the services'
 * answers, its log searched the same way.
 *
 * These run on `@hsn/protocol`'s own XN (B1's), as the push role's process does: not on the double.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appIdentityBytes, formatIdentity } from "@hsn/protocol/app";
import type { RelayPushItem } from "@hsn/protocol/relay";
import { SYSTEM_CLOCK } from "../../src/push/clock.ts";
import { readConfig } from "../../src/push/config.ts";
import { PushLink } from "../../src/push/push-link.ts";
import { startPushRole } from "../../src/push/role.ts";
import { sha256 } from "../../src/push/safe/crypto.ts";
import { loopbackTls, writeSecretFile } from "../../../tools/push-standins/src/index.ts";
import {
  apnsToken,
  expectNoSecret,
  fcmToken,
  hubIdentity,
  memoryLog,
  must,
  REPO,
  relayKey,
  sealedH,
  secretsOf,
  type StandIns,
  standIns,
  TOPIC,
} from "./helpers.ts";

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function until(condition: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await Bun.sleep(10);
  }
  return condition();
}

function argsFor(s: StandIns, socket: string, extra: readonly string[] = []): string[] {
  const caPath = join(s.folder, "standin-ca.pem");
  writeFileSync(caPath, s.tls.cert);
  return [
    "--socket",
    socket,
    "--apns-key",
    s.apnsKeyPath,
    "--apns-key-id",
    s.apnsKey.keyId,
    "--apns-team",
    s.apnsKey.teamId,
    "--apns-topic",
    TOPIC,
    "--fcm-account",
    s.fcmAccountPath,
    "--apns-production",
    s.apns.origin,
    "--apns-development",
    s.apns.origin,
    "--fcm-origin",
    s.fcm.origin,
    "--test-ca",
    caPath,
    ...extra,
  ];
}

function item(id: number, platform: "apns" | "fcm", token: string): RelayPushItem {
  return { id, hub: hubIdentity(id), platform, env: "production", token, h: sealedH(id) };
}

/** Reads a child's standard error as it comes. */
function collect(stream: ReadableStream<Uint8Array>): { text: () => string; done: Promise<void> } {
  let text = "";
  const decoder = new TextDecoder();
  const done = (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk);
  })();
  return { text: () => text, done };
}

describe("the push role's own process (the real XN)", () => {
  // Windows does not deliver SIGHUP or SIGTERM to a running process.
  test.skipIf(process.platform === "win32")(
    "pushes through both services, refuses a key on SIGHUP, stops on SIGTERM; no secret in its log",
    async () => {
      const s = await standIns();
      stops.push(() => s.close());
      const socket = join(s.folder, "push.sock");
      const refusedPath = join(s.folder, "refused-relays");
      writeFileSync(refusedPath, "# none yet\n");
      const child = Bun.spawn(
        [
          process.execPath,
          "relay/src/push/main.ts",
          ...argsFor(s, socket, ["--refused-relays", refusedPath]),
        ],
        {
          cwd: REPO,
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      stops.push(() => {
        child.kill("SIGKILL");
      });
      const stderr = collect(child.stderr);
      expect(await until(() => stderr.text().includes('"started"'))).toBe(true);
      expect(statSync(socket).mode & 0o777).toBe(0o600);

      const key = relayKey();
      const identity = formatIdentity(appIdentityBytes(sha256, key.publicKey));
      const pushLink = new PushLink({
        url: `ws+unix://${socket}:/v1/relay`,
        staticKey: key,
        version: "0.1.0",
        clock: SYSTEM_CLOCK,
        log: memoryLog(),
        random: () => 0.5,
      });
      stops.push(() => {
        pushLink.stop();
      });
      pushLink.start();
      expect(await until(() => pushLink.up)).toBe(true);

      s.apns.unregister(apnsToken(3));
      s.fcm.unregister(fcmToken(4));
      const sent = [
        item(1, "apns", apnsToken(1)),
        item(2, "fcm", fcmToken(2)),
        item(3, "apns", apnsToken(3)),
        item(4, "fcm", fcmToken(4)),
      ];
      const results = (await pushLink.send(sent))._unsafeUnwrap();
      expect([...results].sort((a, b) => a.id - b.id)).toEqual([
        { id: 1, outcome: "accepted" },
        { id: 2, outcome: "accepted" },
        { id: 3, outcome: "badToken" },
        { id: 4, outcome: "badToken" },
      ]);
      expect(s.apns.received.map((r) => r.deviceToken)).toEqual([apnsToken(1), apnsToken(3)]);
      expect(s.fcm.received.map((r) => r.token)).toEqual([fcmToken(2), fcmToken(4)]);
      expect(JSON.parse(s.apns.received[0]?.body ?? "{}")).toMatchObject({ h: sealedH(1) });

      writeFileSync(refusedPath, `# refused\n${identity}\n`);
      child.kill("SIGHUP");
      expect(await until(() => !pushLink.up)).toBe(true);
      expect(await until(() => stderr.text().includes('"refusedRelays"'))).toBe(true);

      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      await stderr.done;
      const log = stderr.text();
      expect(log).toContain('"stopped"');
      // One JSON object a line, every line.
      for (const line of log.trim().split("\n"))
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      expectNoSecret(log, [
        ...secretsOf(s, sent),
        identity,
        Buffer.from(key.publicKey).toString("hex"),
      ]);
    },
  );

  // This refusal is driven by a POSIX key mode, which Windows does not expose.
  test.skipIf(process.platform === "win32")(
    "a key file others may read: it does not start (78), and says so without the key",
    async () => {
      const s = await standIns();
      stops.push(() => s.close());
      chmodSync(s.apnsKeyPath, 0o644);
      const child = Bun.spawn(
        [process.execPath, "relay/src/push/main.ts", ...argsFor(s, join(s.folder, "push.sock"))],
        {
          cwd: REPO,
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(78);
      const log = await new Response(child.stderr).text();
      expect(log).toContain("may be read by others");
      expectNoSecret(log, secretsOf(s, []));
    },
  );
});

describe("the push role started here, over TLS, with more of the services' answers", () => {
  test("every kind of outcome and failure, its log holding no secret, no relay identity and no address", async () => {
    let apnsCalls = 0;
    const s = await standIns({
      apns: (_n, request) => {
        apnsCalls += 1;
        if (request.deviceToken === apnsToken(5))
          return { kind: "status", status: 400, reason: "DeviceTokenNotForTopic" };
        if (request.deviceToken === apnsToken(6))
          return { kind: "status", status: 429, reason: "TooManyRequests" };
        if (request.deviceToken === apnsToken(7))
          return { kind: "status", status: 500, reason: "InternalServerError" };
        return undefined;
      },
    });
    stops.push(() => s.close());
    const tls = must(loopbackTls(Date.now()));
    const tlsKeyPath = must(writeSecretFile(s.folder, "tls.key", tls.key));
    const certPath = join(s.folder, "tls.crt");
    writeFileSync(certPath, tls.cert);
    const config = readConfig(
      [
        ...argsFor(s, join(s.folder, "push.sock")),
        "--listen",
        "127.0.0.1:0",
        "--tls-cert",
        certPath,
        "--tls-key",
        tlsKeyPath,
      ],
      { programFolder: REPO, uid: process.getuid?.() },
    )._unsafeUnwrap();
    const log = memoryLog();
    const role = startPushRole(config, { log })._unsafeUnwrap();
    stops.push(() => role.stop());

    const key = relayKey();
    const identity = formatIdentity(appIdentityBytes(sha256, key.publicKey));
    const pushLink = new PushLink({
      url: `wss://127.0.0.1:${role.listeners.port ?? 0}/v1/relay`,
      staticKey: key,
      version: "0.1.0",
      clock: SYSTEM_CLOCK,
      log,
      ca: tls.cert,
      random: () => 0.5,
    });
    stops.push(() => {
      pushLink.stop();
    });
    pushLink.start();
    expect(await until(() => pushLink.up)).toBe(true);

    expect((await pushLink.send([item(1, "fcm", fcmToken(1))])).isOk()).toBe(true);
    s.fcm.revokeAccessTokens();
    const sent = [
      item(2, "apns", apnsToken(2)),
      item(5, "apns", apnsToken(5)),
      item(6, "apns", apnsToken(6)),
      item(7, "apns", apnsToken(7)),
      item(8, "fcm", fcmToken(8)),
      item(9, "fcm", "x".repeat(10)),
    ];
    const results = (await pushLink.send(sent))._unsafeUnwrap();
    expect(Object.fromEntries(results.map((r) => [r.id, r.outcome]))).toEqual({
      2: "accepted",
      5: "failed",
      6: "limited",
      7: "failed",
      8: "accepted",
      9: "badToken",
    });
    expect(apnsCalls).toBe(4);
    // A refused relay, a malformed frame.
    role.service.setRefused(new Set([identity]));
    expect(await until(() => !pushLink.up)).toBe(true);
    const text = log.text();
    expect(text).toContain('"pushDropped"');
    expect(text).toContain('"credentialsRenewed"');
    expect(text).toContain('"linkJoined"');
    expectNoSecret(text, [
      ...secretsOf(s, [item(1, "fcm", fcmToken(1)), ...sent]),
      ...tls.key.split("\n").filter((l) => l.length > 16 && !l.startsWith("-----")),
      identity,
      "127.0.0.1",
    ]);
  });
});

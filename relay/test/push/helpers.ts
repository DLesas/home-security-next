/**
 * What the push role's tests share: the stand-ins with keys made for each test, key files written
 * as the role expects them (0600, outside the repository), a log that keeps its lines, a clock
 * the test drives, and relay keys for `@hsn/protocol`'s XN.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { type StaticKey, x25519StaticKey } from "@hsn/protocol/app";
import { expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  type ApnsReceived,
  type ApnsScript,
  type FcmReceived,
  type ApnsStandIn,
  type ApnsTestKey,
  type FcmScript,
  type FcmStandIn,
  type FcmTestAccount,
  type LoopbackTls,
  loopbackTls,
  makeApnsTestKey,
  makeFcmTestAccount,
  serviceAccountJson,
  startApnsStandIn,
  startFcmStandIn,
  writeSecretFile,
} from "../../../tools/push-standins/src/index.ts";
import type { LinkClock } from "../../src/push/clock.ts";
import { jsonLineLog, type PushLog } from "../../src/push/log.ts";
import { tempFolder as relayTempFolder } from "../helpers.ts";

export const REPO = resolve(import.meta.dir, "..", "..", "..");
export const TOPIC = "invalid.hsn.app";

/** The value of a result that must be ok; the test fails on the error otherwise. */
export function must<T>(
  result:
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) expect(String(result.error)).toBe("no error");
  return (result as { readonly value: T }).value;
}

/** A fresh folder outside the repository, removed by `cleanup`. */
export function tempFolder(): string {
  return relayTempFolder("hsn-push-test-");
}

export function cleanup(folder: string): void {
  rmSync(folder, { recursive: true, force: true });
}

/** A log that keeps every line, for the tests that search it. */
export function memoryLog(): PushLog & { readonly lines: string[]; readonly text: () => string } {
  const lines: string[] = [];
  const log = jsonLineLog(
    (line) => lines.push(line),
    () => Date.now(),
  );
  return {
    write: (level, event, fields, error) => {
      log.write(level, event, fields, error);
    },
    lines,
    text: () => lines.join(""),
  };
}

/** A clock the test moves by hand; timers run as it passes them. */
export class ManualClock implements LinkClock {
  private timers: { at: number; run: () => void; id: number }[] = [];
  private nextId = 0;
  constructor(public ms: number) {}
  now(): number {
    return this.ms;
  }
  after(ms: number, run: () => void): () => void {
    const id = this.nextId++;
    this.timers.push({ at: this.ms + ms, run, id });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }
  /** Moves the clock, running each timer due, in order. */
  advance(ms: number): void {
    const end = this.ms + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.ms = Math.max(this.ms, due.at);
      due.run();
    }
    this.ms = end;
  }
  get pending(): number {
    return this.timers.length;
  }
}

/** A relay's static key, made for the test. */
export function relayKey(): StaticKey {
  return must(x25519StaticKey(new Uint8Array(randomBytes(32))));
}

/** The stand-ins and everything a test needs to point the push role at them. */
export interface StandIns {
  readonly tls: LoopbackTls;
  readonly apnsKey: ApnsTestKey;
  readonly account: FcmTestAccount;
  readonly apns: ApnsStandIn;
  readonly fcm: FcmStandIn;
  readonly folder: string;
  readonly apnsKeyPath: string;
  readonly fcmAccountPath: string;
  close(): Promise<void>;
}

export interface StandInScripts {
  readonly apns?: (n: number, request: ApnsReceived) => ApnsScript | undefined;
  readonly fcm?: (n: number, request: FcmReceived) => FcmScript | undefined;
  readonly apnsNow?: () => number;
  readonly fcmNow?: () => number;
  readonly maxConcurrentStreams?: number;
  readonly accessTokenLifetimeS?: number;
}

export async function standIns(scripts: StandInScripts = {}): Promise<StandIns> {
  const tls = must(loopbackTls(Date.now()));
  const apnsKey = must(makeApnsTestKey());
  const account = must(makeFcmTestAccount());
  let apnsN = 0;
  let fcmN = 0;
  const apns = must(
    await startApnsStandIn({
      tls,
      keyId: apnsKey.keyId,
      teamId: apnsKey.teamId,
      publicKeyPem: apnsKey.publicPem,
      topic: TOPIC,
      ...(scripts.maxConcurrentStreams === undefined
        ? {}
        : { maxConcurrentStreams: scripts.maxConcurrentStreams }),
      ...(scripts.apnsNow === undefined ? {} : { now: scripts.apnsNow }),
      ...(scripts.apns === undefined
        ? {}
        : { script: (request) => scripts.apns?.(++apnsN, request) }),
    }),
  );
  const fcm = must(
    startFcmStandIn({
      tls,
      projectId: account.projectId,
      clientEmail: account.clientEmail,
      privateKeyId: account.privateKeyId,
      publicKeyPem: account.publicPem,
      ...(scripts.accessTokenLifetimeS === undefined
        ? {}
        : { accessTokenLifetimeS: scripts.accessTokenLifetimeS }),
      ...(scripts.fcmNow === undefined ? {} : { now: scripts.fcmNow }),
      ...(scripts.fcm === undefined ? {} : { script: (request) => scripts.fcm?.(++fcmN, request) }),
    }),
  );
  const folder = tempFolder();
  const apnsKeyPath = must(writeSecretFile(folder, "AuthKey.p8", apnsKey.privatePem));
  const fcmAccountPath = must(
    writeSecretFile(folder, "service-account.json", serviceAccountJson(account, fcm.tokenUri)),
  );
  return {
    tls,
    apnsKey,
    account,
    apns,
    fcm,
    folder,
    apnsKeyPath,
    fcmAccountPath,
    async close() {
      await apns.close();
      await fcm.close();
      cleanup(folder);
    },
  };
}

/** A device token of APNs's form, and an FCM token of the stand-in's. */
export const apnsToken = (n: number) => n.toString(16).padStart(64, "a");
export const fcmToken = (n: number) => `fcm-${n}-`.padEnd(40, "x");

/**
 * A sealed push of the right form, `1.<key id>.<1,744 base64url>`, different for each `n` and the
 * same each time: 1,308 bytes from SHA-256 in counter mode. Its content is not opened here.
 */
export function sealedH(n = 0): string {
  const chunks: Buffer[] = [];
  for (let i = 0; chunks.length * 32 < 1308; i += 1)
    chunks.push(createHash("sha256").update(`${n}:${i}`).digest());
  return `1.${n.toString(16).padStart(16, "0")}.${Buffer.concat(chunks).subarray(0, 1308).toString("base64url")}`;
}

/** A hub identity of the right form. */
export function hubIdentity(n: number): string {
  let letters = "";
  let rest = n;
  do {
    letters += "abcdefghijklmnopqrstuvwxyz"[rest % 26] ?? "a";
    rest = Math.floor(rest / 26);
  } while (rest > 0);
  return `hub${letters}`.padEnd(26, "q");
}

/** A PEM's base64 lines: any one of them in a log would be part of a key. */
export function pemLines(pem: string): string[] {
  return pem.split("\n").filter((line) => line.length >= 16 && !line.startsWith("-----"));
}

/**
 * Everything secret a run with these stand-ins may have handled: the keys' text, every JWT and
 * access token the stand-ins saw or issued, and the tokens and `h` values the test sent. A log
 * line holding any of them fails the test that calls this.
 */
export function secretsOf(
  s: StandIns,
  sent: readonly { readonly token: string; readonly h: string }[],
): string[] {
  const jwts = s.apns.received.flatMap((r) => {
    const bearer = r.authorization?.replace(/^bearer /u, "");
    return bearer === undefined ? [] : [bearer, bearer.split(".")[2] ?? bearer];
  });
  const assertions = s.fcm.tokenRequests.flatMap((r) =>
    r.assertionText === null
      ? []
      : [r.assertionText, r.assertionText.split(".")[2] ?? r.assertionText],
  );
  return [
    ...pemLines(s.apnsKey.privatePem),
    ...pemLines(s.account.privatePem),
    ...pemLines(s.tls.key),
    s.account.privateKeyId,
    ...jwts,
    ...assertions,
    ...s.fcm.issued,
    ...sent.flatMap((item) => [item.token, item.h, item.h.slice(19, 80)]),
  ].filter((secret) => secret.length >= 8);
}

/** Fails, naming which, if any secret appears in `text`. */
export function expectNoSecret(text: string, secrets: readonly string[]): void {
  const found = secrets
    .filter((secret) => text.includes(secret))
    .map((secret) => `${secret.slice(0, 12)}…`);
  expect(found).toEqual([]);
}

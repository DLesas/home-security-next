/**
 * A self-hosted relay and the operated service (docs/m4-design.md section 3, "Self-hosting", and
 * section 6: "a self-hosted relay fills its folder over its relay link to the operated service";
 * D77, D84, D142). Every piece as its own process: the operated push role (its local socket for the
 * operator's relay, a TLS listener for self-hosted ones, the releases role's forwarding socket),
 * the operated relay with a signed release in its folder, a self-hosted relay program whose
 * configuration points its push link at the operated push service over TLS, and a real hub on the
 * self-hosted relay with a phone registered through it.
 *
 * - Pushes: the self-hosted relay's relay link to the operated push service carries the hub's
 *   pushes to the stand-ins, sealed as the hub sealed them.
 * - Its release cache over that relay link (FOUND-2): the release arrives whole and checked
 *   without using the same-host forwarding socket as the upstream.
 * - On one host (the operated relay's forwarding socket as the upstream, which the program does
 *   offer): the cache fills, whole and checked, and a hub on the self-hosted relay is offered the
 *   release and fetches and stages it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endProcesses } from "../world/processes.ts";
import { loopbackTls, writeSecretFile } from "../../../tools/push-standins/src/index.ts";
import { Seen } from "./leaks.ts";
import { AwayPhone } from "./phone.ts";
import {
  ALL_OUTPUT,
  check,
  freePort,
  HubProcess,
  PushRole,
  RelayProgram,
  shortFolder,
  waitFor,
} from "./processes.ts";
import {
  fcmToken,
  openedFor,
  RELEASE_VERSION,
  type StandIns,
  standIns,
  writeTestRelease,
} from "./pushes.ts";

const SECOND = 1000;
const roots: string[] = [];
const stops: (() => unknown)[] = [];
const seen = new Seen();
afterAll(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await endProcesses();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Operated {
  readonly root: string;
  readonly s: StandIns;
  readonly push: PushRole;
  readonly relay: RelayProgram;
  readonly forwarding: string;
  readonly release: ReturnType<typeof writeTestRelease>;
  /** `wss://127.0.0.1:<port>/v1/relay` and the certificate a self-hosted relay trusts for it. */
  readonly pushUrl: string;
  readonly caPath: string;
}

/** The operated service: push role (socket and TLS), relay with a release, forwarding socket. */
async function operated(): Promise<Operated> {
  const root = shortFolder("hsn-sh-");
  roots.push(root);
  const s = await standIns();
  seen.standIns = s;
  stops.push(() => s.close());
  const tls = loopbackTls(Date.now());
  check(tls.ok, "a certificate for the push service");
  const pair = tls.ok ? tls.value : { key: "", cert: "" };
  const keyPath = writeSecretFile(root, "push-tls.key", pair.key);
  check(keyPath.ok, "the TLS key written");
  const certPath = join(root, "push-tls.crt");
  writeFileSync(certPath, pair.cert);
  const port = await freePort();
  const forwarding = join(root, "releases.sock");
  const push = new PushRole(root, s, {
    releasesSocket: forwarding,
    tls: { certPath, keyPath: keyPath.ok ? keyPath.value : "", port },
  });
  await push.start();
  stops.push(() => push.stop());
  const releases = join(root, "releases");
  mkdirSync(releases);
  const release = writeTestRelease(releases, 300 * 1024);
  const relay = new RelayProgram(root, {
    pushUrl: push.url,
    releases: { folder: releases, socket: forwarding },
  });
  await relay.start();
  seen.relayDirs.push(relay.dataFolder);
  stops.push(() => relay.stop());
  return {
    root,
    s,
    push,
    relay,
    forwarding,
    release,
    pushUrl: `wss://127.0.0.1:${String(port)}/v1/relay`,
    caPath: certPath,
  };
}

/** A self-hosted relay program on its own folder, its push link to the operated push service. */
async function selfHosted(
  o: Operated,
  upstreamSocket?: string,
): Promise<{ relay: RelayProgram; folder: string }> {
  const root = shortFolder("hsn-own-");
  roots.push(root);
  const folder = join(root, "releases");
  mkdirSync(folder);
  const relay = new RelayProgram(root, {
    pushUrl: o.pushUrl,
    pushCa: o.caPath,
    releases: {
      folder,
      ...(upstreamSocket === undefined ? {} : { upstreamSocket }),
    },
  });
  await relay.start();
  seen.relayDirs.push(relay.dataFolder);
  stops.push(() => relay.stop());
  return { relay, folder };
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const cached = (folder: string, name: string) =>
  existsSync(join(folder, name)) &&
  readdirSync(folder).every((entry) => !entry.startsWith(".partial-"));

describe("a self-hosted relay and the operated service", () => {
  test("a hub on a self-hosted relay is pushed to through the operated push service, over TLS", async () => {
    const o = await operated();
    const own = await selfHosted(o);
    check(
      await waitFor(() => own.relay.events("relayLinkUp").length >= 1, 15 * SECOND),
      "the self-hosted relay's link to the push service is up",
    );
    const hub = new HubProcess(own.relay.folder);
    seen.hubDirs.push(hub.dataDir);
    await hub.start();
    stops.push(() => hub.kill());
    check((await hub.op("relay.set", { url: own.relay.url })).ok, "relay.set");
    check(await hub.relayState("up", 15 * SECOND), "the hub on the self-hosted relay");
    const invite = await hub.op("link.create", {
      kind: { newPerson: { name: "Sam" } },
      form: "qr",
    });
    const linked = await AwayPhone.link(
      invite.ok ? String(invite.body.qr) : "",
      "Sam's phone",
      own.relay.url,
    );
    check(linked instanceof AwayPhone, `linked: ${JSON.stringify(linked)}`);
    const phone = linked as AwayPhone;
    seen.phones.push(phone);
    stops.push(() => {
      phone.stop();
    });
    check(await phone.open(), "the session");
    const token = fcmToken(61);
    seen.tokens.push(token);
    check((await phone.registerPush("fcm", token)).ok, "push.register");
    await Bun.sleep(500);
    check((await phone.request("push.test", {})).ok, "push.test");
    check(
      await waitFor(() => openedFor(o.s, token, phone).length === 1, 10 * SECOND),
      "the test push at the stand-in",
    );
    expect(openedFor(o.s, token, phone)[0]?.content.n.kind).toBe("push_test");
    phone.stop();
    await hub.stop();
  }, 90_000);

  test("FOUND-2: a self-hosted relay fills its release cache over its relay link to the operated service", async () => {
    const o = await operated();
    const own = await selfHosted(o);
    const name = o.release.path.split("/").at(-1) ?? "";
    expect(await waitFor(() => cached(own.folder, name), 20 * SECOND)).toBe(true);
    expect(sha(join(own.folder, name))).toBe(sha(o.release.path));
  }, 60_000);

  test("on one host, through the forwarding socket: the cache fills, and a hub on the self-hosted relay fetches and stages the release", async () => {
    const o = await operated();
    const own = await selfHosted(o, o.forwarding);
    const name = o.release.path.split("/").at(-1) ?? "";
    check(await waitFor(() => cached(own.folder, name), 20 * SECOND), "the cache filled");
    expect(sha(join(own.folder, name))).toBe(sha(o.release.path));
    const hub = new HubProcess(own.relay.folder, { programTree: true });
    seen.hubDirs.push(hub.dataDir);
    await hub.start();
    stops.push(() => hub.kill());
    check((await hub.op("relay.set", { url: own.relay.url })).ok, "relay.set");
    check(await hub.relayState("up", 15 * SECOND), "the hub on the self-hosted relay");
    const offered = await waitFor(
      async () => {
        const offers = await hub.op("update.offers", {});
        return (
          offers.ok &&
          (offers.body.offer as { version?: string } | null)?.version === RELEASE_VERSION
        );
      },
      10 * SECOND,
      200,
    );
    check(offered, "offered by the self-hosted relay");
    check((await hub.op("update.fetch", { version: RELEASE_VERSION })).ok, "update.fetch");
    check(
      await waitFor(
        async () => {
          const status = await hub.op("update.status", {});
          return status.ok && status.body.staged === RELEASE_VERSION;
        },
        30 * SECOND,
        250,
      ),
      "staged",
    );
    await hub.stop();
  }, 120_000);
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});

/**
 * M4's "done when", as proposed (docs/m4-design.md section 1), on this Mac (section 11, "The
 * 'done when', locally"): `bun run m4`, as `bun run m1a` is for M1a.
 *
 * Every piece runs as it runs on a host: the push role as its own process against B3's stand-ins
 * for Apple and Google; the relay program from a configuration file in `relay/test/local.json`'s
 * form; the real hub (`runHub`, through the tests' entry that trusts `TEST_PUBLISHER_KEY`) on a
 * temporary data folder with a gateway and a door sensor paired, the gateway scripted on the hub's
 * `/device` WebSocket (`hub/test/world`); a second real hub that fetches and installs a release; and
 * phones on the phone's own client code (`app/src/hub/`), through the relay, as phones away from
 * home. The relay runs on the system clock, so its 3 minutes are real: the run takes about five
 * minutes.
 *
 * Each numbered check is recorded and the run goes on where it can, so one run shows every
 * finding; the test fails if any check did. What cannot be made on this Mac says so in its name and
 * tests the furthest point that can be reached: real delivery by Apple and Google, and a phone's
 * extension opening a push, are replaced by the stand-ins' record of exactly what they were given,
 * opened with the protocol package's opener and the phone's key.
 *
 * It runs only with `HSN_M4=1`: `bun run m4` at the repository's root.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEPLOYMENT } from "@hsn/deployment";
import { pushOpener, RELAY_LIMITS } from "@hsn/protocol/relay";
import { installPaths } from "../../launcher/src/layout.ts";
import { endProcesses } from "../world/processes.ts";
import { COUNTDOWN_S, HOME_KEYS, HomeGateway, SENSOR, SENSOR_NAME, seedHome } from "./home.ts";
import { collectSecrets, guardsEngaged, leaksIn } from "./leaks.ts";
import { AwayPhone, relayConnect } from "./phone.ts";
import {
  ALL_OUTPUT,
  freePort,
  HubProcess,
  Passthrough,
  PushRole,
  REPO,
  RelayProgram,
  shortFolder,
  waitFor,
} from "./processes.ts";
import {
  apnsToken,
  arrivedFor,
  fcmToken,
  openedFor,
  RELEASE_VERSION,
  type StandIns,
  standIns,
  writeTestRelease,
} from "./pushes.ts";

const ENABLED = process.env.HSN_M4 === "1";
const KEEP = process.env.HSN_M4_KEEP === "1";
const SECOND = 1000;
/** The relay's alert, 180 s after the last frame (D96), and the design's tolerance (section 11). */
const UNREACHABLE_AFTER_MS = 180 * SECOND;
const TOLERANCE_MS = 2 * SECOND;

class Checks {
  readonly passed: string[] = [];
  readonly findings: string[] = [];
  check(ok: boolean, what: string, evidence: unknown = ""): boolean {
    if (ok) this.passed.push(what);
    else
      this.findings.push(
        evidence === ""
          ? what
          : `${what}\n  ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`,
      );
    return ok;
  }
}

const roots: string[] = [];
const stops: (() => unknown)[] = [];
afterAll(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await endProcesses();
  if (!KEEP) for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Every file under `folder` with one of `extensions`, for the configuration's check. */
function sourceFiles(folder: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(folder)) {
    if (entry === "node_modules" || entry.startsWith(".") || entry === "dist") continue;
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path, extensions));
    else if (extensions.some((e) => entry.endsWith(e))) out.push(path);
  }
  return out;
}

describe.skipIf(!ENABLED)("M4's done when, on this Mac (bun run m4)", () => {
  test("the hub on a relay with no account, a phone away from home, sealed pushes, Disarm, the unreachable alert, late notifications and a release", async () => {
    const c = new Checks();
    const root = shortFolder("hsn-m4-");
    roots.push(root);

    // ----- The service: the stand-ins, the push role, the relay with a signed release. -----
    const s: StandIns = await standIns();
    stops.push(() => s.close());
    const releases = join(root, "releases");
    mkdirSync(releases);
    const release = writeTestRelease(releases, 600 * 1024);
    const forwarding = join(root, "releases.sock");
    const push = new PushRole(root, s, { releasesSocket: forwarding });
    await push.start();
    stops.push(() => push.stop());
    const relay = new RelayProgram(root, {
      pushUrl: push.url,
      releases: { folder: releases, socket: forwarding },
    });
    await relay.start();
    stops.push(() => relay.stop());
    // Hub A's way to the relay: the home's internet, which the run cuts.
    const internet = new Passthrough(relay.port);
    stops.push(() => {
      internet.close();
    });

    // ----- Hub A: a home with a door; hub B: the one that installs the release. -----
    const hubA = new HubProcess(root, { seed: seedHome });
    await hubA.start();
    stops.push(() => hubA.kill());
    const gateway = new HomeGateway();
    stops.push(() => {
      gateway.close();
    });
    c.check(await gateway.connect(hubA.devicePort), "setup: hub A welcomes its gateway");
    const hubB = new HubProcess(root, { programTree: true });
    await hubB.start();
    stops.push(() => hubB.kill());
    const identityA = await hubA.identity();
    const identityB = await hubB.identity();

    // 0. The configuration point (section 2): while the domain is the placeholder, no relay.
    const before = await hubA.relayStatus();
    c.check(
      before.state === "off" && before.url === null && before.isDefault === true,
      "0. a hub with the placeholder deployment has no relay and reaches nothing until one is set",
      before,
    );
    c.check(
      relay.events("hubJoined").length === 0,
      "0. no hub joined the relay before it was set",
      relay.events("hubJoined"),
    );

    // 1. The hub joins the relay with no account: `relay.set`, then XN with its app key.
    const setA = await hubA.op("relay.set", { url: internet.url });
    const setB = await hubB.op("relay.set", { url: relay.url });
    c.check(setA.ok && setB.ok, "1. relay.set is taken on both hubs", { setA, setB });
    const joined = await waitFor(
      async () =>
        (await hubA.relayStatus()).state === "up" && (await hubB.relayStatus()).state === "up",
      15 * SECOND,
      100,
    );
    c.check(joined, "1. both hubs' links are up", {
      a: await hubA.relayStatus(),
      b: await hubB.relayStatus(),
    });
    {
      const db = new Database(join(relay.dataFolder, "relay.db"), { readonly: true });
      const hubs = db.query<Record<string, unknown>, []>("SELECT * FROM hubs").all();
      db.close(true);
      const identities = hubs.map((row) => row.identity);
      c.check(
        identities.includes(identityA) && identities.includes(identityB) && hubs.length === 2,
        "1. the relay knows each hub only by the identity its key proved (no account, no address stored)",
        hubs.map((row) => Object.keys(row)),
      );
      c.check(
        hubs.every((row) =>
          Object.values(row).every(
            (value) => typeof value !== "string" || !value.includes("127.0.0.1"),
          ),
        ),
        "1. the relay stored no address of a hub",
      );
    }

    // 2. A phone links away from home through the relay and holds a session.
    const invite = await hubA.op("link.create", {
      kind: { newPerson: { name: "Anna" } },
      form: "qr",
    });
    const qr = invite.ok && typeof invite.body.qr === "string" ? invite.body.qr : "";
    c.check(
      (await AwayPhone.relayOf(qr)) === internet.url,
      "2. the link code names the hub's relay (r=), which is not the default",
      qr.replace(/s=[^&]+/u, "s=…"),
    );
    // The phone is away: it reaches the relay itself, not through the home's internet.
    const annaLinked = await AwayPhone.link(qr, "Anna's phone", relay.url, true);
    const anna = annaLinked instanceof AwayPhone ? annaLinked : undefined;
    c.check(
      anna !== undefined,
      "2. the phone links through the relay (XXpsk3 on the link path)",
      annaLinked,
    );
    if (anna === undefined) {
      expect(c.findings).toEqual([]);
      return;
    }
    stops.push(() => {
      anna.stop();
    });
    c.check(
      anna.identity === identityA && anna.backupKey !== undefined,
      "2. linked to hub A, holding its backup key",
    );
    c.check(await anna.open(), "2. its session (IK) opens through the relay", anna.statuses);
    const info = await anna.request("hub.info", {});
    c.check(
      info.ok && (info.body as { relay?: { url?: string } }).relay?.url === internet.url,
      "2. hub.info names the relay in use",
      info,
    );

    // User management is off (a new hub's default): every person may view and manage every
    // device, so Anna is told of the door and offered Disarm.
    const pushToken = fcmToken(1);
    const registered = await anna.registerPush("fcm", pushToken);
    c.check(registered.ok, "3. push.register through the session", registered);
    const rostered = await waitFor(() => relay.events("roster").length >= 1, 10 * SECOND);
    c.check(rostered, "3. the hub's roster reaches the relay", relay.events("roster"));

    // 3. The armed door's countdown reaches the phone as a push the relay cannot read.
    const armed = await anna.request("arm", { target: { sensor: SENSOR } });
    c.check(armed.ok, "3. Anna arms the door through the relay", armed);
    const openedAt = Date.now();
    c.check(gateway.door(true), "3. the door opens");
    const countdownPush = await waitFor(
      () => openedFor(s, pushToken, anna).some((p) => p.content.n.kind === "countdown_started"),
      10 * SECOND,
    );
    const countdown = openedFor(s, pushToken, anna).find(
      (p) => p.content.n.kind === "countdown_started",
    );
    c.check(
      countdownPush,
      "3. the countdown's push reaches the phone (real FCM and the phone's service cannot run here: the stand-in received a sealed h the phone's key opens)",
      arrivedFor(s, pushToken),
    );
    if (countdown !== undefined) {
      c.check(
        countdown.content.hub === identityA &&
          countdown.content.n.critical &&
          countdown.content.actions.includes("disarm") &&
          countdown.content.names.device === SENSOR_NAME &&
          !countdown.content.delayed &&
          countdown.content.armed,
        "3. it says which hub and door, is critical, not late, armed, and offers Disarm",
        countdown.content,
      );
      c.check(
        countdown.atMs - openedAt < 5 * SECOND,
        `3. within 5 s of the door (${String(countdown.atMs - openedAt)} ms)`,
      );
      const otherKey = new Uint8Array(32).fill(0x5a);
      c.check(
        !pushOpener.open(countdown.h, () => otherKey).ok &&
          countdown.h.length === 1763 &&
          !countdown.body.includes(SENSOR_NAME) &&
          !countdown.body.includes("countdown"),
        "3. the push is 1,763 characters of sealed h that no other key opens, nothing readable beside it",
        countdown.body.length,
      );
    }

    // 4. Disarm as `first`, through whichever path answers: home (refused: away), then the relay.
    const closedPort = await freePort();
    const disarm = await anna.disarmFirst([
      relayConnect(`ws://127.0.0.1:${String(closedPort)}`, identityA),
      relayConnect(relay.url, identityA),
    ]);
    const disarmed = disarm.reply as
      { ok?: boolean; body?: { disarmed?: readonly number[] } } | undefined;
    c.check(
      disarmed?.ok === true && (disarmed.body?.disarmed ?? []).includes(SENSOR),
      "4. Disarm from the push, as first of an IK session through the path that answered (the relay; the lock screen's own code is not built: protocol's Noise stands in)",
      disarm,
    );
    await Bun.sleep((COUNTDOWN_S + 2) * SECOND);
    c.check(
      !openedFor(s, pushToken, anna).some((p) => p.content.n.kind === "alarm"),
      "4. the countdown was cancelled: no alarm followed",
      openedFor(s, pushToken, anna).map((p) => p.content.n.kind),
    );

    // 5. The alarm: armed again, the door shut and opened, the countdown left to end.
    gateway.door(false);
    await Bun.sleep(1500);
    const armedAgain = await anna.request("arm", { target: { sensor: SENSOR } });
    c.check(armedAgain.ok, "5. armed again", armedAgain);
    gateway.door(true);
    const alarmed = await waitFor(
      () => openedFor(s, pushToken, anna).some((p) => p.content.n.kind === "alarm"),
      (COUNTDOWN_S + 10) * SECOND,
    );
    const alarm = openedFor(s, pushToken, anna).find((p) => p.content.n.kind === "alarm");
    c.check(
      alarmed &&
        alarm !== undefined &&
        alarm.content.n.critical &&
        alarm.content.actions.includes("disarm"),
      "5. the alarm reaches the phone as a sealed push, critical, offering Disarm",
      alarm?.content ?? openedFor(s, pushToken, anna).map((p) => p.content.n.kind),
    );
    const ended = await anna.request("disarm", { target: "mine" });
    c.check(
      ended.ok && (ended.body as { alarmEnded?: boolean }).alarmEnded === true,
      "5. Disarm through the session ends the alarm",
      ended,
    );
    gateway.door(false);
    c.check(anna.status === "open", "2. the session held throughout", anna.statuses);
    const lastAskedAt = Date.now();
    const statusesBefore = anna.statuses.length;

    // 6. A signed test release: offered at link-up, fetched on request, staged.
    const benInvite = await hubB.op("link.create", {
      kind: { newPerson: { name: "Ben" } },
      form: "qr",
    });
    const benQr = benInvite.ok && typeof benInvite.body.qr === "string" ? benInvite.body.qr : "";
    const benLinked = await AwayPhone.link(benQr, "Ben's phone", relay.url);
    const ben = benLinked instanceof AwayPhone ? benLinked : undefined;
    c.check(ben !== undefined, "setup: a phone linked to hub B through the relay", benLinked);
    const benToken = apnsToken(2);
    if (ben !== undefined) {
      stops.push(() => {
        ben.stop();
      });
      c.check(await ben.open(), "setup: its session opens");
      const benRegistered = await ben.registerPush("apns", benToken);
      c.check(benRegistered.ok, "setup: Ben registers for push (APNs)", benRegistered);
      await waitFor(() => relay.events("roster").length >= 2, 10 * SECOND);
    }
    const offers = await hubB.op("update.offers", {});
    const offer = offers.ok
      ? (offers.body.offer as { version?: string; bytes?: number })
      : undefined;
    c.check(
      offer?.version === RELEASE_VERSION && offer.bytes === release.size,
      "6. the signed release in the relay's folder is offered to the hub",
      offers,
    );
    const fetched = await hubB.op("update.fetch", { version: RELEASE_VERSION });
    c.check(fetched.ok, "6. update.fetch is taken", fetched);
    const staged = await waitFor(
      async () => {
        const status = await hubB.op("update.status", {});
        return status.ok && status.body.staged === RELEASE_VERSION;
      },
      60 * SECOND,
      250,
    );
    c.check(
      staged,
      `6. fetched through the relay in pieces (${String(release.size)} bytes) and staged, its signature checked`,
      await hubB.op("update.status", {}),
    );

    // 2. The session held, idle, past the relay's 90 s for a quiet stream: the hub's encrypted
    // ping keeps it open (section 3, "Close codes to the phone").
    await Bun.sleep(Math.max(0, lastAskedAt + RELAY_LIMITS.streamIdleMs + 5 * SECOND - Date.now()));
    const idleAnswer = await anna.request("hub.info", {});
    c.check(
      idleAnswer.ok && anna.statuses.length === statusesBefore && anna.status === "open",
      "2. the session, idle past the relay's 90 s, is still open and answers: the hub's ping keeps it",
      anna.statuses.slice(statusesBefore),
    );

    // 7 and 8. Hub A's internet is cut and the hub stopped (unannounced); hub B switches to the
    // release (announced). 9. Meanwhile hub A raises a countdown it cannot push.
    const cutAt = Date.now();
    internet.cut();
    const approved = await hubB.op("update.approve", {});
    c.check(approved.ok, "8. hub B's update is approved and switches", approved);
    const switched = await Promise.race([hubB.ended(), Bun.sleep(10 * SECOND).then(() => -1)]);
    c.check(
      switched === 70,
      `8. hub B announced its restart and exited 70 for its launcher (${String(switched)})`,
    );
    // The relay holds hub B's grace: `restarting` came before the stop (the relay's own record).
    {
      const db = new Database(join(relay.dataFolder, "relay.db"), { readonly: true });
      const row = db
        .query<{ grace_end_ms: number }, [string]>(
          "SELECT grace_end_ms FROM hubs WHERE identity = ?",
        )
        .get(identityB);
      db.close(true);
      const graceLeftMs = (row?.grace_end_ms ?? 0) - Date.now();
      c.check(
        graceLeftMs > RELAY_LIMITS.maxRestartWithinMs - 15 * SECOND &&
          graceLeftMs <= RELAY_LIMITS.maxRestartWithinMs,
        `8. the relay holds hub B's announced grace of 10 minutes (${String(Math.round(graceLeftMs / SECOND))} s left)`,
      );
    }
    const switchFile = hubB.prefix === undefined ? "" : installPaths(hubB.prefix).switchFile;
    c.check(
      existsSync(switchFile) &&
        (JSON.parse(readFileSync(switchFile, "utf8")) as { to?: string }).to === RELEASE_VERSION,
      "6. the release is installed as far as this Mac goes: the launcher is told to switch to it (the launcher's own switch is M2's, tested there)",
    );
    await Bun.sleep(3 * SECOND);
    const lateArm = await hubA.op("arm", { target: { sensor: SENSOR } });
    c.check(lateArm.ok, "9. hub A armed while its internet is cut", lateArm);
    const lateRaisedAt = Date.now();
    gateway.door(true);
    const lateCountdown = await waitFor(
      async () => {
        const log = await hubA.hsn("log", "--kind", "decision");
        return log.out.split("countdown_started").length - 1 >= 3;
      },
      10 * SECOND,
      250,
    );
    c.check(lateCountdown, "9. hub A raised the countdown while it could not reach the relay");
    const lateDisarm = await hubA.op("disarm", { target: { sensor: SENSOR } });
    c.check(lateDisarm.ok, "9. and disarmed it at home", lateDisarm);
    gateway.door(false);
    await Bun.sleep(1000);
    await hubA.kill();
    gateway.close();
    const lastFrameMs = internet.lastFromHubMs;
    c.check(lastFrameMs > 0 && lastFrameMs <= cutAt, "7. the hub's last frame came before the cut");

    // 7. "Unreachable" 180 s after the last frame; nothing to hub B's phone through its grace.
    const alerted = await waitFor(
      () => openedFor(s, pushToken, anna).some((p) => p.content.n.kind === "hub_unreachable"),
      UNREACHABLE_AFTER_MS + 30 * SECOND,
      100,
    );
    const unreachable = openedFor(s, pushToken, anna).find(
      (p) => p.content.n.kind === "hub_unreachable",
    );
    const afterMs = unreachable === undefined ? Number.NaN : unreachable.atMs - lastFrameMs;
    c.check(
      alerted && Math.abs(afterMs - UNREACHABLE_AFTER_MS) <= TOLERANCE_MS,
      `7. the phone is told "unreachable" 180 s ± 2 s after the hub's last frame (${String(afterMs)} ms)`,
      openedFor(s, pushToken, anna).map((p) => [p.content.n.kind, p.atMs - lastFrameMs]),
    );
    c.check(
      unreachable?.content.hub === identityA && unreachable.content.n.seq === 0,
      "7. the alert is the one hub A sealed in advance for this phone (D127)",
      unreachable?.content,
    );

    // B back within its grace; A back with its internet.
    await hubB.start();
    const bBack = await hubB.relayState("up", 30 * SECOND);
    c.check(bBack, "8. hub B is back on the relay after its switch");
    internet.mend();
    await hubA.start();
    c.check(await gateway.connect(hubA.devicePort), "7. hub A is back, its gateway with it");
    const aBack = await hubA.relayState("up", 30 * SECOND);
    c.check(aBack, "7. hub A's link is up again");
    const back = await waitFor(
      () => openedFor(s, pushToken, anna).some((p) => p.content.n.kind === "hub_back"),
      20 * SECOND,
      100,
    );
    c.check(
      back,
      '7. the phone is told "back" on its return',
      openedFor(s, pushToken, anna).map((p) => p.content.n.kind),
    );

    // 9. The countdown raised while unreachable arrives afterwards, marked late, at its true time.
    const late = await waitFor(
      () =>
        openedFor(s, pushToken, anna).filter((p) => p.content.n.kind === "countdown_started")
          .length >= 3,
      30 * SECOND,
      100,
    );
    const pushes = openedFor(s, pushToken, anna);
    const latePush = pushes.filter((p) => p.content.n.kind === "countdown_started")[2];
    const backPush = pushes.find((p) => p.content.n.kind === "hub_back");
    c.check(
      late &&
        latePush !== undefined &&
        latePush.content.delayed &&
        Math.abs(latePush.content.n.atMs - lateRaisedAt) < 3 * SECOND &&
        latePush.atMs - latePush.content.n.atMs > 60 * SECOND,
      "9. the countdown raised while the relay was unreachable arrives afterwards, marked late, with its true time (D102)",
      latePush?.content ?? pushes.map((p) => p.content.n.kind),
    );
    c.check(
      backPush !== undefined && latePush !== undefined && backPush.atMs <= latePush.atMs,
      "9. after the back alert",
      pushes.map((p) => [p.content.n.kind, p.atMs]),
    );

    // 8. Nothing reached hub B's phone through its announced restart.
    await Bun.sleep(5 * SECOND);
    const benKinds =
      ben === undefined ? [] : openedFor(s, benToken, ben).map((p) => p.content.n.kind);
    c.check(
      ben !== undefined &&
        arrivedFor(s, benToken).length === benKinds.length &&
        !benKinds.includes("hub_unreachable") &&
        !benKinds.includes("hub_back"),
      "8. hub B's phone was told nothing of its announced restart: no unreachable, no back (its own notifications, the update's, it was sent)",
      benKinds,
    );

    // 3 and 7. Every push on the wire is one envelope of one size, the relay's alerts included.
    const everyH = [pushToken, benToken].flatMap((token) => arrivedFor(s, token).map((a) => a.h));
    c.check(
      everyH.length > 0 && everyH.every((h) => h.length === 1763 && h.startsWith("1.")),
      `3. every push the stand-ins received (${String(everyH.length)}, alerts included) is one 1,763-character sealed h`,
      everyH.map((h) => h.length),
    );

    // 10. Everything that depends on the product's name or domain comes from one file.
    const apnsRequest = s.apns.received[0];
    c.check(
      apnsRequest === undefined || apnsRequest.headers["apns-topic"] === DEPLOYMENT.ios.bundleId,
      "10. the push role's APNs topic is the deployment's bundle identifier, given by no option",
      apnsRequest?.headers,
    );
    {
      const values = [
        DEPLOYMENT.ios.bundleId,
        DEPLOYMENT.ios.appGroup,
        DEPLOYMENT.android.applicationId,
        new URL(DEPLOYMENT.relay.url.replace(/^wss/u, "https")).hostname,
        new URL(DEPLOYMENT.push.url.replace(/^wss/u, "https")).hostname,
        DEPLOYMENT.names.domain,
      ];
      const named = [
        ...sourceFiles(join(REPO, "hub", "src"), [".ts"]),
        ...sourceFiles(join(REPO, "relay", "src"), [".ts"]),
        ...sourceFiles(join(REPO, "app", "src"), [".ts", ".tsx"]),
        join(REPO, "app", "app.config.ts"),
      ].filter((file) => values.some((value) => readFileSync(file, "utf8").includes(value)));
      c.check(
        named.length === 0,
        "10. no file of the hub, the relay or the app names the domain, a bundle identifier or the app group: only packages/deployment does",
        named,
      );
    }

    // 11. No key, token, push key or sealed content in any output; no loop guard engaged.
    await hubA.stop();
    await hubB.stop();
    await relay.stop();
    await push.stop();
    await Promise.all(ALL_OUTPUT.map((out) => out.done));
    const secrets = collectSecrets({
      standIns: s,
      phones: ben === undefined ? [anna] : [anna, ben],
      tokens: [pushToken, benToken],
      relayDataFolders: [relay.dataFolder],
      hubDataFolders: [hubA.dataDir, hubB.dataDir],
      deviceKeys: HOME_KEYS,
    });
    const leaks = leaksIn(
      ALL_OUTPUT.map((out) => out.text),
      secrets,
    );
    c.check(
      leaks.length === 0,
      "11. no key, token, push key or sealed push in any process's output",
      leaks,
    );
    const relayText = [...relay.outs, push.out].map((out) => out?.text ?? "").join("");
    c.check(
      !relayText.includes(identityA) && !relayText.includes(identityB),
      "11. the relay's and the push role's logs name no hub (section 3: counts and errors only)",
    );
    const guards = guardsEngaged(ALL_OUTPUT.map((out) => out.text));
    c.check(
      guards.length === 0,
      "11. the hub's loop guard and the relay's stall guard never engaged",
      guards,
    );

    writeFileSync(
      join(root, "m4-report.json"),
      JSON.stringify({ passed: c.passed, known: [], findings: c.findings }, null, 2),
    );
    console.log(
      [
        "M4, on this Mac:",
        ...c.passed.map((p) => `  pass   ${p}`),
        ...c.findings.map((f) => `  FAIL   ${f}`),
      ].join("\n"),
    );
    expect(c.findings).toEqual([]);
  }, 900_000);
});

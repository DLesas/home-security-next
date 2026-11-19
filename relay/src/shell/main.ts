/**
 * The relay program (docs/m4-design.md section 3, "Roles" and "Self-hosting"):
 *
 *   bun relay/src/shell/main.ts --config <path>       (bun run start --config <path> in relay/)
 *   relay/dist/hsn-relay --config <path>              (bun run compile in relay/)
 *
 * It runs the roles its configuration names (`config.ts`): `relay`, or `relay` and `releases`.
 * Pushes go to the push service, B3's separate process (`relay/src/push/main.ts`), over a relay
 * link made with this relay's own key (`relay-key.ts`): the push role's local socket on the
 * operated host, `<DEPLOYMENT.push.url>/v1/relay` for a self-hosted relay. It logs one JSON line
 * per event to standard error (counts and errors only), reads the refused hub keys again on
 * SIGHUP, and stops on SIGTERM or SIGINT: every phone hears 1001, every hub link closes 1001.
 *
 * Exit codes: 0 stopped; 78 a configuration, key or storage problem at start (EX_CONFIG); 70
 * anything else (EX_SOFTWARE), including an uncaught exception, whose code alone is logged.
 */
import { join } from "node:path";
import { relayIdentity } from "@hsn/protocol/relay";
import relayPackage from "../../package.json";
import { ReleaseBudget } from "../core/release-budget.ts";
import { RELEASES_RULES } from "../core/rules.ts";
import { jsonLineLog as pushJsonLineLog } from "../push/log.ts";
import { PushLink } from "../push/push-link.ts";
import { FolderReleaseIndex } from "../releases/folder-index.ts";
import { listenForwarding } from "../releases/forwarding.ts";
import { ReleaseService } from "../releases/service.ts";
import { socketChannel, UpstreamCache } from "../releases/upstream.ts";
import { SYSTEM_CLOCK } from "./clock.ts";
import { pushUrl, readConfig, readRefusedHubs } from "./config.ts";
import { jsonLineLog } from "./log.ts";
import { Pseudonyms } from "./pseudonym.ts";
import { Relay } from "./relay.ts";
import { loadOrMakeRelayKey } from "./relay-key.ts";
import { errorFrom } from "./safe/thrown.ts";
import { makeFolder, readText } from "./safe/fs.ts";
import { listen } from "./server.ts";
import { openStore } from "./storage/store.ts";

const write = (line: string) => {
  process.stderr.write(line);
};
const log = jsonLineLog(write, () => Date.now());
const pushLog = pushJsonLineLog(write, () => Date.now());

const fatal = (thrown: unknown) => {
  log.write("error", "fatal", {}, errorFrom("link", "shell/main", "uncaught", thrown));
  process.exit(70);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

function exitConfig(error: Parameters<typeof log.write>[3]): never {
  log.write("error", "config", {}, error);
  process.exit(78);
}

const config = readConfig(process.argv.slice(2));
if (config.isErr()) exitConfig(config.error);
const settings = config.value;

const folder = makeFolder(settings.dataFolder);
if (folder.isErr()) exitConfig(folder.error);
const key = loadOrMakeRelayKey(settings.dataFolder);
if (key.isErr()) exitConfig(key.error);
const store = openStore(join(settings.dataFolder, "relay.db"));
if (store.isErr()) exitConfig(store.error);
const url = pushUrl(settings);
if (url.isErr()) exitConfig(url.error);
const ca = settings.push?.ca === undefined ? undefined : readText(settings.push.ca, "the push CA");
if (ca?.isErr() === true) exitConfig(ca.error);
const refused =
  settings.refusedHubs === undefined ? undefined : readRefusedHubs(settings.refusedHubs);
if (refused?.isErr() === true) exitConfig(refused.error);
const pseudonyms = Pseudonyms.start(SYSTEM_CLOCK);
if (pseudonyms.isErr()) exitConfig(pseudonyms.error);

const version: string = relayPackage.version;
const push = new PushLink({
  url: url.value,
  staticKey: key.value,
  version,
  clock: SYSTEM_CLOCK,
  log: pushLog,
  ...(ca?.isOk() === true ? { ca: ca.value } : {}),
});
const stops: (() => Promise<void> | void)[] = [
  () => {
    push.stop();
  },
];
let releases: ReleaseService | undefined;
const releasesSettings = settings.releases;
if (settings.roles.length === 2 && releasesSettings !== undefined) {
  const index = new FolderReleaseIndex(releasesSettings.folder, log);
  const first = await index.refresh();
  if (first.isErr()) log.write("warning", "releaseIndex", { why: "unavailable" });
  const refresh = () => {
    void index.refresh().then((again) => {
      if (again.isErr()) log.write("warning", "releaseIndex", { why: "unavailable" });
    });
    stops.push(SYSTEM_CLOCK.after(RELEASES_RULES.refreshMs, refresh));
  };
  stops.push(SYSTEM_CLOCK.after(RELEASES_RULES.refreshMs, refresh));
  releases = new ReleaseService(index, new ReleaseBudget(), SYSTEM_CLOCK, log);
  if (releasesSettings.socket !== undefined) {
    const forwarding = listenForwarding(
      releases,
      releasesSettings.socket,
      log,
      releasesSettings.socketMode,
    );
    if (forwarding.isErr()) exitConfig(forwarding.error);
    stops.push(() => forwarding.value.stop());
  }
  const upstream = releasesSettings.upstream;
  if (upstream !== undefined) {
    const identity = relayIdentity(key.value.publicKey);
    const socket =
      "socket" in upstream && identity !== undefined
        ? socketChannel(upstream.socket, identity)
        : undefined;
    if (socket?.isErr() === true) exitConfig(socket.error);
    const channel = socket?.isOk() === true ? socket.value : undefined;
    if (channel !== undefined || "link" in upstream) {
      const cache = new UpstreamCache({
        index,
        clock: SYSTEM_CLOCK,
        log,
        channel: channel ?? push.releaseChannel,
      });
      if (channel === undefined) push.attachReleases(cache);
      else channel.attach(cache);
      cache.start();
      stops.push(() => {
        cache.stop();
        channel?.close();
      });
    }
  }
}
push.start();

const relay = Relay.start({
  clock: SYSTEM_CLOCK,
  log,
  store: store.value,
  push,
  version,
  roles: settings.roles,
  pseudonyms: pseudonyms.value,
  ...(releases === undefined ? {} : { releases }),
  ...(refused?.isOk() === true ? { refused: refused.value } : {}),
});
if (relay.isErr()) exitConfig(relay.error);

const listener = listen(relay.value, {
  hostname: settings.listen.hostname,
  port: settings.listen.port,
  ...(settings.listen.trustedProxies === undefined
    ? {}
    : { trustedProxies: settings.listen.trustedProxies }),
  ...(settings.listen.tls === undefined
    ? {}
    : (() => {
        const cert = readText(settings.listen.tls.cert, "the TLS certificate");
        const tlsKey = readText(settings.listen.tls.key, "the TLS key");
        if (cert.isErr()) exitConfig(cert.error);
        if (tlsKey.isErr()) exitConfig(tlsKey.error);
        return { tls: { cert: cert.value, key: tlsKey.value } };
      })()),
});
if (listener.isErr()) exitConfig(listener.error);
log.write("info", "started", { port: listener.value.port, releases: releases !== undefined });

process.on("SIGHUP", () => {
  if (settings.refusedHubs === undefined) return;
  const again = readRefusedHubs(settings.refusedHubs);
  if (again.isErr()) log.write("error", "refusedHubs", {}, again.error);
  else relay.value.setRefused(again.value);
});

const stop = () => {
  log.write("info", "stopping", {});
  void (async () => {
    await listener.value.stop();
    for (const step of stops) await step();
    store.value.close();
    log.write("info", "stopped", {});
    process.exit(0);
  })();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

/**
 * The push role, put together (docs/m4-design.md section 3, "Roles"): its own process under its
 * own account, with the publisher's credentials read from files at start, the local socket the
 * operator's relay opens and, when configured, the TLS listener self-hosted relays reach.
 * `main.ts` runs it; tests start it in their own process too.
 */
import { err, ok, type Result } from "neverthrow";
import relayPackage from "../../package.json";
import { ApnsClient } from "./apns.ts";
import type { LinkClock } from "./clock.ts";
import { SYSTEM_CLOCK } from "./clock.ts";
import { type PushRoleConfig, readRefused } from "./config.ts";
import type { PushError } from "./errors.ts";
import { FcmClient } from "./fcm.ts";
import { ApnsProviderToken } from "./jwt.ts";
import type { PushLog } from "./log.ts";
import { PushService, ServiceDispatch } from "./push-service.ts";
import { forwardedRoutes } from "./releases-route.ts";
import { listen, type PushListeners } from "./server.ts";

/** The push role's version: the relay program's. */
export const PUSH_ROLE_VERSION: string = relayPackage.version;

export interface PushRoleDeps {
  readonly log: PushLog;
  readonly clock?: LinkClock;
}

export interface PushRole {
  readonly service: PushService;
  readonly listeners: PushListeners;
  /** Forwarding sockets to the releases role open now (0 without a releases socket). */
  readonly releaseRoutes: () => number;
  /** Reads the refused relay keys again (SIGHUP); joined links of newly refused keys close. */
  reloadRefused(): Result<number, PushError>;
  stop(): Promise<void>;
}

export function startPushRole(
  config: PushRoleConfig,
  deps: PushRoleDeps,
): Result<PushRole, PushError> {
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const now = () => clock.now();
  const refusedPath = config.refusedPath;
  const refused = refusedPath === undefined ? ok(new Set<string>()) : readRefused(refusedPath);
  if (refused.isErr()) return err(refused.error);

  const apns =
    config.apns === undefined
      ? undefined
      : new ApnsClient({
          tokens: new ApnsProviderToken(config.apns.signer),
          topic: config.apns.topic,
          origins: config.apns.origins,
          ...(config.testCa === undefined ? {} : { ca: config.testCa }),
          now,
          log: deps.log,
        });
  const fcm =
    config.fcm === undefined
      ? undefined
      : new FcmClient({
          account: config.fcm.account,
          origin: config.fcm.origin,
          ...(config.testCa === undefined ? {} : { ca: config.testCa }),
          now,
          log: deps.log,
        });
  const dispatch = new ServiceDispatch(apns, fcm);
  const routes =
    config.releasesSocket === undefined
      ? undefined
      : forwardedRoutes(config.releasesSocket, deps.log);
  const service = new PushService({
    dispatch,
    version: PUSH_ROLE_VERSION,
    clock,
    log: deps.log,
    refused: refused.value,
    ...(routes === undefined ? {} : { openReleases: routes.open }),
  });
  const listeners = listen(service, {
    ...(config.socketPath === undefined ? {} : { socketPath: config.socketPath }),
    socketMode: config.socketMode,
    ...(config.tcp === undefined ? {} : { tcp: config.tcp }),
  });
  if (listeners.isErr()) {
    dispatch.close();
    return err(listeners.error);
  }
  deps.log.write("info", "listening", {
    local: config.socketPath !== undefined,
    port: listeners.value.port ?? 0,
    apns: apns !== undefined,
    fcm: fcm !== undefined,
  });
  return ok({
    service,
    listeners: listeners.value,
    releaseRoutes: () => routes?.live() ?? 0,
    reloadRefused() {
      if (refusedPath === undefined) return ok(0);
      return readRefused(refusedPath).map((set) => {
        service.setRefused(set);
        return set.size;
      });
    },
    async stop() {
      await listeners.value.stop();
      dispatch.close();
    },
  });
}

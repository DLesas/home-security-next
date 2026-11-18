/**
 * The push service (docs/m4-design.md sections 3 and 5; D77, D142): it accepts items only over
 * relay links on which a relay proved its own key, counts each against the limits per relay key
 * and hub together, per relay key, per address and in total (`limits.ts`), sends what passes to
 * Apple or Google (`apns.ts`, `fcm.ts`), and answers every item with an outcome. The operator can
 * refuse a relay key: its links are turned away after message 3 and closed if already joined.
 *
 * It keeps nothing but counters in memory (section 3, "What the relay stores"): the publisher's
 * credentials are the senders', read at start.
 */
import { RELAY_CLOSE, type RelayPushItem } from "@hsn/protocol/relay";
import type { ApnsClient } from "./apns.ts";
import type { LinkClock } from "./clock.ts";
import type { FcmClient } from "./fcm.ts";
import { LinkGuard, type UpgradeAnswer } from "./link-guard.ts";
import { PUSH_SERVICE_LIMITS, PushLimiter } from "./limits.ts";
import type { PushLog } from "./log.ts";
import { dropped, type ServiceOutcome, toPushOutcome } from "./outcomes.ts";
import type { OpenReleaseRoute } from "./releases-route.ts";
import {
  type ItemResult,
  type LinkHost,
  type LinkPeer,
  type LinkSocket,
  type PushAnswer,
  RelayLinkServer,
} from "./relay-link.ts";

/** Sends one item to Apple or Google. Never rejects. */
export interface PushDispatch {
  send(item: RelayPushItem): Promise<ServiceOutcome>;
}

/** The real dispatch: APNs for `apns` items, FCM for `fcm`; a service not configured drops. */
export class ServiceDispatch implements PushDispatch {
  constructor(
    private readonly apns: ApnsClient | undefined,
    private readonly fcm: FcmClient | undefined,
  ) {}

  send(item: RelayPushItem): Promise<ServiceOutcome> {
    if (item.platform === "apns") {
      return this.apns === undefined
        ? Promise.resolve(dropped("notConfigured"))
        : this.apns.send({ env: item.env, token: item.token, h: item.h });
    }
    return this.fcm === undefined
      ? Promise.resolve(dropped("notConfigured"))
      : this.fcm.send({ token: item.token, h: item.h });
  }

  close(): void {
    this.apns?.close();
  }
}

export interface PushServiceOptions {
  readonly dispatch: PushDispatch;
  readonly version: string;
  readonly clock: LinkClock;
  readonly log: PushLog;
  readonly limiter?: PushLimiter;
  readonly guard?: LinkGuard;
  /** Relay identities the operator refuses. */
  readonly refused?: ReadonlySet<string>;
  /** The way to the releases role for each joined link; none: release frames are not served. */
  readonly openReleases?: OpenReleaseRoute;
}

export class PushService implements LinkHost {
  readonly version: string;
  readonly clock: LinkClock;
  readonly log: PushLog;
  readonly framesInHand = PUSH_SERVICE_LIMITS.framesInHand;
  readonly openReleases: OpenReleaseRoute | undefined;
  private readonly dispatch: PushDispatch;
  private readonly limiter: PushLimiter;
  private readonly guard: LinkGuard;
  private refused: ReadonlySet<string>;
  private readonly links = new Set<RelayLinkServer>();
  private readonly byIdentity = new Map<string, RelayLinkServer>();

  constructor(options: PushServiceOptions) {
    this.dispatch = options.dispatch;
    this.version = options.version;
    this.clock = options.clock;
    this.log = options.log;
    this.limiter = options.limiter ?? new PushLimiter();
    this.guard = options.guard ?? new LinkGuard();
    this.refused = options.refused ?? new Set();
    this.openReleases = options.openReleases;
  }

  /** An HTTP upgrade to `/v1/relay`, before anything is kept: `ok`, or 429 (`rate`) or 503 (`busy`). */
  upgrade(address: string | null): UpgradeAnswer {
    const answer = this.guard.upgrade(address, this.clock.now());
    if (answer !== "ok") {
      this.log.write("warning", "upgradeRefused", {
        why: answer,
        peer: address === null ? "local" : "remote",
      });
    }
    return answer;
  }

  /** An upgrade `upgrade` let through did not become a socket: forget it. */
  abandon(address: string | null): void {
    this.guard.closed(address, false);
  }

  /** An upgraded socket (after `upgrade` answered `ok`): its link. */
  open(socket: LinkSocket, peer: LinkPeer): RelayLinkServer {
    const link = new RelayLinkServer(socket, this, peer);
    this.links.add(link);
    return link;
  }

  join(link: RelayLinkServer, identity: string): "ok" | "refused" | "full" {
    if (this.refused.has(identity)) return "refused";
    if (!this.guard.joined(link.peer.address)) return "full";
    // One link per relay key: the newest wins, as on hub links. Only the key's holder gets here.
    const older = this.byIdentity.get(identity);
    this.byIdentity.set(identity, link);
    older?.close(RELAY_CLOSE.replaced);
    return "ok";
  }

  gone(link: RelayLinkServer): void {
    if (!this.links.delete(link)) return;
    this.guard.closed(link.peer.address, link.everJoined);
    const identity = link.identity;
    if (identity !== undefined && this.byIdentity.get(identity) === link) {
      this.byIdentity.delete(identity);
    }
  }

  /** The operator's list of refused relay keys changed: joined links of those keys close at once. */
  setRefused(identities: ReadonlySet<string>): void {
    this.refused = identities;
    for (const [identity, link] of this.byIdentity) {
      if (identities.has(identity)) link.close(RELAY_CLOSE.refused);
    }
    this.log.write("info", "refusedRelays", { count: identities.size });
  }

  async push(link: RelayLinkServer, items: readonly RelayPushItem[]): Promise<PushAnswer> {
    const relayKey = link.identity;
    if (relayKey === undefined) {
      return { results: items.map((item) => ({ id: item.id, outcome: "failed" })) };
    }
    const nowMs = this.clock.now();
    let linkWide: number | undefined;
    let limited = 0;
    const pending: Promise<ItemResult>[] = [];
    for (const item of items) {
      const refusal = this.limiter.admit(
        { relayKey, hub: item.hub, address: link.peer.address, operator: link.peer.local },
        nowMs,
      );
      if (refusal !== undefined) {
        limited += 1;
        if (refusal.what !== "pair") linkWide = Math.max(linkWide ?? 0, refusal.retryAfterMs);
        this.log.write("warning", "pushLimited", { what: refusal.what });
        pending.push(Promise.resolve({ id: item.id, outcome: "limited" }));
        continue;
      }
      pending.push(
        this.dispatch.send(item).then((outcome) => {
          if (outcome.kind === "dropped") {
            this.log.write("error", "pushDropped", { service: item.platform, why: outcome.why });
          }
          return { id: item.id, outcome: toPushOutcome(outcome) };
        }),
      );
    }
    if (this.limiter.alertDue(nowMs)) {
      this.log.write("warning", "operatorAlert", { what: "total", today: this.limiter.today });
    }
    const results = await Promise.all(pending);
    const count = (outcome: string) => results.filter((r) => r.outcome === outcome).length;
    this.log.write("info", "pushFrame", {
      items: results.length,
      accepted: count("accepted"),
      badToken: count("badToken"),
      limited: count("limited"),
      failed: count("failed"),
      overLimits: limited,
      peer: link.peer.local ? "local" : "remote",
    });
    return linkWide === undefined ? { results } : { results, limitRetryAfterMs: linkWide };
  }

  /** Closes every link with 1001: the service is stopping. */
  stop(): void {
    for (const link of [...this.links]) link.close(RELAY_CLOSE.stopping);
  }

  /** Links open now, joined or not. */
  get linkCount(): number {
    return this.links.size;
  }
}

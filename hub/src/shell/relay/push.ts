/**
 * Sealing pushes and sending the roster (docs/m4-design.md sections 4 and 5; D126, D127).
 *
 * - **`pushSend {id, client, content}`.** Sealed at once with the client's push key from
 *   `PushKeys` and a fresh 12-byte nonce from the system's generator, a new one for every seal and
 *   never another's (`pushSealer.seal`), then held for the turn's `push` frames: the core's
 *   effects of one turn are performed in one synchronous run, and the frames go when it ends
 *   (`queueMicrotask`), split by `splitHubPushItems` within the limits the relay announced. At most
 *   4 push frames are in the relay's hands at once (B2's relay answers a fifth all `limited`); more
 *   wait for a `pushResult`. Every `pushResult` goes to the core as `pushResults`, whatever the
 *   link did since. A push sealed or sent while the link is down is dropped: the core heard `down`
 *   and sends it again when the link returns.
 * - **A push that cannot be sealed** (no key for the client, or content the sealer refuses as the
 *   phone would, `badContent` or `tooLong`) is a fault in the core, never retried by the shell: it
 *   is recorded as one (`inputRejected {source: "core"}`, a critical hub event) and gets no result.
 * - **`relayRoster {rev, targets}`.** Each target's `unreachable` and `back` are sealed afresh with
 *   `sealRelayAlerts`, two new nonces each time, `armed` and the hub's identity as the core built
 *   them. A target with no key is left out, recorded as above. A roster over 131,072 bytes (or the
 *   relay's own bound) is never sent: recorded. The relay answers `rosterAck {rev}` only once it
 *   stored the roster, so a roster with no ack is sent again, as it is, every 15 s ‡ while the
 *   link stays up; a newer roster replaces it, and a lost link forgets it (the core sends the
 *   whole roster again when the link is back).
 * - **`pushKey`** is `PushKeys.apply`.
 *
 * No key, nonce or sealed byte is logged, recorded or put in an error.
 */
import type { PushContent, PushOutcome } from "@hsn/protocol/app";
import {
  encodeTextFrame,
  formatPushKeyId,
  type HubPushItem,
  pushSealer,
  type PushSealError,
  RELAY_LIMITS,
  type RelayWelcome,
  type RosterTarget,
  sealRelayAlerts,
  splitHubPushItems,
} from "@hsn/protocol/relay";
import type { Result } from "neverthrow";
import type { Effect, RosterEntry } from "../../core/model/effects.ts";
import type { HubError } from "../../core/model/errors.ts";
import type { HubEvent } from "../../core/model/events.ts";
import { type ClientId, outboxId } from "../../core/model/ids.ts";
import type { PushKeys } from "../../ports/push-keys.ts";
import type { Timers } from "../app/channel.ts";
import type { RelayLink } from "./link.ts";

const ORIGIN = "shell/relay/push";

/** Push frames in the relay's hands at once, at most (B2's relay: `framesInHand`). */
export const PUSH_FRAMES_IN_HAND = 4;
/** A roster with no `rosterAck` is sent again after this ‡. */
export const ROSTER_RESEND_MS = RELAY_LIMITS.pongWithinMs;

type PushSend = Extract<Effect, { readonly kind: "pushSend" }>;
type RelayRoster = Extract<Effect, { readonly kind: "relayRoster" }>;
type PushKeyEffect = Extract<Effect, { readonly kind: "pushKey" }>;

export interface PushOptions {
  readonly keys: PushKeys;
  /** 12 fresh random bytes for each seal. */
  readonly nonce: () => Result<Uint8Array, HubError>;
  readonly emit: (event: HubEvent) => void;
  readonly report: (error: HubError) => void;
  readonly timers: Timers;
}

export class RelayPush {
  readonly #o: PushOptions;
  #link: RelayLink | undefined;
  #limits: { readonly maxItems: number; readonly maxBytes: number } = {
    maxItems: RELAY_LIMITS.maxPushItemsPerFrame,
    maxBytes: RELAY_LIMITS.maxRosterBytes,
  };
  #queue: HubPushItem[] = [];
  #flushing = false;
  #inHand = 0;
  #unacked: { readonly rev: number; readonly text: string } | undefined;
  #resend: (() => void) | undefined;

  constructor(options: PushOptions) {
    this.#o = options;
  }

  /** Push frames sent and not yet answered. */
  get inHand(): number {
    return this.#inHand;
  }

  /** Items sealed and waiting for a frame. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** The roster sent and not yet acknowledged, if any. */
  get unackedRev(): number | undefined {
    return this.#unacked?.rev;
  }

  linkUp(link: RelayLink, welcome: RelayWelcome): void {
    this.#link = link;
    this.#limits = {
      maxItems: Math.min(welcome.limits.maxPushItemsPerFrame, RELAY_LIMITS.maxPushItemsPerFrame),
      maxBytes: Math.min(welcome.limits.maxRosterBytes, RELAY_LIMITS.maxRosterBytes),
    };
  }

  linkLost(): void {
    this.#link = undefined;
    this.#queue = [];
    this.#inHand = 0;
    this.#unacked = undefined;
    this.#resend?.();
    this.#resend = undefined;
  }

  key(effect: PushKeyEffect): void {
    this.#o.keys.apply(effect.client, effect.keyId, effect.key);
  }

  send(effect: PushSend): void {
    if (this.#link?.up !== true) return;
    const sealed = this.#seal(effect.client, effect.content);
    if (!sealed.ok) {
      this.#fault(`push ${String(effect.id)} could not be sealed: ${sealed.error}`, {
        id: effect.id,
        error: sealed.error,
      });
      return;
    }
    this.#queue.push({ id: effect.id, key: sealed.keyId, h: sealed.h });
    if (!this.#flushing) {
      this.#flushing = true;
      queueMicrotask(() => {
        this.#flushing = false;
        this.flush();
      });
    }
  }

  /** Sends what waits, in as few frames as fit, while fewer than 4 are in the relay's hands. */
  flush(): void {
    const link = this.#link;
    if (link?.up !== true || this.#queue.length === 0) return;
    while (this.#queue.length > 0 && this.#inHand < PUSH_FRAMES_IN_HAND) {
      const split = splitHubPushItems(this.#queue, this.#limits);
      if (!split.ok) {
        // The item named is not one the relay accepts, or alone too large: never sent.
        const [bad] = this.#queue.splice(split.error.index, 1);
        this.#fault(`push ${String(bad?.id)} cannot go in a push frame: ${split.error.error}`, {
          id: bad?.id ?? 0,
          error: split.error.error,
        });
        continue;
      }
      const frame = split.value[0];
      if (frame === undefined) return;
      if (link.sendEncoded(frame.text).isErr()) return;
      this.#inHand += 1;
      this.#queue.splice(0, frame.items.length);
    }
  }

  /** The relay's `pushResult`: to the core, by outbox row, and room for the next frame. */
  results(results: readonly { readonly id: number; readonly outcome: PushOutcome }[]): void {
    this.#inHand = Math.max(0, this.#inHand - 1);
    this.#o.emit({
      kind: "pushResults",
      results: results.map((r) => ({ id: outboxId(r.id), outcome: r.outcome })),
    });
    this.flush();
  }

  roster(effect: RelayRoster): void {
    const link = this.#link;
    if (link?.up !== true) return;
    const targets: RosterTarget[] = [];
    for (const entry of effect.targets) {
      const target = this.#target(entry);
      if (target !== undefined) targets.push(target);
    }
    const text = encodeTextFrame("hubToRelay", { t: "roster", rev: effect.rev, targets });
    if (!text.ok || new TextEncoder().encode(text.value).length > this.#limits.maxBytes) {
      this.#fault(
        `roster ${String(effect.rev)} of ${String(targets.length)} targets was not sent: ${text.ok ? "tooLarge" : text.error}`,
        { rev: effect.rev, targets: targets.length },
      );
      return;
    }
    this.#unacked = { rev: effect.rev, text: text.value };
    this.#sendRoster();
  }

  /** `rosterAck {rev}`: the roster `rev` is stored; an older ack changes nothing. */
  acked(rev: number): void {
    if (this.#unacked?.rev !== rev) return;
    this.#unacked = undefined;
    this.#resend?.();
    this.#resend = undefined;
  }

  stop(): void {
    this.linkLost();
  }

  #sendRoster(): void {
    const unacked = this.#unacked;
    const link = this.#link;
    if (unacked === undefined || link?.up !== true) return;
    link.sendEncoded(unacked.text).match(
      () => undefined,
      (error) => {
        this.#o.report(error);
      },
    );
    this.#resend?.();
    this.#resend = this.#o.timers.after(ROSTER_RESEND_MS, () => {
      this.#resend = undefined;
      this.#sendRoster();
    });
  }

  #target(entry: RosterEntry): RosterTarget | undefined {
    const key = this.#o.keys.key(entry.client);
    const keyHex = key === undefined ? undefined : formatPushKeyId(key.keyId);
    if (key === undefined || keyHex === undefined) {
      this.#fault(`client ${String(entry.client)} is in the roster with no push key`, {
        client: entry.client,
      });
      return undefined;
    }
    const unreachable = this.#o.nonce();
    if (unreachable.isErr()) {
      this.#o.report(unreachable.error);
      return undefined;
    }
    const back = this.#o.nonce();
    if (back.isErr()) {
      this.#o.report(back.error);
      return undefined;
    }
    const sealed = sealRelayAlerts(entry.unreachable.hub, entry.unreachable.armed, key, {
      unreachable: unreachable.value,
      back: back.value,
    });
    if (!sealed.ok) {
      this.#fault(`client ${String(entry.client)}'s alerts could not be sealed: ${sealed.error}`, {
        client: entry.client,
        error: sealed.error,
      });
      return undefined;
    }
    return {
      key: keyHex,
      platform: entry.platform,
      env: entry.environment,
      token: entry.token,
      unreachable: sealed.value.unreachable,
      back: sealed.value.back,
    };
  }

  #seal(
    client: ClientId,
    content: PushContent,
  ):
    | { readonly ok: true; readonly keyId: string; readonly h: string }
    | { readonly ok: false; readonly error: PushSealError | "noKey" | "noNonce" } {
    const key = this.#o.keys.key(client);
    const keyHex = key === undefined ? undefined : formatPushKeyId(key.keyId);
    if (key === undefined || keyHex === undefined) return { ok: false, error: "noKey" };
    const nonce = this.#o.nonce();
    if (nonce.isErr()) {
      this.#o.report(nonce.error);
      return { ok: false, error: "noNonce" };
    }
    const h = pushSealer.seal(content, key, nonce.value);
    return h.ok ? { ok: true, keyId: keyHex, h: h.value } : { ok: false, error: h.error };
  }

  /** A fault of the core's making, recorded as one (a critical hub event), never retried here. */
  #fault(message: string, detail: Readonly<Record<string, string | number | boolean>>): void {
    this.#o.emit({
      kind: "inputRejected",
      rejection: { source: "core", event: "pushResults", origin: ORIGIN, message, detail },
    });
  }
}

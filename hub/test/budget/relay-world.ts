/**
 * The relay for the whole hub of `test/world/home.ts` (`HomeSpec.relay`): the loop's relay port
 * answered at once, as a relay client whose relay is always there unless cut, and the rows a phone's
 * registration leaves (docs/m4-design.md section 4). For the budget's day with the relay
 * (`relay-budget.test.ts`) and the relay's crash points (`../crash/relay-crash.test.ts`).
 *
 * - `relayConnect {url}` is answered `relayLink {up}` (while not cut);
 * - each `pushSend` is answered `pushResults {accepted}` (while not cut, else dropped, as the
 *   shell drops a push while the link is down), and kept with its content;
 * - each `relayRoster` is kept, so a test can see which phones the relay would push to;
 * - `cut()` and `mend()` are the link going down and coming back.
 */
import type { PushContent } from "@hsn/protocol/app";
import type { RosterEntry } from "../../src/core/model/effects.ts";
import type { ClientId, OutboxId } from "../../src/core/model/ids.ts";
import type { RelayLoopEffect } from "../../src/shell/loop.ts";
import type { OpenedStore } from "../../src/shell/storage/store.ts";
import type { Home } from "../world/home.ts";

/** The relay in use (a setting, as `relay.set` leaves it). */
export const RELAY_URL = "ws://127.0.0.1:8480";

/** A push the hub sent, as the shell was given it. */
export interface SentPush {
  readonly id: OutboxId;
  readonly client: ClientId;
  readonly content: PushContent;
}

export class ScriptedRelayClient {
  home: Home | undefined;
  up = true;
  url: string | null = null;
  readonly sent: SentPush[] = [];
  readonly rosters: (readonly RosterEntry[])[] = [];

  perform(effect: RelayLoopEffect): void {
    switch (effect.kind) {
      case "relayConnect":
        this.url = effect.url;
        if (effect.url !== null && this.up) this.#link("up");
        return;
      case "pushSend":
        if (!this.up) return;
        this.sent.push({ id: effect.id, client: effect.client, content: effect.content });
        this.home?.input({
          kind: "pushResults",
          results: [{ id: effect.id, outcome: "accepted" }],
        });
        return;
      case "relayRoster":
        this.rosters.push(effect.targets);
        return;
      case "pushKey":
        return;
    }
  }

  /** The link goes down. */
  cut(): void {
    this.up = false;
    this.#link("down");
  }

  /** The link is back. */
  mend(): void {
    this.up = true;
    this.#link("up");
  }

  /** The link the boot asked for, once the port knows its home (it is made before the home). */
  connectNow(): void {
    this.perform({ kind: "relayConnect", url: this.url ?? RELAY_URL });
  }

  #link(state: "up" | "down"): void {
    if (this.url === null) return;
    this.home?.input(
      state === "up"
        ? { kind: "relayLink", state, url: this.url, roles: ["relay", "releases"] }
        : { kind: "relayLink", state, url: this.url, reason: "connect" },
    );
  }
}

/** A phone of the household: its client id and its person. */
export interface SeededPhone {
  readonly client: number;
  readonly person: number;
}

/** The relay setting, and phones with their push targets and keys, as registrations leave them. */
export function seedPhones(
  store: OpenedStore,
  phones: readonly SeededPhone[],
  options: { readonly registered?: boolean } = {},
): void {
  const at = Date.UTC(2026, 9, 1);
  const { db } = store;
  db.run(`UPDATE relay_settings SET url = ?, revision = 1`, [RELAY_URL]);
  for (const phone of phones) {
    db.run(
      `INSERT INTO clients (id, person_id, static_key, kind, name, linked_by_client, created_ms, removed_ms, last_seq, last_seen_ms, backup_key_epoch) VALUES (?, ?, ?, 2, ?, NULL, ?, NULL, 0, NULL, NULL)`,
      [
        phone.client,
        phone.person,
        new Uint8Array(32).fill(0x60 + phone.client),
        `phone ${String(phone.client)}`,
        at,
      ],
    );
    if (options.registered === false) continue;
    db.run(`INSERT INTO push_targets VALUES (?, ?, 1, 0, ?, ?, NULL)`, [
      phone.client,
      new Uint8Array(8).fill(phone.client),
      `fcm-token-${String(phone.client)}`.padEnd(40, "x"),
      at,
    ]);
    db.run(`INSERT INTO push_keys VALUES (?, ?)`, [
      phone.client,
      new Uint8Array(32).fill(0x70 + phone.client),
    ]);
  }
}

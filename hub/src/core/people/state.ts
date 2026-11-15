/**
 * The people module's slice (m2-design.md section 2): people, linked clients and their public
 * keys, permissions, the user-management switch, link tokens and invites, each client's last
 * accepted sequence number and the replies of its last changes (section 3).
 *
 * Everything here is written now (section 3, "Classes of the new state") but a client's
 * `last_seen_ms`, which is routine. A reply still waiting for its owner's answer (section 2,
 * "Requests for M1a's modules": `usb.add` answers when the board does) is held in memory only:
 * its `seq` is committed in the request's own step, its reply when the answer comes.
 */
import type { AppReply } from "@hsn/protocol/app";
import type { BootId, ClientId, DeviceId, PersonId, RequestId, TokenId } from "../model/ids.ts";
import type {
  ClientRow,
  LinkTokenRow,
  PermissionRow,
  PersonRoleRow,
  PersonRow,
} from "../model/rows.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** A change's reply as kept for a retry with the same `seq` (section 5). */
export type StoredReply =
  /** Sent, or ready to be: a retry is answered with it again, marked `repeat`. */
  | { readonly kind: "sent"; readonly reply: AppReply }
  /** Its owner has not answered yet; a retry is answered when it does. */
  | { readonly kind: "pending" };

/** A link token that can still be used: not used, not expired, not cancelled, not void. */
export interface LiveToken {
  readonly row: LinkTokenRow;
  /** When it expires, on this boot's clock (section 5, "Expiry and an untrusted clock"). */
  readonly expiresAt: Mono;
  /** The lookup as `LinkHello.find` carries it: 8 hex digits, or a typed code's 4 characters. */
  readonly lookup: string;
}

export interface PeopleSlice {
  readonly timers: readonly TimerOf<"people">[];
  /** This run's boot, from the boot event; tokens record it (`link_tokens.created_boot`). */
  readonly boot: BootId | undefined;
  /** D13: off by default; `people_settings.user_management`. */
  readonly userManagement: boolean;
  /** Every person ever made, removed ones included: history names them. */
  readonly people: ReadonlyMap<PersonId, PersonRow>;
  /**
   * A person's global permissions. A person with no row has never had their permissions set
   * (section 7: switching user management on keeps everyone with every permission until changed).
   */
  readonly roles: ReadonlyMap<PersonId, PersonRoleRow>;
  /** Per person, their per-device rows (D33). */
  readonly permissions: ReadonlyMap<PersonId, ReadonlyMap<DeviceId, PermissionRow>>;
  /** Every client ever linked, removed ones included. */
  readonly clients: ReadonlyMap<ClientId, ClientRow>;
  /** Per client, the replies of its last changes by `seq` (`client_replies`, 16 ‡). */
  readonly replies: ReadonlyMap<ClientId, ReadonlyMap<number, StoredReply>>;
  readonly tokens: ReadonlyMap<TokenId, LiveToken>;
  /** Phones' `backup.key` requests waiting for `upkeep`'s answer, by `conn:id`: memory only. */
  readonly keyAsks: ReadonlyMap<string, ClientId>;
  /** `hsn open`'s waits for a console token, by token (`console-wait.ts`): memory only. */
  readonly consoleWaits: ReadonlyMap<TokenId, readonly RequestId[]>;
  /** The console tokens used to link in this run. */
  readonly consoleUsed: ReadonlySet<TokenId>;
  /** Failed link tries in the last hour, by the peer's address (section 5): memory only. */
  readonly failures: ReadonlyMap<string, readonly Mono[]>;
  /** The next `link_tokens.id`: one above the highest ever stored, never reused (section 5). */
  readonly nextToken: number;
  readonly nextPerson: number;
  readonly nextClient: number;
  /** The hub's static public key for apps, whose hash is its app identity (section 5). */
  readonly appStaticPublic: Uint8Array | undefined;
}

/** The slice before the boot event. */
export const EMPTY_PEOPLE_SLICE: PeopleSlice = {
  timers: [],
  boot: undefined,
  userManagement: false,
  people: new Map(),
  roles: new Map(),
  permissions: new Map(),
  clients: new Map(),
  replies: new Map(),
  tokens: new Map(),
  keyAsks: new Map(),
  consoleWaits: new Map(),
  consoleUsed: new Set(),
  failures: new Map(),
  nextToken: 1,
  nextPerson: 1,
  nextClient: 1,
  appStaticPublic: undefined,
};

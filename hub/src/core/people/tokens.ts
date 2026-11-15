/**
 * Link tokens (m2-design.md section 5, "Linking"; D61, D62, D99, D120, D121): their secrets,
 * lookups and pre-shared keys, the typed code, expiry, and voiding.
 *
 * - A **128-bit secret** (QR codes, link addresses, the console's token) is 16 bytes of the
 *   input's entropy. Its lookup is the first 4 bytes of SHA-256 of `hsn-find/1`, 0, secret; its
 *   key SHA-256 of `hsn-link/1`, 0, secret (`@hsn/protocol/app`).
 * - A **typed code** is a token id of 20 bits, chosen among those not in use, and a secret of 35
 *   bits (5 bytes, the top 5 bits zero); its lookup is the token id's 4 characters, kept in
 *   `link_tokens.lookup` as those 4 ASCII bytes; its key is made from the 5 bytes as above.
 * - A lookup is never shared by two unused tokens (`link_tokens_lookup_unused`): a draw that meets
 *   one in use is drawn again from the same input's entropy.
 * - A token works once (D121), and is void once used, cancelled, expired, worn out by failed tries
 *   (typed codes, 5 ‡) or made by a client that is removed. Void means `used_ms` is set (which
 *   frees its lookup in the unique index), its key row is deleted, and the shell is told
 *   (`linkSecret` with no key). The row itself stays, so a token's number is never reused.
 */
import { err, ok, type Result } from "neverthrow";
import type { Sha256 } from "@hsn/protocol";
import {
  formatTypedCode,
  label,
  secretLookup,
  secretPsk,
  typedLookup,
  typedPsk,
  LINKING,
} from "@hsn/protocol/app";
import { type CoreFault, coreFault } from "../model/errors.ts";
import type { Effect } from "../model/effects.ts";
import type { Context } from "../model/handler.ts";
import { TOKEN_RANGES, type TokenId, tokenId, tokenPurpose } from "../model/ids.ts";
import { type LinkTokenRow, TokenKind } from "../model/rows.ts";
import type { HubRules } from "../model/rules.ts";
import { type Mono, monoAfterMs } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import { writeNow } from "./records.ts";
import type { LiveToken, PeopleSlice } from "./state.ts";

const ORIGIN = "core/people";

/** A secret made for a token: what the shell and the person are given. */
export interface MadeSecret {
  /** `LinkHello.find`'s text. */
  readonly lookup: string;
  /** `link_tokens.lookup`. */
  readonly lookupBytes: Uint8Array;
  readonly psk: Uint8Array;
  /** A 128-bit secret's 16 bytes; undefined for a typed code. */
  readonly secret: Uint8Array | undefined;
  /** A typed code's `XXXX-XXXX-XXXX`; undefined for a 128-bit secret. */
  readonly code: string | undefined;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The lookups of the tokens still usable, by their stored bytes as hex. */
function lookupsInUse(slice: PeopleSlice): ReadonlySet<string> {
  return new Set([...slice.tokens.values()].map((t) => hex(t.row.lookup)));
}

/** How many draws one step may make before it gives up: as many as the input's entropy allows. */
const SECRET_DRAWS = 2;
const TYPED_DRAWS = 4;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** A 128-bit secret whose lookup no unused token has. */
export function drawSecret(
  ctx: Context,
  slice: PeopleSlice,
  sha256: Sha256,
): Result<MadeSecret, CoreFault> {
  const inUse = lookupsInUse(slice);
  for (let draw = 0; draw < SECRET_DRAWS; draw++) {
    const taken = ctx.entropy.take(LINKING.secretBytes);
    if (taken.isErr()) return err(taken.error);
    const secret = taken.value;
    const lookupBytes = sha256(concat(label("hsn-find/1"), secret)).slice(0, LINKING.lookupBytes);
    if (inUse.has(hex(lookupBytes))) continue;
    return ok({
      lookup: secretLookup(sha256, secret),
      lookupBytes,
      psk: secretPsk(sha256, secret),
      secret,
      code: undefined,
    });
  }
  return err(coreFault(ctx.event, ORIGIN, "no free lookup for a link token", {}));
}

const TYPED_ID_BYTES = 3;
const TYPED_ID_MASK = 0xf_ffff;

/** A typed code whose token id no unused token has (section 5, "A typed code"). */
export function drawTypedCode(
  ctx: Context,
  slice: PeopleSlice,
  sha256: Sha256,
): Result<MadeSecret, CoreFault> {
  const inUse = lookupsInUse(slice);
  const encoder = new TextEncoder();
  for (let draw = 0; draw < TYPED_DRAWS; draw++) {
    const idBytes = ctx.entropy.take(TYPED_ID_BYTES);
    if (idBytes.isErr()) return err(idBytes.error);
    const secretBytes = ctx.entropy.take(LINKING.typedSecretBytes);
    if (secretBytes.isErr()) return err(secretBytes.error);
    const [a = 0, b = 0, c = 0] = idBytes.value;
    const id = ((a << 16) | (b << 8) | c) & TYPED_ID_MASK;
    const bytes = secretBytes.value;
    // 35 bits: the top 5 bits of the first byte are zero (section 5).
    bytes[0] = (bytes[0] ?? 0) & 0x07;
    const secret = bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
    const lookup = typedLookup(id);
    const lookupBytes = encoder.encode(lookup);
    const code = formatTypedCode({ tokenId: id, secret });
    if (inUse.has(hex(lookupBytes)) || code === undefined) continue;
    return ok({ lookup, lookupBytes, psk: typedPsk(sha256, secret), secret: undefined, code });
  }
  return err(coreFault(ctx.event, ORIGIN, "no free token id for a typed code", {}));
}

/** The next link token number (section 5, "Token numbers"), or a fault past the range. */
export function nextTokenId(ctx: Context, slice: PeopleSlice): Result<TokenId, CoreFault> {
  return slice.nextToken <= TOKEN_RANGES.link.last
    ? ok(tokenId(slice.nextToken))
    : err(coreFault(ctx.event, ORIGIN, "link token numbers exhausted", {}));
}

/** Whether a token number is people's (link tokens), not upkeep's (restore tokens). */
export function isLinkToken(token: TokenId): boolean {
  return tokenPurpose(token) === "link";
}

/** Which lifetime a new token has (section 5, "Token numbers"; D62, D99). */
export type TokenLifetime = "appCode" | "invite" | "installer" | "console";

export function lifetimeMs(rules: HubRules, lifetime: TokenLifetime): number {
  switch (lifetime) {
    case "appCode":
      return rules.people.appCodeExpiryMs;
    case "invite":
      return rules.people.inviteExpiryMs;
    case "installer":
      return rules.people.installerCodeExpiryMs;
    case "console":
      return rules.people.consoleTokenExpiryMs;
  }
}

function expiryTimer(token: TokenId, at: Mono): TimerOf<"people"> {
  return { at, key: { module: "people", kind: "tokenExpiry", token } };
}

/** The slice with a token live, its expiry timer set. */
export function withToken(slice: PeopleSlice, live: LiveToken): PeopleSlice {
  const tokens = new Map(slice.tokens);
  tokens.set(live.row.id, live);
  const timers = [
    ...slice.timers.filter((t) => t.key.token !== live.row.id),
    expiryTimer(live.row.id, live.expiresAt),
  ];
  return { ...slice, tokens, timers, nextToken: Math.max(slice.nextToken, live.row.id + 1) };
}

/** The writes and the effect that make a token usable (section 3: before the code is shown). */
export function tokenMade(live: LiveToken, psk: Uint8Array): readonly Effect[] {
  return [
    writeNow({ table: "link_tokens", op: "upsert", row: live.row }),
    writeNow({ table: "link_secrets", op: "upsert", row: { tokenId: live.row.id, psk } }),
    // The shell finds the token by the lookup text `LinkHello.find` carries (section 5).
    // A new person whose name was not given: message 2 asks for one (step 1, wave 2).
    {
      kind: "linkSecret",
      token: live.row.id,
      purpose: "link",
      askName: live.row.kind === TokenKind.NewPerson && live.row.personName === null,
      lookup: live.lookup,
      psk,
    },
  ];
}

/** A live token's expiry on this boot's clock, from its row. */
export function expiresAt(row: LinkTokenRow): Mono {
  return monoAfterMs(row.createdMono, row.expiresAfterMs);
}

/**
 * Voids a token (see the file's comment): its row with `used_ms`, its key deleted, the shell told.
 * `row` may carry other changes (a used token's failures, for instance).
 */
export function voidToken(
  slice: PeopleSlice,
  row: LinkTokenRow,
  atMs: number,
): { readonly slice: PeopleSlice; readonly out: readonly Effect[] } {
  const tokens = new Map(slice.tokens);
  tokens.delete(row.id);
  const timers = slice.timers.filter((t) => t.key.token !== row.id);
  return {
    slice: { ...slice, tokens, timers },
    out: [
      writeNow({ table: "link_tokens", op: "upsert", row: { ...row, usedMs: atMs } }),
      writeNow({ table: "link_secrets", op: "delete", key: { tokenId: row.id } }),
      {
        kind: "linkSecret",
        token: row.id,
        purpose: "link",
        askName: false,
        lookup: null,
        psk: null,
      },
    ],
  };
}

/** Voids every token in `ids`, in order. */
export function voidTokens(
  slice: PeopleSlice,
  ids: readonly TokenId[],
  atMs: number,
): { readonly slice: PeopleSlice; readonly out: readonly Effect[] } {
  let next = slice;
  const out: Effect[] = [];
  for (const id of ids) {
    const live = next.tokens.get(id);
    if (live === undefined) continue;
    const voided = voidToken(next, live.row, atMs);
    next = voided.slice;
    out.push(...voided.out);
  }
  return { slice: next, out };
}

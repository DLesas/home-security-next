/**
 * Linking (m2-design.md section 5, "Linking"; section 7, "People and permissions"; D34, D61, D62,
 * D99, D120, D121): making tokens (`link.create`, `hsn open`'s console token), cancelling them,
 * their expiry and failed tries, and the handshake that spends one (`linkCompleted`).
 *
 * - Who may make one: a new person needs *manage users* (anyone while user management is off,
 *   D13); another device of one's own, any linked person (section 12, Q10).
 * - Lifetimes (section 11, "Step 1's questions"): 7 days ‡ for the installer's first code only
 *   (D62), 24 hours for an invite (D99), 2 minutes ‡ for the console's token, 10 minutes ‡ for
 *   every other. The installer's first code is the one the hub computer makes for a new person
 *   while the hub has no person yet: it is what makes the first person (section 7).
 * - A valid code links at once, with no second step, and works once (D121): the token is void in
 *   the commit that makes the client. Everything a link writes is written now, before
 *   `LinkResult` (section 3), which goes as the connection's `handshake` message; a refused link's
 *   connection is closed (`closeConn`).
 * - Failed tries are recorded (routine), and a warning after 10 in an hour ‡ from one address.
 */
import { ok } from "neverthrow";
import {
  appIdentityBytes,
  formatConsoleAddress,
  formatIdentity,
  formatLinkAddress,
  formatLinkQr,
  type AppOpBody,
} from "@hsn/protocol/app";
import { answerError, answerOk } from "../control/view.ts";
import type { HubEvent } from "../model/events.ts";
import { hubFacts } from "../app/view.ts";
import type { Effect } from "../model/effects.ts";
import type { Context } from "../model/handler.ts";
import { clientId, type PersonId } from "../model/ids.ts";
import { type Mono, msBetween } from "../model/time.ts";
import type { Internal } from "../model/messages.ts";
import { ClientKind, type ClientRow, type LinkTokenRow, TokenKind } from "../model/rows.ts";
import { hubEventRecord } from "../registry/view.ts";
import {
  addPerson,
  answer,
  answered,
  invalid,
  notFound,
  type OpRequest,
  refused,
  type Step,
  unauthorized,
  withClient,
  Writes,
} from "./ops.ts";
import { livePeople } from "./objects.ts";
import { consoleTokenUsed } from "./console-wait.ts";
import { holdsEpoch } from "./backup-epoch.ts";
import { backupKeyOf } from "../upkeep/view.ts";
import { actorHasGlobal, actorPerson, isLivePerson } from "./permissions.ts";
import { peopleDecision, writeNow, writeRoutine } from "./records.ts";
import type { LiveToken, PeopleSlice } from "./state.ts";
import {
  drawSecret,
  drawTypedCode,
  expiresAt,
  isLinkToken,
  lifetimeMs,
  type MadeSecret,
  nextTokenId,
  type TokenLifetime,
  tokenMade,
  voidToken,
  withToken,
} from "./tokens.ts";

const ORIGIN = "core/people";

type LinkCompleted = Extract<HubEvent, { readonly kind: "linkCompleted" }>;
type LinkFailed = Extract<HubEvent, { readonly kind: "linkFailed" }>;
type ConsoleTokenRequest = Extract<Internal, { readonly kind: "consoleTokenRequest" }>;

/** The hub has not yet been given what a QR code or a link address names (`hubFacts`, its app key). */
function unavailable(slice: PeopleSlice, request: OpRequest): Step {
  return answered(slice, request, refused({ code: "unavailable", detail: {} }));
}

const HOUR_MS = 3_600_000;

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Bytes as base64url without padding, as `backupKeyPayload` carries the key (section 6). */
function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let k = 0; k < chars; k++) out += BASE64URL[(n >>> (18 - 6 * k)) & 63] ?? "";
  }
  return out;
}

/** The client an actor uses, as a token's maker (`link_tokens.created_by_client`). */
function makerOf(request: OpRequest): ClientRow["linkedByClient"] {
  const actor = request.actor;
  return actor.kind === "person" || actor.kind === "console" ? actor.client : null;
}

function nameInUse(slice: PeopleSlice, name: string): boolean {
  return [...slice.people.values()].some((row) => row.removedMs === null && row.name === name);
}

export function linkCreate(
  slice: PeopleSlice,
  ctx: Context,
  request: OpRequest,
  body: AppOpBody<"link.create">,
): Step {
  const actor = request.actor;
  let kind: TokenKind;
  let person: PersonId | null = null;
  let personName: string | undefined;
  if (body.kind === "ownDevice") {
    const own = actorPerson(actor);
    // The console and the hub computer belong to no person: there is no "own device" to link.
    if (own === undefined) return answered(slice, request, invalid("kind", "range"));
    kind = TokenKind.OwnDevice;
    person = own;
  } else {
    if (!actorHasGlobal(slice, actor, "manageUsers"))
      return answered(slice, request, unauthorized("manageUsers"));
    personName = body.kind.newPerson.name;
    if (personName !== undefined && nameInUse(slice, personName))
      return answered(slice, request, invalid("kind.newPerson.name", "taken"));
    kind = TokenKind.NewPerson;
  }

  const sha256 = ctx.deps.sha256;
  const typed = body.form === "code";
  const facts = hubFacts(ctx.view);
  const appKey = slice.appStaticPublic;
  if (!typed && (facts === undefined || appKey === undefined)) return unavailable(slice, request);
  const boot = slice.boot;
  if (boot === undefined) return unavailable(slice, request);

  const installersFirst =
    actor.kind === "computer" && kind === TokenKind.NewPerson && livePeople(slice).length === 0;
  const lifetime: TokenLifetime =
    body.invite === true ? "invite" : installersFirst ? "installer" : "appCode";
  const expiresAfterMs = lifetimeMs(ctx.deps.rules, lifetime);
  const id = nextTokenId(ctx, slice);
  if (id.isErr()) return id.map(() => ({ slice, out: [] }));
  const drawn = typed ? drawTypedCode(ctx, slice, sha256) : drawSecret(ctx, slice, sha256);
  if (drawn.isErr()) return drawn.map(() => ({ slice, out: [] }));
  const secret: MadeSecret = drawn.value;

  const row: LinkTokenRow = {
    id: id.value,
    lookup: secret.lookupBytes,
    kind,
    personId: person,
    personName: personName ?? null,
    createdByClient: makerOf(request),
    createdBoot: boot,
    createdMono: ctx.now.mono,
    expiresAfterMs,
    typed,
    failures: 0,
    usedMs: null,
  };
  const live: LiveToken = { row, expiresAt: expiresAt(row), lookup: secret.lookup };

  let shown: { readonly qr?: string; readonly code?: string; readonly url?: string } = {};
  if (secret.code !== undefined) shown = { code: secret.code };
  else if (secret.secret !== undefined && facts !== undefined && appKey !== undefined) {
    const identity = formatIdentity(appIdentityBytes(sha256, appKey));
    shown =
      body.form === "qr"
        ? {
            qr: formatLinkQr({
              identity,
              secret: secret.secret,
              addresses: facts.addresses,
              port: facts.appsPort,
              fingerprint: facts.certificateSha256,
            }),
          }
        : {
            url: formatLinkAddress(
              facts.addresses[0] ?? "",
              facts.appsPort,
              identity,
              secret.secret,
            ),
          };
  }
  const next = withToken(slice, live);
  return ok({
    slice: next,
    out: [
      ...tokenMade(live, secret.psk),
      answer(request, { ok: true, body: { token: row.id, ...shown, expiresInMs: expiresAfterMs } }),
    ],
  });
}

/** `link.cancel`: by its maker, or by someone with *manage users*. */
export function linkCancel(
  slice: PeopleSlice,
  ctx: Context,
  request: OpRequest,
  body: AppOpBody<"link.cancel">,
): Step {
  const live = [...slice.tokens.values()].find((t) => t.row.id === body.token);
  if (live === undefined) return answered(slice, request, notFound("token", body.token));
  const actor = request.actor;
  const maker =
    actor.kind === "computer" ||
    actor.kind === "schedule" ||
    live.row.createdByClient === actor.client;
  if (!maker && !actorHasGlobal(slice, actor, "manageUsers"))
    return answered(slice, request, unauthorized("manageUsers"));
  const voided = voidToken(slice, live.row, ctx.now.wall);
  return ok({ slice: voided.slice, out: [...voided.out, answer(request, { ok: true, body: {} })] });
}

/** `hsn open`'s one-time console token (section 5, "The console"): 128 bits, 2 minutes ‡. */
export function consoleToken(slice: PeopleSlice, ctx: Context, request: ConsoleTokenRequest): Step {
  const sha256 = ctx.deps.sha256;
  const boot = slice.boot;
  if (boot === undefined)
    return ok({
      slice,
      out: [answerError(request.request, "failed", "the hub has not started yet")],
    });
  // The address names the console listener's port as it really opened (`hubFacts`, section 2),
  // never a constant; before the shell has said, no token is made.
  const facts = hubFacts(ctx.view);
  if (facts === undefined)
    return ok({
      slice,
      out: [
        answerError(
          request.request,
          "failed",
          "the hub's listeners have not given their ports yet: try again in a moment",
        ),
      ],
    });
  const id = nextTokenId(ctx, slice);
  if (id.isErr()) return id.map(() => ({ slice, out: [] }));
  const drawn = drawSecret(ctx, slice, sha256);
  if (drawn.isErr()) return drawn.map(() => ({ slice, out: [] }));
  const secret = drawn.value.secret;
  if (secret === undefined)
    return ok({ slice, out: [answerError(request.request, "failed", "no secret was drawn")] });
  const expiresAfterMs =
    request.for === "installer"
      ? ctx.deps.rules.people.installerConsoleTokenExpiryMs
      : lifetimeMs(ctx.deps.rules, "console");
  const row: LinkTokenRow = {
    id: id.value,
    lookup: drawn.value.lookupBytes,
    kind: TokenKind.Console,
    personId: null,
    personName: null,
    createdByClient: null,
    createdBoot: boot,
    createdMono: ctx.now.mono,
    expiresAfterMs,
    typed: false,
    failures: 0,
    usedMs: null,
  };
  const live: LiveToken = { row, expiresAt: expiresAt(row), lookup: drawn.value.lookup };
  return ok({
    slice: withToken(slice, live),
    out: [
      ...tokenMade(live, drawn.value.psk),
      answerOk(request.request, {
        kind: "consoleToken",
        url: formatConsoleAddress(facts.consolePort, secret),
        expiresInMs: expiresAfterMs,
        token: id.value,
      }),
    ],
  });
}

/** A link the hub will not make: recorded, its connection closed; the token stays as it was. */
function refuseLink(slice: PeopleSlice, ctx: Context, event: LinkCompleted, why: string): Step {
  return hubEventRecord(ctx, {
    level: "info",
    origin: ORIGIN,
    code: "link_refused",
    message: `a link with token ${event.token} was refused: ${why}`,
    detail: JSON.stringify({ token: event.token, listener: event.listener, why }),
  }).map((record) => ({
    slice,
    out: [record, { kind: "closeConn", conn: event.conn, reason: "linkRefused" }],
  }));
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const KEY_BYTES = 32;

/**
 * A handshake completed with a token's key (section 5): the client is made at once and the token
 * void, in one commit; a new person with it, for a token that makes one. Refused, and recorded,
 * when the token is no longer live (used, cancelled, expired: D121's "finds it refused"), when a
 * console token comes in on the home network's listener (section 5: the console's trust belongs to
 * the computer), when the key is already a client's, or when the new person has no name or one
 * already used.
 */
export function linkCompleted(slice: PeopleSlice, ctx: Context, event: LinkCompleted): Step {
  if (!isLinkToken(event.token)) return ok({ slice, out: [] });
  const live = slice.tokens.get(event.token);
  if (live === undefined) return refuseLink(slice, ctx, event, "the token is not live");
  const token = live.row;
  if (token.kind === TokenKind.Console && event.listener !== "console")
    return refuseLink(slice, ctx, event, "a console token on the home network's listener");
  if (event.staticKey.length !== KEY_BYTES)
    return refuseLink(slice, ctx, event, "a static key that is not 32 bytes");
  if ([...slice.clients.values()].some((row) => sameKey(row.staticKey, event.staticKey)))
    return refuseLink(slice, ctx, event, "the static key is already a client's");

  const writes = new Writes();
  let next = slice;
  let person: PersonId | null = null;
  const by = `token ${token.id}`;
  if (token.kind === TokenKind.NewPerson) {
    const name = token.personName ?? event.link.person?.name;
    if (name === undefined) return refuseLink(slice, ctx, event, "the new person has no name");
    if (nameInUse(slice, name)) return refuseLink(slice, ctx, event, "the name is already used");
    const added = addPerson(next, ctx, name, by, null, writes);
    next = added.slice;
    person = added.person;
  } else if (token.kind === TokenKind.OwnDevice) {
    if (token.personId === null || !isLivePerson(slice, token.personId))
      return refuseLink(slice, ctx, event, "the token's person is removed");
    person = token.personId;
  }

  const client: ClientRow = {
    id: clientId(next.nextClient),
    personId: person,
    staticKey: event.staticKey,
    kind:
      token.kind === TokenKind.Console
        ? ClientKind.Console
        : event.link.kind === "phone"
          ? ClientKind.Phone
          : ClientKind.Web,
    name: event.link.name,
    linkedByClient: token.createdByClient,
    createdMs: ctx.now.wall,
    removedMs: null,
    lastSeq: 0,
    lastSeenMs: null,
    backupKeyEpoch: null,
  };
  next = withClient(next, client);
  writes.push(writeNow({ table: "clients", op: "upsert", row: client }));
  const voided = voidToken(next, token, ctx.now.wall);
  next = token.kind === TokenKind.Console ? consoleTokenUsed(voided.slice, token.id) : voided.slice;
  writes.push(...voided.out);
  writes.decide(
    peopleDecision(
      ctx,
      "client_linked",
      client.id,
      {
        person: client.personId,
        kind: client.kind,
        name: client.name,
        linkedBy: client.linkedByClient,
        token: token.id,
      },
      null,
    ),
  );
  writes.push({ kind: "clientAdded", client: client.id, person: client.personId });
  // Message 4 (section 5): a phone is also given the backup key and its epoch (D78, D99), and its
  // row says it holds that epoch, in this commit; a browser never is.
  const backup = client.kind === ClientKind.Phone ? backupKeyOf(ctx.view) : undefined;
  if (backup !== undefined) {
    const held = holdsEpoch(next, client.id, backup.epoch);
    next = held.slice;
    writes.push(...held.out);
  }
  writes.push({
    kind: "appSend",
    conn: event.conn,
    message: {
      kind: "handshake",
      body:
        backup === undefined
          ? { client: client.id, person: client.personId }
          : {
              client: client.id,
              person: client.personId,
              backupKey: { key: base64url(backup.key), epoch: backup.epoch },
            },
    },
  });
  return writes.done(next);
}

/** The failures from one address in the last hour, this one included (memory only). */
function failuresFrom(slice: PeopleSlice, address: string, now: Mono): readonly Mono[] {
  const recent = (slice.failures.get(address) ?? []).filter((at) => msBetween(at, now) < HOUR_MS);
  return [...recent, now];
}

/**
 * A failed try (section 5, "The real hub limits tries"): recorded, routine, and at the 10th ‡ in
 * an hour from one address a warning (`HubRules.people.linkFailureWarningPerHour`); a typed code is
 * void after 5 ‡ failures, its count routine until then; a 128-bit token has no limit, since
 * nobody can guess it.
 */
export function linkFailed(slice: PeopleSlice, ctx: Context, event: LinkFailed): Step {
  if (!isLinkToken(event.token)) return ok({ slice, out: [] });
  const recent = failuresFrom(slice, event.address, ctx.now.mono);
  const failures = new Map(slice.failures);
  failures.set(event.address, recent);
  let next: PeopleSlice = { ...slice, failures };
  const warn = recent.length === ctx.deps.rules.people.linkFailureWarningPerHour;
  const out: (Internal | Effect)[] = [];
  const record = hubEventRecord(ctx, {
    level: warn ? "warning" : "info",
    origin: ORIGIN,
    code: "link_failed",
    message: warn
      ? `${recent.length} failed link tries in an hour from ${event.address}`
      : `a failed link try from ${event.address}: ${event.reason}`,
    detail: JSON.stringify({ token: event.token, address: event.address, reason: event.reason }),
    durability: warn ? "now" : "routine",
  });
  if (record.isErr()) return record.map(() => ({ slice, out: [] }));
  out.push(record.value);
  const live = next.tokens.get(event.token);
  if (live?.row.typed === true) {
    const row: LinkTokenRow = { ...live.row, failures: live.row.failures + 1 };
    if (row.failures >= ctx.deps.rules.people.typedMaxFailures) {
      const voided = voidToken(next, row, ctx.now.wall);
      next = voided.slice;
      out.push(...voided.out);
    } else {
      const tokens = new Map(next.tokens);
      tokens.set(row.id, { ...live, row });
      next = { ...next, tokens };
      out.push(writeRoutine({ table: "link_tokens", op: "upsert", row }));
    }
  }
  return ok({ slice: next, out });
}

/** A token's lifetime ran out (section 5): void. */
export function tokenExpired(slice: PeopleSlice, ctx: Context, token: LinkTokenRow["id"]): Step {
  const live = slice.tokens.get(token);
  if (live === undefined) return ok({ slice, out: [] });
  const voided = voidToken(slice, live.row, ctx.now.wall);
  return ok({ slice: voided.slice, out: voided.out });
}

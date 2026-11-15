/**
 * The boot event (m2-design.md section 4: every table is small and read whole at start): the slice
 * rebuilt from the snapshot, and the tokens carried across the restart.
 *
 * A token's age runs on the monotonic clock from its creation, carried across restarts as
 * countdowns are (section 5, "Expiry and an untrusted clock"; HD 5): its age at the last commit
 * plus the downtime. When the downtime is not known at the start (D113), every token of an earlier
 * run counts as expired and is voided: it must be made again. A token still live is written again
 * with this boot's id and clock, so a second restart measures it from here.
 */
import { err, ok, type Result } from "neverthrow";
import { downtime, lastCommitMark } from "../clock/view.ts";
import type { CoreFault } from "../model/errors.ts";
import type { HubEvent } from "../model/events.ts";
import type { Context, Handled } from "../model/handler.ts";
import type { ClientId, DeviceId, PersonId } from "../model/ids.ts";
import type { LinkTokenRow, PermissionRow } from "../model/rows.ts";
import { msBetween } from "../model/time.ts";
import { hubEventRecord } from "../registry/view.ts";
import type { Internal } from "../model/messages.ts";
import type { Effect } from "../model/effects.ts";
import { writeNow } from "./records.ts";
import { decodeReply } from "./replies.ts";
import { EMPTY_PEOPLE_SLICE, type LiveToken, type PeopleSlice, type StoredReply } from "./state.ts";
import { expiresAt, voidToken, withToken } from "./tokens.ts";

type Boot = Extract<HubEvent, { readonly kind: "boot" }>;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A stored lookup as `LinkHello.find` carries it: a typed code's 4 characters, or 8 hex digits. */
export function lookupText(row: LinkTokenRow): string {
  return row.typed ? new TextDecoder().decode(row.lookup) : hex(row.lookup);
}

/** What is left of a token of an earlier run, or undefined when it cannot be told. */
function remainingMs(ctx: Context, row: LinkTokenRow): number | undefined {
  const mark = lastCommitMark(ctx.view);
  const down = downtime(ctx.view);
  if (mark?.boot !== row.createdBoot || down.kind !== "known") return undefined;
  const ageAtMark = msBetween(row.createdMono, mark.lastSeenMono);
  return row.expiresAfterMs - ageAtMark - down.ms;
}

export function onBoot(ctx: Context, event: Boot): Result<Handled<"people">, CoreFault> {
  const m2 = event.snapshot.m2;
  const boot = event.boot.id;

  const permissions = new Map<PersonId, Map<DeviceId, PermissionRow>>();
  for (const row of m2.permissions) {
    const rows = permissions.get(row.personId) ?? new Map<DeviceId, PermissionRow>();
    rows.set(row.deviceId, row);
    permissions.set(row.personId, rows);
  }

  let unreadable = 0;
  const replies = new Map<ClientId, Map<number, StoredReply>>();
  for (const row of m2.clientReplies) {
    const reply = decodeReply(row.reply);
    if (reply === undefined) {
      unreadable++;
      continue;
    }
    const kept = replies.get(row.clientId) ?? new Map<number, StoredReply>();
    kept.set(row.seq, { kind: "sent", reply });
    replies.set(row.clientId, kept);
  }

  const highest = (ids: readonly number[]): number => ids.reduce((a, b) => Math.max(a, b), 0);
  let next: PeopleSlice = {
    ...EMPTY_PEOPLE_SLICE,
    boot,
    userManagement: m2.peopleSettings?.userManagement ?? false,
    people: new Map(m2.people.map((row) => [row.id, row])),
    roles: new Map(m2.personRoles.map((row) => [row.personId, row])),
    permissions,
    clients: new Map(m2.clients.map((row) => [row.id, row])),
    replies,
    nextToken: highest(m2.linkTokens.map((row) => row.id)) + 1,
    nextPerson: highest(m2.people.map((row) => row.id)) + 1,
    nextClient: highest(m2.clients.map((row) => row.id)) + 1,
    appStaticPublic: m2.appKeys?.appStaticPublic,
  };

  const out: (Internal | Effect)[] = [];
  const unused = m2.linkTokens.filter((row) => row.usedMs === null);
  for (const row of unused) {
    const left = remainingMs(ctx, row);
    if (left === undefined || left <= 0) {
      const voided = voidToken(next, row, ctx.now.wall);
      next = voided.slice;
      out.push(...voided.out);
      continue;
    }
    const carried: LinkTokenRow = {
      ...row,
      createdBoot: boot,
      createdMono: ctx.now.mono,
      expiresAfterMs: left,
    };
    const live: LiveToken = {
      row: carried,
      expiresAt: expiresAt(carried),
      lookup: lookupText(carried),
    };
    next = withToken(next, live);
    out.push(writeNow({ table: "link_tokens", op: "upsert", row: carried }));
  }

  if (unreadable > 0) {
    const record = hubEventRecord(ctx, {
      level: "warning",
      origin: "core/people",
      code: "client_replies_unreadable",
      message: `${unreadable} stored replies could not be read: their retries are answered seqTooLow`,
    });
    if (record.isErr()) return err(record.error);
    out.push(record.value);
  }
  return ok({ slice: next, out });
}

/**
 * What a session is sent, by the channel version it agreed (docs/m3-m4-plan.md: one version 2 for
 * the three designs; m2-design.md section 5, "Versions": "the hub sends a client only what its
 * version names"). A version 1 session gets version 1's objects exactly as before version 2
 * existed; a version 2 session gets version 2's, each complete for its strict schema:
 *
 * - `hub.info`: version 1's, with the home-network addresses (as a link code's `a=` lists them),
 *   the apps' port and the relay in use (m3-design section 3, m4-design section 9);
 * - device objects: with their update (`firmware`'s view, m3-updates-design section 4);
 * - notifications: with `happenedAtMs` (D102, `notify`'s view);
 * - the snapshot: all of those, and for a phone its push target's state (`relay`'s view) and the
 *   backup key's epoch (`upkeep`'s view); null for any other client.
 *
 * Also the hub's home-network addresses as apps are given them (`appAddresses`): the certificate's
 * addresses without IPv6 link-local ones, which need a zone and so cannot be written in a URL a
 * phone opens (m2-design.md section 5, "A QR code"), IPv4 first, IPv6 in its shortest form.
 */
import {
  APP_PROTO_LATEST,
  type AppProtoVersion,
  type DeviceObject,
  type DeviceObjectV2,
  homeAddress,
  type HubInfo,
  type HubInfoV2,
  type NotificationObject,
  type NotificationObjectV2,
  type SnapshotObject,
  type SnapshotObjectV2,
} from "@hsn/protocol/app";
import { backupKeyEpoch } from "../upkeep/view.ts";
import { asVersion2, happenedAtFor } from "../notify/view.ts";
import type { CoreDeps } from "../model/handler.ts";
import type { Actor } from "../model/messages.ts";
import { ClientKind, type DeviceRow } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import type { Now } from "../model/time.ts";
import { liveClient } from "../people/view.ts";
import { pushTargetState, relayInUse } from "../relay/view.ts";
import { deviceUpdateOf } from "../firmware/view.ts";
import { deviceId } from "../model/ids.ts";
import { deviceObject, hubInfoObject, snapshotObject } from "./objects.ts";
import type { HubFacts } from "./state.ts";

/** A session's version as the protocol names it: 2 for a session that agreed 2, else 1. */
export function protoOf(proto: number): AppProtoVersion {
  return proto >= APP_PROTO_LATEST ? APP_PROTO_LATEST : 1;
}

// ----- Addresses -----

const IPV6_GROUPS = 8;

/** The 16-bit groups of an IPv6 address written without a zone or embedded IPv4, or undefined. */
function ipv6Groups(text: string): readonly number[] | undefined {
  const halves = text.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const part = (half: string | undefined): readonly string[] =>
    half === undefined || half === "" ? [] : half.split(":");
  const head = part(halves[0]);
  const tail = part(halves[1]);
  const missing = IPV6_GROUPS - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const words = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill("0"), ...tail];
  if (!words.every((w) => /^[0-9a-f]{1,4}$/u.test(w))) return undefined;
  return words.map((w) => Number.parseInt(w, 16));
}

/**
 * An IPv6 address in its shortest form (RFC 5952): lower case, no leading zeros, the longest run
 * of two or more zero groups (the first, on a tie) as `::`. Undefined for anything else.
 */
export function shortestIpv6(text: string): string | undefined {
  const groups = ipv6Groups(text);
  if (groups === undefined) return undefined;
  let best = { at: -1, length: 0 };
  for (let at = 0; at < groups.length;) {
    if (groups[at] !== 0) {
      at++;
      continue;
    }
    let end = at;
    while (end < groups.length && groups[end] === 0) end++;
    if (end - at > best.length) best = { at, length: end - at };
    at = end;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.length < 2) return hex.join(":");
  return `${hex.slice(0, best.at).join(":")}::${hex.slice(best.at + best.length).join(":")}`;
}

/** True for an IPv6 link-local address, `fe80::/10`, which needs a zone to be reached. */
export function isLinkLocalIpv6(text: string): boolean {
  const first = ipv6Groups(text)?.[0];
  return first !== undefined && (first & 0xffc0) === 0xfe80;
}

/**
 * The hub's home-network addresses as apps are given them (`hub.info`'s `addresses`, a link
 * code's `a=`, a link address): IPv4 first, then IPv6 in its shortest form, without link-local
 * IPv6 addresses, addresses with a zone, or anything that is not an address; each once.
 */
export function appAddresses(addresses: readonly string[]): readonly string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const address of addresses) {
    if (address.includes("%")) continue;
    if (homeAddress.safeParse(address).success && !address.includes(":")) {
      if (!v4.includes(address)) v4.push(address);
      continue;
    }
    const shortest = shortestIpv6(address);
    if (shortest === undefined || isLinkLocalIpv6(shortest)) continue;
    if (!homeAddress.safeParse(shortest).success) continue;
    if (!v6.includes(shortest)) v6.push(shortest);
  }
  return [...v4, ...v6];
}

/** The shell's facts with the addresses apps are given (`appAddresses`). */
export function factsForApps(facts: HubFacts): HubFacts {
  return { ...facts, addresses: appAddresses(facts.addresses) };
}

// ----- Objects by version -----

/** `hub.info` in version 2 (m3-design section 3, m4-design section 9). */
export function hubInfoV2(info: HubInfo, view: HubState, facts: HubFacts): HubInfoV2 {
  return {
    ...info,
    proto: APP_PROTO_LATEST,
    addresses: facts.addresses,
    appsPort: facts.appsPort,
    relay: relayInUse(view),
  };
}

/** `hub.info` for a session of `proto`; undefined before the shell's facts and the app key. */
export function hubInfoFor(
  view: HubState,
  deps: CoreDeps,
  now: Now,
  proto: AppProtoVersion,
): HubInfo | HubInfoV2 | undefined {
  const info = hubInfoObject(view, deps, now);
  const facts = view.app.facts;
  if (info === undefined || facts === undefined || proto === 1) return info;
  return hubInfoV2(info, view, facts);
}

/** A device object for a session of `proto`. */
export function deviceFor(
  view: HubState,
  deps: CoreDeps,
  row: DeviceRow,
  proto: AppProtoVersion,
): DeviceObject | DeviceObjectV2 | undefined {
  const object = deviceObject(view, deps, row);
  return object === undefined || proto === 1 ? object : deviceToV2(view, object);
}

/** Version 1's device object as version 2 has it: with its update, null when it has none. */
export function deviceToV2(view: HubState, object: DeviceObject): DeviceObjectV2 {
  return { ...object, update: deviceUpdateOf(view, deviceId(object.id)) };
}

/**
 * A notification for a session of `proto`: version 2's with `happenedAtMs` (D102), given beside
 * the object by `notify` (`notificationRaised`), or read from its view by `seq`.
 */
export function notificationFor(
  view: HubState,
  notification: NotificationObject,
  happenedAtMs: number | null | undefined,
  proto: AppProtoVersion,
): NotificationObject | NotificationObjectV2 {
  if (proto === 1) return notification;
  return {
    ...notification,
    happenedAtMs: happenedAtMs ?? happenedAtFor(view, notification.seq) ?? null,
  };
}

/** The asking client's kind, when the actor is a person's or the console's client. */
function clientOf(view: HubState, actor: Actor) {
  return actor.kind === "person" || actor.kind === "console"
    ? liveClient(view, actor.client)
    : undefined;
}

/**
 * The snapshot in version 2 (m3-design sections 3 and 4, m4-design section 9): version 1's, with
 * `hub.info` in version 2's form, devices with their updates, notifications with `happenedAtMs`,
 * and, for a phone, its push target's state and the backup key's epoch (null for another client).
 */
export function snapshotV2(
  view: HubState,
  actor: Actor,
  snapshot: SnapshotObject,
): SnapshotObjectV2 | undefined {
  const facts = view.app.facts;
  if (facts === undefined) return undefined;
  const client = clientOf(view, actor);
  const phone = client?.kind === ClientKind.Phone;
  return {
    ...snapshot,
    hub: hubInfoV2(snapshot.hub, view, facts),
    devices: snapshot.devices.map((device) => deviceToV2(view, device)),
    notifications: asVersion2(view, snapshot.notifications),
    push: client === undefined ? null : pushTargetState(view, client.id),
    backupKeyEpoch: phone ? backupKeyEpoch(view) : null,
  };
}

/** The snapshot for a session of `proto`; undefined before the shell's facts and the app key. */
export function snapshotFor(
  view: HubState,
  deps: CoreDeps,
  actor: Actor,
  now: Now,
  rev: number,
  proto: AppProtoVersion,
): SnapshotObject | SnapshotObjectV2 | undefined {
  const snapshot = snapshotObject(view, deps, actor, now, rev);
  if (snapshot === undefined || proto === 1) return snapshot;
  return snapshotV2(view, actor, snapshot);
}

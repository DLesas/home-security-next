/**
 * The relay's address (docs/m4-design.md sections 2 and 9): the setting, the deployment's default,
 * the rule `relay.set` applies, and `relay.status`. Pure.
 *
 * - **The default.** `relay_settings.url` null means the deployment's default relay, which the
 *   boot input carries (`BootInfo.defaultRelayUrl`, the shell's `defaultRelayUrl(DEPLOYMENT)`,
 *   since the core may not import `@hsn/deployment`). While the product's domain is the
 *   placeholder it is **none**: the client stays off and `relay.status` says `off` (section 2).
 * - **`relay.set`'s rule** is `relaySettingProblems` of `@hsn/deployment` (section 2), written
 *   again here for the same reason: a `wss://` URL to any host, or `ws://` only to a loopback or
 *   private address, with no credentials and no path (the shell has checked the schema's shape,
 *   `relayUrl`). A test holds the two to the same answers.
 */
import {
  relayStatusObject,
  RELAY_SET_REFUSALS,
  type AppErrorV2,
  type RelayStatusObject,
} from "@hsn/protocol/app";
import type { RelaySettingsRow } from "../model/rows.ts";
import type { LinkState, RelaySlice } from "./state.ts";

/** The relay a setting names: itself, else the default; null when there is none. */
export function urlOf(settings: RelaySettingsRow, defaultUrl: string | null): string | null {
  return settings.url ?? defaultUrl;
}

/** The relay in use: the setting, else the default; null when there is none. */
export function urlInUse(slice: RelaySlice): string | null {
  return urlOf(slice.settings, slice.defaultUrl);
}

/** The link's state when a relay is (or is not) in use and nothing is known of it yet. */
export function linkAtStart(url: string | null): LinkState {
  return url === null ? { kind: "off" } : { kind: "down", reason: undefined };
}

// ----- `relay.set`'s rule -----

/**
 * True for a host a `ws://` relay may name (`isLocalHost` of `@hsn/deployment`): `localhost`,
 * 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, `::1` and fc00::/7. Link-local
 * addresses and every other name are refused: a cleartext link stays on this computer or the
 * home network.
 */
export function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (lower === "localhost") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(lower);
  if (v4 !== null) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return false;
    const [a = 0, b = 0] = parts;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (!lower.includes(":")) return false;
  if (lower === "::1") return true;
  const first = lower.split(":")[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/u.test(first)) return false;
  const high = Number.parseInt(first.padStart(4, "0"), 16);
  return (high & 0xfe00) === 0xfc00;
}

/** A URL's parts as `relay.set` reads them, or undefined when it is not a `ws://` or `wss://` URL. */
function urlParts(
  url: string,
): { readonly secure: boolean; readonly authority: string; readonly path: string } | undefined {
  const match = /^(wss?):\/\/([^\s/?#]+)(\/[^\s?#]*)?$/u.exec(url);
  if (match === null) return undefined;
  return { secure: match[1] === "wss", authority: match[2] ?? "", path: match[3] ?? "" };
}

/** The host of an authority (`host`, `host:port`, `[v6]` or `[v6]:port`), or undefined. */
function hostOf(authority: string): string | undefined {
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/u.exec(authority);
  const plain = /^([^:[\]]+)(?::(\d+))?$/u.exec(authority);
  const match = bracketed ?? plain;
  if (match === null) return undefined;
  const port = match[2];
  if (port !== undefined && (port === "" || Number(port) < 1 || Number(port) > 65_535)) {
    return undefined;
  }
  return match[1];
}

/**
 * Why `relay.set` refuses `url` (`RELAY_SET_REFUSALS`), or undefined when it may be set: `format`
 * for anything but a `ws://` or `wss://` URL with a host, an optional port and no credentials or
 * path; `notLocal` for `ws://` to a host that is not loopback or private.
 */
export function relaySetRefusal(url: string): AppErrorV2 | undefined {
  const parts = urlParts(url);
  if (parts === undefined || parts.authority.includes("@")) return RELAY_SET_REFUSALS.format;
  if (parts.path !== "" && parts.path !== "/") return RELAY_SET_REFUSALS.format;
  const host = hostOf(parts.authority);
  if (host === undefined) return RELAY_SET_REFUSALS.format;
  if (parts.secure) return undefined;
  return isLocalHost(host) ? undefined : RELAY_SET_REFUSALS.notLocal;
}

// ----- `relay.status` -----

type RelayRole = RelayStatusObject["roles"][number];
const roleSchema = relayStatusObject.unwrap().shape.roles.unwrap().element;

function isRelayRole(role: string): role is RelayRole {
  return roleSchema.safeParse(role).success;
}

/** `relay.status`, and `relay.set`'s reply (section 9). */
export function statusOf(slice: RelaySlice): RelayStatusObject {
  const url = urlInUse(slice);
  const { link } = slice;
  const base = {
    url,
    isDefault: slice.settings.url === null,
    state: link.kind,
    sinceMs: slice.changedMs,
    roles: link.kind === "up" ? link.roles.filter(isRelayRole) : [],
  };
  return link.kind === "down" && link.reason !== undefined
    ? { ...base, lastError: link.reason }
    : base;
}

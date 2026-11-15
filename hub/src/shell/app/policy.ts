/**
 * The defences on every HTTP and WebSocket request of the two app listeners (m2-design.md
 * section 5, "Defences on every HTTP and WebSocket request"; D62):
 *
 * - The `Host` header must name one of the certificate's names or addresses with the listener's
 *   port (the console: `127.0.0.1:8445` or `localhost:8445`); otherwise 421. A page that rebinds
 *   its own name to the hub's address cannot reach it.
 * - A WebSocket upgrade's `Origin` must be the listener's own origin, the scheme and the `Host`
 *   it was served under; otherwise 403.
 * - Every response carries the content security policy built from the web build's `csp.json`
 *   (`contentSecurityPolicy`), and headers that refuse sniffing, referrers and framing.
 * - No cookies, nothing but the static files and the channel.
 */
import { join } from "node:path";
import {
  contentSecurityPolicy,
  CSP_FILE,
  EMPTY_STYLE_HASH,
  webCspFile,
  type WebCspFile,
} from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { AppListener } from "../../core/model/events.ts";
import { readTextIfExists } from "../safe/fs.ts";
import { parseJson } from "../safe/json.ts";
import { hostKey, splitHost } from "./addresses.ts";

const ORIGIN = "shell/app/policy";

/** The policy when there is no web build: no inline style or script at all. */
export const NO_BUILD_POLICY: WebCspFile = { styles: [EMPTY_STYLE_HASH], scripts: [] };

/**
 * The policy of the web build in `webRoot`, from its `csp.json`. A missing file is the strictest
 * policy (no build to serve); a file that is not the schema's is an error, so a broken build is
 * never served under a policy it did not ask for.
 */
export function loadPolicy(webRoot: string): Result<string, HubError> {
  const caller = { kind: "config", origin: ORIGIN } as const;
  const text = readTextIfExists(caller, join(webRoot, CSP_FILE));
  if (text.isErr()) return err(text.error);
  if (text.value === undefined) return ok(contentSecurityPolicy(NO_BUILD_POLICY));
  const json = parseJson(text.value, "config", ORIGIN);
  if (json.isErr()) return err(json.error);
  const parsed = webCspFile.safeParse(json.value);
  return parsed.success
    ? ok(contentSecurityPolicy(parsed.data))
    : err({ kind: "config", origin: ORIGIN, message: `${CSP_FILE} is not the web build's policy` });
}

/** The headers every response carries (section 5). */
export function securityHeaders(policy: string): Record<string, string> {
  return {
    "content-security-policy": policy,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "no-store",
  };
}

/** What a listener answers to: its scheme, its port and the hosts it may be named by. */
export interface HostRule {
  readonly listener: AppListener;
  readonly port: number;
  /** Names and addresses, as `hostKey` makes them comparable. */
  readonly hosts: ReadonlySet<string>;
}

/** The console's rule: `127.0.0.1` or `localhost`, on its port (section 5). */
export function consoleRule(port: number): HostRule {
  return {
    listener: "console",
    port,
    hosts: new Set([hostKey("127.0.0.1"), hostKey("localhost")]),
  };
}

/** The home network's rule: the certificate's names and addresses, on the apps' port. */
export function lanRule(port: number, names: ReadonlySet<string>): HostRule {
  return { listener: "lan", port, hosts: names };
}

/** Whether a `Host` header names this listener (section 5); otherwise the request gets 421. */
export function hostAllowed(rule: HostRule, header: string | null): boolean {
  const split = header === null ? undefined : splitHost(header);
  return split?.port === rule.port && rule.hosts.has(hostKey(split.host));
}

/**
 * Whether a WebSocket upgrade's `Origin` is the listener's own origin: the scheme of the listener
 * and exactly the `Host` the request came under, which `hostAllowed` has checked; otherwise 403.
 */
export function originAllowed(rule: HostRule, host: string | null, origin: string | null): boolean {
  if (host === null || origin === null || !hostAllowed(rule, host)) return false;
  const scheme = rule.listener === "lan" ? "https" : "http";
  return origin.toLowerCase() === `${scheme}://${host.toLowerCase()}`;
}

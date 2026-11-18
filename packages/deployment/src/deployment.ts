/**
 * The one configuration point (docs/m4-design.md section 2, D128): everything that depends on
 * the product's name, its domain or its host. The hub, the relay and the app import it; nothing
 * else names a domain, a bundle identifier, an app group or a display name. Frozen by the joint
 * step 0 (docs/m3-m4-plan.md): the values change when the product owner chooses them; the shape
 * and the rules change only through the step 0 owner.
 *
 * **The values live in `packages/deployment/deployment.json`** (the coordinator's ruling, for
 * what cannot load TypeScript: Expo's `app.config.ts` under plain Node, later a firmware header
 * generator). That file is the one place a person edits; this module reads it, checks it
 * (`deploymentFileProblems`, which this package's test and a release build run), and gives every
 * TypeScript user the typed `DEPLOYMENT` of section 2. The file's fields, flat:
 *
 * - `productName`: the app's display name.
 * - `domain`: the product's domain, the one line to change when it is chosen. The default relay
 *   is `wss://relay.<domain>` (RA3) and the operated push service `wss://push.<domain>` (D77).
 * - `hubsDomain`: the registrable domain for per-hub names, kept apart from the product's (S4,
 *   recommendation 1); the canary is `rebindtest.<hubsDomain>` (always a private address, S4 2.4)
 *   and the control name `control.<hubsDomain>` (always a public address).
 * - `iosBundleId`, `iosAppGroup`, `iosTeamId` (null until the Apple account's team is set),
 *   `androidApplicationId`: never shown to users, and may be chosen before the name (QP1).
 * - `acmeDirectory`: the certificate authority's ACME directory, overridable by the name service.
 *
 * What it does not hold: secrets (the APNs key, the FCM service account and the relay's TLS key
 * live on the relay's host), protocol labels (`hsn-relay/1` and the others are bytes inside
 * cryptography), and the URL scheme `hsn` (the protocol's, in `LINKING`).
 *
 * No dependencies, and no function here throws: the rules return lists of problems.
 */
import file from "../deployment.json";

/** The keys of `deployment.json`, exactly: a key missing, misspelt or extra is a problem. */
export const DEPLOYMENT_FILE_KEYS = [
  "productName",
  "domain",
  "hubsDomain",
  "iosBundleId",
  "iosAppGroup",
  "iosTeamId",
  "androidApplicationId",
  "acmeDirectory",
] as const;

/** `deployment.json` as it must be. */
export interface DeploymentFile {
  readonly productName: string;
  readonly domain: string;
  readonly hubsDomain: string;
  readonly iosBundleId: string;
  readonly iosAppGroup: string;
  readonly iosTeamId: string | null;
  readonly androidApplicationId: string;
  readonly acmeDirectory: string;
}

/** One thing wrong with `deployment.json`'s shape: a key missing, unknown, or of the wrong type. */
export interface DeploymentFileProblem {
  readonly key: string;
  readonly problem: "missing" | "unknown" | "notText" | "empty";
}

/**
 * Checks a parsed `deployment.json`: an object with exactly `DEPLOYMENT_FILE_KEYS`, each a
 * non-empty string (`iosTeamId` may be null). Empty when the shape is right; the values' own
 * rules are `deploymentProblems`'.
 */
export function deploymentFileProblems(value: unknown): readonly DeploymentFileProblem[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [{ key: "", problem: "notText" }];
  const known: readonly string[] = DEPLOYMENT_FILE_KEYS;
  const problems: DeploymentFileProblem[] = Object.keys(value)
    .filter((key) => !known.includes(key))
    .map((key) => ({ key, problem: "unknown" }));
  for (const key of DEPLOYMENT_FILE_KEYS) {
    if (!Object.hasOwn(value, key)) {
      problems.push({ key, problem: "missing" });
      continue;
    }
    const field: unknown = (value as Readonly<Record<string, unknown>>)[key];
    if (key === "iosTeamId" && field === null) continue;
    if (typeof field !== "string") problems.push({ key, problem: "notText" });
    else if (field === "") problems.push({ key, problem: "empty" });
  }
  return problems;
}

/** The typed deployment of section 2, from a file of the right shape. */
export function deploymentOf(source: DeploymentFile): Deployment {
  return {
    productName: source.productName,
    ios: {
      bundleId: source.iosBundleId,
      appGroup: source.iosAppGroup,
      teamId: source.iosTeamId,
    },
    android: { applicationId: source.androidApplicationId },
    relay: { url: `wss://relay.${source.domain}` },
    push: { url: `wss://push.${source.domain}` },
    names: {
      domain: source.hubsDomain,
      canary: `rebindtest.${source.hubsDomain}`,
      control: `control.${source.hubsDomain}`,
      acmeDirectory: source.acmeDirectory,
    },
  };
}

/** What is wrong with this package's own `deployment.json`; empty when its shape is right. */
export const DEPLOYMENT_FILE_PROBLEMS: readonly DeploymentFileProblem[] =
  deploymentFileProblems(file);

/** `deployment.json` as read; its shape is checked by `DEPLOYMENT_FILE_PROBLEMS`. */
export const DEPLOYMENT_FILE: DeploymentFile = file;

/** The deployment (m4-design section 2), from `deployment.json`. */
export const DEPLOYMENT: Deployment = deploymentOf(DEPLOYMENT_FILE);

/** The same object under the name `app.config.ts` first imported (0c); `DEPLOYMENT` is the name to use. */
export const deployment: Deployment = DEPLOYMENT;

/** The shape every deployment has; a self-hosted builder's own values must fit it. */
export interface Deployment {
  readonly productName: string;
  readonly ios: {
    readonly bundleId: string;
    readonly appGroup: string;
    readonly teamId: string | null;
  };
  readonly android: { readonly applicationId: string };
  readonly relay: { readonly url: string };
  readonly push: { readonly url: string };
  readonly names: {
    readonly domain: string;
    readonly canary: string;
    readonly control: string;
    readonly acmeDirectory: string;
  };
}

/** One thing wrong with a deployment or a URL, by the field it is in. */
export interface DeploymentProblem {
  /** The field's dotted path, for example `ios.bundleId` or `relay.url`. */
  readonly field: string;
  readonly problem:
    /** A `.invalid` name (RFC 6761) or an identifier with an `invalid` label: never reaches anyone. */
    | "placeholder"
    /** No Apple team id. */
    | "noTeam"
    /** Not a URL at all, or one with credentials, a query or a fragment. */
    | "notUrl"
    /** Not `wss://` or `https://` (`ws://` and `http://` only through `relay.set`, and only local). */
    | "notSecure"
    /** A relay URL with a path: the hub and the phone append `/v1/...` themselves. */
    | "hasPath";
}

/** True for a domain under `.invalid`, the RFC 6761 name that never resolves. */
export function isPlaceholderDomain(domain: string): boolean {
  const lower = domain.toLowerCase().replace(/\.$/u, "");
  return lower === "invalid" || lower.endsWith(".invalid");
}

/**
 * True for a reverse-DNS identifier (bundle id, app group, application id) with a label
 * `invalid`, as the placeholders `invalid.hsn.app` and `group.invalid.hsn.app` have.
 */
export function isPlaceholderIdentifier(identifier: string): boolean {
  return identifier
    .toLowerCase()
    .split(".")
    .some((part) => part === "invalid");
}

/** A URL parsed without throwing, or undefined. */
function parseUrl(text: string): URL | undefined {
  return URL.canParse(text) ? new URL(text) : undefined;
}

/** The host of a URL without IPv6 brackets, lower case. */
function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
}

/** A URL's own problems: parse, credentials, query, fragment, and whether its host is a placeholder. */
function urlShapeProblems(field: string, text: string): readonly DeploymentProblem[] {
  const url = parseUrl(text);
  if (url === undefined) return [{ field, problem: "notUrl" }];
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    return [{ field, problem: "notUrl" }];
  return [];
}

function secureSchemeProblems(field: string, text: string): readonly DeploymentProblem[] {
  const url = parseUrl(text);
  if (url === undefined) return [];
  return url.protocol === "wss:" || url.protocol === "https:"
    ? []
    : [{ field, problem: "notSecure" }];
}

function placeholderHostProblems(field: string, text: string): readonly DeploymentProblem[] {
  const url = parseUrl(text);
  if (url === undefined) return [];
  return isPlaceholderDomain(hostOf(url)) ? [{ field, problem: "placeholder" }] : [];
}

/** A base URL (relay, push) must not carry a path: `/v1/hub` and the others are appended to it. */
function pathProblems(field: string, text: string): readonly DeploymentProblem[] {
  const url = parseUrl(text);
  if (url === undefined) return [];
  return url.pathname === "" || url.pathname === "/" ? [] : [{ field, problem: "hasPath" }];
}

/**
 * The rules of m4-design section 2, checked by this package's test and by the release build
 * (`hub/packaging/shared/build-program.ts`, beside `releaseKeysProblem`):
 *
 * - always: every URL is `wss://` or `https://`, parses, and carries no credentials, query or
 *   fragment; the relay and push URLs carry no path;
 * - for a release build also: no placeholder domain (any URL's host or any name), no placeholder
 *   bundle identifier, app group or application id, and a team id.
 *
 * Empty when nothing is wrong. The development placeholders pass `{release: false}`.
 */
export function deploymentProblems(
  value: Deployment,
  options: { readonly release: boolean },
): readonly DeploymentProblem[] {
  const urls: readonly (readonly [string, string, boolean])[] = [
    ["relay.url", value.relay.url, true],
    ["push.url", value.push.url, true],
    ["names.acmeDirectory", value.names.acmeDirectory, false],
  ];
  const problems: DeploymentProblem[] = [];
  for (const [field, text, base] of urls) {
    problems.push(...urlShapeProblems(field, text), ...secureSchemeProblems(field, text));
    if (base) problems.push(...pathProblems(field, text));
  }
  if (!options.release) return problems;
  for (const [field, text] of urls) problems.push(...placeholderHostProblems(field, text));
  const names: readonly (readonly [string, string])[] = [
    ["names.domain", value.names.domain],
    ["names.canary", value.names.canary],
    ["names.control", value.names.control],
  ];
  for (const [field, name] of names)
    if (isPlaceholderDomain(name)) problems.push({ field, problem: "placeholder" });
  const identifiers: readonly (readonly [string, string])[] = [
    ["ios.bundleId", value.ios.bundleId],
    ["ios.appGroup", value.ios.appGroup],
    ["android.applicationId", value.android.applicationId],
  ];
  for (const [field, identifier] of identifiers)
    if (isPlaceholderIdentifier(identifier)) problems.push({ field, problem: "placeholder" });
  if (value.ios.teamId === null || value.ios.teamId === "")
    problems.push({ field: "ios.teamId", problem: "noTeam" });
  return problems;
}

/**
 * The default relay a hub uses when its `relay_settings.url` is null: the deployment's, or null
 * ("none") while its domain is a placeholder, so a hub reaches no relay until a person sets one
 * with `relay.set` (section 2). Null too when the URL is not a usable `wss://` base URL.
 */
export function defaultRelayUrl(value: Deployment): string | null {
  const field = "relay.url";
  const text = value.relay.url;
  const problems = [
    ...urlShapeProblems(field, text),
    ...secureSchemeProblems(field, text),
    ...pathProblems(field, text),
    ...placeholderHostProblems(field, text),
  ];
  return problems.length === 0 ? text : null;
}

/** An IPv4 address as four numbers, or undefined. */
function ipv4(host: string): readonly [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (match === null) return undefined;
  const parts = [match[1], match[2], match[3], match[4]].map(Number);
  const [a, b, c, d] = parts;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  if (parts.some((part) => part > 255)) return undefined;
  return [a, b, c, d];
}

/**
 * True for a host a hub's `relay.set` may reach without TLS: a loopback or private address,
 * written as an address. IPv4: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16. IPv6:
 * ::1 and fc00::/7 (unique local). The name `localhost`, which is loopback by RFC 6761.
 *
 * Refused, by this design's choice: link-local addresses (169.254.0.0/16, fe80::/10), which name
 * no fixed computer and need a zone; and every other name, `.local` ones included, since a name
 * can resolve anywhere and a cleartext link must stay on this computer or the home network.
 */
export function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (lower === "localhost") return true;
  const v4 = ipv4(lower);
  if (v4 !== undefined) {
    const [a, b] = v4;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (!lower.includes(":")) return false;
  if (lower === "::1") return true;
  const first = lower.split(":")[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/u.test(first)) return false;
  // fc00::/7: the first 16 bits, read as written (leading zeros may be left out).
  const high = Number.parseInt(first.padStart(4, "0"), 16);
  return (high & 0xfe00) === 0xfc00;
}

/**
 * The rule for a hub's own `relay.set` (m4-design section 2): a URL that parses, with no
 * credentials, query, fragment or path; `wss://` or `https://` to any host; `ws://` or `http://`
 * only to a local host (`isLocalHost`), for testing against a relay on this computer or the home
 * network. Empty when the URL is acceptable.
 */
export function relaySettingProblems(url: string): readonly DeploymentProblem[] {
  const field = "url";
  const shape = urlShapeProblems(field, url);
  if (shape.length > 0) return shape;
  const parsed = parseUrl(url);
  if (parsed === undefined) return [{ field, problem: "notUrl" }];
  const path = pathProblems(field, url);
  if (parsed.protocol === "wss:" || parsed.protocol === "https:") return path;
  if ((parsed.protocol === "ws:" || parsed.protocol === "http:") && isLocalHost(hostOf(parsed)))
    return path;
  return [{ field, problem: "notSecure" }, ...path];
}

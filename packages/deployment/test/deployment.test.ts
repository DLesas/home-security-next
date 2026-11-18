/**
 * The configuration point's values and rules (docs/m4-design.md section 2): the placeholders
 * never reach anyone, a release build refuses them, and `relay.set` takes cleartext only locally.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEPLOYMENT,
  DEPLOYMENT_FILE,
  DEPLOYMENT_FILE_KEYS,
  DEPLOYMENT_FILE_PROBLEMS,
  type DeploymentFile,
  deploymentFileProblems,
  deploymentOf,
  type Deployment,
  type DeploymentProblem,
  defaultRelayUrl,
  deploymentProblems,
  isLocalHost,
  isPlaceholderDomain,
  isPlaceholderIdentifier,
  relaySettingProblems,
} from "../src/deployment.ts";

/** A deployment as a builder with a real name would write it. */
const real: Deployment = {
  productName: "Homeguard",
  ios: { bundleId: "com.example.app", appGroup: "group.com.example.app", teamId: "ABCDE12345" },
  android: { applicationId: "com.example.app" },
  relay: { url: "wss://relay.example.com" },
  push: { url: "wss://push.example.com" },
  names: {
    domain: "hubs.example.net",
    canary: "rebindtest.hubs.example.net",
    control: "control.hubs.example.net",
    acmeDirectory: "https://acme-v02.api.letsencrypt.org/directory",
  },
};

describe("the placeholders", () => {
  test("are exactly section 2's values", () => {
    expect(DEPLOYMENT).toEqual({
      productName: "HSN",
      ios: { bundleId: "invalid.hsn.app", appGroup: "group.invalid.hsn.app", teamId: null },
      android: { applicationId: "invalid.hsn.app" },
      relay: { url: "wss://relay.example.invalid" },
      push: { url: "wss://push.example.invalid" },
      names: {
        domain: "hubs.example.invalid",
        canary: "rebindtest.hubs.example.invalid",
        control: "control.hubs.example.invalid",
        acmeDirectory: "https://acme-v02.api.letsencrypt.org/directory",
      },
    });
  });

  test("pass the rules for a development build", () => {
    expect(deploymentProblems(DEPLOYMENT, { release: false })).toEqual([]);
  });

  test("are each refused by a release build", () => {
    expect(deploymentProblems(DEPLOYMENT, { release: true })).toEqual([
      { field: "relay.url", problem: "placeholder" },
      { field: "push.url", problem: "placeholder" },
      { field: "names.domain", problem: "placeholder" },
      { field: "names.canary", problem: "placeholder" },
      { field: "names.control", problem: "placeholder" },
      { field: "ios.bundleId", problem: "placeholder" },
      { field: "ios.appGroup", problem: "placeholder" },
      { field: "android.applicationId", problem: "placeholder" },
      { field: "ios.teamId", problem: "noTeam" },
    ]);
  });

  test("give no default relay: the hub's relay is none until a person sets one", () => {
    expect(defaultRelayUrl(DEPLOYMENT)).toBeNull();
  });
});

describe("a real deployment", () => {
  test("passes a release build and has a default relay", () => {
    expect(deploymentProblems(real, { release: true })).toEqual([]);
    expect(defaultRelayUrl(real)).toBe("wss://relay.example.com");
  });

  test("each placeholder alone is refused", () => {
    const cases: readonly (readonly [Deployment, string, DeploymentProblem["problem"]])[] = [
      [{ ...real, relay: { url: "wss://relay.x.invalid" } }, "relay.url", "placeholder"],
      [{ ...real, push: { url: "wss://push.invalid" } }, "push.url", "placeholder"],
      [{ ...real, names: { ...real.names, domain: "h.invalid" } }, "names.domain", "placeholder"],
      [{ ...real, ios: { ...real.ios, bundleId: "invalid.a.b" } }, "ios.bundleId", "placeholder"],
      [{ ...real, ios: { ...real.ios, teamId: null } }, "ios.teamId", "noTeam"],
      [{ ...real, ios: { ...real.ios, teamId: "" } }, "ios.teamId", "noTeam"],
      [
        { ...real, android: { applicationId: "com.invalid.app" } },
        "android.applicationId",
        "placeholder",
      ],
    ];
    for (const [value, field, problem] of cases)
      expect(deploymentProblems(value, { release: true })).toEqual([{ field, problem }]);
  });

  test("every URL is wss:// or https://, in any build", () => {
    for (const release of [false, true]) {
      expect(
        deploymentProblems({ ...real, relay: { url: "ws://relay.example.com" } }, { release }),
      ).toEqual([{ field: "relay.url", problem: "notSecure" }]);
      expect(
        deploymentProblems(
          { ...real, names: { ...real.names, acmeDirectory: "http://acme.example.com/dir" } },
          { release },
        ),
      ).toEqual([{ field: "names.acmeDirectory", problem: "notSecure" }]);
    }
    expect(
      deploymentProblems({ ...real, push: { url: "https://push.example.com" } }, { release: true }),
    ).toEqual([]);
  });

  test("the relay and push URLs are bare bases; a broken URL is refused", () => {
    expect(
      deploymentProblems(
        { ...real, relay: { url: "wss://relay.example.com/v1" } },
        { release: false },
      ),
    ).toEqual([{ field: "relay.url", problem: "hasPath" }]);
    expect(
      deploymentProblems(
        { ...real, push: { url: "wss://push.example.com?a=1" } },
        { release: false },
      ),
    ).toEqual([{ field: "push.url", problem: "notUrl" }]);
    expect(
      deploymentProblems({ ...real, relay: { url: "not a url" } }, { release: false }),
    ).toEqual([{ field: "relay.url", problem: "notUrl" }]);
    expect(defaultRelayUrl({ ...real, relay: { url: "ws://relay.example.com" } })).toBeNull();
    expect(defaultRelayUrl({ ...real, relay: { url: "wss://relay.example.com/x" } })).toBeNull();
  });
});

describe("names", () => {
  test("placeholder domains and identifiers", () => {
    expect(isPlaceholderDomain("example.invalid")).toBe(true);
    expect(isPlaceholderDomain("EXAMPLE.INVALID.")).toBe(true);
    expect(isPlaceholderDomain("invalid")).toBe(true);
    expect(isPlaceholderDomain("invalid.example.com")).toBe(false);
    expect(isPlaceholderDomain("notinvalid")).toBe(false);
    expect(isPlaceholderIdentifier("group.invalid.hsn.app")).toBe(true);
    expect(isPlaceholderIdentifier("com.invalidity.app")).toBe(false);
  });
});

describe("relay.set", () => {
  test("takes wss:// and https:// to any host", () => {
    expect(relaySettingProblems("wss://relay.example.com")).toEqual([]);
    expect(relaySettingProblems("https://relay.example.com:8480/")).toEqual([]);
  });

  test("takes ws:// and http:// only to a loopback or private address", () => {
    for (const url of [
      "ws://127.0.0.1:8480",
      "ws://127.255.0.9",
      "ws://localhost:8480",
      "ws://10.0.0.1:8480",
      "http://172.16.0.1",
      "ws://172.31.255.255",
      "ws://192.168.1.20:8480",
      "ws://[::1]:8480",
      "ws://[fc00::1]",
      "ws://[fd12:3456::1]:8480",
    ])
      expect(relaySettingProblems(url)).toEqual([]);
    for (const url of [
      "ws://relay.example.com",
      "ws://8.8.8.8",
      "ws://172.15.255.255",
      "ws://172.32.0.1",
      "ws://192.169.0.1",
      "ws://11.0.0.1",
      "ws://169.254.1.1",
      "ws://[fe80::1]",
      "ws://[fe00::1]",
      "ws://[2001:db8::1]",
      "ws://hub.local",
      "ftp://127.0.0.1",
    ])
      expect(relaySettingProblems(url)).toEqual([{ field: "url", problem: "notSecure" }]);
  });

  test("refuses credentials, a query, a fragment, a path and non-URLs", () => {
    expect(relaySettingProblems("wss://u:p@relay.example.com")).toEqual([
      { field: "url", problem: "notUrl" },
    ]);
    expect(relaySettingProblems("wss://relay.example.com#x")).toEqual([
      { field: "url", problem: "notUrl" },
    ]);
    expect(relaySettingProblems("relay.example.com")).toEqual([
      { field: "url", problem: "notUrl" },
    ]);
    expect(relaySettingProblems("ws://127.0.0.1:8480/v1/hub")).toEqual([
      { field: "url", problem: "hasPath" },
    ]);
  });

  test("isLocalHost on bare hosts", () => {
    expect(isLocalHost("[FD00::1]")).toBe(true);
    expect(isLocalHost("fbff::1")).toBe(false);
    expect(isLocalHost("256.0.0.1")).toBe(false);
  });
});

/** The file as a reader without TypeScript sees it: plain JSON from disk. */
const ON_DISK: unknown = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "deployment.json"), "utf8"),
);

describe("deployment.json, the one place a person edits", () => {
  test("has exactly the keys the schema knows, each of the right type", () => {
    expect(Object.keys(ON_DISK as object).toSorted()).toEqual([...DEPLOYMENT_FILE_KEYS].toSorted());
    expect(deploymentFileProblems(ON_DISK)).toEqual([]);
    expect(DEPLOYMENT_FILE_PROBLEMS).toEqual([]);
    expect(DEPLOYMENT_FILE).toEqual(ON_DISK as DeploymentFile);
  });

  test("holds the placeholders, flat", () => {
    expect(ON_DISK).toEqual({
      productName: "HSN",
      domain: "example.invalid",
      hubsDomain: "hubs.example.invalid",
      iosBundleId: "invalid.hsn.app",
      iosAppGroup: "group.invalid.hsn.app",
      iosTeamId: null,
      androidApplicationId: "invalid.hsn.app",
      acmeDirectory: "https://acme-v02.api.letsencrypt.org/directory",
    });
  });

  test("a misspelt, missing, extra or mistyped key is a problem", () => {
    const good = ON_DISK as Readonly<Record<string, unknown>>;
    const { domain, ...noDomain } = good;
    expect(domain).toBe("example.invalid");
    expect(deploymentFileProblems(noDomain)).toEqual([{ key: "domain", problem: "missing" }]);
    expect(deploymentFileProblems({ ...noDomain, domian: "example.com" })).toEqual([
      { key: "domian", problem: "unknown" },
      { key: "domain", problem: "missing" },
    ]);
    expect(deploymentFileProblems({ ...good, productName: 7 })).toEqual([
      { key: "productName", problem: "notText" },
    ]);
    expect(deploymentFileProblems({ ...good, iosBundleId: null })).toEqual([
      { key: "iosBundleId", problem: "notText" },
    ]);
    expect(deploymentFileProblems({ ...good, hubsDomain: "" })).toEqual([
      { key: "hubsDomain", problem: "empty" },
    ]);
    expect(deploymentFileProblems({ ...good, iosTeamId: "ABCDE12345" })).toEqual([]);
    expect(deploymentFileProblems([])).toEqual([{ key: "", problem: "notText" }]);
    expect(deploymentFileProblems(null)).toEqual([{ key: "", problem: "notText" }]);
  });

  test("one line, the domain, moves the relay and the push service", () => {
    const named = deploymentOf({
      ...(ON_DISK as DeploymentFile),
      domain: "example.com",
      hubsDomain: "hubs.example.net",
      iosTeamId: "ABCDE12345",
    });
    expect(named.relay.url).toBe("wss://relay.example.com");
    expect(named.push.url).toBe("wss://push.example.com");
    expect(named.names).toEqual({
      domain: "hubs.example.net",
      canary: "rebindtest.hubs.example.net",
      control: "control.hubs.example.net",
      acmeDirectory: "https://acme-v02.api.letsencrypt.org/directory",
    });
    expect(named.ios.teamId).toBe("ABCDE12345");
  });
});

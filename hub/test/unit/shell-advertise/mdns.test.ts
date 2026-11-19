/**
 * The mDNS record's keys for apps (docs/m3-design.md section 2; protocol.md §10, "Finding the
 * hub"): `id` for devices as before, and `app` (the apps' port, decimal) and `aid` (the app
 * identity, 26 characters of base32) once the apps' listener is open, so a phone can choose where
 * to try. Without the listener the record is as it was.
 */
import { describe, expect, test } from "bun:test";
import { toHex } from "@hsn/protocol";
import { formatIdentity, parseIdentity } from "@hsn/protocol/app";
import {
  APP_IDENTITY_TXT_KEY,
  APPS_PORT_TXT_KEY,
  type AppsRecord,
  IDENTITY_TXT_KEY,
  type MdnsLibrary,
  MdnsAdvertiser,
  txtRecord,
} from "../../../src/shell/advertise/mdns.ts";

const HUB = new Uint8Array([0xd6, 0xc2, 0x3e, 0x27, 0x44, 0xa8, 0x40, 0xcb]);
const APP_IDENTITY = new Uint8Array(16).map((_, i) => i * 13);

function recording() {
  const published: { port: number; txt: Readonly<Record<string, string>> }[] = [];
  const library: MdnsLibrary = {
    publish: (options) => {
      published.push({ port: options.port, txt: options.txt });
      return {};
    },
    unpublishAll: () => undefined,
    destroy: () => undefined,
  };
  return { published, library };
}

describe("the TXT record", () => {
  test("the keys and their forms", () => {
    expect([IDENTITY_TXT_KEY, APPS_PORT_TXT_KEY, APP_IDENTITY_TXT_KEY]).toEqual([
      "id",
      "app",
      "aid",
    ]);
    const txt = txtRecord(HUB, { port: 8444, identity: APP_IDENTITY });
    expect(txt).toEqual({
      id: toHex(HUB),
      app: "8444",
      aid: formatIdentity(APP_IDENTITY),
    });
    expect(txt.aid).toHaveLength(26);
    expect(parseIdentity(txt.aid ?? "")).toBeDefined();
  });

  test("before the apps' listener is open: `id` alone", () => {
    expect(txtRecord(HUB, undefined)).toEqual({ id: toHex(HUB) });
  });
});

describe("the advertiser", () => {
  test("publishes `app` and `aid` once the listener is known, on the served port", () => {
    const { published, library } = recording();
    const held: { apps: AppsRecord | undefined } = { apps: undefined };
    const advertiser = new MdnsAdvertiser(
      8443,
      () => library,
      () => held.apps,
    );
    expect(advertiser.advertise(HUB, 0).isOk()).toBe(true);
    held.apps = { port: 50_123, identity: APP_IDENTITY };
    expect(advertiser.advertise(HUB, 0).isOk()).toBe(true);
    expect(published).toEqual([
      { port: 8443, txt: { id: toHex(HUB) } },
      {
        port: 8443,
        txt: { id: toHex(HUB), app: "50123", aid: formatIdentity(APP_IDENTITY) },
      },
    ]);
  });

  test("without an apps record given, as before", () => {
    const { published, library } = recording();
    expect(new MdnsAdvertiser(8443, () => library).advertise(HUB, 9000).isOk()).toBe(true);
    expect(published).toEqual([{ port: 9000, txt: { id: toHex(HUB) } }]);
  });
});

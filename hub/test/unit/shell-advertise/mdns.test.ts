/**
 * The mDNS record's keys for apps (docs/m3-design.md section 2; protocol.md §10, "Finding the
 * hub"): `id` for devices as before, and `app` (the apps' port, decimal) and `aid` (the app
 * identity, 26 characters of base32) once the apps' listener is open, so a phone can choose where
 * to try. Without the listener the record is as it was.
 */
import { describe, expect, mock, test } from "bun:test";
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
import type { Scheduler } from "../../../src/shell/clock/time-trust.ts";

const HUB = new Uint8Array([0xd6, 0xc2, 0x3e, 0x27, 0x44, 0xa8, 0x40, 0xcb]);
const APP_IDENTITY = new Uint8Array(16).map((_, i) => i * 13);

/** Records the advertisements published without contacting the network. */
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

/** Captures library callbacks and the deadline so tests choose exactly when they run. */
function shutdownFixture() {
  const publish = mock<MdnsLibrary["publish"]>(() => ({}));
  const unpublishAll = mock<MdnsLibrary["unpublishAll"]>(() => undefined);
  const destroy = mock<MdnsLibrary["destroy"]>(() => undefined);
  const cancel = mock(() => undefined);
  const schedule = mock<Scheduler>(() => ({ cancel }));
  const advertiser = new MdnsAdvertiser(
    8443,
    () => ({ publish, unpublishAll, destroy }),
    undefined,
    schedule,
  );
  return { advertiser, publish, unpublishAll, destroy, schedule, cancel };
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

describe("mDNS shutdown", () => {
  test("waits for the goodbye before destroying and for destroy before resolving", async () => {
    const { advertiser, unpublishAll, destroy, cancel } = shutdownFixture();
    expect(advertiser.advertise(HUB, 0).isOk()).toBe(true);
    const stopped = advertiser.stopAsync();
    const settled = mock(() => undefined);
    void stopped.then(settled);
    expect(unpublishAll).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    const goodbye = unpublishAll.mock.calls[0]?.[0];
    expect(goodbye).toBeFunction();
    goodbye?.();
    expect(destroy).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    const closed = destroy.mock.calls[0]?.[0];
    expect(closed).toBeFunction();
    closed?.();
    expect((await stopped).isOk()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test.each(["goodbye", "destroy"] as const)("bounds a missing %s callback", async (missing) => {
    const { advertiser, unpublishAll, destroy, schedule } = shutdownFixture();
    expect(advertiser.advertise(HUB, 0).isOk()).toBe(true);
    const stopped = advertiser.stopAsync();
    const goodbye = unpublishAll.mock.calls[0]?.[0];
    expect(goodbye).toBeFunction();
    if (missing === "destroy") goodbye?.();
    expect(destroy).toHaveBeenCalledTimes(missing === "destroy" ? 1 : 0);
    expect(schedule).toHaveBeenCalledTimes(1);
    const deadline = schedule.mock.calls[0];
    expect(deadline?.[0]).toBe(500);
    deadline?.[1]();
    expect((await stopped).isErr()).toBe(true);
    goodbye?.();
    destroy.mock.calls[0]?.[0]?.();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test.each(["unpublishAll", "destroy"] as const)("contains a throw from %s", async (failing) => {
    const fixture = shutdownFixture();
    const { advertiser, unpublishAll, destroy, cancel } = fixture;
    fixture[failing].mockImplementation(() => JSON.parse("{") as never);
    expect(advertiser.advertise(HUB, 0).isOk()).toBe(true);
    const stopped = advertiser.stopAsync();
    if (failing === "destroy") {
      // Invoke this after unpublishAll has returned to exercise the asynchronous callback path.
      const goodbye = unpublishAll.mock.calls[0]?.[0];
      expect(goodbye).toBeFunction();
      goodbye?.();
    }
    expect((await stopped).isErr()).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("stopping before advertising or during another stop does nothing", async () => {
    const { advertiser, unpublishAll, destroy, schedule } = shutdownFixture();
    expect((await advertiser.stopAsync()).isOk()).toBe(true);
    expect(schedule).not.toHaveBeenCalled();
    expect(unpublishAll).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(advertiser.advertise(HUB, 0).isOk()).toBe(true);
    const stopped = advertiser.stopAsync();
    expect((await advertiser.stopAsync()).isOk()).toBe(true);
    expect(unpublishAll).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    schedule.mock.calls[0]?.[1]();
    expect((await stopped).isErr()).toBe(true);
    expect((await advertiser.stopAsync()).isOk()).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("reannouncing unpublishes and destroys synchronously before publishing again", () => {
    const { advertiser, publish, unpublishAll, destroy, schedule } = shutdownFixture();
    const calls: string[] = [];
    publish.mockImplementation(() => {
      calls.push("publish");
      return {};
    });
    unpublishAll.mockImplementation(() => {
      calls.push("unpublish");
    });
    destroy.mockImplementation(() => {
      calls.push("destroy");
    });
    expect(advertiser.advertise(HUB, 0).isOk()).toBe(true);
    expect(advertiser.advertise(HUB, 0).isOk()).toBe(true);
    expect(calls).toEqual(["publish", "unpublish", "destroy", "publish"]);
    expect(unpublishAll.mock.calls).toEqual([[]]);
    expect(destroy.mock.calls).toEqual([[]]);
    expect(schedule).not.toHaveBeenCalled();
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

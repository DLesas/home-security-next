/**
 * The platform split (m3-design.md section 2; `src/platform/split.ts`): the web build's alerts
 * behave as the notifications screen did before the split, and every phone file refuses, plainly,
 * until wave 1 builds it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { NOT_BUILT, NOT_BUILT_MESSAGE } from "../src/platform/split";
import { settle } from "./support/timers";

/** The global the browser's alerts read, writable here for the test. */
const browser = globalThis as unknown as { Notification?: unknown };
const realNotification = browser.Notification;

/** A stand-in for the browser's `Notification`, recording what was shown. */
function fakeNotification(permission: string, answer = permission) {
  const shown: { title: string; options: unknown }[] = [];
  class Fake {
    static permission = permission;
    static requestPermission = () => Promise.resolve(answer);
    readonly title: string;
    constructor(title: string, options: unknown) {
      this.title = title;
      shown.push({ title, options });
    }
  }
  browser.Notification = Fake;
  return shown;
}

afterEach(() => {
  browser.Notification = realNotification;
});

describe("the web build's alerts", () => {
  test("without the browser's notifications: unsupported, and nothing is shown", async () => {
    browser.Notification = undefined;
    const web = await import("../src/platform/alerts.web");
    expect(web.noticePermission()).toBe("unsupported");
    expect(await web.askNoticePermission()).toBe("unsupported");
    web.showNotice("Alarm", "Front door", "1");
  });

  test("the browser's answer, asked and as it stands", async () => {
    fakeNotification("default", "granted");
    const web = await import("../src/platform/alerts.web");
    expect(web.noticePermission()).toBe("default");
    expect(await web.askNoticePermission()).toBe("granted");
  });

  test("a notification only once granted, tagged so tabs share one", async () => {
    const web = await import("../src/platform/alerts.web");
    const refused = fakeNotification("denied");
    web.showNotice("Alarm", "Front door", "7");
    expect(refused).toEqual([]);
    const granted = fakeNotification("granted");
    web.showNotice("Alarm", "Front door", "7");
    expect(granted).toEqual([{ title: "Alarm", options: { body: "Front door", tag: "7" } }]);
  });
});

describe("the phone's files, not built yet", () => {
  test("no key is made, so a phone cannot link", async () => {
    const keys = await import("../src/platform/keys.native");
    expect(await keys.makeClientKey()).toEqual(NOT_BUILT);
    const key = keys.staticKeyOf({ privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) });
    // An all-zero Diffie-Hellman, which the Noise code refuses.
    expect(await key.dh(new Uint8Array(32).fill(9))).toEqual(new Uint8Array(32));
  });

  test("no derivation, no export, no alert", async () => {
    const digest = await import("../src/hub/digest.native");
    const refusal = (pending: Promise<unknown>) =>
      pending.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : "not an error"),
      );
    expect(await refusal(digest.sha256(new Uint8Array(1)))).toBe(NOT_BUILT_MESSAGE);
    expect(await refusal(digest.identityOf(new Uint8Array(32)))).toBe(NOT_BUILT_MESSAGE);
    expect(digest.toHex(new Uint8Array([0, 255]))).toBe("00ff");
    const save = await import("../src/platform/save-file.native");
    expect(await save.saveFile("hsn-backup.hsnb", new Uint8Array(1))).toEqual(NOT_BUILT);
    const alerts = await import("../src/platform/alerts.native");
    expect(alerts.noticePermission()).toBe("unsupported");
    expect(await alerts.askNoticePermission()).toBe("unsupported");
  });

  test("the client starts not linked, and reaches nothing", async () => {
    // React Native's `__DEV__`, false: as in a release build, so wave 0's checks are not loaded.
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const start = await import("../src/hub/start.native");
    expect(start.claimArrivedCode()).toBeUndefined();
    const { client } = start.startClient();
    await settle();
    expect(client.live.getState().connection.kind).toBe("notLinked");
    await client.link(
      { kind: "secret", secret: new Uint8Array(16), identity: undefined },
      "typed",
      { name: "Phone", kind: "phone" },
    );
    // Bun's tests take the web's key (they choose no platform, `split.ts`), so linking gets as far
    // as the socket, which the phone's start does not open; on a phone the key refuses first.
    expect(client.local.getState().link).toEqual({
      kind: "failed",
      from: "typed",
      failure: "unreachable",
    });
    client.stop();
  });
});

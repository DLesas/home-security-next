/**
 * The platform split (m3-design.md section 2; `src/platform/split.ts`): the web build's alerts
 * behave as the notifications screen did before the split. The phone's key, records, finding the
 * hub and its start are built (P2): `phone-vault.test.ts`, `phone-finder.test.ts`,
 * `phone-digest.test.ts`, `phone-client.test.ts` and `phone-real-hub.test.ts` test them; the
 * phone's export and alerts are P5's, and load React Native, which runs only in the app.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("the phone's files", () => {
  test("the key is built: one is made, 32 bytes, and its Diffie-Hellman is not refused", async () => {
    const keys = await import("../src/platform/keys.native");
    const made = await keys.makeClientKey();
    if (!made.ok) throw new Error(made.fault);
    expect(made.value.privateKey).toHaveLength(32);
    const other = await keys.makeClientKey();
    if (!other.ok) throw new Error(other.fault);
    const shared = await keys.staticKeyOf(made.value).dh(other.value.publicKey);
    expect(shared.some((b) => b !== 0)).toBe(true);
  });

  test("the start file binds the phone's own pieces, and offers version 2 only", () => {
    // It imports React Native and Expo's modules, which run only in the app: read, not run. What it
    // binds them to runs under Bun in `phone-client.test.ts`.
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "hub", "start.native.ts"),
      "utf8",
    );
    for (const piece of [
      'from "../platform/vault-items.native"',
      'from "../platform/keys.native"',
      "proto: PHONE_PROTO",
      // P1's hub-net, in place of NO_FINDER.
      'from "../../modules/hub-net"',
      "finder: hubNet().finder",
      'Linking.addEventListener("url"',
      "phone.resume()",
    ])
      expect(source).toContain(piece);
  });
});

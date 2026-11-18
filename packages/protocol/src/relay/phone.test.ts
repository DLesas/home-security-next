/**
 * A phone's stream through the relay (docs/m4-design.md section 3, "Phones"): what the relay may
 * carry and the close code for what it may not; the request it reads; the addresses both ends open.
 */
import { describe, expect, test } from "bun:test";
import {
  checkPhoneMessage,
  hubLinkUrl,
  phoneCloseFor,
  phoneStreamUrl,
  readPhoneRequest,
  relayLinkUrl,
} from "./phone.ts";

const IDENTITY = "abcdefghijklmnopqrstuvwxyz";

describe("what the relay carries", () => {
  test("binary messages of 1 to 65,535 bytes, one for one", () => {
    for (const n of [1, 2, 65_534, 65_535]) {
      const message = new Uint8Array(n);
      const checked = checkPhoneMessage(message);
      expect(checked.ok && checked.value).toBe(message);
    }
  });

  test("a text message, an empty one and one past 65,535 bytes are not carried", () => {
    expect(checkPhoneMessage("hello")).toEqual({ ok: false, error: "textMessage" });
    expect(checkPhoneMessage("")).toEqual({ ok: false, error: "textMessage" });
    expect(checkPhoneMessage(new Uint8Array(0))).toEqual({ ok: false, error: "empty" });
    expect(checkPhoneMessage(new Uint8Array(65_536))).toEqual({ ok: false, error: "tooLarge" });
  });

  test("the close codes: 1003 for text and empty, 1009 for too large", () => {
    expect(phoneCloseFor("textMessage")).toBe(1003);
    expect(phoneCloseFor("empty")).toBe(1003);
    expect(phoneCloseFor("tooLarge")).toBe(1009);
  });
});

describe("the request the relay reads", () => {
  test("an absolute URL whose path is exactly the phone's", () => {
    for (const path of ["session", "link", "restore"] as const)
      for (const origin of [
        "http://relay.example.invalid",
        "https://r.example.invalid:8443",
        "ws://192.168.1.20:8480",
        "http://[fd00::1]:8480",
      ])
        expect(readPhoneRequest(`${origin}/v1/phone/${IDENTITY}/${path}`)).toEqual({
          identity: IDENTITY,
          path,
        });
  });

  test("anything else is refused (4400)", () => {
    const base = `http://relay.example.invalid/v1/phone/${IDENTITY}/session`;
    for (const url of [
      `${base}?`,
      `${base}?a=1`,
      `${base}#x`,
      `${base}/`,
      `http://relay.example.invalid//v1/phone/${IDENTITY}/session`,
      `http://relay.example.invalid/v1/phone/%61${IDENTITY.slice(1)}/session`,
      `http://relay.example.invalid/v1/phone/x/../${IDENTITY}/session`,
      `http://relay.example.invalid/v1/phone/${IDENTITY}/Session`,
      `http://relay.example.invalid/v1/hub`,
      `/v1/phone/${IDENTITY}/session`,
      `http://relay.example.invalid`,
      `http://relay.example.invalid/v1/phone/${IDENTITY}/session extra`,
      "",
    ])
      expect({ url, read: readPhoneRequest(url) }).toEqual({ url, read: undefined });
  });
});

describe("the addresses the hub, the relay and the phone open", () => {
  test("from a relay URL, with or without a path or a trailing slash", () => {
    expect(hubLinkUrl("wss://relay.example.invalid")).toBe("wss://relay.example.invalid/v1/hub");
    expect(hubLinkUrl("wss://relay.example.invalid/")).toBe("wss://relay.example.invalid/v1/hub");
    expect(hubLinkUrl("wss://relay.example.invalid/base//")).toBe(
      "wss://relay.example.invalid/base/v1/hub",
    );
    expect(hubLinkUrl("ws://192.168.1.20:8480")).toBe("ws://192.168.1.20:8480/v1/hub");
    expect(hubLinkUrl("ws://[fd00::20]:8480")).toBe("ws://[fd00::20]:8480/v1/hub");
    expect(relayLinkUrl("wss://push.example.invalid")).toBe("wss://push.example.invalid/v1/relay");
    expect(
      phoneStreamUrl("wss://relay.example.invalid", { identity: IDENTITY, path: "link" }),
    ).toBe(`wss://relay.example.invalid/v1/phone/${IDENTITY}/link`);
  });

  test("refuses what is not a relay URL, or a phone path that is not one", () => {
    for (const url of [
      "https://relay.example.invalid",
      "http://relay.example.invalid",
      "relay.example.invalid",
      "wss://",
      "wss://user@relay.example.invalid",
      "wss://relay.example.invalid?x=1",
      "wss://relay.example.invalid/#x",
      "wss://relay example.invalid",
      "WSS://relay.example.invalid",
      "",
    ]) {
      expect({ url, link: hubLinkUrl(url) }).toEqual({ url, link: undefined });
      expect(relayLinkUrl(url)).toBeUndefined();
      expect(phoneStreamUrl(url, { identity: IDENTITY, path: "session" })).toBeUndefined();
    }
    expect(
      phoneStreamUrl("wss://relay.example.invalid", { identity: "short", path: "session" }),
    ).toBeUndefined();
  });
});

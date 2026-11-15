/**
 * Codes in the address (m2-design.md section 5): read, and removed from the address bar and the
 * history before anything else; a typed code's check character; a QR code's text.
 */
import { describe, expect, test } from "bun:test";
import {
  formatConsoleAddress,
  formatLinkAddress,
  formatLinkQr,
  formatTypedCode,
} from "@hsn/protocol/app";
import { qrSecret, takeCodeFromAddress, typedSecret } from "../src/hub/fragment";

function page(url: string) {
  const parsed = new URL(url);
  const calls: string[] = [];
  const location = { hash: parsed.hash, pathname: parsed.pathname, search: parsed.search };
  const history = {
    replaceState: (_d: unknown, _u: string, next?: string) => {
      calls.push(next ?? "");
      location.hash = "";
    },
  };
  return { location, history, calls };
}

const SECRET = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const IDENTITY = "abcdefghijklmnopqrstuvwxya";

describe("the socket", () => {
  test("the client's own close codes are ones a browser accepts (1000, or 3000 to 4999)", async () => {
    const { CLOSE } = await import("../src/hub/wire");
    for (const code of Object.values(CLOSE))
      expect(code === 1000 || (code >= 3000 && code <= 4999)).toBe(true);
  });
});

describe("a code in the address", () => {
  test("the console's: read, and the address keeps no trace of it", () => {
    const p = page(formatConsoleAddress(8445, SECRET));
    const code = takeCodeFromAddress(p.location, p.history);
    expect(code).toEqual({
      from: "console",
      secret: { kind: "secret", secret: SECRET, identity: undefined },
    });
    expect(p.calls).toEqual(["/"]);
    expect(p.location.hash).toBe("");
  });

  test("a link address: its identity and secret; the path and query kept, the fragment gone", () => {
    const url = formatLinkAddress("192.168.1.5", 8444, IDENTITY, SECRET).replace(
      "/#",
      "/devices?x=1#",
    );
    const p = page(url);
    const code = takeCodeFromAddress(p.location, p.history);
    expect(code).toEqual({
      from: "linkAddress",
      secret: { kind: "secret", secret: SECRET, identity: IDENTITY },
    });
    expect(p.calls).toEqual(["/devices?x=1"]);
  });

  test("the address is cleared before the code is read, even when it cannot be read", () => {
    const p = page("https://192.168.1.5:8444/#link=nonsense");
    let clearedFirst = false;
    const history = {
      replaceState: (d: unknown, u: string, next?: string) => {
        clearedFirst = true;
        p.history.replaceState(d, u, next);
      },
    };
    expect(takeCodeFromAddress(p.location, history)).toEqual({ from: "unreadable" });
    expect(clearedFirst).toBe(true);
    expect(p.location.hash).toBe("");
  });

  test("an address with no code is left alone", () => {
    const p = page("https://192.168.1.5:8444/devices#top");
    expect(takeCodeFromAddress(p.location, p.history)).toBeUndefined();
    expect(p.calls).toEqual([]);
  });

  test("a typed code is read with its check character; a mistyped one is not", () => {
    const code = formatTypedCode({ tokenId: 77, secret: 123_456n }) ?? "";
    expect(typedSecret(code.toLowerCase())).toEqual({
      kind: "typed",
      code: { tokenId: 77, secret: 123_456n },
    });
    const mistyped = `${code.slice(0, 5)}${code[5] === "A" ? "B" : "A"}${code.slice(6)}`;
    expect(typedSecret(mistyped)).toBeUndefined();
  });

  test("a QR code's text gives its identity and secret", () => {
    const text = formatLinkQr({
      identity: IDENTITY,
      secret: SECRET,
      addresses: ["192.168.1.5"],
      port: 8444,
      fingerprint: new Uint8Array(32),
    });
    expect(qrSecret(text)).toEqual({ kind: "secret", secret: SECRET, identity: IDENTITY });
    expect(qrSecret("hsn://restore/1?h=x")).toBeUndefined();
  });
});

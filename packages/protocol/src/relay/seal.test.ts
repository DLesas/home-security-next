/**
 * Sealing and opening a push (docs/m4-design.md section 5): the padding at every size, the sizes
 * of `h`, the order of the refusals, the key and key id as `push.register` carries them, base64url,
 * and the relay's two alerts (D127). relay-vectors.test.ts runs the committed cases.
 */
import { describe, expect, test } from "bun:test";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex } from "../bytes.ts";
import {
  PUSH_H,
  type PushContent,
  pushContent,
  pushContentBytes,
  pushH,
  type PushKey,
} from "./push.ts";
import {
  formatPushKey,
  formatPushKeyId,
  fromBase64url,
  padPushContent,
  parsePushKey,
  parsePushKeyId,
  pushAad,
  pushOpener,
  pushSealer,
  RELAY_ALERT_KINDS,
  relayAlertContent,
  sealRelayAlerts,
  toBase64url,
  unpadPushContent,
} from "./seal.ts";

const encoder = new TextEncoder();
const fixed = (name: string) => sha256(encoder.encode(`seal-test/${name}`));
const KEY: PushKey = { key: fixed("key"), keyId: fixed("key-id").slice(0, 8) };
const NONCE = fixed("nonce").slice(0, 12);
const HUB = "abcdefghijklmnopqrstuvwxyz";
const keyFor = (key: PushKey) => (id: Uint8Array) =>
  toHex(id) === toHex(key.keyId) ? key.key : undefined;

const content: PushContent = {
  v: 1,
  hub: HUB,
  n: {
    seq: 12,
    atMs: 1_763_456_789_012,
    clockOk: true,
    kind: "countdown",
    category: "countdown",
    critical: true,
    device: 3,
    cause: null,
  },
  delayed: false,
  names: { device: "Hall" },
  detail: { seconds: 30 },
  actions: ["disarm"],
  armed: true,
};

/** Content of exactly `bytes` bytes of JSON, padded with `detail.pad`. */
function sized(bytes: number, fill = "x"): PushContent {
  const base = pushContentBytes({ ...content, detail: { pad: "" } }).length;
  const width = encoder.encode(fill).length;
  const pad = fill.repeat(Math.floor((bytes - base) / width)) + "y".repeat((bytes - base) % width);
  const out: PushContent = { ...content, detail: { pad } };
  expect(pushContentBytes(out).length).toBe(bytes);
  return out;
}

describe("the padding", () => {
  test("every content size from 0 to 1,279 pads to 1,280 bytes and back", () => {
    for (let n = 0; n <= PUSH_H.maxContentBytes; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => 0x20 + (i % 90));
      const padded = padPushContent(bytes);
      if (padded === undefined) throw new Error(`refused ${n}`);
      expect(padded.length).toBe(1280);
      expect(padded[n]).toBe(0x80);
      expect(padded.slice(n + 1).every((b) => b === 0)).toBe(true);
      expect(unpadPushContent(padded)).toEqual(bytes);
    }
    expect(padPushContent(new Uint8Array(1280))).toBeUndefined();
  });

  test("the mark is the last non-zero byte, not the first 0x80", () => {
    const bytes = Uint8Array.of(0xc3, 0x80, 0x80, 0x41, 0x80);
    expect(unpadPushContent(padPushContent(bytes) ?? new Uint8Array(0))).toEqual(bytes);
  });

  test("wrong padding is refused", () => {
    expect(unpadPushContent(new Uint8Array(1280))).toBeUndefined();
    const noMark = new Uint8Array(1280);
    noMark[10] = 0x41;
    expect(unpadPushContent(noMark)).toBeUndefined();
    const other = new Uint8Array(1280);
    other[0] = 0x81;
    expect(unpadPushContent(other)).toBeUndefined();
    const last = new Uint8Array(1280);
    last[0] = 0x80;
    last[1279] = 0x01;
    expect(unpadPushContent(last)).toBeUndefined();
    const full = new Uint8Array(1280).fill(0x80);
    expect(unpadPushContent(full)?.length).toBe(1279);
  });
});

describe("sealing", () => {
  test("content at 1,278, 1,279 and 1,280 bytes: the last is too long", () => {
    for (const [bytes, fill] of [
      [1278, "x"],
      [1279, "x"],
      [1279, "é"],
      [1279, "🚪"],
    ] as const) {
      const sealed = pushSealer.seal(sized(bytes, fill), KEY, NONCE);
      if (!sealed.ok) throw new Error(sealed.error);
      expect(sealed.value.length).toBe(PUSH_H.hChars);
      expect(pushOpener.open(sealed.value, keyFor(KEY))).toEqual({
        ok: true,
        value: sized(bytes, fill),
      });
    }
    expect(pushSealer.seal(sized(1280), KEY, NONCE)).toEqual({ ok: false, error: "tooLong" });
    expect(pushSealer.seal(sized(1281, "é"), KEY, NONCE)).toEqual({ ok: false, error: "tooLong" });
  });

  test("h is exactly the format, the same for the same inputs, other for another nonce", () => {
    const h = pushSealer.seal(content, KEY, NONCE);
    if (!h.ok) throw new Error(h.error);
    expect(pushH.safeParse(h.value).success).toBe(true);
    expect(h.value.startsWith(`1.${toHex(KEY.keyId)}.`)).toBe(true);
    expect(pushSealer.seal(content, KEY, NONCE)).toEqual(h);
    const other = pushSealer.seal(content, KEY, fixed("nonce 2").slice(0, 12));
    expect(other.ok && other.value).not.toBe(h.value);
    // By hand: nonce ‖ ChaCha20-Poly1305(key, nonce, aad, padded).
    const padded = padPushContent(pushContentBytes(content)) ?? new Uint8Array(0);
    const sealed = chacha20poly1305(KEY.key, NONCE, pushAad(KEY.keyId)).encrypt(padded);
    expect(h.value).toBe(
      `1.${toHex(KEY.keyId)}.${Buffer.concat([NONCE, sealed]).toString("base64url")}`,
    );
  });

  test("the associated data", () => {
    expect(toHex(pushAad(KEY.keyId))).toBe(
      toHex(new Uint8Array([...encoder.encode("hsn-push/1"), 0, ...KEY.keyId])),
    );
  });

  test("keys and nonces of the wrong length, checked key first", () => {
    for (const key of [31, 33, 0].map((n) => new Uint8Array(n)))
      expect(pushSealer.seal(content, { ...KEY, key }, NONCE)).toEqual({
        ok: false,
        error: "badKey",
      });
    for (const keyId of [7, 9, 0].map((n) => new Uint8Array(n)))
      expect(pushSealer.seal(content, { ...KEY, keyId }, NONCE)).toEqual({
        ok: false,
        error: "badKey",
      });
    for (const nonce of [11, 13, 0].map((n) => new Uint8Array(n)))
      expect(pushSealer.seal(content, KEY, nonce)).toEqual({ ok: false, error: "badNonce" });
    expect(
      pushSealer.seal(sized(1280), { ...KEY, key: new Uint8Array(1) }, new Uint8Array(1)),
    ).toEqual({
      ok: false,
      error: "badKey",
    });
    expect(pushSealer.seal(sized(1280), KEY, new Uint8Array(1))).toEqual({
      ok: false,
      error: "badNonce",
    });
  });
});

describe("opening", () => {
  const h = (() => {
    const sealed = pushSealer.seal(content, KEY, NONCE);
    if (!sealed.ok) throw new Error(sealed.error);
    return sealed.value;
  })();

  test("asks for the key id in h, as bytes, and opens with it", () => {
    const asked: string[] = [];
    const opened = pushOpener.open(h, (id) => {
      asked.push(toHex(id));
      return KEY.key;
    });
    expect(opened).toEqual({ ok: true, value: content });
    expect(asked).toEqual([toHex(KEY.keyId)]);
  });

  test("no key, or a key that is not 32 bytes, is unknownKey", () => {
    expect(pushOpener.open(h, () => undefined)).toEqual({ ok: false, error: "unknownKey" });
    expect(pushOpener.open(h, () => KEY.key.slice(0, 31))).toEqual({
      ok: false,
      error: "unknownKey",
    });
  });

  test("the form is checked before the key is asked for", () => {
    let asked = 0;
    const count = () => {
      asked += 1;
      return KEY.key;
    };
    for (const bad of ["", h.slice(0, -1), `${h}A`, `2${h.slice(1)}`, h.replace(".", "-")])
      expect(pushOpener.open(bad, count)).toEqual({ ok: false, error: "badFormat" });
    expect(asked).toBe(0);
  });

  test("a wrong key or any changed byte does not open", () => {
    expect(pushOpener.open(h, () => fixed("other key"))).toEqual({
      ok: false,
      error: "decryptFailed",
    });
    const body = Buffer.from(h.slice(19), "base64url");
    for (const at of [0, 11, 12, 600, 1291, 1292, 1307]) {
      const changed = Buffer.from(body);
      changed[at] = (changed[at] ?? 0) ^ 0x40;
      const altered = `${h.slice(0, 19)}${changed.toString("base64url")}`;
      expect({ at, opened: pushOpener.open(altered, keyFor(KEY)) }).toEqual({
        at,
        opened: { ok: false, error: "decryptFailed" },
      });
    }
  });

  test("content the schema refuses is badContent, and what opens is the schema's", () => {
    const raw = (json: string) => {
      const padded = padPushContent(encoder.encode(json)) ?? new Uint8Array(0);
      const body = Buffer.concat([
        NONCE,
        chacha20poly1305(KEY.key, NONCE, pushAad(KEY.keyId)).encrypt(padded),
      ]);
      return `1.${toHex(KEY.keyId)}.${body.toString("base64url")}`;
    };
    expect(pushOpener.open(raw(JSON.stringify(content)), keyFor(KEY))).toEqual({
      ok: true,
      value: content,
    });
    for (const json of [
      "",
      "{}",
      "[]",
      "null",
      JSON.stringify({ ...content, v: 2 }),
      "﻿" + JSON.stringify(content),
    ])
      expect({ json: json.slice(0, 20), opened: pushOpener.open(raw(json), keyFor(KEY)) }).toEqual({
        json: json.slice(0, 20),
        opened: { ok: false, error: "badContent" },
      });
  });
});

describe("the key and key id as push.register carries them", () => {
  test("round trips, and refuses anything not exactly as written", () => {
    expect(formatPushKeyId(KEY.keyId)).toBe(toHex(KEY.keyId));
    expect(parsePushKeyId(toHex(KEY.keyId))).toEqual(KEY.keyId);
    expect(formatPushKeyId(new Uint8Array(7))).toBeUndefined();
    for (const bad of [
      "",
      "0011223344556677".toUpperCase().replace("0", "A"),
      "001122334455667",
      "00112233445566778",
      "0011223344556g77",
    ])
      expect(parsePushKeyId(bad)).toBeUndefined();
    const text = formatPushKey(KEY.key) ?? "";
    expect(text.length).toBe(43);
    expect(parsePushKey(text)).toEqual(KEY.key);
    expect(text).toBe(Buffer.from(KEY.key).toString("base64url"));
    expect(formatPushKey(new Uint8Array(31))).toBeUndefined();
    // 43 characters carry 258 bits: the last character's two low bits are unused and must be 0.
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = ALPHABET.indexOf(text.at(-1) ?? "");
    expect(last & 3).toBe(0);
    const head = text.slice(0, -1);
    for (const bad of [
      `${head}${ALPHABET[last | 1] ?? ""}`,
      `${head}${ALPHABET[last | 2] ?? ""}`,
      text.slice(1),
      `${text}A`,
      `${head}=`,
      `${head}+`,
      `${head}/`,
    ])
      expect({ bad, key: parsePushKey(bad) }).toEqual({ bad, key: undefined });
  });

  test("base64url: every length, as Node writes it; refuses other characters and bits", () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = fixed(`b64/${n}`).slice(0, Math.min(n, 32));
      const all = n > 32 ? new Uint8Array([...bytes, ...fixed("more").slice(0, n - 32)]) : bytes;
      const text = toBase64url(all);
      expect(text).toBe(Buffer.from(all).toString("base64url"));
      expect(fromBase64url(text)).toEqual(all);
    }
    for (const bad of ["A", "AB", "ABD", "AAAAA", "AA==", "A+", "A/", "A A", "é"])
      expect({ bad, read: fromBase64url(bad) }).toEqual({ bad, read: undefined });
    expect(fromBase64url("AA")).toEqual(Uint8Array.of(0));
    expect(fromBase64url("AAA")).toEqual(Uint8Array.of(0, 0));
    expect(fromBase64url("")).toEqual(new Uint8Array(0));
  });
});

describe("the relay's two alerts (D127)", () => {
  const nonces = { unreachable: fixed("u").slice(0, 12), back: fixed("b").slice(0, 12) };

  test("their content", () => {
    for (const alert of ["unreachable", "back"] as const)
      for (const armed of [true, false]) {
        const c = relayAlertContent(alert, HUB, armed);
        expect(pushContent.safeParse(c).success).toBe(true);
        expect(c).toEqual({
          v: 1,
          hub: HUB,
          n: {
            seq: 0,
            atMs: 0,
            clockOk: false,
            kind: RELAY_ALERT_KINDS[alert],
            category: "hub",
            critical: false,
            device: null,
            cause: null,
          },
          delayed: false,
          names: {},
          actions: [],
          armed,
        });
      }
    expect(RELAY_ALERT_KINDS).toEqual({ unreachable: "hub_unreachable", back: "hub_back" });
  });

  test("sealed for one target, each opening to its own kind", () => {
    const sealed = sealRelayAlerts(HUB, true, KEY, nonces);
    if (!sealed.ok) throw new Error(sealed.error);
    expect(sealed.value.unreachable).not.toBe(sealed.value.back);
    for (const alert of ["unreachable", "back"] as const) {
      expect(sealed.value[alert].length).toBe(PUSH_H.hChars);
      expect(pushOpener.open(sealed.value[alert], keyFor(KEY))).toEqual({
        ok: true,
        value: relayAlertContent(alert, HUB, true),
      });
      expect(sealed.value[alert]).toBe(
        (
          pushSealer.seal(relayAlertContent(alert, HUB, true), KEY, nonces[alert]) as {
            value: string;
          }
        ).value,
      );
    }
  });

  test("one nonce for both is refused; a bad key or nonce as sealing refuses it", () => {
    expect(
      sealRelayAlerts(HUB, true, KEY, { unreachable: nonces.back, back: nonces.back }),
    ).toEqual({
      ok: false,
      error: "badNonce",
    });
    expect(sealRelayAlerts(HUB, true, { ...KEY, key: new Uint8Array(3) }, nonces)).toEqual({
      ok: false,
      error: "badKey",
    });
    expect(sealRelayAlerts(HUB, true, KEY, { ...nonces, back: new Uint8Array(11) })).toEqual({
      ok: false,
      error: "badNonce",
    });
    expect(sealRelayAlerts(HUB, true, KEY, { ...nonces, unreachable: new Uint8Array(13) })).toEqual(
      {
        ok: false,
        error: "badNonce",
      },
    );
  });
});

describe("sealing refuses what the phone would drop", () => {
  /** Content as it might reach the sealer at run time, past what its type says. */
  const loose = (change: Record<string, unknown>) =>
    ({ ...content, ...change }) as unknown as PushContent;
  const without = (key: string) =>
    Object.fromEntries(
      Object.entries(content).filter(([k]) => k !== key),
    ) as unknown as PushContent;
  const seals = (c: PushContent) => pushSealer.seal(c, KEY, NONCE);

  test("a name of 64 code points seals; 65 does not: Unicode code points, not UTF-16 units", () => {
    expect(seals(loose({ names: { device: "x".repeat(64) } })).ok).toBe(true);
    expect(seals(loose({ names: { device: "x".repeat(65) } }))).toEqual({
      ok: false,
      error: "badContent",
    });
    // Each 🚪 is one code point and two UTF-16 units: 64 of them (128 units) seal, 65 do not.
    expect("🚪".repeat(64).length).toBe(128);
    expect(seals(loose({ names: { device: "🚪".repeat(64) } })).ok).toBe(true);
    expect(seals(loose({ names: { device: "🚪".repeat(65) } }))).toEqual({
      ok: false,
      error: "badContent",
    });
    // A combining accent is a code point of its own: e and U+0301, 32 times, is 64.
    expect(seals(loose({ names: { device: "e\u0301".repeat(32) } })).ok).toBe(true);
    expect(seals(loose({ names: { device: `${"e\u0301".repeat(32)}e` } }))).toEqual({
      ok: false,
      error: "badContent",
    });
    expect(seals(loose({ names: { device: "" } }))).toEqual({ ok: false, error: "badContent" });
    const sealed = seals(loose({ names: { device: "🚪".repeat(64) } }));
    expect(sealed.ok && pushOpener.open(sealed.value, keyFor(KEY)).ok).toBe(true);
  });

  test("an unknown action, two actions, a missing field, an extra field, a wrong version", () => {
    for (const bad of [
      loose({ actions: ["arm"] }),
      loose({ actions: ["disarm", "armAway"] }),
      without("armed"),
      without("n"),
      loose({ class: "critical" }),
      loose({ names: { device: "Hall", room: "Hall" } }),
      loose({ v: 2 }),
      loose({ hub: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" }),
      loose({ n: { ...content.n, category: "doors" } }),
      loose({ n: { ...content.n, seq: -1 } }),
      loose({ n: { ...content.n, device: 0 } }),
      loose({ n: { ...content.n, kind: "k".repeat(65) } }),
      loose({ detail: { nested: { a: 1 } } }),
      loose({ detail: { "": 1 } }),
    ])
      expect(seals(bad)).toEqual({ ok: false, error: "badContent" });
  });

  test("values JSON cannot carry as they are", () => {
    expect(seals(loose({ detail: { n: Number.NaN } }))).toEqual({ ok: false, error: "badContent" });
    expect(seals(loose({ detail: { n: Number.POSITIVE_INFINITY } }))).toEqual({
      ok: false,
      error: "badContent",
    });
    expect(seals(loose({ detail: { n: 10n } }))).toEqual({ ok: false, error: "badContent" });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(seals(loose({ detail: cycle }))).toEqual({ ok: false, error: "badContent" });
  });

  test("everything sealed opens; badContent comes after the key and nonce, before tooLong", () => {
    const bad = loose({ actions: ["arm"], detail: { pad: "x".repeat(2000) } });
    expect(pushSealer.seal(bad, { ...KEY, key: new Uint8Array(1) }, NONCE)).toEqual({
      ok: false,
      error: "badKey",
    });
    expect(pushSealer.seal(bad, KEY, new Uint8Array(1))).toEqual({ ok: false, error: "badNonce" });
    expect(seals(bad)).toEqual({ ok: false, error: "badContent" });
    expect(seals(sized(1280))).toEqual({ ok: false, error: "tooLong" });
    const sealed = seals(content);
    expect(sealed.ok && pushOpener.open(sealed.value, keyFor(KEY))).toEqual({
      ok: true,
      value: content,
    });
  });

  test("the relay's alerts for a hub identity the phone would refuse are not sealed", () => {
    const nonces = { unreachable: fixed("u2").slice(0, 12), back: fixed("b2").slice(0, 12) };
    for (const hub of ["short", HUB.toUpperCase(), `${HUB}a`])
      expect(sealRelayAlerts(hub, true, KEY, nonces)).toEqual({ ok: false, error: "badContent" });
    expect(sealRelayAlerts(HUB, false, KEY, nonces).ok).toBe(true);
  });
});

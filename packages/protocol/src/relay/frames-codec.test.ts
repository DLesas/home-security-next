/**
 * The links' frame codecs at their edges (docs/m4-design.md section 3): binary frames' bounds,
 * order of refusals, byte order, copies; text frames' size bound in UTF-8 bytes, their errors by
 * kind, and each direction's own schema. relay-vectors.test.ts runs the committed cases.
 */
import { describe, expect, test } from "bun:test";
import { RELAY_LIMITS } from "./constants.ts";
import { RELAY_BINARY_LIMITS, relayBinaryCodec } from "./binary.ts";
import type { RelayBinaryFrame } from "./frames.ts";
import {
  decodeTextFrame,
  encodeTextFrame,
  RELAY_TEXT_LIMITS,
  RELAY_TEXT_SCHEMAS,
  type RelayTextDirection,
  splitHubPushItems,
  splitRelayPushItems,
} from "./text.ts";

const encode = (frame: RelayBinaryFrame) => relayBinaryCodec.encode(frame);
const decode = (bytes: Uint8Array) => relayBinaryCodec.decode(bytes);
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + 1) & 0xff);
const KEY_ID = "0011223344556677";
const H = `1.${KEY_ID}.${"A".repeat(1744)}`;
const IDENTITY = "abcdefghijklmnopqrstuvwxyz";

describe("binary frames", () => {
  test("the bounds follow from the shared limits", () => {
    expect(RELAY_BINARY_LIMITS).toEqual({
      maxStreamMessageBytes: 65_535,
      maxReleasePieceBytes: 262_144,
      maxStreamFrameBytes: 65_540,
      maxFrameBytes: 262_149,
    });
  });

  test("layout: kind, then the u32 little-endian, then the payload", () => {
    const frame = encode({ kind: 1, stream: 0x0102_0304, message: Uint8Array.of(9, 8) });
    expect(frame).toEqual({ ok: true, value: Uint8Array.of(1, 4, 3, 2, 1, 9, 8) });
    const piece = encode({ kind: 2, id: 0xa0b0_c0d0, bytes: Uint8Array.of(7) });
    expect(piece).toEqual({ ok: true, value: Uint8Array.of(2, 0xd0, 0xc0, 0xb0, 0xa0, 7) });
  });

  test("each kind's payload at its bounds, both ways", () => {
    for (const [kind, max] of [
      [1, 65_535],
      [2, 262_144],
    ] as const) {
      for (const [length, fits] of [
        [0, false],
        [1, true],
        [max, true],
        [max + 1, false],
      ] as const) {
        const payload = bytes(length);
        const frame: RelayBinaryFrame =
          kind === 1 ? { kind, stream: 5, message: payload } : { kind, id: 5, bytes: payload };
        const encoded = encode(frame);
        expect({ kind, length, ok: encoded.ok }).toEqual({ kind, length, ok: fits });
        if (!encoded.ok) expect(encoded.error).toBe("badLength");
        const raw = new Uint8Array(5 + length);
        raw.set([kind, 5, 0, 0, 0]);
        raw.set(payload, 5);
        const decoded = decode(raw);
        expect(decoded).toEqual(
          fits ? { ok: true, value: frame } : { ok: false, error: "badLength" },
        );
      }
    }
  });

  test("stream numbers and ids: every u32, nothing else", () => {
    for (const n of [0, 1, 0xffff_fffe, 0xffff_ffff]) {
      const encoded = encode({ kind: 1, stream: n, message: bytes(3) });
      expect(encoded.ok && decode(encoded.value)).toEqual({
        ok: true,
        value: { kind: 1, stream: n, message: bytes(3) },
      });
      const piece = encode({ kind: 2, id: n, bytes: bytes(3) });
      expect(piece.ok && decode(piece.value)).toEqual({
        ok: true,
        value: { kind: 2, id: n, bytes: bytes(3) },
      });
    }
    for (const n of [-1, 0x1_0000_0000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(encode({ kind: 1, stream: n, message: bytes(3) })).toEqual({
        ok: false,
        error: "badLength",
      });
      expect(encode({ kind: 2, id: n, bytes: bytes(3) })).toEqual({
        ok: false,
        error: "badLength",
      });
    }
  });

  test("refusals in order: empty, kind, short, length", () => {
    expect(decode(new Uint8Array(0))).toEqual({ ok: false, error: "truncated" });
    for (const kind of [0, 3, 4, 0x7f, 0x80, 0xff])
      for (const length of [1, 4, 5, 6, 100])
        expect(decode(Uint8Array.from({ length }, (_, i) => (i === 0 ? kind : 1)))).toEqual({
          ok: false,
          error: "unknownKind",
        });
    for (const kind of [1, 2])
      for (const length of [1, 2, 3, 4])
        expect(decode(Uint8Array.from({ length }, (_, i) => (i === 0 ? kind : 0)))).toEqual({
          ok: false,
          error: "truncated",
        });
    expect(decode(Uint8Array.of(1, 0, 0, 0, 0))).toEqual({ ok: false, error: "badLength" });
    const wrong = { kind: 3, stream: 1, message: bytes(1) } as unknown as RelayBinaryFrame;
    expect(encode(wrong)).toEqual({ ok: false, error: "unknownKind" });
  });

  test("reads a view into a larger buffer at its own offset, and returns a copy", () => {
    const backing = new Uint8Array(64).fill(0xee);
    backing.set([1, 0x10, 0, 0, 0, 1, 2, 3], 11);
    const view = backing.subarray(11, 19);
    const decoded = decode(view);
    expect(decoded).toEqual({
      ok: true,
      value: { kind: 1, stream: 0x10, message: Uint8Array.of(1, 2, 3) },
    });
    if (!decoded.ok || decoded.value.kind !== 1) throw new Error("no frame");
    backing[16] = 99;
    expect(decoded.value.message).toEqual(Uint8Array.of(1, 2, 3));
    expect(decoded.value.message.byteOffset).toBe(0);
  });
});

describe("text frames", () => {
  const roster = (token: string) =>
    JSON.stringify({
      t: "roster",
      rev: 1,
      targets: [
        { key: KEY_ID, platform: "fcm", env: "production", token, unreachable: H, back: H },
      ],
    });

  test("the bound is the roster's: 131,072 UTF-8 bytes", () => {
    expect(RELAY_TEXT_LIMITS.maxTextBytes).toBe(RELAY_LIMITS.maxRosterBytes);
    expect(RELAY_TEXT_LIMITS.maxTextBytes).toBe(131_072);
  });

  test("a roster at the bound and one byte past it", () => {
    // One target's token is at most 4,096 characters, so the size is made by many targets.
    const targets = (n: number, last: number) =>
      Array.from({ length: n }, (_, i) => ({
        key: i.toString(16).padStart(16, "0"),
        platform: "fcm",
        env: "production",
        token: "t".repeat(i === n - 1 ? last : 4096),
        unreachable: H,
        back: H,
      }));
    const text = (n: number, last: number) =>
      JSON.stringify({ t: "roster", rev: 1, targets: targets(n, last) });
    let n = 1;
    while (text(n, 4096).length < 131_072) n += 1;
    const last = 4096 - (text(n, 4096).length - 131_072);
    const exact = text(n, last);
    expect(exact.length).toBe(131_072);
    expect(decodeTextFrame("hubToRelay", exact).ok).toBe(true);
    // One more digit in `rev`: a byte past the bound, every field still valid.
    const over = exact.replace('"rev":1,', '"rev":10,');
    expect(over.length).toBe(131_073);
    expect(decodeTextFrame("hubToRelay", over)).toEqual({ ok: false, error: "tooLarge" });
    const typed = (text: string) =>
      RELAY_TEXT_SCHEMAS.hubToRelay.parse(JSON.parse(text) as unknown);
    expect(encodeTextFrame("hubToRelay", typed(exact))).toEqual({ ok: true, value: exact });
    expect(encodeTextFrame("hubToRelay", typed(over))).toEqual({ ok: false, error: "tooLarge" });
  });

  test("the size is counted in UTF-8 bytes, before any parsing", () => {
    // 65,536 two-byte characters are 131,072 bytes: within; one more is past.
    const frame = (chars: number) => `{"t":"ping","n":1,"x":"${"é".repeat(chars)}"}`;
    const overhead = new TextEncoder().encode(frame(0)).length;
    const within = Math.floor((131_072 - overhead) / 2);
    expect(decodeTextFrame("hubToRelay", frame(within))).toEqual({ ok: false, error: "badFrame" });
    expect(decodeTextFrame("hubToRelay", frame(within + 1))).toEqual({
      ok: false,
      error: "tooLarge",
    });
    expect(frame(within + 1).length).toBeLessThan(131_072);
    // Not JSON, but too large first.
    expect(decodeTextFrame("relayToHub", "{".repeat(131_073))).toEqual({
      ok: false,
      error: "tooLarge",
    });
    expect(decodeTextFrame("relayToHub", "[".repeat(100_000))).toEqual({
      ok: false,
      error: "badJson",
    });
  });

  test("errors by kind", () => {
    expect(decodeTextFrame("hubToRelay", "")).toEqual({ ok: false, error: "badJson" });
    expect(decodeTextFrame("hubToRelay", '{"t":"ping",')).toEqual({ ok: false, error: "badJson" });
    expect(decodeTextFrame("hubToRelay", "null")).toEqual({ ok: false, error: "badFrame" });
    expect(decodeTextFrame("hubToRelay", '{"t":"ping","n":1}')).toEqual({
      ok: true,
      value: { t: "ping", n: 1 },
    });
    expect(decodeTextFrame("hubToRelay", '{"t":"ping","n":1,"__proto__":{}}')).toEqual({
      ok: false,
      error: "badFrame",
    });
    expect(decodeTextFrame("hubToRelay", '{"t":"ping","n":1e400}')).toEqual({
      ok: false,
      error: "badFrame",
    });
  });

  test("each direction reads only its own frames", () => {
    const frames: Record<RelayTextDirection, string> = {
      hubToRelay: '{"t":"restarting","reason":"update","withinMs":1}',
      relayToHub: '{"t":"open","stream":1,"path":"session","peer":"relay-0011223344556677"}',
      relayToPush: JSON.stringify({
        t: "push",
        items: [{ id: 1, hub: IDENTITY, platform: "fcm", env: "production", token: "x", h: H }],
      }),
      pushToRelay: '{"t":"pushResult","results":[{"id":1,"outcome":"accepted"}]}',
    };
    const accepted: Record<RelayTextDirection, readonly RelayTextDirection[]> = {
      hubToRelay: ["hubToRelay"],
      relayToHub: ["relayToHub"],
      relayToPush: ["relayToPush"],
      pushToRelay: ["pushToRelay", "relayToHub"], // pushResult travels to a hub too
    };
    for (const [from, text] of Object.entries(frames) as [RelayTextDirection, string][])
      for (const direction of Object.keys(RELAY_TEXT_SCHEMAS) as RelayTextDirection[])
        expect({ from, direction, ok: decodeTextFrame(direction, text).ok }).toEqual({
          from,
          direction,
          ok: accepted[from].includes(direction),
        });
  });

  test("encoding refuses what the other end would, and reads back", () => {
    expect(encodeTextFrame("hubToRelay", { t: "ping", n: 7 })).toEqual({
      ok: true,
      value: '{"t":"ping","n":7}',
    });
    expect(encodeTextFrame("hubToRelay", { t: "ping", n: -1 })).toEqual({
      ok: false,
      error: "badFrame",
    });
    expect(encodeTextFrame("relayToHub", { t: "close", stream: 1, code: 999 })).toEqual({
      ok: false,
      error: "badFrame",
    });
    const item = {
      id: 1,
      hub: IDENTITY,
      platform: "fcm",
      env: "production",
      token: "t".repeat(4096),
      h: H,
    } as const;
    const big = {
      t: "push",
      items: Array.from({ length: 32 }, (_, i) => ({ ...item, id: i + 1 })),
    } as const;
    expect(RELAY_TEXT_SCHEMAS.relayToPush.safeParse(big).success).toBe(true);
    expect(encodeTextFrame("relayToPush", big)).toEqual({ ok: false, error: "tooLarge" });
    const half = { t: "push", items: big.items.slice(0, 16) } as const;
    const written = encodeTextFrame("relayToPush", half);
    expect(written.ok && decodeTextFrame("relayToPush", written.value)).toEqual({
      ok: true,
      value: half,
    });
    const rosterText = roster("token:1");
    const parsed = decodeTextFrame("hubToRelay", rosterText);
    expect(parsed.ok && encodeTextFrame("hubToRelay", parsed.value)).toEqual({
      ok: true,
      value: rosterText,
    });
  });
});

describe("splitting push items into frames that fit", () => {
  const hubItem = (id: number) => ({ id, key: KEY_ID, h: H });
  const relayItem = (id: number, tokenChars = 1) => ({
    id,
    hub: IDENTITY,
    platform: "fcm" as const,
    env: "production" as const,
    token: "t".repeat(tokenChars),
    h: H,
  });
  const bytesOf = (text: string) => new TextEncoder().encode(text).length;
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };

  test("no items, no frames; up to 32 in one; 33 in two; order kept", () => {
    expect(splitHubPushItems([])).toEqual({ ok: true, value: [] });
    for (const [n, counts] of [
      [1, [1]],
      [32, [32]],
      [33, [32, 1]],
      [64, [32, 32]],
      [65, [32, 32, 1]],
    ] as const) {
      const items = Array.from({ length: n }, (_, i) => hubItem(i + 1));
      const frames = must(splitHubPushItems(items));
      expect(frames.map((f) => f.items.length)).toEqual([...counts]);
      expect(frames.flatMap((f) => f.items.map((i) => i.id))).toEqual(items.map((i) => i.id));
      for (const f of frames) {
        expect(f.text).toBe(JSON.stringify({ t: "push", items: f.items }));
        expect(decodeTextFrame("hubToRelay", f.text).ok).toBe(true);
      }
    }
  });

  test("by size: 32 items with long tokens go in as many frames as the bytes need", () => {
    const items = Array.from({ length: 32 }, (_, i) => relayItem(i + 1, 4096));
    expect(encodeTextFrame("relayToPush", { t: "push", items })).toEqual({
      ok: false,
      error: "tooLarge",
    });
    const frames = must(splitRelayPushItems(items));
    expect(frames.length).toBe(2);
    for (const f of frames) {
      expect(bytesOf(f.text)).toBeLessThanOrEqual(131_072);
      expect(decodeTextFrame("relayToPush", f.text).ok).toBe(true);
    }
    // The first frame is as full as it can be: one more item would pass the bound.
    const first = frames[0]?.items ?? [];
    const next = items[first.length];
    expect(bytesOf(JSON.stringify({ t: "push", items: [...first, next] }))).toBeGreaterThan(
      131_072,
    );
  });

  test("a frame exactly at the bound, and one byte past it", () => {
    const unit = bytesOf(JSON.stringify({ t: "push", items: [relayItem(1, 100)] }));
    // Two items: find a token size that makes the frame exactly maxBytes.
    const two = (chars: number) =>
      bytesOf(JSON.stringify({ t: "push", items: [relayItem(1, 100), relayItem(2, chars)] }));
    const limit = two(100) + 5;
    expect(must(splitHubPushItems([], { maxBytes: limit }))).toEqual([]);
    const at = must(
      splitRelayPushItems([relayItem(1, 100), relayItem(2, 105)], { maxBytes: limit }),
    );
    expect(at.map((f) => f.items.length)).toEqual([2]);
    expect(bytesOf(at[0]?.text ?? "")).toBe(limit);
    const past = must(
      splitRelayPushItems([relayItem(1, 100), relayItem(2, 106)], { maxBytes: limit }),
    );
    expect(past.map((f) => f.items.length)).toEqual([1, 1]);
    expect(unit).toBeLessThan(limit);
  });

  test("an item that alone does not fit is refused with its index, not looped on", () => {
    const alone = bytesOf(JSON.stringify({ t: "push", items: [relayItem(2, 50)] }));
    const items = [relayItem(1, 1), relayItem(2, 50), relayItem(3, 1)];
    expect(splitRelayPushItems(items, { maxBytes: alone - 1 })).toEqual({
      ok: false,
      error: { error: "tooLarge", index: 1 },
    });
    expect(splitRelayPushItems(items, { maxBytes: alone }).ok).toBe(true);
  });

  test("an item its schema refuses is refused with its index", () => {
    const bad = [hubItem(1), { ...hubItem(2), id: 0 }, hubItem(3)];
    expect(splitHubPushItems(bad)).toEqual({ ok: false, error: { error: "badFrame", index: 1 } });
    const envelopeB = [{ ...relayItem(1), class: "critical" }] as unknown as Parameters<
      typeof splitRelayPushItems
    >[0];
    expect(splitRelayPushItems(envelopeB)).toEqual({
      ok: false,
      error: { error: "badFrame", index: 0 },
    });
    expect(
      splitRelayPushItems([hubItem(1)] as unknown as Parameters<typeof splitRelayPushItems>[0]),
    ).toEqual({
      ok: false,
      error: { error: "badFrame", index: 0 },
    });
  });

  test("smaller announced limits are kept, larger or nonsense ones are not", () => {
    const items = Array.from({ length: 10 }, (_, i) => hubItem(i + 1));
    expect(must(splitHubPushItems(items, { maxItems: 4 })).map((f) => f.items.length)).toEqual([
      4, 4, 2,
    ]);
    expect(must(splitHubPushItems(items, { maxItems: 1 })).length).toBe(10);
    const forty = Array.from({ length: 40 }, (_, i) => hubItem(i + 1));
    for (const maxItems of [100, 0, -1, 2.5, Number.NaN])
      expect(must(splitHubPushItems(forty, { maxItems })).map((f) => f.items.length)).toEqual([
        32, 8,
      ]);
    const big = Array.from({ length: 32 }, (_, i) => relayItem(i + 1, 4096));
    expect(must(splitRelayPushItems(big, { maxBytes: 10_000_000 })).length).toBe(2);
  });
});

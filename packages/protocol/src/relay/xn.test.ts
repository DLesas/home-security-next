/**
 * XN on the relay's links (docs/m4-design.md section 3, D125): both roles through the three
 * messages and into transport, on both links, with the real payloads; what the vectors cannot show
 * (calls out of turn, a failure ending everything, the options XN refuses); and that IK and
 * XXpsk3 are untouched, beside their own vectors in noise.test.ts and app-vectors.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { appIdentityBytes, formatIdentity } from "../app/linking.ts";
import {
  type Handshake,
  NOISE_PATTERNS,
  type NoisePattern,
  type StaticKey,
} from "../app/noise-interface.ts";
import {
  holdsStaticKey,
  NO_STATIC_KEY,
  PATTERNS,
  startHandshake,
  x25519StaticKey,
} from "../app/noise.ts";
import { LOW_ORDER_POINTS } from "../app/vectors/app-vectors.ts";
import { RELAY_LIMITS } from "./constants.ts";
import type { RelayWelcome } from "./frames.ts";
import {
  decodeRelayHello,
  decodeRelayJoin,
  decodeRelayPeerHello,
  decodeRelayWelcome,
  encodeRelayHello,
  encodeRelayJoin,
  encodeRelayPeerHello,
  encodeRelayWelcome,
  provedIdentity,
  relayCloseReconnect,
  relayIdentity,
  relayLinkPrologue,
  type RelayLinkKind,
  sharedRelayProto,
  startRelayInitiator,
  startRelayResponder,
} from "./link-handshake.ts";

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

function must<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function keyPair(seed: string) {
  const privateKey = sha256(encoder.encode(`xn-test/${seed}`));
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}
const HUB = keyPair("hub");
const OTHER = keyPair("other");
const hubKey = (): StaticKey => must(x25519StaticKey(HUB.privateKey));

const welcome: RelayWelcome = {
  proto: 1,
  relay: "0.4.0",
  roles: ["relay", "releases"],
  limits: {
    maxRosterBytes: RELAY_LIMITS.maxRosterBytes,
    maxPushItemsPerFrame: RELAY_LIMITS.maxPushItemsPerFrame,
    maxReleasePieceBytes: RELAY_LIMITS.maxReleasePieceBytes,
    maxRestartWithinMs: RELAY_LIMITS.maxRestartWithinMs,
  },
};

/** Writes on one side and reads on the other, returning the message and what was read. */
async function pass(from: Handshake, to: Handshake, payload: Uint8Array) {
  const message = must(await from.writeMessage(payload));
  return { message, read: await to.readMessage(message) };
}

const sides = (link: RelayLinkKind, key: StaticKey = hubKey()) => ({
  hub: must(startRelayInitiator(link, key)),
  relay: must(startRelayResponder(link)),
});

describe("XN: both roles, three messages, transport", () => {
  for (const link of ["hub", "relay"] as const) {
    test(`${link} link: the payloads, the proved key, the split`, async () => {
      const { hub, relay } = sides(link);
      const hello =
        link === "hub"
          ? must(encodeRelayHello({ proto: [1, 1], hub: "0.4.0" }))
          : must(encodeRelayPeerHello({ proto: [1, 1], relay: "0.4.0" }));

      const one = await pass(hub, relay, hello);
      expect(one.message.length).toBe(32 + hello.length); // e, then the payload in the clear
      const helloRead = must(one.read);
      expect(
        link === "hub" ? decodeRelayHello(helloRead).ok : decodeRelayPeerHello(helloRead).ok,
      ).toBe(true);
      expect(relay.remoteStatic()).toBeUndefined();
      expect(provedIdentity(relay)).toBeUndefined();

      const welcomeBytes = must(encodeRelayWelcome(welcome));
      const two = await pass(relay, hub, welcomeBytes);
      expect(two.message.length).toBe(32 + welcomeBytes.length + 16); // e, the sealed payload
      expect(decodeRelayWelcome(must(two.read))).toEqual({ ok: true, value: welcome });
      expect(hub.complete).toBe(false);

      const join = must(encodeRelayJoin({}));
      const three = await pass(hub, relay, join);
      expect(three.message.length).toBe(48 + join.length + 16); // the sealed static key, the payload
      expect(decodeRelayJoin(must(three.read))).toEqual({ ok: true, value: {} });

      expect(hub.complete && relay.complete).toBe(true);
      expect(relay.remoteStatic()).toEqual(HUB.publicKey);
      // The initiator learns no static key: the relay has none (TLS names it).
      expect(hub.remoteStatic()).toBeUndefined();
      expect(hub.handshakeHash()).toEqual(relay.handshakeHash());
      const identity = formatIdentity(appIdentityBytes(sha256, HUB.publicKey));
      expect(provedIdentity(relay)).toBe(identity);
      expect(relayIdentity(HUB.publicKey)).toBe(identity);

      const a = must(hub.split());
      const b = must(relay.split());
      for (const [from, to] of [
        [a, b],
        [b, a],
        [a, b],
      ] as const) {
        const plain = encoder.encode("one frame");
        expect(must(to.decrypt(must(from.encrypt(plain))))).toEqual(plain);
      }
    });
  }

  test("the hub link and the relay link differ only by prologue", async () => {
    expect(new TextDecoder().decode(relayLinkPrologue("hub"))).toBe("hsn-relay/1\0");
    expect(new TextDecoder().decode(relayLinkPrologue("relay"))).toBe("hsn-relay-peer/1\0");
    const fixed = keyPair("e");
    const run = async (link: RelayLinkKind) => {
      const hub = must(startRelayInitiator(link, hubKey(), fixed));
      const relay = must(startRelayResponder(link, keyPair("r")));
      await pass(hub, relay, EMPTY);
      await pass(relay, hub, EMPTY);
      return hub.handshakeHash();
    };
    expect(await run("hub")).not.toEqual(await run("relay"));
  });

  test("a different key proves a different identity; a key that is not 32 bytes none", () => {
    expect(relayIdentity(OTHER.publicKey)).not.toBe(relayIdentity(HUB.publicKey));
    expect(relayIdentity(HUB.publicKey)).toMatch(/^[a-z2-7]{26}$/u);
    expect(relayIdentity(HUB.publicKey.slice(0, 31))).toBeUndefined();
    expect(relayIdentity(new Uint8Array(33))).toBeUndefined();
  });
});

describe("XN: what the relay refuses", () => {
  test("a static key its holder cannot use: message 3 does not open, nothing is proved", async () => {
    const claimed: StaticKey = {
      publicKey: HUB.publicKey,
      dh: (their) => Promise.resolve(x25519.getSharedSecret(OTHER.privateKey, their)),
    };
    const { hub, relay } = sides("hub", claimed);
    await pass(hub, relay, EMPTY);
    await pass(relay, hub, EMPTY);
    const three = await pass(hub, relay, EMPTY);
    expect(three.read).toEqual({ ok: false, error: "decryptFailed" });
    expect(relay.complete).toBe(false);
    expect(provedIdentity(relay)).toBeUndefined();
    expect(relay.split()).toEqual({ ok: false, error: "wrongState" });
  });

  test("message 3 replayed against a new message 2", async () => {
    const first = sides("hub");
    const m1 = (await pass(first.hub, first.relay, EMPTY)).message;
    await pass(first.relay, first.hub, EMPTY);
    const m3 = (await pass(first.hub, first.relay, EMPTY)).message;
    expect(first.relay.complete).toBe(true);

    const relay = must(startRelayResponder("hub"));
    must(await relay.readMessage(m1));
    must(await relay.writeMessage(EMPTY)); // a new ephemeral
    expect(await relay.readMessage(m3)).toEqual({ ok: false, error: "decryptFailed" });
    expect(provedIdentity(relay)).toBeUndefined();
  });

  test("message 2 replayed to a hub with a new ephemeral", async () => {
    const first = sides("hub");
    await pass(first.hub, first.relay, EMPTY);
    const m2 = must(await first.relay.writeMessage(EMPTY));
    const hub = must(startRelayInitiator("hub", hubKey()));
    must(await hub.writeMessage(EMPTY));
    expect(await hub.readMessage(m2)).toEqual({ ok: false, error: "decryptFailed" });
  });

  test("messages out of order, and calls out of turn", async () => {
    const { hub, relay } = sides("hub");
    // The responder cannot write first, nor the initiator read first.
    expect(await sides("hub").relay.writeMessage(EMPTY)).toEqual({
      ok: false,
      error: "wrongState",
    });
    expect(await sides("hub").hub.readMessage(new Uint8Array(48))).toEqual({
      ok: false,
      error: "wrongState",
    });
    const m1 = must(await hub.writeMessage(EMPTY));
    // The hub cannot send message 3 before it has read message 2.
    const early = must(startRelayInitiator("hub", hubKey()));
    must(await early.writeMessage(EMPTY));
    expect(await early.writeMessage(EMPTY)).toEqual({ ok: false, error: "wrongState" });
    // The relay reads message 1, then is given message 1 again where it must write message 2.
    must(await relay.readMessage(m1));
    expect(await relay.readMessage(m1)).toEqual({ ok: false, error: "wrongState" });
    // Once failed, everything is refused.
    expect(await relay.writeMessage(EMPTY)).toEqual({ ok: false, error: "wrongState" });
    expect(relay.split()).toEqual({ ok: false, error: "wrongState" });
  });

  test("message 3 given to a relay that has not written message 2", async () => {
    const first = sides("hub");
    const m1 = (await pass(first.hub, first.relay, EMPTY)).message;
    await pass(first.relay, first.hub, EMPTY);
    const m3 = must(await first.hub.writeMessage(EMPTY));
    const relay = must(startRelayResponder("hub"));
    must(await relay.readMessage(m1));
    expect(await relay.readMessage(m3)).toEqual({ ok: false, error: "wrongState" });
  });

  test("a message after the handshake, and a split before it ends", async () => {
    const { hub, relay } = sides("hub");
    await pass(hub, relay, EMPTY);
    expect(hub.split()).toEqual({ ok: false, error: "wrongState" });
    const again = sides("hub");
    await pass(again.hub, again.relay, EMPTY);
    await pass(again.relay, again.hub, EMPTY);
    const m3 = (await pass(again.hub, again.relay, EMPTY)).message;
    expect(await again.relay.readMessage(m3)).toEqual({ ok: false, error: "wrongState" });
    expect(await again.hub.writeMessage(EMPTY)).toEqual({ ok: false, error: "wrongState" });
  });

  for (const [hubSide, relaySide] of [
    ["hub", "relay"],
    ["relay", "hub"],
  ] as const) {
    test(`a ${hubSide} link's initiator against a ${relaySide} link's responder: message 2 does not open`, async () => {
      const hub = must(startRelayInitiator(hubSide, hubKey()));
      const relay = must(startRelayResponder(relaySide));
      await pass(hub, relay, EMPTY);
      const two = await pass(relay, hub, EMPTY);
      expect(two.read).toEqual({ ok: false, error: "decryptFailed" });
    });
  }

  test("a prologue without its zero byte, or another protocol's, does not open", async () => {
    for (const label of ["hsn-relay/1", "hsn-relay/1\0\0", "hsn-relay/2\0", "hsn-session/1\0"]) {
      const hub = must(startRelayInitiator("hub", hubKey()));
      const relay = must(
        startHandshake({
          pattern: NOISE_PATTERNS.relay,
          initiator: false,
          prologue: encoder.encode(label),
          staticKey: NO_STATIC_KEY,
        }),
      );
      await pass(hub, relay, EMPTY);
      expect((await pass(relay, hub, EMPTY)).read).toEqual({ ok: false, error: "decryptFailed" });
    }
  });

  test("low-order keys in each message", async () => {
    for (const [, point] of LOW_ORDER_POINTS) {
      const relay = must(startRelayResponder("hub"));
      must(await relay.readMessage(point));
      expect(await relay.writeMessage(EMPTY)).toEqual({ ok: false, error: "allZeroDh" });

      const hub = must(startRelayInitiator("hub", hubKey()));
      must(await hub.writeMessage(EMPTY));
      const m2 = new Uint8Array(48);
      m2.set(point);
      expect(await hub.readMessage(m2)).toEqual({ ok: false, error: "allZeroDh" });

      const attacker = sides("hub", {
        publicKey: point,
        dh: () => Promise.resolve(new Uint8Array(32).fill(7)),
      });
      await pass(attacker.hub, attacker.relay, EMPTY);
      await pass(attacker.relay, attacker.hub, EMPTY);
      expect((await pass(attacker.hub, attacker.relay, EMPTY)).read).toEqual({
        ok: false,
        error: "allZeroDh",
      });
    }
  });

  test("lengths: one byte short of each message's shortest, and past 65,535", async () => {
    const { hub, relay } = sides("hub");
    const m1 = must(await hub.writeMessage(EMPTY));
    expect(m1.length).toBe(32);
    expect(await must(startRelayResponder("hub")).readMessage(m1.slice(0, 31))).toEqual({
      ok: false,
      error: "badMessage",
    });
    expect(await must(startRelayResponder("hub")).readMessage(new Uint8Array(65_536))).toEqual({
      ok: false,
      error: "tooLong",
    });
    must(await relay.readMessage(m1));
    const m2 = must(await relay.writeMessage(EMPTY));
    expect(m2.length).toBe(48);
    const shortHub = must(startRelayInitiator("hub", hubKey(), undefined));
    must(await shortHub.writeMessage(EMPTY));
    expect(await shortHub.readMessage(m2.slice(0, 47))).toEqual({ ok: false, error: "badMessage" });
    must(await hub.readMessage(m2));
    const m3 = must(await hub.writeMessage(EMPTY));
    expect(m3.length).toBe(64);
    expect(await relay.readMessage(m3.slice(0, 63))).toEqual({ ok: false, error: "badMessage" });
  });

  test("a payload that would make a message pass 65,535 bytes is refused as tooLong", async () => {
    const hub = must(startRelayInitiator("hub", hubKey()));
    expect(await hub.writeMessage(new Uint8Array(65_535 - 32 + 1))).toEqual({
      ok: false,
      error: "tooLong",
    });
    const fits = must(startRelayInitiator("hub", hubKey()));
    expect(must(await fits.writeMessage(new Uint8Array(65_535 - 32))).length).toBe(65_535);
  });
});

describe("XN: the options it takes", () => {
  const start = (pattern: NoisePattern, initiator: boolean, staticKey: StaticKey, extra = {}) =>
    startHandshake({ pattern, initiator, prologue: EMPTY, staticKey, ...extra });

  test("its responder takes NO_STATIC_KEY and nothing else; its initiator a 32-byte key", () => {
    expect(start(NOISE_PATTERNS.relay, false, NO_STATIC_KEY).ok).toBe(true);
    expect(start(NOISE_PATTERNS.relay, false, hubKey())).toEqual({
      ok: false,
      error: "wrongState",
    });
    expect(start(NOISE_PATTERNS.relay, true, hubKey()).ok).toBe(true);
    expect(start(NOISE_PATTERNS.relay, true, NO_STATIC_KEY)).toEqual({
      ok: false,
      error: "wrongState",
    });
    const short: StaticKey = { publicKey: new Uint8Array(31), dh: () => Promise.resolve(EMPTY) };
    expect(start(NOISE_PATTERNS.relay, true, short)).toEqual({ ok: false, error: "wrongState" });
    expect(start(NOISE_PATTERNS.relay, false, short)).toEqual({ ok: false, error: "wrongState" });
  });

  test("no remote static key, no pre-shared key, no setPsk", async () => {
    const remote = { remoteStatic: OTHER.publicKey };
    const psk = { psk: new Uint8Array(32) };
    expect(start(NOISE_PATTERNS.relay, true, hubKey(), remote).ok).toBe(false);
    expect(start(NOISE_PATTERNS.relay, false, NO_STATIC_KEY, remote).ok).toBe(false);
    expect(start(NOISE_PATTERNS.relay, true, hubKey(), psk).ok).toBe(false);
    expect(start(NOISE_PATTERNS.relay, false, NO_STATIC_KEY, psk).ok).toBe(false);
    const { hub, relay } = sides("hub");
    await pass(hub, relay, EMPTY);
    expect(relay.setPsk(new Uint8Array(32))).toEqual({ ok: false, error: "wrongState" });
  });

  test("the responder never calls its static key's Diffie-Hellman", async () => {
    let calls = 0;
    const counting: StaticKey = {
      publicKey: new Uint8Array(0),
      dh: () => {
        calls += 1;
        return Promise.resolve(EMPTY);
      },
    };
    const hub = must(startRelayInitiator("hub", hubKey()));
    const relay = must(
      startHandshake({
        pattern: NOISE_PATTERNS.relay,
        initiator: false,
        prologue: relayLinkPrologue("hub"),
        staticKey: counting,
      }),
    );
    await pass(hub, relay, EMPTY);
    await pass(relay, hub, EMPTY);
    must((await pass(hub, relay, EMPTY)).read);
    expect(calls).toBe(0);
    expect(NO_STATIC_KEY.publicKey.length).toBe(0);
    expect(await NO_STATIC_KEY.dh(HUB.publicKey)).toEqual(EMPTY);
    expect(Object.isFrozen(NO_STATIC_KEY)).toBe(true);
  });

  test("IK and XXpsk3 refuse NO_STATIC_KEY on every side", () => {
    for (const pattern of [NOISE_PATTERNS.session, NOISE_PATTERNS.link]) {
      for (const initiator of [true, false]) {
        const extra =
          pattern === NOISE_PATTERNS.session && initiator
            ? { remoteStatic: OTHER.publicKey }
            : pattern === NOISE_PATTERNS.link && initiator
              ? { psk: new Uint8Array(32) }
              : {};
        expect(start(pattern, initiator, NO_STATIC_KEY, extra)).toEqual({
          ok: false,
          error: "wrongState",
        });
        expect(start(pattern, initiator, hubKey(), extra).ok).toBe(true);
      }
    }
  });

  test("which sides hold a static key", () => {
    const holds = (pattern: NoisePattern, initiator: boolean) => {
      const definition = PATTERNS[pattern];
      return definition !== undefined && holdsStaticKey(definition, initiator);
    };
    expect([true, false].map((i) => holds(NOISE_PATTERNS.session, i))).toEqual([true, true]);
    expect([true, false].map((i) => holds(NOISE_PATTERNS.link, i))).toEqual([true, true]);
    expect([true, false].map((i) => holds(NOISE_PATTERNS.relay, i))).toEqual([true, false]);
    // Patterns we do not use, to pin the rule itself: NK (<- s; -> e, es; <- e, ee) gives only the
    // responder one, by its pre-message; NN neither side.
    const nk = {
      responderStaticPremessage: true,
      psk: false,
      messages: [
        ["e", "es"],
        ["e", "ee"],
      ],
    } as const;
    expect([true, false].map((i) => holdsStaticKey(nk, i))).toEqual([false, true]);
    const nn = {
      responderStaticPremessage: false,
      psk: false,
      messages: [["e"], ["e", "ee"]],
    } as const;
    expect([true, false].map((i) => holdsStaticKey(nn, i))).toEqual([false, false]);
  });
});

describe("IK and XXpsk3 are untouched", () => {
  test("their definitions are as M2 froze them, and XN's is Noise 7.4's", () => {
    expect(PATTERNS).toEqual({
      [NOISE_PATTERNS.session]: {
        responderStaticPremessage: true,
        psk: false,
        messages: [
          ["e", "es", "s", "ss"],
          ["e", "ee", "se"],
        ],
      },
      [NOISE_PATTERNS.link]: {
        responderStaticPremessage: false,
        psk: true,
        messages: [["e"], ["e", "ee", "s", "es"], ["s", "se", "psk"]],
      },
      [NOISE_PATTERNS.relay]: {
        responderStaticPremessage: false,
        psk: false,
        messages: [["e"], ["e", "ee"], ["s", "se"]],
      },
    });
  });
});

describe("the payloads", () => {
  test("each decodes what its encoder writes, and refuses the rest", () => {
    const hello = { proto: [1, 2], hub: "1.2.3" } as const;
    expect(decodeRelayHello(must(encodeRelayHello(hello)))).toEqual({ ok: true, value: hello });
    const peer = { proto: [1, 1], relay: "0.0.1" } as const;
    expect(decodeRelayPeerHello(must(encodeRelayPeerHello(peer)))).toEqual({
      ok: true,
      value: peer,
    });
    expect(decodeRelayHello(must(encodeRelayPeerHello(peer)))).toEqual({
      ok: false,
      error: "badPayload",
    });
    expect(decodeRelayPeerHello(must(encodeRelayHello(hello)))).toEqual({
      ok: false,
      error: "badPayload",
    });
    expect(encodeRelayHello({ proto: [2, 1], hub: "1.2.3" })).toEqual({
      ok: false,
      error: "badPayload",
    });
    expect(encodeRelayWelcome({ ...welcome, roles: [] })).toEqual({
      ok: false,
      error: "badPayload",
    });
    expect(decodeRelayJoin(encoder.encode("{}"))).toEqual({ ok: true, value: {} });
    expect(decodeRelayJoin(encoder.encode('{"s":1}'))).toEqual({ ok: false, error: "badPayload" });
    expect(decodeRelayJoin(EMPTY)).toEqual({ ok: false, error: "badJson" });
    expect(decodeRelayJoin(encoder.encode("{"))).toEqual({ ok: false, error: "badJson" });
    expect(decodeRelayJoin(Uint8Array.of(0x7b, 0xff, 0x7d))).toEqual({
      ok: false,
      error: "badJson",
    });
    expect(decodeRelayWelcome(encoder.encode("null"))).toEqual({ ok: false, error: "badPayload" });
  });

  test("the shared version: the highest both speak, or none", () => {
    expect(sharedRelayProto([1, 1])).toBe(1);
    expect(sharedRelayProto([1, 3])).toBe(1);
    expect(sharedRelayProto([2, 3])).toBeUndefined();
    expect(sharedRelayProto([1, 3], { min: 1, max: 2 })).toBe(2);
    expect(sharedRelayProto([1, 2], { min: 2, max: 4 })).toBe(2);
    expect(sharedRelayProto([1, 1], { min: 2, max: 4 })).toBeUndefined();
    expect(sharedRelayProto([5, 6], { min: 2, max: 4 })).toBeUndefined();
    expect(sharedRelayProto([4, 9], { min: 2, max: 4 })).toBe(4);
    expect(sharedRelayProto([3, 1])).toBeUndefined();
    expect(sharedRelayProto([1.5, 2], { min: 1, max: 2 })).toBeUndefined();
  });
});

describe("after a link closes", () => {
  test("refused stops, the limits wait, everything else backs off", () => {
    expect(relayCloseReconnect(4403)).toBe("never");
    for (const code of [4001, 4426, 4429]) expect(relayCloseReconnect(code)).toBe("wait");
    for (const code of [1000, 1001, 1006, 4400, 4402, 4404, 4408, 4430, 0])
      expect([code, relayCloseReconnect(code)]).toEqual([code, "backoff"]);
  });
});

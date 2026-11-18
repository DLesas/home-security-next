/**
 * What the relay's users take from `@hsn/protocol/relay`, imported as they import it (the
 * package's own name, through its `exports`), so a name dropped from `index.ts` fails here and not
 * first in their code.
 */
import { describe, expect, test } from "bun:test";
import * as relay from "@hsn/protocol/relay";

/** Each user's names (docs/m4-design.md section 12). */
const NEEDS = {
  B2: [
    "startRelayResponder",
    "provedIdentity",
    "relayIdentity",
    "decodeRelayHello",
    "encodeRelayWelcome",
    "decodeRelayJoin",
    "sharedRelayProto",
    "relayBinaryCodec",
    "RELAY_BINARY_LIMITS",
    "decodeTextFrame",
    "encodeTextFrame",
    "RELAY_TEXT_LIMITS",
    "readPhoneRequest",
    "checkPhoneMessage",
    "phoneCloseFor",
    "startRelayInitiator",
    "encodeRelayPeerHello",
    "decodeRelayWelcome",
    "encodeRelayJoin",
    "relayLinkUrl",
    "splitRelayPushItems",
  ],
  B3: [
    "startRelayResponder",
    "NO_STATIC_KEY",
    "provedIdentity",
    "decodeRelayPeerHello",
    "encodeRelayWelcome",
    "decodeRelayJoin",
    "sharedRelayProto",
    "decodeTextFrame",
    "encodeTextFrame",
    "pushOpener",
  ],
  B6: [
    "startRelayInitiator",
    "encodeRelayHello",
    "decodeRelayWelcome",
    "encodeRelayJoin",
    "hubLinkUrl",
    "relayBinaryCodec",
    "decodeTextFrame",
    "encodeTextFrame",
    "splitHubPushItems",
    "pushSealer",
    "sealRelayAlerts",
    "relayAlertContent",
    "RELAY_ALERT_KINDS",
    "parsePushKey",
    "parsePushKeyId",
    "formatPushKeyId",
  ],
  P1: [
    "pushOpener",
    "phoneStreamUrl",
    "parsePushKey",
    "formatPushKey",
    "formatPushKeyId",
    "RELAY_ALERT_KINDS",
    "PUSH_H",
    "pushContent",
  ],
} as const;

describe("@hsn/protocol/relay", () => {
  for (const [user, names] of Object.entries(NEEDS))
    test(`exports what ${user} needs`, () => {
      const exported: Record<string, unknown> = relay;
      for (const name of names)
        expect({ name, defined: exported[name] !== undefined }).toEqual({ name, defined: true });
    });

  test("the exports work end to end: seal, open, frame, handshake", () => {
    const key = { key: new Uint8Array(32).fill(1), keyId: new Uint8Array(8).fill(2) };
    const content = relay.relayAlertContent("unreachable", "abcdefghijklmnopqrstuvwxyz", true);
    const h = relay.pushSealer.seal(content, key, new Uint8Array(12).fill(3));
    expect(h.ok && relay.pushOpener.open(h.value, () => key.key)).toEqual({
      ok: true,
      value: content,
    });
    const frame = relay.relayBinaryCodec.encode({ kind: 1, stream: 1, message: Uint8Array.of(9) });
    expect(frame.ok && relay.relayBinaryCodec.decode(frame.value).ok).toBe(true);
    const responder = relay.startRelayResponder("hub");
    expect(responder.ok).toBe(true);
    expect(relay.hubLinkUrl("wss://relay.example.invalid")).toBe(
      "wss://relay.example.invalid/v1/hub",
    );
  });
});

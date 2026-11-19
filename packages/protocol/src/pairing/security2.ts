/**
 * Protocomm security 2, the phone's side (`StartSecurity2`, `Security2Client`, `Security2Session`
 * of `types.ts`), to what ESP-IDF v6.1.1's `components/protocomm/src/security/security2.c` does:
 *
 *   command 0   → SessionData{Sec2Payload{Command0, S2SessionCmd0{username, A}}}
 *   response 0  ← Response0, status, B, salt
 *   command 1   → Command1, M
 *   response 1  ← Response1, status, AMK, the 12-byte nonce: the board's session id (8 random
 *                 bytes), then a 32-bit big-endian counter of 1
 *
 * Then every setup message is AES-256-GCM under K's first 32 bytes, no associated data, the tag
 * after the ciphertext. Both directions share the one counter, stepped after each message: a
 * request uses the counter, its answer the next, the next request the one after. security2.c wraps
 * the counter from 0xffffffff to 0 and refuses to open or seal at 0; a request at 0xffffffff is
 * opened and acted on by the board, which then cannot seal its answer. So the phone seals no
 * request at 0xffffffff, and its session ends after an answer at 0xffffffff.
 *
 * The board's proof is checked, in constant time, before the session key is used for anything.
 * Any refusal ends the attempt: every later call answers `protocol`. Nothing here logs, and no
 * refusal carries a value.
 */
import { PAIRING_SECURITY } from "./constants.ts";
import { decodeSessionData, encodeSessionData } from "./protobuf.ts";
import { gcmOpen, gcmSeal, random } from "./safe/throwing.ts";
import { SRP, srpClientProof, srpClientPublic, srpDeviceProofMatches } from "./srp.ts";
import type {
  PairingCodeText,
  PairResult,
  PairSecurityFault,
  Security2Client,
  Security2Session,
  StartSecurity2,
} from "./types.ts";

const MAX_COUNTER = 0xffffffff;
const encoder = new TextEncoder();

const ok = <T>(value: T): PairResult<T> => ({ ok: true, value });
const refuse = <T>(error: PairSecurityFault): PairResult<T> => ({ ok: false, error });

/** The 12-byte nonce: the session id, then the counter big-endian. */
export function security2Nonce(sessionId: Uint8Array, counter: number): Uint8Array {
  const out = new Uint8Array(PAIRING_SECURITY.nonceBytes);
  out.set(sessionId.subarray(0, PAIRING_SECURITY.sessionIdBytes));
  new DataView(out.buffer).setUint32(PAIRING_SECURITY.sessionIdBytes, counter >>> 0);
  return out;
}

/** The counter of a 12-byte nonce. */
function nonceCounter(nonce: Uint8Array): number {
  return new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).getUint32(
    PAIRING_SECURITY.sessionIdBytes,
  );
}

/**
 * An open session from its AES key (K's first 32 bytes) and the nonce response 1 gave, at its
 * counter. `role` "phone" seals a request then opens its answer, in turn; "board" opens a request
 * then seals its answer, as security2.c does (it opens at 0xffffffff and then cannot seal), for the
 * scripted boards. Out of turn is `protocol`; a tag that does not verify, or the counter used up,
 * is `decryptFailed`; either ends the session.
 */
export function security2Session(
  key: Uint8Array,
  nonce: Uint8Array,
  role: "phone" | "board" = "phone",
): Security2Session {
  const aesKey = key.slice(0, PAIRING_SECURITY.aesKeyBytes);
  const sessionId = nonce.slice(0, PAIRING_SECURITY.sessionIdBytes);
  const shaped =
    aesKey.length === PAIRING_SECURITY.aesKeyBytes && nonce.length === PAIRING_SECURITY.nonceBytes;
  let counter = shaped ? nonceCounter(nonce) : 0;
  // 0 is the wrapped counter: nothing more can be sealed or opened.
  let ended = !shaped || counter === 0;
  /** The phone's turn is to seal first; the board's to open first. */
  let sealsNext = role === "phone";

  const end = <T>(error: PairSecurityFault): PairResult<T> => {
    ended = true;
    aesKey.fill(0);
    return refuse(error);
  };
  const step = (): void => {
    counter = counter === MAX_COUNTER ? 0 : counter + 1;
  };

  return {
    seal(plaintext) {
      if (ended) return refuse("protocol");
      if (!sealsNext) return end("protocol");
      if (counter === 0) return end("decryptFailed");
      // The phone's request needs the next counter for its answer.
      if (role === "phone" && counter === MAX_COUNTER) return end("decryptFailed");
      const sealed = gcmSeal(aesKey, security2Nonce(sessionId, counter), plaintext);
      step();
      sealsNext = false;
      return ok(sealed);
    },
    open(ciphertext) {
      if (ended) return refuse("protocol");
      if (sealsNext) return end("protocol");
      if (counter === 0) return end("decryptFailed");
      if (ciphertext.length < PAIRING_SECURITY.tagBytes) return end("decryptFailed");
      const plaintext = gcmOpen(aesKey, security2Nonce(sessionId, counter), ciphertext);
      if (plaintext === undefined) return end("decryptFailed");
      step();
      sealsNext = true;
      return ok(plaintext);
    },
  };
}

/**
 * `StartSecurity2`: one pairing attempt's handshake with `code` as the password and
 * `PAIRING_SECURITY.username` as the user name. `fixed.clientPrivate` (32 bytes) replaces the
 * random a, for the vectors.
 */
export const startSecurity2: StartSecurity2 = (code, fixed) => client(code, fixed?.clientPrivate);

function client(code: PairingCodeText, fixedPrivate: Uint8Array | undefined): Security2Client {
  const username = encoder.encode(PAIRING_SECURITY.username);
  const password = encoder.encode(code);
  let stage: "start" | "sent0" | "sent1" | "done" = "start";
  let clientPrivate: Uint8Array | undefined;
  let clientPublic: Uint8Array | undefined;
  let expected: { deviceProof: Uint8Array; sessionKey: Uint8Array } | undefined;

  const fail = <T>(error: PairSecurityFault): PairResult<T> => {
    stage = "done";
    clientPrivate?.fill(0);
    expected?.sessionKey.fill(0);
    clientPrivate = undefined;
    expected = undefined;
    return refuse(error);
  };

  return {
    command0() {
      if (stage !== "start") return Promise.resolve(fail("protocol"));
      const a = fixedPrivate?.slice() ?? random(SRP.privateBytes);
      const A = a === undefined ? undefined : srpClientPublic(a);
      if (a === undefined || A === undefined) return Promise.resolve(fail("protocol"));
      clientPrivate = a;
      clientPublic = A;
      stage = "sent0";
      return Promise.resolve(ok(encodeSessionData({ msg: "command0", username, publicKey: A })));
    },

    command1(response0) {
      if (stage !== "sent0" || clientPrivate === undefined || clientPublic === undefined)
        return Promise.resolve(fail("protocol"));
      const message = decodeSessionData(response0);
      if (message?.msg !== "response0" || message.status !== 0)
        return Promise.resolve(fail("protocol"));
      const proof = srpClientProof({
        username,
        password,
        salt: message.salt,
        clientPrivate,
        clientPublic,
        devicePublic: message.publicKey,
      });
      clientPrivate.fill(0);
      clientPrivate = undefined;
      if (!proof.ok) return Promise.resolve(fail("protocol"));
      expected = { deviceProof: proof.value.deviceProof, sessionKey: proof.value.sessionKey };
      stage = "sent1";
      return Promise.resolve(
        ok(encodeSessionData({ msg: "command1", proof: proof.value.clientProof })),
      );
    },

    finish(response1) {
      if (stage !== "sent1" || expected === undefined) return Promise.resolve(fail("protocol"));
      const message = decodeSessionData(response1);
      if (message?.msg !== "response1" || message.status !== 0)
        return Promise.resolve(fail("protocol"));
      if (message.proof.length !== SRP.hashBytes) return Promise.resolve(fail("protocol"));
      // The board's proof first: nothing uses the key before it verifies.
      if (!srpDeviceProofMatches(expected.deviceProof, message.proof))
        return Promise.resolve(fail("wrongCode"));
      const nonce = message.nonce;
      if (nonce.length !== PAIRING_SECURITY.nonceBytes) return Promise.resolve(fail("protocol"));
      if (nonceCounter(nonce) !== PAIRING_SECURITY.firstCounter)
        return Promise.resolve(fail("protocol"));
      const session = security2Session(expected.sessionKey, nonce, "phone");
      expected.sessionKey.fill(0);
      expected = undefined;
      stage = "done";
      return Promise.resolve(ok(session));
    },
  };
}

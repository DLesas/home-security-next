/**
 * The board's side of pairing's security layer, behind one small interface of the bench's own
 * (m3-design.md section 5, layer 2): the server end of protocomm's handshake on `prov-session`,
 * and the session's sealing of every later request and answer. It is shaped on ESP-IDF's own
 * `protocomm_security_t` (`components/protocomm/include/common/protocomm_security.h`, read on
 * this Mac in v6.1.1): one instance per connection (`new_transport_session`), dropped at the
 * disconnect (`close_transport_session`); `session` is its `security_req_handler`; `decrypt` and
 * `encrypt` are its own two.
 *
 * The real Security 2 server in security2-server.ts is the default on a scripted board.
 * The test stand-in sends the code in the clear and has no encryption. It keeps its distinct
 * label for the older transport and setup tests. unjoinedSecurity models a missing handler.
 */
import type { PairingCodeText } from "../../../../packages/protocol/src/pairing/types.ts";
import { fault, ok, type Outcome } from "../outcome.ts";

/** Why a `prov-session` request is refused; the write then fails with an ATT error. */
export type SessionRefusal =
  /**
   * The phone's proof did not verify: a wrong code. ESP-IDF posts
   * `PROTOCOMM_SECURITY_SESSION_CREDENTIALS_MISMATCH`, which the board counts (five end the window).
   */
  | "mismatch"
  /** Out of turn, of the wrong shape, or anything else the handler refuses. */
  | "failed";

/** One connection's security: protocomm's security handler and its session's sealing. */
export interface PairingSecurityServer {
  /** One `prov-session` request (a `Sec2Payload`, for security 2), and the answer to read back. */
  session(request: Uint8Array): Outcome<Uint8Array, SessionRefusal>;
  /** True once the handshake has succeeded and the session is open. */
  readonly established: boolean;
  /** Opens a request written to another endpoint; refused before the session is open. */
  decrypt(data: Uint8Array): Outcome<Uint8Array, "failed">;
  /** Seals an answer to it. */
  encrypt(data: Uint8Array): Outcome<Uint8Array, "failed">;
}

/** Makes one connection's security from the board's pairing code. */
export type StartPairingSecurity = (code: PairingCodeText) => PairingSecurityServer;

/** A board whose security layer is not joined: every handshake is refused. */
export const unjoinedSecurity: StartPairingSecurity = () => ({
  established: false,
  session: () => fault("failed"),
  decrypt: () => fault("failed"),
  encrypt: () => fault("failed"),
});

// ----- The test stand-in -----

/** The stand-in's label, first in every handshake request: never protocomm's. */
export const STAND_IN_LABEL = "hsn-bench-stand-in/1 NOT SECURITY 2";
/** The stand-in's answer to a right code. */
export const STAND_IN_ACCEPTED = Uint8Array.of(0x01);

const encoder = new TextEncoder();

/** The stand-in's one handshake request: its label, a zero byte, the code as ASCII. */
export function standInRequest(code: string): Uint8Array {
  const label = encoder.encode(STAND_IN_LABEL);
  const text = encoder.encode(code);
  const out = new Uint8Array(label.length + 1 + text.length);
  out.set(label, 0);
  out.set(text, label.length + 1);
  return out;
}

/**
 * The test stand-in (see the file's head): one request with the code in the clear; a wrong one
 * is a mismatch, as security 2's wrong proof is; nothing is encrypted. Never for a real board.
 */
export const standInSecurity: StartPairingSecurity = (code) => {
  let established = false;
  const expected = standInRequest(code);
  return {
    get established() {
      return established;
    },
    session(request) {
      const label = encoder.encode(STAND_IN_LABEL);
      if (request.length < label.length + 1 || label.some((b, i) => request[i] !== b)) {
        return fault("failed");
      }
      if (established) return fault("failed");
      const same = request.length === expected.length && request.every((b, i) => b === expected[i]);
      if (!same) return fault("mismatch");
      established = true;
      return ok(STAND_IN_ACCEPTED);
    },
    decrypt: (data) => (established ? ok(data.slice()) : fault("failed")),
    encrypt: (data) => (established ? ok(data.slice()) : fault("failed")),
  };
};
